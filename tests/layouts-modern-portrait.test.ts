// M10b A5a — modern A5 PORTRAIT layouts (src/lib/layouts/modern/portrait): geometry rules (trim,
// safe zone, fold, gutters, bleed, aspect), text panel bindings, spread twins (D-064 repair) and
// validateBookDoc over a doc that uses every layout.

import { describe, expect, it } from "vitest";
import { bleedRect, printSlotSizeMm } from "@/lib/book/bleed";
import { LayoutSchema, validateBookDoc } from "@/lib/book/schema";
import { layoutsFor, rectHalf, repairSpreads, toPageRect } from "@/lib/book/spreads";
import type { BookDoc, BookPage, Caption, Layout, Rect } from "@/lib/book/types";
import { getLayout, LAYOUTS, SAFE_MM } from "@/lib/layouts";
import { MODERN_PORTRAIT_LAYOUTS } from "@/lib/layouts/modern/portrait";
import { GUTTER_MM, PAGE_H_MM, PAGE_W_MM } from "@/lib/layouts/modern/portrait/geometry";

const EPS = 1e-6;
const MM_EPS = 0.01;
const FOLD_MIN_MM = 8;

const all = MODERN_PORTRAIT_LAYOUTS;
const byRole = (role: Layout["role"]) => all.filter((l) => l.role === role);
const areaW = (l: Layout) => (l.role === "spread" ? 200 : 100);

/** % rect → mm (spreads: x across both pages, 0..296). */
const mm = (r: Rect) => ({
  x0: (r.x / 100) * PAGE_W_MM,
  y0: (r.y / 100) * PAGE_H_MM,
  x1: ((r.x + r.w) / 100) * PAGE_W_MM,
  y1: ((r.y + r.h) / 100) * PAGE_H_MM,
});
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
const sameRect = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS;
/** Separation in mm between two non-overlapping rects (0 when touching/overlapping). */
function gapMm(a: Rect, b: Rect): number {
  const A = mm(a);
  const B = mm(b);
  const dx = Math.max(0, B.x0 - A.x1, A.x0 - B.x1);
  const dy = Math.max(0, B.y0 - A.y1, A.y0 - B.y1);
  return Math.max(dx, dy);
}
const ratio = (r: Rect) => (r.w * PAGE_W_MM) / (r.h * PAGE_H_MM);
const textBoxes = (l: Layout) => (l.texts ?? []).map((t) => t.box);

describe("modern portrait catalogue", () => {
  it("has 9 single pages, 3 spreads, 2 covers — all modern A5 portrait, ids m-p-*", () => {
    expect(byRole("page")).toHaveLength(9);
    expect(byRole("spread")).toHaveLength(3);
    expect(byRole("cover")).toHaveLength(2);
    for (const l of all) {
      expect(l.id.startsWith("m-p-")).toBe(true);
      expect(l.style).toBe("modern");
      expect(l.format).toBe("A5_PORTRAIT");
    }
  });

  it("is wired into the catalogue: getLayout + layoutsFor(A5_PORTRAIT, modern, role)", () => {
    for (const l of all) expect(getLayout(l.id)).toBe(l);
    expect(LAYOUTS.filter((l) => l.style === "modern" && l.format === "A5_PORTRAIT")).toEqual([...all]);
    for (const role of ["page", "spread", "cover"] as const) {
      expect(layoutsFor("A5_PORTRAIT", "modern", role)).toEqual(byRole(role));
    }
  });

  it("has at least one single page per photo count 1–6 (autolayout always has a choice)", () => {
    const counts = new Set(byRole("page").map((l) => l.photoCount));
    for (let n = 1; n <= 6; n++) expect(counts.has(n), `count ${n}`).toBe(true);
  });

  it("has a full-bleed single page, text-panel pages, a dense spread grid, a mosaic and a panorama", () => {
    expect(getLayout("m-p-full")!.slots[0]).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    const panels = byRole("page").filter((l) => {
      const binds = (l.texts ?? []).map((t) => t.bind);
      return binds.includes("chapterTitle") && binds.includes("dateLabel") && binds.includes("pageCaption");
    });
    expect(panels.length).toBeGreaterThanOrEqual(1);
    expect(getLayout("m-p-spread-grid")!.photoCount).toBe(12);
    const pano = getLayout("m-p-spread-panorama")!;
    expect(pano.slots).toEqual([{ x: 0, y: 0, w: 200, h: 100 }]);
  });
});

