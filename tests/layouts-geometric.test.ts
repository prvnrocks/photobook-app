// M10c T5a/T5b — geometric layouts (src/lib/layouts/geometric/{portrait,landscape}): catalogue
// shape, layoutIssues with the real sticker catalogue, REAL shape geometry (polygons / circles in
// mm: photos never touch, one ~3 mm gutter between neighbours, text and decorations clear of every
// photo), text rules (safe zone, fold, bindings, plates), spread twins + D-064 repair, and
// validateBookDoc over a doc that uses every layout of each orientation.

import { describe, expect, it } from "vitest";
import { pageMm } from "@/lib/book/format";
import { layoutIssues, LayoutSchema, validateBookDoc } from "@/lib/book/schema";
import { polygonInPage, shapePoints, type Point } from "@/lib/book/slot-geometry";
import { layoutsFor, rectHalf, repairSpreads } from "@/lib/book/spreads";
import type { BookDoc, BookFormat, BookPage, Caption, Layout, LayoutSlotDef, Rect } from "@/lib/book/types";
import { DECORATION_STICKER_IDS, STICKERS } from "@/lib/design/stickers";
import { getLayout, LAYOUTS, SAFE_MM } from "@/lib/layouts";
import { GEOMETRIC_LANDSCAPE_LAYOUTS } from "@/lib/layouts/geometric/landscape";
import { GEO_GUTTER_MM } from "@/lib/layouts/geometric/geometry";
import { GEOMETRIC_PORTRAIT_LAYOUTS } from "@/lib/layouts/geometric/portrait";

const EPS = 1e-6;
const MM_EPS = 0.01;
const FOLD_MIN_MM = 8;
/** Arc chords (notches, circles drawn as 64-gons) may sit a little inside the 3 mm design gutter. */
const GUTTER_MIN_MM = GEO_GUTTER_MM - 0.3;
const stickerIds = new Set(DECORATION_STICKER_IDS);
const stickerKinds = new Map(Object.values(STICKERS).map((s) => [s.id, s.kind] as const));

type P = { x: number; y: number };

const SETS = [
  { orientation: "portrait", format: "A5_PORTRAIT" as BookFormat, prefix: "g-p-", list: GEOMETRIC_PORTRAIT_LAYOUTS },
  { orientation: "landscape", format: "A5_LANDSCAPE" as BookFormat, prefix: "g-l-", list: GEOMETRIC_LANDSCAPE_LAYOUTS },
] as const;

// --- geometry in mm --------------------------------------------------------------------------------

const areaW = (l: Layout) => (l.role === "spread" ? 200 : 100);
const toMm = (l: Layout, p: Point): P => {
  const page = pageMm(l.format);
  return { x: (p.x / 100) * page.w, y: (p.y / 100) * page.h };
};
const rectPoly = (l: Layout, r: Rect): P[] =>
  [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((p) => toMm(l, p));

/** A slot's visible shape as a polygon in page mm (circle = 64-gon). */
function slotPoly(l: Layout, s: LayoutSlotDef): P[] {
  const kind = s.shape?.kind ?? "rect";
  if (kind === "rect") return rectPoly(l, s);
  if (kind === "circle") {
    const [a, b] = [toMm(l, { x: s.x, y: s.y }), toMm(l, { x: s.x + s.w, y: s.y + s.h })];
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const r = (b.x - a.x) / 2;
    return Array.from({ length: 64 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 32), y: c.y + r * Math.sin((i * Math.PI) / 32) }));
  }
  const pts = shapePoints(s.shape);
  if (!pts) throw new Error(`unexpected shape ${kind}`);
  return polygonInPage(pts, s).map((p) => toMm(l, p));
}

