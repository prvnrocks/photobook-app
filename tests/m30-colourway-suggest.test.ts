// M30 T9b — accent colourway suggestion (src/lib/design/colourway-suggest.ts): pure rule from the
// photos' stored colours; stamped by the album builders; a user's choice is never replaced.

import { describe, expect, it } from "vitest";
import { autolayout } from "@/lib/autolayout";
import type { BookDesign } from "@/lib/book/book-design";
import { serializeDoc, usesV2Features } from "@/lib/book/doc-version";
import { relayoutDoc } from "@/lib/book/relayout";
import { buildRuleDraft, type DraftPhotoRow } from "@/lib/book/rule-draft";
import { BOOK_FORMATS, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { stripPhotoFromDoc } from "@/lib/book/strip-photos";
import type { BookDoc } from "@/lib/book/types";
import {
  COVER_WEIGHT,
  suggestColourway,
  userColourwayOf,
  withSuggestedColourway,
  type ColourwayPhoto,
} from "@/lib/design/colourway-suggest";
import { colourwaysFor, defaultColourway } from "@/lib/design/colourways";
import { momentSet } from "./fixtures/autolayout-sets";

// Photo colours as the upload pipeline stores them (muted dominant colours).
const SKY = "#5B8DB8"; // blue
const SEA = "#3E9C96"; // teal
const SAND = "#C9A46B"; // warm yellow-orange
const SUNSET = "#C8683A"; // orange
const ROSE = "#C9606A"; // red / coral
const LEAF = "#5E9A4A"; // green
const GREY = "#8A8A88";
const WHITEISH = "#E9E8E6";

const id = (style: "magazine" | "editorial", colours: (string | null)[], cover?: string | null) =>
  suggestColourway(style, colours, cover)?.id;

describe("suggestColourway", () => {
  it("a clear hue lean picks the colourway with the nearest accent hue", () => {
    expect(id("magazine", [SKY, SKY, SKY, SKY])).toBe("sky");
    expect(id("magazine", [SEA, SEA, SEA, GREY])).toBe("teal");
    expect(id("magazine", [SUNSET, SUNSET, SUNSET])).toBe("sunset");
    expect(id("magazine", [ROSE, ROSE, ROSE])).toBe("coral");
    expect(id("magazine", [SAND, SAND, SAND, SAND])).toBe("gold");
    expect(id("magazine", [LEAF, LEAF, LEAF])).toBe("lime");
    expect(id("editorial", [SKY, SKY, SKY, SKY])).toBe("cobalt");
    expect(id("editorial", [SEA, SEA, SEA])).toBe("teal");
    expect(id("editorial", [ROSE, ROSE, ROSE])).toBe("coral");
    expect(id("editorial", [SAND, SAND, SAND])).toBe("mustard");
    expect(id("editorial", [LEAF, LEAF, LEAF])).toBe("forest");
  });

  it("the result is always a colourway of the style", () => {
    for (const style of ["magazine", "editorial"] as const) {
      const ids = colourwaysFor(style).map((c) => c.id);
      for (const c of [SKY, SEA, SAND, SUNSET, ROSE, LEAF, GREY, WHITEISH, "#FF00FF", "#00FF00", "#123456"]) {
        expect(ids).toContain(id(style, [c, c, c, c]));
      }
    }
  });

  it("grey photos, too few photos, unknown colours or mixed hues → the default colourway", () => {
    for (const style of ["magazine", "editorial"] as const) {
      const def = defaultColourway(style)!.id;
      expect(id(style, [])).toBe(def);
      expect(id(style, [null, null, null])).toBe(def);
      expect(id(style, [GREY, GREY, WHITEISH, GREY], GREY)).toBe(def);
      expect(id(style, [SKY, SKY])).toBe(def); // 2 known colours: too little evidence
      expect(id(style, [SKY, GREY, GREY, GREY, GREY, GREY, GREY])).toBe(def); // mostly grey
      expect(id(style, [SKY, SUNSET, LEAF, ROSE, "#8A4FB0", "#B0A040"])).toBe(def); // no agreement
      expect(id(style, ["not-a-colour", "#12", "#GGGGGG", "", null])).toBe(def);
    }
    expect(defaultColourway("magazine")!.id).toBe("lime");
    expect(defaultColourway("editorial")!.id).toBe("ink");
  });

  it("near-grey photos are ignored for the hue (they only count against a lean)", () => {
    expect(id("magazine", [SKY, SKY, SKY, GREY, GREY])).toBe("sky");
  });

  it(`the cover photo counts ×${COVER_WEIGHT}`, () => {
    expect(COVER_WEIGHT).toBe(3);
    // Two teal photos and a blue cover: the cover pulls the lean to blue …
    expect(id("magazine", [SEA, SEA], SKY)).toBe("sky");
    // … as an ordinary photo it is outvoted.
    expect(id("magazine", [SEA, SEA, SKY])).toBe("teal");
    // Opposite hues (blue cover, orange photos) are no lean at all → default.
    expect(id("magazine", [SUNSET, SUNSET], SKY)).toBe("lime");
    // A cover alone is not enough evidence.
    expect(id("magazine", [], SKY)).toBe("lime");
  });

  it("editorial never picks the neutral 'ink' as a hue match — it is only the no-lean default", () => {
    for (const c of [SKY, SEA, SAND, SUNSET, ROSE, LEAF]) expect(id("editorial", [c, c, c])).not.toBe("ink");
  });

  it("is deterministic and order-independent; the four older styles get none", () => {
    const a = [SKY, SEA, SKY, GREY, SAND, SKY];
    expect(id("magazine", a)).toBe(id("magazine", [...a].reverse()));
    expect(id("magazine", a)).toBe(id("magazine", a));
    for (const style of ["classic", "modern", "geometric", "scrapbook", null, undefined] as const) {
      expect(suggestColourway(style, [SKY, SKY, SKY, SKY], SKY)).toBeNull();
    }
  });
});

// --- stamping --------------------------------------------------------------------------------------

const design = (designStyle: BookDesign["designStyle"], format: BookDesign["format"] = "A5_PORTRAIT"): BookDesign => ({ format, designStyle });

function ruleDoc(d: BookDesign, n = 12): { doc: BookDoc; photos: ColourwayPhoto[] } {
  const set = momentSet(n, 300 + n);
  const doc = autolayout(set, { occasion: "travel", title: null, captionLang: "en", isPaid: false, design: d });
  return { doc, photos: set.map((p) => ({ id: p.id, status: p.status, color: SKY })) };
}

describe("withSuggestedColourway (build writers)", () => {
  it("magazine / editorial: sets { id, source: 'ai' } when absent; the doc stays valid and round-trips", () => {
    for (const style of ["magazine", "editorial"] as const) {
      for (const format of BOOK_FORMATS) {
        const { doc, photos } = ruleDoc(design(style, format));
        expect(doc.style.colourway).toBeUndefined(); // autolayout itself never stamps
        const out = withSuggestedColourway(doc, photos);
        expect(out.style.colourway).toEqual({ id: style === "magazine" ? "sky" : "cobalt", source: "ai" });
        expect(validateBookDoc(out, { photoIds: new Set(photos.map((p) => p.id)), maxPages: 20 })).toEqual([]);
        const back = parseBookDoc(JSON.parse(JSON.stringify(serializeDoc(out))));
        expect(back.ok && back.doc.style.colourway).toEqual(out.style.colourway);
        // Everything else untouched; the input is not mutated.
        expect({ ...out, style: { ...out.style, colourway: undefined } }).toEqual({ ...doc, style: { ...doc.style, colourway: undefined } });
      }
    }
  });

  it("no colour data → the style's default, still stamped as 'ai'", () => {
    const { doc, photos } = ruleDoc(design("magazine"));
    const out = withSuggestedColourway(doc, photos.map((p) => ({ ...p, color: null })));
    expect(out.style.colourway).toEqual({ id: "lime", source: "ai" });
    expect(withSuggestedColourway(doc, []).style.colourway).toEqual({ id: "lime", source: "ai" });
  });

  it("an 'ai' colourway is re-suggested; a 'user' colourway is never replaced", () => {
    const { doc, photos } = ruleDoc(design("editorial"));
    const ai: BookDoc = { ...doc, style: { ...doc.style, colourway: { id: "mustard", source: "ai" } } };
    expect(withSuggestedColourway(ai, photos).style.colourway).toEqual({ id: "cobalt", source: "ai" });
    const user: BookDoc = { ...doc, style: { ...doc.style, colourway: { id: "mustard", source: "user" } } };
    expect(withSuggestedColourway(user, photos)).toBe(user);
    // Same suggestion again → the same object (nothing to write).
    const once = withSuggestedColourway(doc, photos);
    expect(withSuggestedColourway(once, photos)).toBe(once);
  });

  it("only kept photos vote; the doc's cover photo is the weighted one", () => {
    const { doc, photos } = ruleDoc(design("magazine"));
    const coverId = doc.cover.photoId!;
    const kept = photos.filter((p) => p.status === "kept");
    // Dropped photos are all orange, kept ones blue → blue.
    const mixed = photos.map((p) => ({ ...p, color: p.status === "kept" ? SKY : SUNSET }));
    expect(withSuggestedColourway(doc, mixed).style.colourway?.id).toBe("sky");
    // Cover blue + two teal photos, nothing else known → the cover's blue wins; with another
    // photo as the blue one, teal does.
    const others = kept.filter((p) => p.id !== coverId).slice(0, 3).map((p) => p.id);
    const coverBlue = photos.map((p) => ({ ...p, color: p.id === coverId ? SKY : others.slice(0, 2).includes(p.id) ? SEA : null }));
    expect(withSuggestedColourway(doc, coverBlue).style.colourway?.id).toBe("sky");
    const otherBlue = photos.map((p) => ({ ...p, color: p.id === others[2] ? SKY : others.slice(0, 2).includes(p.id) ? SEA : null }));
    expect(withSuggestedColourway(doc, otherBlue).style.colourway?.id).toBe("teal");
  });

  it("rebuild: the user colourway of the doc being replaced is carried over (valid ids of the same style only)", () => {
    const { doc, photos } = ruleDoc(design("magazine"));
    const previous = { style: { colourway: { id: "coral", source: "user" } } };
    expect(withSuggestedColourway(doc, photos, previous).style.colourway).toEqual({ id: "coral", source: "user" });
    for (const prev of [
      { style: { colourway: { id: "coral", source: "ai" } } }, // not the user's
      { style: { colourway: { id: "cobalt", source: "user" } } }, // an editorial id
      { style: { colourway: { id: "nope", source: "user" } } },
      { style: { colourway: "coral" } },
      { style: null },
      {},
      null,
      "x",
      undefined,
    ]) {
      expect(withSuggestedColourway(doc, photos, prev).style.colourway).toEqual({ id: "sky", source: "ai" });
    }
    expect(userColourwayOf(previous, "magazine")).toEqual({ id: "coral", source: "user" });
    expect(userColourwayOf(previous, "classic")).toBeNull();
    expect(userColourwayOf({ style: { colourway: { id: "teal", source: "user" } } }, "editorial")).toEqual({ id: "teal", source: "user" });
  });

  it("the four older styles never get a colourway (classic portrait stays v1)", () => {
    for (const style of ["classic", "modern", "geometric", "scrapbook"] as const) {
      for (const format of BOOK_FORMATS) {
        const { doc, photos } = ruleDoc(design(style, format));
        const out = withSuggestedColourway(doc, photos, { style: { colourway: { id: "coral", source: "user" } } });
        expect(out).toBe(doc);
        expect(out.style.colourway).toBeUndefined();
      }
    }
    const { doc, photos } = ruleDoc(design("classic"));
    expect(usesV2Features(withSuggestedColourway(doc, photos))).toBe(usesV2Features(doc));
  });
});

describe("rule build writer + later paths", () => {
  const rows = (n: number, color: string | null): DraftPhotoRow[] =>
    momentSet(n, 500 + n).map((p, i) => ({
      // uuid ids: scrapbook's faded-photo backgrounds need them (schema).
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      width: p.width,
      height: p.height,
      taken_at: p.takenAt,
      date_source: p.dateSource,
      place: p.place,
      blur_score: p.blurScore,
      status: p.status,
      dup_group: p.dupGroup,
      color,
    }));

  it("buildRuleDraft stamps the colourway for magazine / editorial and nothing for older styles", () => {
    for (const format of BOOK_FORMATS) {
      const input = { occasion: "travel" as const, title: null, captionLang: "en" as const, isPaid: false };
      const mg = buildRuleDraft(rows(14, SEA), { ...input, design: design("magazine", format) });
      expect(mg.ok && mg.doc.style.colourway).toEqual({ id: "teal", source: "ai" });
      const ed = buildRuleDraft(rows(14, null), { ...input, design: design("editorial", format) });
      expect(ed.ok && ed.doc.style.colourway).toEqual({ id: "ink", source: "ai" });
      // White pages are the style: no background suggestion, no backgroundSource.
      if (mg.ok) {
        expect(mg.doc.style.background).toEqual({ kind: "color", hex: "#FFFFFF" });
        expect(mg.doc.style.backgroundSource).toBeUndefined();
        expect(mg.doc.pages.every((p) => p.background === undefined)).toBe(true);
      }
      for (const style of ["classic", "modern", "geometric", "scrapbook"] as const) {
        const r = buildRuleDraft(rows(14, SEA), { ...input, design: design(style, format) });
        expect(r.ok && r.doc.style.colourway).toBeUndefined();
      }
    }
  });

  it("Update album and photo delete keep the colourway — the user's and the AI's", () => {
    for (const style of ["magazine", "editorial"] as const) {
      for (const source of ["user", "ai"] as const) {
        const set = momentSet(20, 77);
        const base = autolayout(set, { occasion: "travel", title: null, captionLang: "en", isPaid: false, design: design(style) });
        const cw = { id: "coral" as const, source };
        const doc: BookDoc = { ...base, style: { ...base.style, colourway: cw } };
        const kept = set.filter((p) => p.status === "kept");
        // Drop two placed photos and add two new ones.
        const placed = doc.pages.flatMap((p) => p.slots.flatMap((s) => (s.photoId ? [s.photoId] : [])));
        const changed = [
          ...set.map((p) => (p.id === placed[1] || p.id === placed[4] ? { ...p, status: "dropped" as const } : p)),
          ...momentSet(2, 9).map((p) => ({ ...p, id: `new-${p.id}`, status: "kept" as const, dupGroup: null })),
        ];
        const r = relayoutDoc(doc, changed, { isPaid: false, maxPages: 20, captionLang: "en" });
        expect(r.changed).toBe(true);
        expect(r.doc.style.colourway).toEqual(cw);
        const s = stripPhotoFromDoc(doc, placed[0], kept);
        expect(s.changed).toBe(true);
        expect(s.doc.style.colourway).toEqual(cw);
      }
    }
  });
});
