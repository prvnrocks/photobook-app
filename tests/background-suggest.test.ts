// M10c T11: rule-based background suggestions (src/lib/design/background-suggest.ts), D5
// style.backgroundSource, and how Update album / photo delete / rebuild treat AI vs user backgrounds.

import { describe, expect, it } from "vitest";
import { autolayout, type AutoPhoto } from "@/lib/autolayout";
import type { BookDesign } from "@/lib/book/book-design";
import { serializeDoc, usesV2Features } from "@/lib/book/doc-version";
import { markUserEdited, setBookBackground, setPageBackground } from "@/lib/book/edit-ops";
import { relayoutDoc, type RelayoutPhoto } from "@/lib/book/relayout";
import { isAiReplaceableDoc, hasUserBackgrounds } from "@/lib/book/replaceable";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { stripPhotoFromDoc } from "@/lib/book/strip-photos";
import type { Background, BookDoc, BookPage } from "@/lib/book/types";
import {
  AI_BACKGROUND_CATALOGUE,
  AI_BACKGROUND_STYLES,
  applyBackgroundSuggestions,
  backgroundForId,
  FADED_PHOTO_ID,
  FADED_PHOTO_VEIL,
  fadedPhotoBackground,
  isValidAiBackground,
  pruneAiBackgrounds,
  styleDefaultBackground,
  suggestBookBackground,
  type SuggestPhoto,
} from "@/lib/design/background-suggest";
import { BACKGROUND_SWATCHES, BACKGROUND_VEIL_MAX, BACKGROUND_VEIL_MIN, swatchById, TEXTURE_IDS } from "@/lib/design/backgrounds";
import { getLayout } from "@/lib/layouts";
import { toPublicDoc } from "@/lib/publish/public-doc";
import { albumEditedByUser } from "@/lib/review/ui";
import { momentSet, rng } from "./fixtures/autolayout-sets";

const SAGE_ISH = ["#7d9a6e", "#86a07a", "#6f8f63", "#90a883", "#7a956c"];
const BLUE_ISH = ["#5d7fa3", "#6a8bb0", "#56789c", "#7392b4"];

const AI_DESIGNS: readonly BookDesign[] = [
  { format: "A5_PORTRAIT", designStyle: "modern" },
  { format: "A5_LANDSCAPE", designStyle: "modern" },
  { format: "A5_PORTRAIT", designStyle: "geometric" },
  { format: "A5_LANDSCAPE", designStyle: "geometric" },
  { format: "A5_PORTRAIT", designStyle: "scrapbook" },
  { format: "A5_LANDSCAPE", designStyle: "scrapbook" },
];

function withColours(photos: AutoPhoto[], seed: number): (AutoPhoto & { color: string | null })[] {
  const r = rng(seed);
  // Photo backgrounds need uuid photo ids (schema); momentSet ids aren't.
  return photos.map((p, i) => ({
    ...p,
    id: `00000000-0000-4000-8000-${String(seed * 1000 + i).padStart(12, "0")}`,
    color: r() < 0.2 ? null : `#${Math.floor(r() * 0xffffff).toString(16).padStart(6, "0")}`,
  }));
}

function build(design: BookDesign, n = 60, seed = 7) {
  const photos = withColours(momentSet(n, seed), seed);
  const doc = autolayout(photos, { occasion: "family", title: null, captionLang: "en", isPaid: true, design });
  return { doc, photos };
}

const keptIds = (photos: SuggestPhoto[]) => new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));

function openerIndex(doc: BookDoc): Map<string, number> {
  const m = new Map<string, number>();
  doc.pages.forEach((p, i) => {
    if (p.chapterId !== null && !m.has(p.chapterId)) m.set(p.chapterId, i);
  });
  return m;
}

function chapterIds(doc: BookDoc, chapterId: string): Set<string> {
  return new Set(doc.pages.filter((p) => p.chapterId === chapterId).flatMap((p) => p.slots.map((s) => s.photoId)).filter((x): x is string => x !== null));
}

const toRelayout = (p: AutoPhoto, status = p.status): RelayoutPhoto => ({
  id: p.id,
  width: p.width,
  height: p.height,
  takenAt: p.takenAt,
  status,
  place: p.place,
  dupGroup: p.dupGroup,
  blurScore: p.blurScore,
});