const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function pointInPoly(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function pointSegDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
const edges = (poly: P[]) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as const);
/** Distance between two polygons in mm; 0 when they touch or overlap. */
function polyDist(A: P[], B: P[]): number {
  for (const [a, b] of edges(A)) for (const [c, d] of edges(B)) if (segmentsCross(a, b, c, d)) return 0;
  if (A.some((p) => pointInPoly(p, B)) || B.some((p) => pointInPoly(p, A))) return 0;
  let m = Infinity;
  for (const p of A) for (const [c, d] of edges(B)) m = Math.min(m, pointSegDist(p, c, d));
  for (const p of B) for (const [a, b] of edges(A)) m = Math.min(m, pointSegDist(p, a, b));
  return m;
}

const sameRect = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS;
const shifted = <T extends Rect>(r: T, dx: number): T => ({ ...r, x: Math.round((r.x + dx) * 10000) / 10000 });
const textRects = (l: Layout) => [...(l.caption ? [l.caption] : []), ...(l.texts ?? []).map((t) => t.box)];

// --- catalogue -----------------------------------------------------------------------------------

describe.each(SETS)("geometric $orientation catalogue", ({ format, prefix, list }) => {
  const byRole = (role: Layout["role"]) => list.filter((l) => l.role === role);

  it("has 1 cover, 6 single pages, 1 spread — all geometric, ids g-<o>-*", () => {
    expect(byRole("cover")).toHaveLength(1);
    expect(byRole("page")).toHaveLength(6);
    expect(byRole("spread")).toHaveLength(1);
    for (const l of list) {
      expect(l.id.startsWith(prefix)).toBe(true);
      expect(l.style).toBe("geometric");
      expect(l.format).toBe(format);
    }
  });

  it("is wired into the catalogue: getLayout + layoutsFor(format, geometric, role)", () => {
    for (const l of list) expect(getLayout(l.id)).toBe(l);
    expect(LAYOUTS.filter((l) => l.style === "geometric" && l.format === format)).toEqual([...list]);
    for (const role of ["page", "spread", "cover"] as const) expect(layoutsFor(format, "geometric", role)).toEqual(byRole(role));
  });

  it("single pages cover every photo count 1–5, mostly with a caption area", () => {
    const counts = new Set(byRole("page").map((l) => l.photoCount));
    for (let n = 1; n <= 5; n++) expect(counts.has(n), `count ${n}`).toBe(true);
    expect(byRole("page").filter((l) => l.caption).length).toBeGreaterThanOrEqual(5);
  });

  it("mixes shapes: diagonal polygons, circle, diamonds, hexagons, petals", () => {
    const kinds = new Set<string>(list.flatMap((l) => l.slots.map((s) => s.shape?.kind ?? "rect")));
    for (const k of ["polygon", "circle", "diamond", "hexagon"]) expect(kinds.has(k), k).toBe(true);
  });

  it("a single big photo page carries a geometric accent decoration", () => {
    const accented = byRole("page").filter((l) => l.photoCount === 1 && (l.decorations ?? []).length > 0);
    expect(accented.length).toBeGreaterThanOrEqual(1);
  });

  it("no shadows (PDF size: geometric is flat)", () => {
    for (const l of list) for (const s of l.slots) expect(s.shadow ?? "none").toBe("none");
  });
});

// --- per layout ----------------------------------------------------------------------------------

const ALL = SETS.flatMap((s) => s.list);