describe.each(all.map((l) => [l.id, l] as const))("%s", (_id, l) => {
  it("matches LayoutSchema; photoCount = slots = prefers, ≤ 12", () => {
    expect(LayoutSchema.safeParse(l).success).toBe(true);
    expect(l.slots).toHaveLength(l.photoCount);
    expect(l.prefers).toHaveLength(l.photoCount);
    expect(l.photoCount).toBeLessThanOrEqual(12);
  });

  it("every rect lies inside its area (pages/covers 0..100, spreads 0..200 × 0..100)", () => {
    const rects = [...l.slots, ...(l.caption ? [l.caption] : []), ...textBoxes(l)];
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(areaW(l) + EPS);
      expect(r.y + r.h).toBeLessThanOrEqual(100 + EPS);
    }
  });

  it("slots do not overlap; caption and text panels do not overlap slots", () => {
    for (let i = 0; i < l.slots.length; i++)
      for (let j = i + 1; j < l.slots.length; j++) expect(overlaps(l.slots[i], l.slots[j]), `slots ${i}/${j}`).toBe(false);
    for (const t of [...(l.caption ? [l.caption] : []), ...textBoxes(l)])
      for (const s of l.slots) expect(overlaps(t, s)).toBe(false);
  });

  it("text panels do not overlap each other (a pageCaption panel IS the caption box)", () => {
    const texts = l.texts ?? [];
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++) expect(overlaps(texts[i].box, texts[j].box)).toBe(false);
    for (const t of texts) {
      if (t.bind === "pageCaption") {
        expect(l.caption).not.toBeNull();
        expect(sameRect(t.box, l.caption!)).toBe(true);
      } else if (l.caption && l.role !== "cover") {
        expect(overlaps(t.box, l.caption)).toBe(false);
      }
    }
    // A caption area always has its typed panel (the renderer styles it from texts[]).
    if (l.caption && l.role !== "cover") expect(texts.some((t) => t.bind === "pageCaption")).toBe(true);
  });

  it("bindings fit the role: covers show title + subtitle, pages/spreads only page data", () => {
    const binds = (l.texts ?? []).map((t) => t.bind);
    if (l.role === "cover") {
      expect(l.texts?.find((t) => t.bind === "coverTitle")?.font).toBe("title");
      expect(l.texts?.find((t) => t.bind === "coverSubtitle")?.font).toBe("year");
      expect(binds.every((b) => b === "coverTitle" || b === "coverSubtitle")).toBe(true);
      // Today's <BookCover> puts title + subtitle into layout.caption: keep it = union of both panels.
      const boxes = textBoxes(l);
      const union = {
        x: Math.min(...boxes.map((b) => b.x)),
        y: Math.min(...boxes.map((b) => b.y)),
        w: Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x)),
        h: Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y)),
      };
      expect(l.caption).not.toBeNull();
      expect(sameRect(l.caption!, union)).toBe(true);
    } else {
      expect(binds.some((b) => b === "coverTitle" || b === "coverSubtitle")).toBe(false);
      for (const t of l.texts ?? []) {
        if (t.bind === "chapterTitle") expect(t.font).toBe("chapter");
        if (t.bind === "pageCaption") expect(t.font).toBe("caption");
      }
    }
  });

  it(`text is ≥ ${SAFE_MM} mm inside the trim and ≥ ${FOLD_MIN_MM} mm from the fold, never across it`, () => {
    const W = (areaW(l) / 100) * PAGE_W_MM;
    for (const r of [...(l.caption ? [l.caption] : []), ...textBoxes(l)]) {
      const b = mm(r);
      for (const gap of [b.x0, b.y0, W - b.x1, PAGE_H_MM - b.y1]) expect(gap).toBeGreaterThanOrEqual(SAFE_MM - MM_EPS);
      if (l.role === "page") {
        // A single page lands left or right: either side edge may be the fold.
        expect(b.x0).toBeGreaterThanOrEqual(FOLD_MIN_MM - MM_EPS);
        expect(PAGE_W_MM - b.x1).toBeGreaterThanOrEqual(FOLD_MIN_MM - MM_EPS);
      }
      if (l.role === "spread") {
        const fold = PAGE_W_MM;
        const clear = b.x1 <= fold - FOLD_MIN_MM + MM_EPS || b.x0 >= fold + FOLD_MIN_MM - MM_EPS;
        expect(clear, `text ${JSON.stringify(r)} vs fold`).toBe(true);
      }
    }
  });

  it(`photos are separated by one consistent ${GUTTER_MM} mm gutter (neighbours closer than 10 mm)`, () => {
    for (let i = 0; i < l.slots.length; i++)
      for (let j = i + 1; j < l.slots.length; j++) {
        const g = gapMm(l.slots[i], l.slots[j]);
        if (g < 10) expect(Math.abs(g - GUTTER_MM), `slots ${i}/${j} gap ${g}`).toBeLessThan(MM_EPS);
      }
  });

  it("slot edges sit on the trim (bleed) or clearly inside it — no slivers", () => {
    const W = (areaW(l) / 100) * PAGE_W_MM;
    for (const s of l.slots) {
      const b = mm(s);
      for (const gap of [b.x0, b.y0, W - b.x1, PAGE_H_MM - b.y1]) {
        expect(gap < MM_EPS || gap >= SAFE_MM, `edge gap ${gap}`).toBe(true);
      }
    }
  });

  it("slot aspect ratios suit their preference (and both orientations for 'any')", () => {
    // Cover strips are slices of ONE cover photo (see the module header) — the union is checked instead.
    if (l.role === "cover" && l.slots.length > 1) {
      const xs = l.slots.map((s) => [s.x, s.x + s.w]).flat();
      const ys = l.slots.map((s) => [s.y, s.y + s.h]).flat();
      const u = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      expect(ratio(u)).toBeGreaterThan(0.75);
      expect(ratio(u)).toBeLessThan(1.35);
      return;
    }
    l.slots.forEach((s, i) => {
      const r = ratio(s);
      const p = l.prefers[i];
      const [min, max] = p === "portrait" ? [0.5, 0.999] : p === "landscape" ? [1.001, 2] : [0.75, 1.35];
      expect(r, `slot ${i} (${p})`).toBeGreaterThanOrEqual(min);
      expect(r, `slot ${i} (${p})`).toBeLessThanOrEqual(max);
    });
  });
});