/** First scrapbook doc (over a few seeds) that got at least one faded photo. */
function scrapbookWithFaded(format: BookDesign["format"] = "A5_PORTRAIT") {
  for (let seed = 1; seed < 40; seed++) {
    const { doc, photos } = build({ format, designStyle: "scrapbook" }, 50, seed);
    const out = applyBackgroundSuggestions(doc, photos);
    const idx = out.pages.findIndex((p) => p.background?.kind === "photo");
    if (idx >= 0) return { doc: out, photos, idx };
  }
  throw new Error("no scrapbook fixture with a faded photo");
}

describe("catalogue", () => {
  it("every catalogue id is a known swatch, texture or the faded photo", () => {
    for (const style of AI_BACKGROUND_STYLES) {
      for (const id of AI_BACKGROUND_CATALOGUE[style]) {
        if (id === FADED_PHOTO_ID) {
          expect(style).toBe("scrapbook");
          continue;
        }
        const bg = backgroundForId(style, id);
        expect(bg, `${style}:${id}`).not.toBeNull();
        expect(isValidAiBackground(style, bg as Background, { scope: "book" })).toBe(true);
        // light catalogue entries only (dark ink)
        const s = swatchById(id);
        if (s) expect(s.ink).toBe("dark");
        else expect((TEXTURE_IDS as readonly string[]).includes(id)).toBe(true);
      }
    }
  });

  it("classic has no catalogue; foreign ids and arbitrary hex are rejected", () => {
    expect(backgroundForId("classic", "white")).toBeNull();
    expect(isValidAiBackground("classic", { kind: "color", hex: "#FFFFFF" }, { scope: "book" })).toBe(false);
    expect(backgroundForId("geometric", "kraft")).toBeNull();
    expect(backgroundForId("modern", "navy")).toBeNull();
    expect(isValidAiBackground("modern", { kind: "color", hex: "#123456" }, { scope: "book" })).toBe(false);
    expect(isValidAiBackground("scrapbook", { kind: "texture", textureId: "kraft", tint: "#FF0000" }, { scope: "book" })).toBe(false);
  });

  it("faded photo: scrapbook chapter opener only, kept + same chapter + not on the page, catalogue veil", () => {
    expect(FADED_PHOTO_VEIL).toBeGreaterThanOrEqual(BACKGROUND_VEIL_MIN);
    expect(FADED_PHOTO_VEIL).toBeLessThanOrEqual(BACKGROUND_VEIL_MAX);
    const id = "0b6f3c2e-8d1a-4c5e-9f7a-2b3c4d5e6f70";
    const bg = fadedPhotoBackground(id);
    const ok = { scope: "chapterOpener" as const, keptPhotoIds: new Set([id]), chapterPhotoIds: new Set([id]), pagePhotoIds: new Set<string>() };
    expect(isValidAiBackground("scrapbook", bg, ok)).toBe(true);
    expect(isValidAiBackground("modern", bg, ok)).toBe(false);
    expect(isValidAiBackground("scrapbook", bg, { ...ok, scope: "book" })).toBe(false);
    expect(isValidAiBackground("scrapbook", bg, { ...ok, keptPhotoIds: new Set() })).toBe(false);
    expect(isValidAiBackground("scrapbook", bg, { ...ok, chapterPhotoIds: new Set() })).toBe(false);
    expect(isValidAiBackground("scrapbook", bg, { ...ok, pagePhotoIds: new Set([id]) })).toBe(false);
    expect(isValidAiBackground("scrapbook", { ...bg, veil: 0.6 } as Background, ok)).toBe(false);
  });

  it("style defaults: white for modern/geometric/classic, cream paper for scrapbook", () => {
    expect(styleDefaultBackground("classic")).toEqual({ kind: "color", hex: "#FFFFFF" });
    expect(styleDefaultBackground("modern")).toEqual({ kind: "color", hex: "#FFFFFF" });
    expect(styleDefaultBackground("geometric")).toEqual({ kind: "color", hex: "#FFFFFF" });
    expect(styleDefaultBackground("scrapbook")).toEqual({ kind: "texture", textureId: "paper-cream" });
  });
});

