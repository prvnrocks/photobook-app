// mm → layout-unit helpers for the magazine A5 PORTRAIT layouts (M30 T4). Pure, types only: the
// layouts are drawn in page millimetres (148 × 210, y down) and stored as % rects. Spread pages run
// on to x = 296 mm (fold at 148 mm = 100 %).

import type { LayoutSlotDef, Rect } from "@/lib/book/types";

export const W = 148;
export const H = 210;
/** Side margin of text and inset photos (either side may be the fold). */
export const M = 10;
/** Gutter between neighbouring photos. */
export const G = 3;

const round = (n: number) => Math.round(n * 10000) / 10000;
const px = (mm: number) => round((mm / W) * 100);
const py = (mm: number) => round((mm / H) * 100);

/** Rect from its edges in mm. Edges on the trim stay exact 0 / 100 / 200. */
export function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = px(x0);
  const y = py(y0);
  return { x, y, w: round(px(x1) - x), h: round(py(y1) - y) };
}

/** The same rect / slot on the right page of a spread. */
export function shift<T extends Rect>(r: T): T {
  return { ...r, x: round(r.x + 100) };
}

/** Circle slot of radius r mm (box square in mm). */
export function circle(cx: number, cy: number, r: number): LayoutSlotDef {
  return { ...rect(cx - r, cy - r, cx + r, cy + r), shape: { kind: "circle" } };
}

/** `n` equal cells between a and b (mm) separated by the photo gutter: [start, end] pairs. */
export function cells(a: number, b: number, n: number, gap = G): Array<[number, number]> {
  const size = (b - a - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => [a + i * (size + gap), a + i * (size + gap) + size]);
}
