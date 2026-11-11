// M10b A5b — A5 LANDSCAPE layouts (classic + modern): geometry rules on a 210×148 mm page, text
// safe zone + fold distance, full-bleed edges (book/bleed.ts), spread twins vs repairSpreads.

import { describe, expect, it } from "vitest";
import { EDGE_EPS_PCT } from "@/lib/book/bleed";
import { pageMm } from "@/lib/book/format";
import { LayoutSchema, validateBookDoc } from "@/lib/book/schema";
import { layoutsFor, rectHalf, repairSpreads, toPageRect } from "@/lib/book/spreads";
import type { BookDoc, BookPage, DesignStyle, Layout, Rect } from "@/lib/book/types";
import { BLEED_MM, getLayout, SAFE_MM } from "@/lib/layouts";
import { CLASSIC_LANDSCAPE_LAYOUTS } from "@/lib/layouts/classic/landscape";
import { MODERN_LANDSCAPE_LAYOUTS } from "@/lib/layouts/modern/landscape";

const PAGE = pageMm("A5_LANDSCAPE"); // 210 × 148
/** Text keeps this far from the fold (and, on single pages, from both side edges — either can be the fold). */
const FOLD_MM = 8;
const ALL: readonly Layout[] = [...CLASSIC_LANDSCAPE_LAYOUTS, ...MODERN_LANDSCAPE_LAYOUTS];

const xMm = (pct: number) => (pct / 100) * PAGE.w;
const yMm = (pct: number) => (pct / 100) * PAGE.h;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - 1e-9 &&
  inner.y >= outer.y - 1e-9 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-9 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-9;
const textRects = (l: Layout): Rect[] => [...(l.caption ? [l.caption] : []), ...(l.texts ?? []).map((t) => t.box)];
const maxX = (l: Layout) => (l.role === "spread" ? 200 : 100);

