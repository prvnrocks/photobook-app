// M30 T9b — magazine + editorial through the rule pipeline (no AI): autolayout, fillPages, the fit
// helpers, Update album (D-028), photo-delete refit (D-066), repairSpreads twins, publish snapshot,
// editor save and the print image plan. Frozen output: tests/autolayout-m30-golden.test.ts.
//
// The rule that matters here: a rule album has no chapter descriptions, so it never uses a layout
// with a "chapterDescription" text panel (src/lib/layouts/description.ts — a data query).

import { describe, expect, it } from "vitest";
import { autolayout, fillPages, type AutoPhoto } from "@/lib/autolayout";
import { ruleAlbum } from "@/lib/ai/fallback";
import { bleedRect, printSlotSizeMm, slotBleeds } from "@/lib/book/bleed";
import { SUPPORTED_DESIGN_STYLES, type BookDesign } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import { pageMm } from "@/lib/book/format";
import { relayoutDoc } from "@/lib/book/relayout";
import { coverRenderModel, pageRenderModel } from "@/lib/book/render";
import { effectiveDpi } from "@/lib/book/resolution";
import { BOOK_FORMATS, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { autoCoversFor, isSpreadAligned, layoutsFor, repairSpreads } from "@/lib/book/spreads";
import { stripPhotoFromDoc } from "@/lib/book/strip-photos";
import type { BookDoc, BookPage, Layout } from "@/lib/book/types";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { AI_BACKGROUND_STYLES, applyBackgroundSuggestions, styleDefaultBackground, suggestsBackgrounds } from "@/lib/design/background-suggest";
import { withSuggestedColourway } from "@/lib/design/colourway-suggest";
import { getLayout, M30_LAYOUTS } from "@/lib/layouts";
import { layoutIdShowsDescription, layoutShowsDescription, preferWithoutDescription } from "@/lib/layouts/description";
import { bestCoverLayout, bestPageLayout, fullPageLayout, isShapeAware } from "@/lib/layouts/fit";
import { planPrintImages, PRINT_DPI } from "@/lib/pdf/image-plan";
import { parsePublicDoc, publicDocToRenderDoc, toPublicDoc } from "@/lib/publish/public-doc";
import { momentSet, SET_SIZES } from "./fixtures/autolayout-sets";

const STYLES = ["magazine", "editorial"] as const;
const DESIGNS: readonly BookDesign[] = STYLES.flatMap((designStyle) => BOOK_FORMATS.map((format) => ({ format, designStyle })));
const key = (d: BookDesign) => `${d.designStyle}/${d.format}`;
const OPTS = { occasion: "travel" as const, title: null, captionLang: "en" as const };

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** momentSet with uuid ids (editor save / publish need them). */
function photoSet(n: number, seed: number): AutoPhoto[] {
  const set = momentSet(n, seed);
  const ids = new Map<string, string>();
  return set.map((p) => {
    if (!ids.has(p.id)) ids.set(p.id, uuid(ids.size + 1));
    return { ...p, id: ids.get(p.id) as string };
  });
}

const placedIds = (doc: Pick<BookDoc, "pages">) => doc.pages.flatMap((p) => p.slots.flatMap((s) => (s.photoId ? [s.photoId] : [])));
const descriptionPages = (doc: Pick<BookDoc, "pages">) => doc.pages.filter((p) => layoutIdShowsDescription(p.layout)).map((p) => p.layout);
const issuesOf = (doc: BookDoc, photos: readonly { id: string }[], maxPages = 20) =>
  validateBookDoc(doc, { photoIds: new Set(photos.map((p) => p.id)), maxPages });

describe("description layouts — the data rule", () => {
  it("layoutShowsDescription = a text panel bound to chapterDescription; only M30 page / spread layouts have one", () => {
    const withPanel = M30_LAYOUTS.filter((l) => layoutShowsDescription(l));
    expect(withPanel.length).toBeGreaterThan(10);
    for (const l of withPanel) {
      expect(l.role, l.id).not.toBe("cover");
      expect(l.texts?.some((t) => t.bind === "chapterDescription"), l.id).toBe(true);
      expect(layoutIdShowsDescription(l.id)).toBe(true);
    }
    for (const style of SUPPORTED_DESIGN_STYLES.filter((s) => s !== "magazine" && s !== "editorial")) {
      for (const format of BOOK_FORMATS) {
        for (const role of ["cover", "page", "spread"] as const) {
          expect(layoutsFor(format, style, role).some((l) => layoutShowsDescription(l)), `${style}/${format}/${role}`).toBe(false);
        }
      }
    }
    expect(layoutShowsDescription(null)).toBe(false);
    expect(layoutShowsDescription({})).toBe(false);
    expect(layoutIdShowsDescription("nope")).toBe(false);
    expect(layoutIdShowsDescription(null)).toBe(false);
  });

  it("covers every layout the G0 gate flagged for holes without a description", () => {
    // tester T8 (.agentos/runs/m30.md). The rule is the data query above; this list only proves it catches them.
    for (const id of [
      "mg-p-one-column", "mg-p-three-feature", "mg-p-spread-feature", "mg-p-spread-panorama", "mg-p-two-panel",
      "mg-l-two-panel", "mg-l-three-feature", "ed-p-two-opener", "ed-p-spread-opener", "ed-p-one-column",
      "ed-l-one-wide", "ed-l-two-notes",
    ]) {
      expect(getLayout(id), id).toBeDefined();
      expect(layoutIdShowsDescription(id), id).toBe(true);
    }
  });

  it("every M30 design keeps a layout WITHOUT a description panel for 1–6 photos, incl. one with a caption area for 2–6", () => {
    for (const d of DESIGNS) {
      const plain = layoutsFor(d.format, d.designStyle, "page").filter((l) => !layoutShowsDescription(l));
      for (let n = 1; n <= 6; n++) {
        expect(plain.some((l) => l.photoCount === n), `${key(d)} ${n}`).toBe(true);
        if (n >= 2) expect(plain.some((l) => l.photoCount === n && l.caption !== null), `${key(d)} ${n} caption`).toBe(true);
      }
    }
  });

  it("preferWithoutDescription: the plain ones, or all when none is plain", () => {
    const a = { texts: [{ bind: "chapterDescription" }] } as unknown as Layout;
    const b = { texts: [{ bind: "chapterTitle" }] } as unknown as Layout;
    const c = {} as Layout;
    expect(preferWithoutDescription([a, b, c])).toEqual([b, c]);
    expect(preferWithoutDescription([a])).toEqual([a]);
    expect(preferWithoutDescription([])).toEqual([]);
  });
});

describe.each(DESIGNS)("rule album for $designStyle / $format", (design) => {
  it("catalogue: an auto cover, a one-photo page and a full-page layout, none with a description panel", () => {
    const covers = autoCoversFor(design.format, design.designStyle);
    expect(covers).toHaveLength(1);
    for (const o of ["portrait", "landscape", "square", null] as const) expect(bestCoverLayout(design, o)).toBe(covers[0].id);
    const full = getLayout(fullPageLayout(design))!;
    expect(full.role).toBe("page");
    expect(full.photoCount).toBe(1);
    expect(layoutShowsDescription(full)).toBe(false);
    // Not shape-aware: rule 9 with the layouts' own slot preferences (autolayout rule 11).
    expect(isShapeAware(design)).toBe(false);
  });

  it("seeded sets 1–150 photos: valid, aligned, in style, ≤ maxPages, no description, no description layout, round-trips", () => {
    for (const n of SET_SIZES) {
      for (const isPaid of [false, true]) {
        const photos = photoSet(n, 400 + n);
        const maxPages = isPaid ? 100 : 20;
        const doc = autolayout(photos, { ...OPTS, isPaid, design });
        const at = `${key(design)} n=${n} paid=${isPaid}`;
        expect(issuesOf(doc, photos, maxPages), at).toEqual([]);
        expect(doc.meta?.generator).toBe("rule");
        expect(doc.format).toBe(design.format);
        expect(doc.style.designStyle).toBe(design.designStyle);
        expect(doc.pages.length, at).toBeLessThanOrEqual(maxPages);
        expect(isSpreadAligned(doc), at).toBe(true);
        for (const p of doc.pages) {
          const l = getLayout(p.layout)!;
          expect(l.format === design.format && l.style === design.designStyle, `${at} ${p.layout}`).toBe(true);
        }
        // No AI → no description text and no layout that would show an empty panel.
        expect(doc.chapters.every((c) => c.description === undefined), at).toBe(true);
        expect(descriptionPages(doc), at).toEqual([]);
        // The auto cover (never a user cover style), captions empty, white pages, no colourway from autolayout itself.
        expect(getLayout(doc.cover.layout)?.autoPick, at).toBeUndefined();
        expect(layoutIdShowsDescription(doc.cover.layout)).toBe(false);
        expect(doc.pages.every((p) => p.caption === null)).toBe(true);
        expect(doc.style.background).toEqual({ kind: "color", hex: "#FFFFFF" });
        expect(doc.style.colourway).toBeUndefined();
        // Every kept photo is placed at most once; small books place them all.
        const placed = placedIds(doc);
        expect(new Set(placed).size).toBe(placed.length);
        // serialise → parse gives the same doc (v2).
        const stored = JSON.parse(JSON.stringify(serializeDoc(doc)));
        expect(stored.version).toBe(2);
        const back = parseBookDoc(stored);
        expect(back.ok, at).toBe(true);
        if (back.ok) expect(back.doc).toEqual(doc);
      }
    }
  });

  it("is deterministic; ruleAlbum (AI fallback) and the stamped build validate and round-trip too", () => {
    const photos = photoSet(33, 21);
    const a = autolayout(photos, { ...OPTS, isPaid: false, design });
    expect(autolayout([...photos].reverse(), { ...OPTS, isPaid: false, design })).toEqual(a);
    const run = "11111111-1111-4111-8111-111111111111";
    const fb = ruleAlbum(photos, { ...OPTS, isPaid: false, design }, run);
    expect(fb.meta?.runId).toBe(run);
    expect(descriptionPages(fb)).toEqual([]);
    const suggest = photos.map((p) => ({ id: p.id, status: p.status, color: "#5B8DB8", width: p.width, height: p.height, blurScore: p.blurScore }));
    const built = withSuggestedColourway(applyBackgroundSuggestions(a, suggest), suggest);
    expect(built.style.colourway?.source).toBe("ai");
    expect(built.style.backgroundSource).toBeUndefined(); // no background suggestions for these styles
    expect(built.pages).toEqual(a.pages);
    expect(issuesOf(built, photos)).toEqual([]);
    const back = parseBookDoc(JSON.parse(JSON.stringify(serializeDoc(built))));
    expect(back.ok && back.doc).toEqual(built);
  });

  it("small books: every kept, de-duplicated photo is on a page", () => {
    const photos = photoSet(12, 5).map((p) => ({ ...p, status: "kept" as const, dupGroup: null }));
    const doc = autolayout(photos, { ...OPTS, isPaid: false, design });
    expect(new Set(placedIds(doc))).toEqual(new Set(photos.map((p) => p.id)));
  });

  it("fillPages (Update album additions): single pages of the design, never a description layout", () => {
    for (const n of [1, 2, 3, 5, 9, 14, 25]) {
      const photos = photoSet(n, 800 + n).filter((p) => p.status === "kept");
      for (const opener of [false, true]) {
        const pages = fillPages(photos, { design, opener });
        expect(pages.flatMap((p) => p.photoIds).sort()).toEqual(photos.map((p) => p.id).sort());
        for (const pg of pages) {
          const l = getLayout(pg.layout)!;
          expect(l.role).toBe("page");
          expect(l.style === design.designStyle && l.format === design.format).toBe(true);
          expect(l.photoCount).toBe(pg.photoIds.length);
          expect(layoutShowsDescription(l), pg.layout).toBe(false);
        }
      }
    }
  });

  it("bestPageLayout: no description layout by default; a caption wins over that; 'prefer' / 'any' opt in", () => {
    const O = ["portrait", "landscape", "square"] as const;
    const pages = layoutsFor(design.format, design.designStyle, "page");
    for (let n = 1; n <= 6; n++) {
      for (const o of O) {
        const orients = Array.from({ length: n }, () => o);
        const plain = getLayout(bestPageLayout(orients, { design })!)!;
        expect(plain.photoCount).toBe(n);
        expect(layoutShowsDescription(plain), `${key(design)} ${n}×${o}`).toBe(false);
        // Captionless layouts go through the "layout with a caption area" path when a caption must stay.
        const withCaption = getLayout(bestPageLayout(orients, { design, preferCaption: true })!)!;
        const captionable = pages.filter((l) => l.photoCount === n && l.caption !== null);
        if (captionable.length > 0) expect(withCaption.caption, `${key(design)} ${n}×${o}`).not.toBeNull();
        // … and still without a description panel whenever a captioned plain layout exists.
        if (captionable.some((l) => !layoutShowsDescription(l))) expect(layoutShowsDescription(withCaption)).toBe(false);
        const prefer = getLayout(bestPageLayout(orients, { design, description: "prefer" })!)!;
        const described = pages.filter((l) => l.photoCount === n && layoutShowsDescription(l));
        expect(layoutShowsDescription(prefer)).toBe(described.length > 0);
        expect(getLayout(bestPageLayout(orients, { design, description: "any" })!)!.photoCount).toBe(n);
      }
    }
    expect(bestPageLayout(Array.from({ length: 7 }, () => "square" as const), { design })).toBeNull();
  });

  it("Update album (D-028): dropped + new photos → valid, aligned, no description layout, user caption kept", () => {
    for (const n of [9, 25, 64]) {
      const photos = photoSet(n, 600 + n);
      const base = autolayout(photos, { ...OPTS, isPaid: true, design });
      // A user caption on the first multi-photo page; that page then loses one photo.
      const ci = base.pages.findIndex((p) => p.side === undefined && p.slots.length >= 2 && getLayout(p.layout)?.caption);
      expect(ci, `${key(design)} n=${n}`).toBeGreaterThanOrEqual(0);
      const caption = { text: "Our words", align: "center" as const, font: base.style.font, source: "user" as const };
      const doc: BookDoc = { ...base, pages: base.pages.map((p, i) => (i === ci ? { ...p, caption } : p)) };
      expect(issuesOf(doc, photos, 100)).toEqual([]);
      const others = placedIds({ pages: doc.pages.filter((_, i) => i !== ci) });
      const drop = new Set([doc.pages[ci].slots[0].photoId as string, others[0], others[others.length - 1]]);
      const extra = photoSet(4, 9000 + n).map((p, i) => ({ ...p, id: uuid(5000 + i), status: "kept" as const, dupGroup: null }));
      const next = [...photos.map((p) => (drop.has(p.id) ? { ...p, status: "dropped" as const } : p)), ...extra];
      const r = relayoutDoc(doc, next, { isPaid: true, maxPages: 100, captionLang: "en" });
      expect(r.changed).toBe(true);
      expect(issuesOf(r.doc, next, 100), `${key(design)} n=${n}`).toEqual([]);
      expect(isSpreadAligned(r.doc)).toBe(true);
      // No description layout — except for the captioned page when the design has no plain layout
      // with a caption area for its photo count (the user's words win over an empty panel).
      for (const p of r.doc.pages) {
        const l = getLayout(p.layout)!;
        if (!layoutShowsDescription(l)) continue;
        expect(p.caption?.source, `${key(design)} n=${n} ${p.layout}`).toBe("user");
        const plainWithCaption = layoutsFor(design.format, design.designStyle, "page").filter(
          (x) => x.photoCount === l.photoCount && x.caption !== null && !layoutShowsDescription(x),
        );
        expect(plainWithCaption, `${key(design)} n=${n} ${p.layout}`).toEqual([]);
      }
      for (const id of drop) expect(placedIds(r.doc)).not.toContain(id);
      for (const p of extra) expect(placedIds(r.doc)).toContain(p.id);
      // The user's words stay, on a layout with a caption area (captionless layouts are skipped for that page).
      const kept = r.doc.pages.filter((p) => p.caption?.source === "user" && p.caption.text === "Our words");
      expect(kept, `${key(design)} n=${n}`).toHaveLength(1);
      expect(getLayout(kept[0].layout)?.caption).not.toBeNull();
    }
  });

  it("photo delete (D-066): every placed photo of a small book can go one by one", () => {
    const photos = photoSet(19, 77);
    let doc = autolayout(photos, { ...OPTS, isPaid: false, design });
    let left = photos.filter((p) => p.status === "kept");
    for (const id of placedIds(doc)) {
      left = left.filter((p) => p.id !== id);
      const r = stripPhotoFromDoc(doc, id, left);
      expect(r.changed).toBe(true);
      expect(placedIds(r.doc)).not.toContain(id);
      expect(issuesOf(r.doc, left), `${key(design)} ${id}`).toEqual([]);
      expect(isSpreadAligned(r.doc)).toBe(true);
      expect(descriptionPages(r.doc)).toEqual([]);
      doc = r.doc;
    }
    expect(doc.pages).toEqual([]);
  });
});

// --- spreads: delete refit + repair, one spread layout per style × format -------------------------

const DIMS = { portrait: { width: 3000, height: 4000 }, landscape: { width: 4000, height: 3000 }, any: { width: 3000, height: 3000 } } as const;

/** [full page, full page, spread L, spread R] of `spread`'s design; photos fit the slot preferences. */
function spreadBook(spread: Layout, description: string | null) {
  const design: BookDesign = { format: spread.format, designStyle: spread.style };
  const full = fullPageLayout(design);
  let n = 0;
  const photos: (AutoPhoto & { width: number; height: number })[] = [];
  const add = (pref: "portrait" | "landscape" | "any") => {
    const id = uuid(++n);
    photos.push({ id, ...DIMS[pref], takenAt: null, dateSource: null, place: null, status: "kept", dupGroup: null, blurScore: null });
    return { photoId: id, crop: { x: 0.5, y: 0.5, zoom: 1 } };
  };
  const single = (id: string): BookPage => ({ id, chapterId: "c1", layout: full, slots: [add("any")], caption: null });
  const pages: BookPage[] = [
    single("p1"),
    single("p2"),
    { id: "p3", chapterId: "c1", layout: spread.id, slots: spread.prefers.map((p) => add(p)), caption: null, side: "left" },
    { id: "p4", chapterId: "c1", layout: spread.id, slots: [], caption: null, side: "right" },
  ];
  const base = autolayout(photos, { ...OPTS, isPaid: false, design });
  const doc: BookDoc = {
    ...base,
    cover: { ...base.cover, photoId: null },
    chapters: [{ id: "c1", title: "Day one", dateLabel: "12 Oct 2026", place: null, ...(description ? { description: { text: description, source: "ai" as const } } : {}) }],
    pages,
  };
  delete doc.filters;
  return { doc, photos, design };
}

const SPREADS = DESIGNS.flatMap((d) => layoutsFor(d.format, d.designStyle, "spread"));

describe("M30 spreads: photo delete refit and repairSpreads", () => {
  it("every style × format has ≥ 2 spreads, each with twins of its own design", () => {
    for (const d of DESIGNS) expect(layoutsFor(d.format, d.designStyle, "spread").length, key(d)).toBeGreaterThanOrEqual(2);
    for (const s of SPREADS) {
      expect(s.twin).toHaveLength(2);
      for (const id of s.twin!) {
        const t = getLayout(id)!;
        expect(t.role === "page" && t.format === s.format && t.style === s.style, `${s.id} → ${id}`).toBe(true);
      }
    }
  });

  describe.each(SPREADS.map((s) => ({ id: s.id })))("$id", ({ id }) => {
    const spread = getLayout(id)!;
    for (const description of [null, "A slow morning by the water, then the long road inland."]) {
      const label = description ? "with a description" : "without a description";

      it(`the fixture is a valid aligned book (${label})`, () => {
        const { doc, photos } = spreadBook(spread, description);
        expect(issuesOf(doc, photos)).toEqual([]);
        expect(isSpreadAligned(doc)).toBe(true);
        const back = parseBookDoc(JSON.parse(JSON.stringify(serializeDoc(doc))));
        expect(back.ok && back.doc).toEqual(doc);
      });

      it(`deleting each photo of the spread re-fits it (${label})`, () => {
        const { doc, photos } = spreadBook(spread, description);
        for (const slot of doc.pages[2].slots) {
          const gone = slot.photoId as string;
          const left = photos.filter((p) => p.id !== gone);
          const r = stripPhotoFromDoc(doc, gone, left);
          expect(r.changed).toBe(true);
          expect(issuesOf(r.doc, left), `${id} − ${gone}`).toEqual([]);
          expect(isSpreadAligned(r.doc)).toBe(true);
          // Nothing else is lost; the two pages before stay as they were.
          expect(placedIds(r.doc).sort()).toEqual(placedIds(doc).filter((x) => x !== gone).sort());
          expect(r.doc.pages.slice(0, 2)).toEqual(doc.pages.slice(0, 2));
          expect(r.doc.chapters).toEqual(doc.chapters);
          const shown = descriptionPages(r.doc);
          if (!description) expect(shown, `${id} − ${gone}`).toEqual([]);
          // The description is never shown on more pages than before (the spread showed it at most once).
          else expect(shown.length).toBeLessThanOrEqual(1);
        }
      });

      it(`a page removed before it → repairSpreads splits it into single pages (${label})`, () => {
        const { doc, photos } = spreadBook(spread, description);
        const shifted: BookDoc = { ...doc, pages: doc.pages.slice(1) };
        expect(isSpreadAligned(shifted)).toBe(false);
        const r = repairSpreads(shifted);
        expect(r.splitCount).toBe(1);
        expect(isSpreadAligned(r.doc)).toBe(true);
        const left = photos.filter((p) => p.id !== doc.pages[0].slots[0].photoId);
        expect(issuesOf(r.doc, left), id).toEqual([]);
        expect(placedIds(r.doc).sort()).toEqual(placedIds(shifted).sort());
        expect(r.doc.pages.every((p) => p.side === undefined)).toBe(true);
        for (const p of r.doc.pages) expect(getLayout(p.layout)?.style).toBe(spread.style);
        const split = r.doc.pages.slice(1);
        if (description) {
          // A described chapter keeps the spread's own twins.
          expect(split.map((p) => p.layout)).toEqual(spread.twin);
        } else {
          // No description → no page with an empty description panel; plain twins are kept.
          expect(descriptionPages(r.doc), id).toEqual([]);
          split.forEach((p, i) => {
            if (!layoutIdShowsDescription(spread.twin![i])) expect(p.layout).toBe(spread.twin![i]);
          });
        }
        // Repairing again changes nothing.
        expect(repairSpreads(r.doc).doc).toBe(r.doc);
      });
    }
  });

  it("a rule album with a panorama gets the plain panorama spread where the style has one", () => {
    // Magazine landscape: mg-l-spread-pano has no description panel → used; magazine portrait and
    // editorial landscape only have description spreads → none in a rule album.
    const pano = (i: number): AutoPhoto => ({
      id: uuid(i), width: 6000, height: 2400, takenAt: `2026-10-12T10:0${i}:00+04:00`, dateSource: "exif", place: null, status: "kept", dupGroup: null, blurScore: 5,
    });
    const photos = [1, 2, 3].map(pano);
    for (const d of DESIGNS) {
      const doc = autolayout(photos, { ...OPTS, isPaid: false, design: d });
      expect(issuesOf(doc, photos), key(d)).toEqual([]);
      const spreads = doc.pages.filter((p) => p.side === "left").map((p) => p.layout);
      const plainPano = layoutsFor(d.format, d.designStyle, "spread").filter((l) => l.photoCount === 1 && !layoutShowsDescription(l));
      if (plainPano.length > 0) expect(spreads.length, key(d)).toBeGreaterThan(0);
      else expect(spreads.filter((s) => getLayout(s)?.photoCount === 1)).toEqual([]);
      expect(descriptionPages(doc)).toEqual([]);
    }
  });
});

// --- backgrounds: none for these styles ------------------------------------------------------------

describe("backgrounds", () => {
  it("magazine / editorial take no background suggestions: white pages, doc untouched", () => {
    expect([...AI_BACKGROUND_STYLES]).toEqual(["modern", "geometric", "scrapbook"]);
    for (const d of DESIGNS) {
      expect(suggestsBackgrounds(d.designStyle)).toBe(false);
      expect(styleDefaultBackground(d.designStyle)).toEqual({ kind: "color", hex: "#FFFFFF" });
      const photos = photoSet(14, 3);
      const doc = autolayout(photos, { ...OPTS, isPaid: false, design: d });
      const suggest = photos.map((p) => ({ id: p.id, status: p.status, color: "#5B8DB8", width: p.width, height: p.height, blurScore: 1 }));
      expect(applyBackgroundSuggestions(doc, suggest, { book: "sky", chapters: new Map([["c1", { id: "sky" }]]) })).toBe(doc);
    }
  });
});

// --- publish snapshot, editor save, print ----------------------------------------------------------

describe.each(DESIGNS)("publish / save / print for $designStyle / $format", (design) => {
  const photos = photoSet(25, 42);
  const suggest = photos.map((p) => ({ id: p.id, status: p.status, color: "#C8683A" }));
  const doc = withSuggestedColourway(autolayout(photos, { ...OPTS, isPaid: false, design }), suggest);

  it("public snapshot: parses, keeps design + colourway id (no source), renders back with the same pages", () => {
    const pub = toPublicDoc(doc, { captionLang: "en" });
    const parsed = parsePublicDoc(JSON.parse(JSON.stringify(pub)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.version).toBe(2);
    const style = (parsed.doc as { style: { designStyle?: string; colourway?: unknown } }).style;
    expect(style.designStyle).toBe(design.designStyle);
    expect(style.colourway).toEqual({ id: doc.style.colourway!.id });
    expect(JSON.stringify(pub)).not.toContain('"source":"ai"');
    const render = publicDocToRenderDoc(parsed.doc);
    expect(render.format).toBe(design.format);
    expect(render.pages.map((p) => p.layout)).toEqual(doc.pages.map((p) => p.layout));
    expect(render.style.colourway?.id).toBe(doc.style.colourway!.id);
  });

  it("editor save accepts the rule album (supported design, colourway kept)", () => {
    const stored = JSON.parse(JSON.stringify(serializeDoc(doc)));
    const r = validateEditorDoc(stored, { photoIds: new Set(photos.map((p) => p.id)), maxPages: 20, savedDoc: stored, design });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.style.colourway).toEqual(doc.style.colourway);
  });

  it("print image plan: every slot photo (polygon and circle slots included) is sized for ≥ 300 dpi on its print box", () => {
    const BIG = 9000;
    const plan = planPrintImages(doc, photos.map((p) => ({ id: p.id, width: BIG, height: (BIG * 2) / 3 })), { maxLongEdge: 100_000 });
    const uses: { id: string; layout: Layout; i: number }[] = [];
    for (const p of doc.pages) {
      const l = getLayout(p.layout)!;
      p.slots.forEach((s, i) => s.photoId && uses.push({ id: s.photoId, layout: l, i }));
    }
    uses.push({ id: doc.cover.photoId!, layout: getLayout(doc.cover.layout)!, i: 0 });
    expect(uses.length).toBeGreaterThan(10);
    for (const u of uses) {
      const box = printSlotSizeMm(u.layout, u.i, doc.format)!;
      const t = plan.get(u.id)!;
      expect(t, `${u.layout.id}#${u.i}`).toBeDefined();
      expect(effectiveDpi(t.width, t.height, box.w, box.h)!, `${u.layout.id}#${u.i}`).toBeGreaterThanOrEqual(PRINT_DPI - 0.5);
    }
  });

  it("print render model: slots on a trim edge are bleed-extended (polygons re-clipped), inner slots unchanged", () => {
    const urls = Object.fromEntries(photos.map((p) => [p.id, { url: `https://x.test/${p.id}.jpg`, width: p.width, height: p.height }]));
    expect(coverRenderModel(doc, urls, "en", { bleed: true }).slot).toBeDefined();
    let polygons = 0;
    doc.pages.forEach((page, pi) => {
      if (page.side === "right") return;
      const layout = getLayout(page.layout)!;
      const view = pageRenderModel(doc, pi, urls, "en")!;
      const print = pageRenderModel(doc, pi, urls, "en", { bleed: true })!;
      expect(print.slots).toHaveLength(view.slots.length);
      if (layout.role !== "page") return;
      layout.slots.forEach((s, i) => {
        expect(slotBleeds(s), `${layout.id}#${i}`).toBe(true); // no frames / tilt in M30 layouts
        const b = bleedRect(s, pageMm(doc.format));
        const touches = b.edges.left || b.edges.top || b.edges.right || b.edges.bottom;
        const { x, y, w, h } = view.slots[i].rect;
        expect(print.slots[i].rect, `${layout.id}#${i}`).toMatchObject(touches ? b.pct : { x, y, w, h });
        if (s.shape?.kind === "polygon") {
          polygons++;
          expect(print.slots[i].look?.clipPath).toMatch(/^polygon\(/);
          if (touches) expect(print.slots[i].look?.clipPath).not.toEqual(view.slots[i].look?.clipPath);
          else expect(print.slots[i].look?.clipPath).toEqual(view.slots[i].look?.clipPath);
        }
        if (s.shape?.kind === "circle") expect(touches, `${layout.id}#${i} circle on a trim edge`).toBe(false);
      });
    });
    if (design.designStyle === "editorial") expect(polygons).toBeGreaterThan(0);
  });
});