describe("suggestBookBackground", () => {
  it("no / few colours → style default", () => {
    expect(suggestBookBackground("modern", [])).toEqual(styleDefaultBackground("modern"));
    expect(suggestBookBackground("geometric", [null, null, null, null])).toEqual(styleDefaultBackground("geometric"));
    expect(suggestBookBackground("scrapbook", ["#7d9a6e", null])).toEqual(styleDefaultBackground("scrapbook"));
  });

  it("a clear hue picks the nearest muted catalogue entry", () => {
    expect(suggestBookBackground("modern", SAGE_ISH)).toEqual({ kind: "color", hex: "#CAD6C1" });
    expect(suggestBookBackground("geometric", BLUE_ISH)).toEqual({ kind: "color", hex: "#CFE1F0" });
    expect(suggestBookBackground("scrapbook", BLUE_ISH)).toEqual({ kind: "texture", textureId: "watercolour-sky" });
  });

  it("greys and mixed colours stay on the default", () => {
    expect(suggestBookBackground("modern", ["#777777", "#808080", "#6b6b6b", "#7d9a6e"])).toEqual(styleDefaultBackground("modern"));
    expect(suggestBookBackground("modern", [...SAGE_ISH.slice(0, 2), ...BLUE_ISH.slice(0, 2), "#a6705a", "#9b6aa0"])).toEqual(
      styleDefaultBackground("modern"),
    );
  });

  it("never an arbitrary hex: any input gives a catalogue entry of the style", () => {
    const r = rng(42);
    for (const style of AI_BACKGROUND_STYLES) {
      for (let i = 0; i < 200; i++) {
        const colours = Array.from({ length: 1 + Math.floor(r() * 12) }, () =>
          r() < 0.1 ? null : `#${Math.floor(r() * 0xffffff).toString(16).padStart(6, "0")}`,
        );
        const bg = suggestBookBackground(style, colours);
        expect(isValidAiBackground(style, bg, { scope: "book" }), JSON.stringify(bg)).toBe(true);
      }
    }
  });
});