describe.each(ALL.map((l) => [l.id, l] as const))("%s", (_id, l) => {
  const page = pageMm(l.format);
  const W = (areaW(l) / 100) * page.w;

  it("matches LayoutSchema and layoutIssues with the real sticker catalogue; counts agree", () => {
    expect(LayoutSchema.safeParse(l).success).toBe(true);
    expect(layoutIssues(l, { stickerIds, stickerKinds })).toEqual([]);
    expect(l.slots).toHaveLength(l.photoCount);
    expect(l.prefers).toHaveLength(l.photoCount);
  });

  it("photo shapes never touch: edge neighbours sit one ~3 mm gutter apart", () => {
    const polys = l.slots.map((s) => slotPoly(l, s));
    for (let i = 0; i < polys.length; i++)
      for (let j = i + 1; j < polys.length; j++) {
        // Spread halves are separate pages: photos may bleed into the fold from both sides.
        if (l.role === "spread" && rectHalf(l.slots[i]) !== rectHalf(l.slots[j])) continue;
        const d = polyDist(polys[i], polys[j]);
        expect(d, `slots ${i}/${j}`).toBeGreaterThanOrEqual(GUTTER_MIN_MM);
        // Shapes sharing an edge use the one gutter (corner-to-corner neighbours are ≥ 3·√2 apart).
        if (d < 4) expect(d, `slots ${i}/${j} gutter`).toBeLessThanOrEqual(GEO_GUTTER_MM + 0.2);
      }
  });

  it("text panels and decorations stay ≥ 3 mm clear of every photo shape", () => {
    const polys = l.slots.map((s) => slotPoly(l, s));
    const boxes = [...textRects(l), ...(l.decorations ?? []).map((d) => d.box)];
    for (const r of boxes) for (const p of polys) expect(polyDist(rectPoly(l, r), p), JSON.stringify(r)).toBeGreaterThanOrEqual(3);
  });

  it("text panels never overlap each other (a pageCaption panel IS the caption box)", () => {
    const texts = l.texts ?? [];
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++) expect(polyDist(rectPoly(l, texts[i].box), rectPoly(l, texts[j].box))).toBeGreaterThan(0);
    for (const t of texts) if (t.bind === "pageCaption") expect(sameRect(t.box, l.caption!)).toBe(true);
    if (l.caption && l.role !== "cover") expect(texts.some((t) => t.bind === "pageCaption")).toBe(true);
  });

  it(`text is ≥ ${SAFE_MM} mm inside the trim, ≥ ${FOLD_MIN_MM} mm from any possible fold`, () => {
    for (const r of textRects(l)) {
      const [a, , c] = rectPoly(l, r);
      for (const gap of [a.x, a.y, W - c.x, page.h - c.y]) expect(gap).toBeGreaterThanOrEqual(SAFE_MM - MM_EPS);
      if (l.role === "page") {
        expect(a.x).toBeGreaterThanOrEqual(FOLD_MIN_MM - MM_EPS);
        expect(page.w - c.x).toBeGreaterThanOrEqual(FOLD_MIN_MM - MM_EPS);
      }
      if (l.role === "spread") expect(c.x <= page.w - FOLD_MIN_MM + MM_EPS || a.x >= page.w + FOLD_MIN_MM - MM_EPS).toBe(true);
    }
  });

  it("bindings + fonts fit the role; plates only on chapter title / date (never pageCaption)", () => {
    const texts = l.texts ?? [];
    if (l.role === "cover") {
      expect(texts.find((t) => t.bind === "coverTitle")?.font).toBe("title");
      expect(texts.find((t) => t.bind === "coverSubtitle")?.font).toBe("year");
      expect(texts.every((t) => t.bind === "coverTitle" || t.bind === "coverSubtitle")).toBe(true);
      const xs = texts.flatMap((t) => [t.box.x, t.box.x + t.box.w]);
      const ys = texts.flatMap((t) => [t.box.y, t.box.y + t.box.h]);
      const union = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      expect(sameRect(l.caption!, union)).toBe(true);
      return;
    }
    for (const t of texts) {
      expect(t.bind === "coverTitle" || t.bind === "coverSubtitle").toBe(false);
      if (t.bind === "chapterTitle") expect(t.font).toBe("chapter");
      if (t.bind === "dateLabel") expect(t.font).toBe("subtitle");
      if (t.bind === "pageCaption") expect(t.font).toBe("caption");
      if (t.plate) expect(["chapterTitle", "dateLabel"]).toContain(t.bind);
    }
  });

  it("slot boxes sit on the trim (bleed, exact 0/100/200) or ≥ 4 mm inside — no slivers", () => {
    for (const s of l.slots) {
      const [a, , c] = rectPoly(l, s);
      for (const gap of [a.x, a.y, W - c.x, page.h - c.y]) expect(gap < MM_EPS || gap >= SAFE_MM, `gap ${gap}`).toBe(true);
      if (a.x < MM_EPS) expect(s.x === 0 || s.x === 100).toBe(true);
      if (a.y < MM_EPS) expect(s.y).toBe(0);
    }
  });

  it("slot aspect ratios suit their preference", () => {
    l.slots.forEach((s, i) => {
      const r = (s.w * page.w) / (s.h * page.h);
      const p = l.prefers[i];
      const [min, max] = p === "portrait" ? [0.5, 0.999] : p === "landscape" ? [1.001, 2] : [0.75, 1.35];
      expect(r, `slot ${i} (${p})`).toBeGreaterThanOrEqual(min);
      expect(r, `slot ${i} (${p})`).toBeLessThanOrEqual(max);
    });
  });
});