describe("bleed (book/bleed.ts)", () => {
  it("m-p-full extends 3 mm past every trim edge, like classic full-page", () => {
    expect(printSlotSizeMm("m-p-full", 0)).toEqual(printSlotSizeMm("full-page", 0));
    expect(printSlotSizeMm("m-p-full", 0)).toEqual({ w: 154, h: 216 });
  });

  it.each(byRole("page").concat(byRole("cover")).map((l) => [l.id, l] as const))(
    "%s: edges on the trim are exactly 0/100 so bleedRect extends them",
    (_id, l) => {
      for (const s of l.slots) {
        const b = mm(s);
        const e = bleedRect(s).edges;
        expect(e.left).toBe(b.x0 < MM_EPS);
        expect(e.top).toBe(b.y0 < MM_EPS);
        expect(e.right).toBe(PAGE_W_MM - b.x1 < MM_EPS);
        expect(e.bottom).toBe(PAGE_H_MM - b.y1 < MM_EPS);
        if (e.left) expect(s.x).toBe(0);
        if (e.top) expect(s.y).toBe(0);
      }
    },
  );

  it.each(byRole("spread").map((l) => [l.id, l] as const))(
    "%s: only a full-spread panorama crosses the fold; per-page rects bleed on the outer trim",
    (_id, l) => {
      for (const s of l.slots) {
        const crosses = s.x < 100 - EPS && s.x + s.w > 100 + EPS;
        if (crosses) {
          expect(s).toEqual({ x: 0, y: 0, w: 200, h: 100 });
          continue;
        }
        const page = toPageRect(s);
        const e = bleedRect(page).edges;
        if (rectHalf(s) === "left") expect(e.left).toBe(s.x === 0);
        else expect(e.right).toBe(Math.abs(s.x + s.w - 200) < EPS);
      }
    },
  );
});

