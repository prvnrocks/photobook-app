// mm → layout-unit helpers of the editorial A5 PORTRAIT layouts (M30 T6). Pure, types only: the
// layouts stay plain data, these turn a design drawn in page millimetres (148 × 210, y down) into
// the catalogue's % rects, slot-relative polygon points and hairline blocks. Spread pages use
// x 0..296 mm (fold at 148).

import type { LayoutBlock, LayoutSlotDef, Rect } from "@/lib/book/types";

export const W = 148;
export const H = 210;

/** A point in page mm [x, y], y down. */
export type Pt = readonly [number, number];

/** Hairline weight (mm) of the style: rules, outlines and the diagonal echo lines. */
export const HAIR_MM = 0.35;

const round = (n: number) => Math.round(n * 10000) / 10000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const px = (mm: number) => round((mm / W) * 100);
const py = (mm: number) => round((mm / H) * 100);

/** Rect from its edges in mm. Edges on the trim stay exact 0 / 100 / 200. */
export function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = px(x0);
  const y = py(y0);
  return { x, y, w: round(px(x1) - x), h: round(py(y1) - y) };
}

/** Polygon slot from page-mm points: bounding box + shape points (% of the box). */
export function poly(points: readonly Pt[]): LayoutSlotDef {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  const rel = points.map(
    (p) => [round3(((p[0] - x0) / (x1 - x0)) * 100), round3(((p[1] - y0) / (y1 - y0)) * 100)] as [number, number],
  );
  return { ...rect(x0, y0, x1, y1), shape: { kind: "polygon", points: rel } };
}

type Fill = LayoutBlock["fill"];
interface RuleOpts {
  fill?: Fill;
  layer?: LayoutBlock["layer"];
  when?: LayoutBlock["when"];
  mm?: number;
}

/** Horizontal rule from x0 to x1 (mm), its top edge at y. */
export function hRule(x0: number, x1: number, y: number, o: RuleOpts = {}): LayoutBlock {
  return {
    box: rect(x0, y, x1, y + (o.mm ?? HAIR_MM)),
    fill: o.fill ?? "ink",
    layer: o.layer ?? "under",
    ...(o.when ? { when: o.when } : {}),
  };
}

/** Vertical rule from y0 to y1 (mm), its left edge at x. */
export function vRule(x: number, y0: number, y1: number, o: RuleOpts = {}): LayoutBlock {
  return {
    box: rect(x, y0, x + (o.mm ?? HAIR_MM), y1),
    fill: o.fill ?? "ink",
    layer: o.layer ?? "under",
    ...(o.when ? { when: o.when } : {}),
  };
}

/**
 * Diagonal hairline from a to b (mm, a left of b), `mm` thick measured across the line. The box is
 * ~1 % of the page taller than the line at both ends (clamped to the page): where an end sits on
 * the trim the print bleed carries the line on along its own slope, and a block only paints inside
 * its box.
 */
export function diagRule(a: Pt, b: Pt, o: RuleOpts = {}): LayoutBlock {
  const slope = (b[1] - a[1]) / (b[0] - a[0]);
  const half = ((o.mm ?? HAIR_MM) * Math.sqrt(1 + slope * slope)) / 2;
  const slack = H / 100;
  const y0 = Math.max(0, Math.min(a[1], b[1]) - half - slack);
  const y1 = Math.min(H, Math.max(a[1], b[1]) + half + slack);
  const ry = (y: number) => round3(((y - y0) / (y1 - y0)) * 100);
  return {
    box: rect(a[0], y0, b[0], y1),
    fill: o.fill ?? "ink",
    layer: o.layer ?? "under",
    points: [
      [0, ry(a[1] - half)],
      [100, ry(b[1] - half)],
      [100, ry(b[1] + half)],
      [0, ry(a[1] + half)],
    ],
    ...(o.when ? { when: o.when } : {}),
  };
}