describe("landscape catalogue", () => {
  it("every layout is A5 landscape, style matches its id prefix, ids unique and registered", () => {
    expect(new Set(ALL.map((l) => l.id)).size).toBe(ALL.length);
    for (const l of CLASSIC_LANDSCAPE_LAYOUTS) {
      expect(l.id.startsWith("c-l-")).toBe(true);
      expect(l.style).toBe("classic");
    }
    for (const l of MODERN_LANDSCAPE_LAYOUTS) {
      expect(l.id.startsWith("m-l-")).toBe(true);
      expect(l.style).toBe("modern");
    }
    for (const l of ALL) {
      expect(l.format).toBe("A5_LANDSCAPE");
      expect(getLayout(l.id)).toBe(l);
    }
  });

  it.each([
    ["classic", "page"],
    ["classic", "cover"],
    ["modern", "page"],
    ["modern", "cover"],
    ["modern", "spread"],
  ] as const)("layoutsFor(A5_LANDSCAPE, %s, %s) is not empty", (style, role) => {
    expect(layoutsFor("A5_LANDSCAPE", style, role).length).toBeGreaterThan(0);
  });

  it.each([
    ["classic", [1, 2, 3, 4]],
    ["modern", [1, 2, 3, 4, 5, 6]],
  ] as const)("%s has a page layout for every photo count it promises", (style, counts) => {
    const have = new Set(layoutsFor("A5_LANDSCAPE", style as DesignStyle, "page").map((l) => l.photoCount));
    for (const n of counts) expect(have.has(n)).toBe(true);
  });

  it("classic has the 6 page counterparts + a cover; modern ~8 pages, 3 spreads, 2 covers", () => {
    expect(layoutsFor("A5_LANDSCAPE", "classic", "page")).toHaveLength(6);
    expect(layoutsFor("A5_LANDSCAPE", "classic", "cover")).toHaveLength(1);
    expect(layoutsFor("A5_LANDSCAPE", "classic", "spread")).toHaveLength(0);
    expect(layoutsFor("A5_LANDSCAPE", "modern", "page").length).toBeGreaterThanOrEqual(8);
    expect(layoutsFor("A5_LANDSCAPE", "modern", "spread")).toHaveLength(3);
    expect(layoutsFor("A5_LANDSCAPE", "modern", "cover")).toHaveLength(2);
  });

  it("the modern text panel binds chapter title + date and has a caption area", () => {
    const panels = layoutsFor("A5_LANDSCAPE", "modern", "page").filter((l) => (l.texts ?? []).length > 0);
    expect(panels.length).toBeGreaterThan(0);
    for (const l of panels) {
      expect(l.caption).not.toBeNull();
      expect(l.texts!.map((t) => t.bind).sort()).toEqual(["chapterTitle", "dateLabel"]);
    }
  });

  it("m-l-two-land: two ≈3:2 landscape photos side by side, centred in m-l-two's photo area, same caption band", () => {
    const l = getLayout("m-l-two-land")!;
    const two = getLayout("m-l-two")!;
    expect([l.role, l.style, l.format, l.photoCount]).toEqual(["page", "modern", "A5_LANDSCAPE", 2]);
    expect(l.prefers).toEqual(["landscape", "landscape"]);
    // appended last: the catalogue order is append-only (AI catalogue / prompt cache)
    expect(MODERN_LANDSCAPE_LAYOUTS.at(-1)).toBe(l);
    const [a, b] = l.slots;
    for (const s of l.slots) {
      const ratio = xMm(s.w) / yMm(s.h);
      expect(ratio).toBeGreaterThanOrEqual(1.4);
      expect(ratio).toBeLessThanOrEqual(1.6);
    }
    expect(a.y).toBeCloseTo(b.y, 6); // side by side, same row
    expect(a.h).toBeCloseTo(b.h, 6);
    expect(xMm(b.x - (a.x + a.w))).toBeCloseTo(2.5, 1); // 2.5 mm gutter
    expect(xMm(a.x)).toBeCloseTo(6, 1); // 6 mm outer margins
    expect(PAGE.w - xMm(b.x + b.w)).toBeCloseTo(6, 1);
    // vertically centred in m-l-two's photo area
    const area = two.slots[0];
    expect(a.y - area.y).toBeCloseTo(area.y + area.h - (a.y + a.h), 2);
    expect(l.caption).toEqual(two.caption);
    expect(l.caption!.y).toBeGreaterThan(a.y + a.h);
  });

  it("modern covers place coverTitle + coverSubtitle inside the cover's title block", () => {
    for (const l of layoutsFor("A5_LANDSCAPE", "modern", "cover")) {
      expect(l.texts!.map((t) => t.bind)).toEqual(["coverTitle", "coverSubtitle"]);
      expect(l.texts![0].font).toBe("title");
      for (const t of l.texts!) expect(contains(l.caption!, t.box)).toBe(true);
    }
    expect(getLayout("m-l-cover-strip")!.texts![1].font).toBe("year");
  });
});