// --- Spreads: twins + repair ---------------------------------------------------------------------

const caption = (text: string): Caption => ({ text, font: "Cormorant", align: "left", source: "user" });

function pageOf(l: Layout, id: string, start: number): BookPage {
  return {
    id,
    chapterId: "m1",
    layout: l.id,
    slots: l.slots.map((_, i) => ({ photoId: `ph${start + i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
    caption: l.caption ? caption(`cap ${id}`) : null,
  };
}
function spreadOf(l: Layout, id: string, start: number): [BookPage, BookPage] {
  return [
    { ...pageOf(l, id, start), side: "left" },
    { id: `${id}r`, chapterId: "m1", layout: l.id, side: "right", slots: [], caption: null },
  ];
}
function docOf(pages: BookPage[], coverLayout = "m-p-cover-strips"): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "other",
    cover: { layout: coverLayout, photoId: "ph0", title: "Summer", subtitle: "2026" },
    chapters: [{ id: "m1", title: "Moment", dateLabel: "12 Feb", place: null }],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "modern", font: "Cormorant" },
  };
}
const photoIdsOf = (pages: BookPage[]) => pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => x !== null));

describe.each(byRole("spread").map((l) => [l.id, l] as const))("spread %s", (_id, l) => {
  it("twin = two modern portrait single pages, each holding its half's photos (rectHalf)", () => {
    expect(l.twin).toBeDefined();
    const halves = { left: 0, right: 0 };
    for (const s of l.slots) halves[rectHalf(s)]++;
    l.twin!.forEach((id, h) => {
      const t = getLayout(id)!;
      expect(t.role).toBe("page");
      expect(t.style).toBe("modern");
      expect(t.format).toBe("A5_PORTRAIT");
      expect(t.photoCount).toBeGreaterThanOrEqual(h === 0 ? halves.left : halves.right);
    });
    if (l.caption) expect(getLayout(l.twin![rectHalf(l.caption) === "left" ? 0 : 1])!.caption).not.toBeNull();
  });

  it("slots are ordered left page first (halves contiguous)", () => {
    const sides = l.slots.map((s) => rectHalf(s));
    const firstRight = sides.indexOf("right");
    if (firstRight >= 0) expect(sides.slice(firstRight).every((s) => s === "right")).toBe(true);
  });

  it("a misaligned spread splits into exactly its twins, keeping every photo and the caption", () => {
    const filler = pageOf(getLayout("m-p-full")!, "f1", 100);
    const [left, right] = spreadOf(l, "sp1", 1);
    const doc = docOf([filler, left, right]);
    const r = repairSpreads(doc);
    expect(r.splitCount).toBe(1);
    expect(r.doc.pages.map((p) => p.layout)).toEqual(["m-p-full", ...l.twin!]);
    expect(photoIdsOf(r.doc.pages).sort()).toEqual(photoIdsOf(doc.pages).sort());
    expect(r.doc.pages.filter((p) => p.caption).length).toBe(doc.pages.filter((p) => p.caption).length);
  });
});

describe("validateBookDoc over every modern portrait layout", () => {
  it("an aligned doc using each cover, single page and spread has no issues", () => {
    let n = 1;
    const pages: BookPage[] = [];
    for (const l of byRole("page")) {
      pages.push(pageOf(l, `pg${pages.length}`, n));
      n += l.photoCount;
    }
    if (pages.length % 2 === 1) {
      pages.push(pageOf(getLayout("m-p-full")!, "pad", n));
      n += 1;
    }
    for (const l of byRole("spread")) {
      pages.push(...spreadOf(l, `sp${pages.length}`, n));
      n += l.photoCount;
    }
    const photoIds = new Set(["ph0", ...photoIdsOf(pages)]);
    for (const cover of byRole("cover")) {
      expect(validateBookDoc(docOf(pages, cover.id), { photoIds, maxPages: 100 })).toEqual([]);
    }
  });
});