describe("applyBackgroundSuggestions", () => {
  it("classic: doc untouched, still white and stored as v1", () => {
    const { doc, photos } = build({ format: "A5_PORTRAIT", designStyle: "classic" });
    const out = applyBackgroundSuggestions(doc, photos);
    expect(out).toBe(doc);
    expect(out.style.background).toEqual({ kind: "color", hex: "#FFFFFF" });
    expect(out.style.backgroundSource).toBeUndefined();
    expect((serializeDoc(out) as { version: number }).version).toBe(1);
  });

  for (const design of AI_DESIGNS) {
    it(`${design.designStyle} ${design.format}: catalogue book background (source ai), valid doc`, () => {
      const { doc, photos } = build(design);
      const out = applyBackgroundSuggestions(doc, photos);
      expect(out.style.backgroundSource).toBe("ai");
      expect(isValidAiBackground(design.designStyle, out.style.background, { scope: "book" })).toBe(true);
      const parsed = parseBookDoc(serializeDoc(out));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.doc).toEqual(out);
      expect(validateBookDoc(parsed.doc, { photoIds: keptIds(photos), maxPages: 100 })).toEqual([]);
      // page backgrounds: only faded photos, only scrapbook
      for (const p of out.pages) {
        if (!p.background) continue;
        expect(design.designStyle).toBe("scrapbook");
        expect(p.background.source).toBe("ai");
        expect(p.background.kind).toBe("photo");
      }
      // idempotent
      expect(applyBackgroundSuggestions(out, photos)).toEqual(out);
    });
  }

  for (const format of ["A5_PORTRAIT", "A5_LANDSCAPE"] as const) {
    it(`scrapbook ${format}: ≤ 1 faded photo per chapter, on its first page, kept photo of that chapter not on the page`, () => {
      let total = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const { doc, photos } = build({ format, designStyle: "scrapbook" }, 40 + seed * 5, seed);
        // Drop a third of the photos in the status list (still on pages): AI must never use them.
        const status = photos.map((p, i) => ({ ...p, status: (i % 3 === 0 ? "dropped" : p.status) as "kept" | "dropped" }));
        const out = applyBackgroundSuggestions(doc, status);
        const kept = keptIds(status);
        const openers = openerIndex(out);
        const perChapter = new Map<string, number>();
        out.pages.forEach((p, i) => {
          if (p.background?.kind !== "photo") return;
          total++;
          expect(p.chapterId).not.toBeNull();
          const ch = p.chapterId as string;
          perChapter.set(ch, (perChapter.get(ch) ?? 0) + 1);
          expect(openers.get(ch)).toBe(i);
          expect(kept.has(p.background.photoId)).toBe(true);
          expect(chapterIds(out, ch).has(p.background.photoId)).toBe(true);
          const bgPhoto = p.background.photoId;
          expect(p.slots.some((s) => s.photoId === bgPhoto)).toBe(false);
          expect(p.side).toBeUndefined();
          expect(getLayout(p.layout)?.role).toBe("page");
          expect(p.background.veil).toBe(FADED_PHOTO_VEIL);
        });
        for (const n of perChapter.values()) expect(n).toBe(1);
      }
      expect(total).toBeGreaterThan(0);
    });
  }

  it("never touches a user page background or a user book background", () => {
    const { doc, photos, idx } = scrapbookWithFaded();
    const userPage = setPageBackground(doc, idx, { kind: "color", hex: "#CAD6C1" });
    const userBook = setBookBackground(userPage, { kind: "texture", textureId: "kraft" }, { keepPageOverrides: true });
    expect(userBook.style.backgroundSource).toBe("user");
    const out = applyBackgroundSuggestions(userBook, photos);
    expect(out.pages[idx].background).toEqual({ kind: "color", hex: "#CAD6C1", source: "user" });
    expect(out.style.background).toEqual({ kind: "texture", textureId: "kraft" });
    expect(out.style.backgroundSource).toBe("user");
  });

  it("valid AI picks are used, invalid ones fall back to the rules", () => {
    const { doc, photos, idx } = scrapbookWithFaded();
    const base = applyBackgroundSuggestions(doc, photos);
    const ch = base.pages[idx].chapterId as string;
    const ruled = base.pages[idx].background;
    // Valid book pick.
    expect(applyBackgroundSuggestions(doc, photos, { book: "linen" }).style.background).toEqual({ kind: "texture", textureId: "linen" });
    // Invalid book pick → rule.
    expect(applyBackgroundSuggestions(doc, photos, { book: "navy" }).style.background).toEqual(base.style.background);
    // Chapter pick of a photo on the opener page itself → rule.
    const onPage = base.pages[idx].slots.find((s) => s.photoId)?.photoId as string;
    const bad = applyBackgroundSuggestions(doc, photos, { chapters: new Map([[ch, { id: FADED_PHOTO_ID, photoId: onPage }]]) });
    expect(bad.pages[idx].background).toEqual(ruled);
    // Dropped photo → rule (never the dropped one).
    const pageIds = new Set(base.pages[idx].slots.map((s) => s.photoId));
    const other = [...chapterIds(base, ch)].find((id) => !pageIds.has(id) && id !== (ruled as { photoId: string }).photoId);
    if (other) {
      const st = photos.map((p) => (p.id === other ? { ...p, status: "dropped" as const } : p));
      const r = applyBackgroundSuggestions(doc, st, { chapters: new Map([[ch, { id: FADED_PHOTO_ID, photoId: other }]]) });
      expect(r.pages[idx].background?.kind === "photo" && r.pages[idx].background.photoId).not.toBe(other);
    }
    // Colour pick on the opener; null = none.
    const colour = applyBackgroundSuggestions(doc, photos, { chapters: new Map([[ch, { id: "sage" }]]) });
    expect(colour.pages[idx].background).toEqual({ kind: "color", hex: "#CAD6C1", source: "ai" });
    const none = applyBackgroundSuggestions(doc, photos, { chapters: new Map([[ch, null]]) });
    expect(none.pages[idx].background).toBeUndefined();
  });
});