// --- spreads: twins + repair ---------------------------------------------------------------------

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
function docOf(format: BookFormat, cover: string, pages: BookPage[]): BookDoc {
  return {
    version: 2,
    format,
    occasion: "travel",
    cover: { layout: cover, photoId: "ph0", title: "Summer", subtitle: "2026" },
    chapters: [{ id: "m1", title: "Moment", dateLabel: "12 Feb", place: null }],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "geometric", font: "Cormorant" },
  };
}
const photoIdsOf = (pages: BookPage[]) => pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => x !== null));

describe.each(ALL.filter((l) => l.role === "spread").map((l) => [l.id, l] as const))("spread %s", (_id, l) => {
  const [left, right] = l.twin!.map((id) => getLayout(id)!);

  it("is exactly its twins side by side: slots, caption, right-page texts and decorations", () => {
    for (const t of [left, right]) {
      expect(t.role).toBe("page");
      expect(t.style).toBe("geometric");
      expect(t.format).toBe(l.format);
    }
    // Same slots, order and shapes as the twins side by side, except the fold-facing edge: the
    // spread pulls it 1.5 mm back from the fold (3 mm gutter, G1); the twins bleed there.
    const twinSlots = [...left.slots, ...right.slots.map((s) => shifted(s, 100))];
    expect(l.slots).toHaveLength(twinSlots.length);
    const page = pageMm(l.format);
    const half = GEO_GUTTER_MM / 2;
    l.slots.forEach((s, i) => {
      const sp = slotPoly(l, s);
      const tw = slotPoly(l, twinSlots[i]);
      expect(sp, `slot ${i}`).toHaveLength(tw.length);
      const onLeft = rectHalf(s) === "left";
      sp.forEach((p, k) => {
        const t = tw[k];
        const atFold = Math.abs(t.x - page.w) < MM_EPS;
        if (!atFold) {
          expect(p.x, `slot ${i} pt ${k} x`).toBeCloseTo(t.x, 2);
          expect(p.y, `slot ${i} pt ${k} y`).toBeCloseTo(t.y, 2);
          return;
        }
        // Fold point → moved 1.5 mm off the fold, staying on the twin's edge line (y may follow the seam).
        expect(p.x, `slot ${i} pt ${k} fold x`).toBeCloseTo(onLeft ? page.w - half : page.w + half, 2);
        expect(Math.abs(p.y - t.y), `slot ${i} pt ${k} fold y`).toBeLessThan(1);
      });
    });
    expect(l.slots.map((s) => rectHalf(s))).toEqual([...left.slots.map(() => "left"), ...right.slots.map(() => "right")]);
    expect(l.caption).toEqual(left.caption);
    for (const t of l.texts ?? []) {
      if (t.bind === "pageCaption") continue;
      const match = (right.texts ?? []).find((r) => r.bind === t.bind);
      expect(match, t.bind).toBeDefined();
      expect(t).toEqual({ ...match!, box: shifted(match!.box, 100) });
    }
    expect(l.decorations ?? []).toEqual([...(left.decorations ?? []), ...(right.decorations ?? []).map((d) => ({ ...d, box: shifted(d.box, 100) }))]);
  });

  it(`keeps the style's ${GEO_GUTTER_MM} mm gutter at the fold: no photo crosses it, ${GEO_GUTTER_MM / 2} mm each side; twins stay full bleed (G1 fix)`, () => {
    const page = pageMm(l.format);
    const half = GEO_GUTTER_MM / 2;
    const polys = l.slots.map((s) => slotPoly(l, s));
    // Every photo stays on its own half, ≥ 1.5 mm clear of the fold line.
    l.slots.forEach((s, i) => {
      const xs = polys[i].map((p) => p.x);
      if (rectHalf(s) === "left") expect(Math.max(...xs), `slot ${i}`).toBeLessThanOrEqual(page.w - half + MM_EPS);
      else expect(Math.min(...xs), `slot ${i}`).toBeGreaterThanOrEqual(page.w + half - MM_EPS);
    });
    // Photos facing each other across the fold sit exactly one gutter apart (not more: the design
    // still reads as one band across the spread).
    const leftPolys = polys.filter((_, i) => rectHalf(l.slots[i]) === "left");
    const rightPolys = polys.filter((_, i) => rectHalf(l.slots[i]) === "right");
    const facing = leftPolys.flatMap((a) => rightPolys.map((b) => polyDist(a, b)));
    expect(Math.min(...facing)).toBeGreaterThanOrEqual(GEO_GUTTER_MM - MM_EPS);
    expect(Math.min(...facing)).toBeLessThanOrEqual(GEO_GUTTER_MM + MM_EPS);
    // The twins stay full bleed on that side (a 1.5 mm strip on a single page's trim would look
    // like a cutting error): left twin reaches its right trim, right twin its left trim.
    const leftTwinMaxX = Math.max(...left.slots.flatMap((s) => slotPoly(left, s).map((p) => p.x)));
    const rightTwinMinX = Math.min(...right.slots.flatMap((s) => slotPoly(right, s).map((p) => p.x)));
    expect(leftTwinMaxX).toBeCloseTo(page.w, 2);
    expect(rightTwinMinX).toBeCloseTo(0, 2);
  });

  it("a misaligned spread splits into exactly its twins, keeping every photo and the caption", () => {
    const pad = getLayout(l.twin![1])!;
    const filler = pageOf(pad, "f1", 100);
    const [a, b] = spreadOf(l, "sp1", 1);
    const cover = ALL.find((c) => c.role === "cover" && c.format === l.format)!.id;
    const doc = docOf(l.format, cover, [filler, a, b]);
    const r = repairSpreads(doc);
    expect(r.splitCount).toBe(1);
    expect(r.doc.pages.map((p) => p.layout)).toEqual([pad.id, ...l.twin!]);
    expect(photoIdsOf(r.doc.pages).sort()).toEqual(photoIdsOf(doc.pages).sort());
    expect(r.doc.pages.filter((p) => p.caption).length).toBe(doc.pages.filter((p) => p.caption).length);
  });
});

describe.each(SETS)("validateBookDoc over every geometric $orientation layout", ({ format, list }) => {
  it("an aligned doc using the cover, every single page and the spread has no issues", () => {
    let n = 1;
    const pages: BookPage[] = [];
    for (const l of list.filter((x) => x.role === "page")) {
      pages.push(pageOf(l, `pg${pages.length}`, n));
      n += l.photoCount;
    }
    for (const l of list.filter((x) => x.role === "spread")) {
      pages.push(...spreadOf(l, `sp${pages.length}`, n));
      n += l.photoCount;
    }
    const cover = list.find((l) => l.role === "cover")!;
    const photoIds = new Set(["ph0", ...photoIdsOf(pages)]);
    expect(validateBookDoc(docOf(format, cover.id, pages), { photoIds, maxPages: 100 })).toEqual([]);
  });
});