describe.each(ALL.map((l) => [l.id, l] as const))("%s", (_id, l) => {
  it("matches LayoutSchema, ≤ 12 slots, photoCount = slots = prefers", () => {
    expect(LayoutSchema.safeParse(l).success).toBe(true);
    expect(l.slots.length).toBeLessThanOrEqual(12);
    expect(l.slots.length).toBe(l.photoCount);
    expect(l.prefers.length).toBe(l.photoCount);
  });

  it("rects lie inside the page (spreads 0..200 × 0..100)", () => {
    for (const r of [...l.slots, ...textRects(l)]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(maxX(l) + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it("slots don't overlap each other; text doesn't overlap slots", () => {
    for (let i = 0; i < l.slots.length; i++)
      for (let j = i + 1; j < l.slots.length; j++) expect(overlaps(l.slots[i], l.slots[j])).toBe(false);
    for (const t of textRects(l)) for (const s of l.slots) expect(overlaps(t, s)).toBe(false);
  });

  it("page texts don't overlap each other or the caption (cover texts sit inside the title block)", () => {
    const texts = (l.texts ?? []).map((t) => t.box);
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++) expect(overlaps(texts[i], texts[j])).toBe(false);
    if (l.role !== "cover" && l.caption) for (const t of texts) expect(overlaps(t, l.caption)).toBe(false);
  });

  it(`text is ≥ ${SAFE_MM} mm inside the trim and ≥ ${FOLD_MM} mm from the fold, never crossing it`, () => {
    for (const r of textRects(l)) {
      expect(yMm(r.y)).toBeGreaterThanOrEqual(SAFE_MM);
      expect(PAGE.h - yMm(r.y + r.h)).toBeGreaterThanOrEqual(SAFE_MM);
      if (l.role === "spread") {
        const left = r.x + r.w <= 100;
        const right = r.x >= 100;
        expect(left || right).toBe(true); // never crosses the fold
        const [a, b] = left ? [r.x, r.x + r.w] : [r.x - 100, r.x + r.w - 100];
        // outer edge: safe zone; fold edge: fold distance
        expect(xMm(left ? a : 100 - b)).toBeGreaterThanOrEqual(SAFE_MM);
        expect(xMm(left ? 100 - b : a)).toBeGreaterThanOrEqual(FOLD_MM);
      } else {
        expect(xMm(r.x)).toBeGreaterThanOrEqual(FOLD_MM);
        expect(PAGE.w - xMm(r.x + r.w)).toBeGreaterThanOrEqual(FOLD_MM);
      }
    }
  });

  it(`photo edges touch a trim edge (→ bleed) or stay ≥ ${BLEED_MM} mm inside; only an edge-to-edge photo crosses the fold`, () => {
    // Page edges in % x: 0 and 100; a spread is two trim pages, so the fold (100) is an edge too.
    const xEdges = l.role === "spread" ? [0, 100, 200] : [0, 100];
    const okX = (v: number) => xEdges.every((e) => Math.abs(v - e) <= EDGE_EPS_PCT || xMm(Math.abs(v - e)) >= BLEED_MM);
    const okY = (v: number) => [0, 100].every((e) => Math.abs(v - e) <= EDGE_EPS_PCT || yMm(Math.abs(v - e)) >= BLEED_MM);
    for (const s of l.slots) {
      expect(okX(s.x)).toBe(true);
      expect(okX(s.x + s.w)).toBe(true);
      expect(okY(s.y)).toBe(true);
      expect(okY(s.y + s.h)).toBe(true);
      if (l.role === "spread" && s.x < 100 && s.x + s.w > 100) {
        expect(s.x).toBe(0);
        expect(s.x + s.w).toBe(200);
      }
    }
  });

  it("slot shape agrees with its orientation preference on a 210×148 mm page", () => {
    l.slots.forEach((s, i) => {
      const ratio = xMm(s.w) / yMm(s.h);
      if (l.prefers[i] === "portrait") expect(ratio).toBeLessThan(1);
      if (l.prefers[i] === "landscape") expect(ratio).toBeGreaterThan(1);
    });
  });
});

// --- spreads vs their twins (D-064, repairSpreads' rectHalf rule) ---------------------------------

const SPREADS = ALL.filter((l) => l.role === "spread");

describe.each(SPREADS.map((l) => [l.id, l] as const))("spread %s", (_id, l) => {
  const twins = l.twin!.map((id) => getLayout(id)!);
  const halves = ([0, 1] as const).map((h) => l.slots.filter((s) => (rectHalf(s) === "left" ? 0 : 1) === h));

  it("twins are single pages of the same format + style", () => {
    for (const t of twins) {
      expect(t).toBeDefined();
      expect(t.role).toBe("page");
      expect(t.format).toBe(l.format);
      expect(t.style).toBe(l.style);
    }
  });

  it("each twin holds its half's photos (slot centre x < 100 → left), and the caption's half has a caption area", () => {
    expect(halves[0].length).toBeLessThanOrEqual(twins[0].photoCount);
    expect(halves[1].length).toBeLessThanOrEqual(twins[1].photoCount);
    // left-half slots come first, so slot order survives the split
    const firstRight = l.slots.findIndex((s) => rectHalf(s) === "right");
    if (firstRight >= 0) expect(l.slots.slice(firstRight).every((s) => rectHalf(s) === "right")).toBe(true);
    if (l.caption) expect(twins[rectHalf(l.caption) === "left" ? 0 : 1].caption).not.toBeNull();
  });

  it("a half with exactly its twin's slot count has the twin's geometry (a split looks the same)", () => {
    const crossesFold = (s: Rect) => s.x < 100 && s.x + s.w > 100; // the panorama: geometry can't match
    ([0, 1] as const).forEach((h) => {
      if (halves[h].length !== twins[h].photoCount || halves[h].some(crossesFold)) return;
      halves[h].map(toPageRect).forEach((r, i) => {
        const t = twins[h].slots[i];
        for (const k of ["x", "y", "w", "h"] as const) expect(r[k]).toBeCloseTo(t[k], 6);
      });
      if (l.caption && rectHalf(l.caption) === (h === 0 ? "left" : "right")) {
        const c = toPageRect(l.caption);
        for (const k of ["x", "y", "w", "h"] as const) expect(c[k]).toBeCloseTo(twins[h].caption![k], 6);
      }
    });
  });

  it("misaligned → repairSpreads splits into the twins, keeping every photo, crop and the caption", () => {
    const photos = l.slots.map((_, i) => `ph${i}`);
    const left: BookPage = {
      id: "sp",
      chapterId: "m1",
      layout: l.id,
      side: "left",
      slots: photos.map((p, i) => ({ photoId: p, crop: { x: 0.5, y: 0.5, zoom: 1 + i / 10 } })),
      caption: l.caption ? { text: "cap", font: "Cormorant", align: "center", source: "user" } : null,
    };
    const right: BookPage = { id: "spr", chapterId: "m1", layout: l.id, side: "right", slots: [], caption: null };
    const before = single("m-l-one", "ph-first");
    const doc = docOf([before, left, right, single("m-l-one", "ph-last")]); // spread on an odd index

    const r = repairSpreads(doc);
    expect(r.splitCount).toBe(1);
    expect(r.doc.pages).toHaveLength(4); // page count unchanged
    const [, a, b] = r.doc.pages;
    expect([a.layout, b.layout]).toEqual(l.twin);
    expect(a.side).toBeUndefined();
    expect(b.side).toBeUndefined();
    const placed = [...a.slots, ...b.slots].filter((s) => s.photoId !== null);
    expect(placed.map((s) => s.photoId)).toEqual(photos);
    expect(placed.map((s) => s.crop.zoom)).toEqual(photos.map((_, i) => 1 + i / 10));
    if (l.caption) expect([a.caption, b.caption].filter(Boolean)).toHaveLength(1);
    expect(validateBookDoc(r.doc, { photoIds: new Set([...photos, "ph-first", "ph-last"]), maxPages: 100 })).toEqual([]);
  });
});

function single(layoutId: string, photoId: string): BookPage {
  const l = getLayout(layoutId)!;
  return {
    id: `pg-${photoId}`,
    chapterId: "m1",
    layout: l.id,
    slots: l.slots.map((_, i) => ({ photoId: i === 0 ? photoId : null, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
    caption: null,
  };
}

function docOf(pages: BookPage[]): BookDoc {
  return {
    version: 2,
    format: "A5_LANDSCAPE",
    occasion: "other",
    cover: { layout: "m-l-cover-strip", photoId: null, title: "T", subtitle: "2026" },
    chapters: [{ id: "m1", title: "Moment", dateLabel: "", place: null }],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "modern", font: "Cormorant" },
  };
}