describe("Update album / photo delete / rebuild", () => {
  it("Update album keeps user backgrounds and removes an AI faded photo whose photo was dropped", () => {
    const { doc, photos, idx } = scrapbookWithFaded();
    const fadedId = (doc.pages[idx].background as { photoId: string }).photoId;
    // A user background on another page + the book background chosen by the user.
    const other = doc.pages.findIndex((p, i) => i !== idx && !p.background && p.side === undefined);
    let edited = setPageBackground(doc, other, { kind: "texture", textureId: "linen" });
    edited = setBookBackground(edited, { kind: "color", hex: "#F5EEDC" }, { keepPageOverrides: true });
    const reviewed = photos.map((p) => toRelayout(p, p.id === fadedId ? "dropped" : p.status));
    const r = relayoutDoc(edited, reviewed, { isPaid: true, maxPages: 100, captionLang: "en" });
    expect(r.changed).toBe(true);
    expect(r.doc.pages.some((p) => p.background?.kind === "photo" && p.background.photoId === fadedId)).toBe(false);
    expect(r.doc.pages.some((p) => p.background?.source === "user" && p.background.kind === "texture" && p.background.textureId === "linen")).toBe(true);
    expect(r.doc.style.background).toEqual({ kind: "color", hex: "#F5EEDC" });
    expect(r.doc.style.backgroundSource).toBe("user");
  });

  it("Update album with nothing changed keeps every background (no-op)", () => {
    const { doc, photos } = scrapbookWithFaded();
    // Kept = exactly the photos in the album (momentSet's kept duplicates would be added).
    const inAlbum = new Set(doc.pages.flatMap((p) => p.slots.map((s) => s.photoId)));
    inAlbum.add(doc.cover.photoId);
    const r = relayoutDoc(doc, photos.map((p) => toRelayout(p, inAlbum.has(p.id) ? "kept" : "dropped")), {
      isPaid: true,
      maxPages: 100,
      captionLang: "en",
    });
    expect(r.changed).toBe(false);
    expect(r.doc).toBe(doc);
  });

  it("a user photo background of a dropped photo is kept (D-062: users may pick any photo)", () => {
    const { doc, photos, idx } = scrapbookWithFaded();
    const fadedId = (doc.pages[idx].background as { photoId: string }).photoId;
    const user = setPageBackground(doc, idx, fadedPhotoBackground(fadedId));
    expect(user.pages[idx].background?.source).toBe("user");
    const reviewed = photos.map((p) => toRelayout(p, p.id === fadedId ? "dropped" : p.status));
    const r = relayoutDoc(user, reviewed, { isPaid: true, maxPages: 100, captionLang: "en" });
    expect(r.doc.pages.some((p) => p.background?.source === "user" && p.background.kind === "photo" && p.background.photoId === fadedId)).toBe(true);
  });

  it("Update album: deleted photo (missing from the list) → AI faded photo removed", () => {
    const { doc, photos, idx } = scrapbookWithFaded();
    const fadedId = (doc.pages[idx].background as { photoId: string }).photoId;
    const r = relayoutDoc(doc, photos.filter((p) => p.id !== fadedId).map((p) => toRelayout(p)), { isPaid: true, maxPages: 100, captionLang: "en" });
    expect(r.doc.pages.some((p) => p.background?.kind === "photo" && p.background.photoId === fadedId)).toBe(false);
  });

  it("photo delete strips the AI faded photo", () => {
    const { doc, photos, idx } = scrapbookWithFaded();
    const fadedId = (doc.pages[idx].background as { photoId: string }).photoId;
    const r = stripPhotoFromDoc(doc, fadedId, photos);
    expect(r.changed).toBe(true);
    expect(r.doc.pages.some((p) => p.background?.kind === "photo" && p.background.photoId === fadedId)).toBe(false);
  });

  it("AI photo book background → style default (not white) when its photo goes; user one → white", () => {
    const { doc, photos } = build({ format: "A5_PORTRAIT", designStyle: "scrapbook" });
    const id = photos.find((p) => p.status === "kept")!.id;
    const ai: BookDoc = { ...doc, style: { ...doc.style, background: fadedPhotoBackground(id), backgroundSource: "ai" } };
    expect(pruneAiBackgrounds(ai, (x) => x !== id).doc.style.background).toEqual({ kind: "texture", textureId: "paper-cream" });
    expect(stripPhotoFromDoc(ai, id, photos).doc.style.background).toEqual({ kind: "texture", textureId: "paper-cream" });
    const user: BookDoc = { ...ai, style: { ...ai.style, backgroundSource: "user" } };
    expect(pruneAiBackgrounds(user, (x) => x !== id).changed).toBe(false);
    expect(stripPhotoFromDoc(user, id, photos).doc.style.background).toEqual({ kind: "color", hex: "#FFFFFF" });
  });

  it("prune: an AI faded photo that is no longer on its chapter's first page goes", () => {
    const { doc, idx } = scrapbookWithFaded();
    const moved: BookPage[] = [...doc.pages];
    const ch = moved[idx].chapterId;
    const next = moved.findIndex((p, i) => i > idx && p.chapterId === ch);
    if (next < 0) return; // single-page chapter: nothing to move
    const bg = moved[idx].background;
    const { background: _b, ...rest } = moved[idx];
    void _b;
    moved[idx] = rest;
    moved[next] = { ...moved[next], background: bg };
    const r = pruneAiBackgrounds({ ...doc, pages: moved }, () => true);
    expect(r.changed).toBe(true);
    expect(r.doc.pages[next].background).toBeUndefined();
  });

  it("Rebuild: a doc with a user background is never AI-replaceable; re-applying keeps it", () => {
    const { doc, photos, idx } = scrapbookWithFaded();
    expect(isAiReplaceableDoc(serializeDoc(doc))).toBe(true);
    const userPage = setPageBackground(doc, idx, { kind: "color", hex: "#DDD5EA" });
    expect(hasUserBackgrounds(serializeDoc(userPage))).toBe(true);
    expect(isAiReplaceableDoc(serializeDoc(userPage))).toBe(false);
    expect(albumEditedByUser(serializeDoc(userPage))).toBe(true);
    const userBook = setBookBackground(doc, { kind: "color", hex: "#DDD5EA" }, { keepPageOverrides: true });
    expect(isAiReplaceableDoc(serializeDoc(userBook))).toBe(false);
    expect(isAiReplaceableDoc(serializeDoc(markUserEdited(doc)))).toBe(false);
    // Rebuild of the same album keeps user choices.
    const rebuilt = applyBackgroundSuggestions(userPage, photos);
    expect(rebuilt.pages[idx].background).toEqual({ kind: "color", hex: "#DDD5EA", source: "user" });
  });
});

describe("D5 style.backgroundSource", () => {
  it("setBookBackground marks the user's pick in AI styles, also when it equals the AI suggestion", () => {
    const { doc, photos } = build({ format: "A5_PORTRAIT", designStyle: "modern" });
    const ai = applyBackgroundSuggestions(doc, photos);
    expect(ai.style.backgroundSource).toBe("ai");
    const same = setBookBackground(ai, ai.style.background);
    expect(same.style.backgroundSource).toBe("user");
    expect(same.style.background).toEqual(ai.style.background);
    expect(setBookBackground(same, same.style.background)).toBe(same);
  });

  it("classic: setBookBackground adds no marker — a colour pick stays v1", () => {
    const { doc } = build({ format: "A5_PORTRAIT", designStyle: "classic" });
    const out = setBookBackground(doc, { kind: "color", hex: BACKGROUND_SWATCHES[1].hex });
    expect(out.style.backgroundSource).toBeUndefined();
    expect(usesV2Features(out)).toBe(false);
    expect((serializeDoc(out) as { version: number }).version).toBe(1);
  });

  it("backgroundSource is a v2 feature, round-trips through serializeDoc, and is stripped from the public doc", () => {
    const { doc } = build({ format: "A5_PORTRAIT", designStyle: "classic" });
    const marked: BookDoc = { ...doc, style: { ...doc.style, backgroundSource: "ai" } };
    expect(usesV2Features(marked)).toBe(true);
    const stored = serializeDoc(marked) as BookDoc;
    expect(stored.version).toBe(2);
    expect(stored.style.backgroundSource).toBe("ai");
    const parsed = parseBookDoc(stored);
    expect(parsed.ok && parsed.doc.style.backgroundSource).toBe("ai");
    expect(parseBookDoc({ ...stored, style: { ...stored.style, backgroundSource: "robot" } }).ok).toBe(false);

    for (const design of AI_DESIGNS) {
      const { doc: d, photos } = build(design);
      const pub = toPublicDoc(applyBackgroundSuggestions(d, photos));
      expect(JSON.stringify(pub)).not.toContain("backgroundSource");
      expect(JSON.stringify(pub)).not.toContain('"source"');
    }
  });
});
