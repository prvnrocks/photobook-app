// mm → layout-unit helpers for the magazine A5 LANDSCAPE layouts (M30 T5). Pure, types only: the
// layouts are drawn in page millimetres (210 × 148, y down; spreads x 0..420, fold at 210) and
// stored as the catalogue's % rects.

import type { LayoutBlock, LayoutSlotDef, LayoutText, Rect } from "@/lib/book/types";

export const W = 210;
export const H = 148;

const round = (n: number) => Math.round(n * 10000) / 10000;
const px = (mm: number) => round((mm / W) * 100);
const py = (mm: number) => round((mm / H) * 100);

/** Rect from its edges in mm. Edges on the trim stay exact (0 / 100 / 200). */
export function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = px(x0);
  const y = py(y0);
  return { x, y, w: round(px(x1) - x), h: round(py(y1) - y) };
}

/** Circle slot of radius r mm (box square in mm). */
export function circle(cx: number, cy: number, r: number): LayoutSlotDef {
  return { ...rect(cx - r, cy - r, cx + r, cy + r), shape: { kind: "circle" } };
}

/** A rect / slot / block / text moved onto the right page of a spread (x + 100). */
export function shiftRect<T extends Rect>(r: T): T {
  return { ...r, x: round(r.x + 100) };
}
export const shiftBlock = (b: LayoutBlock): LayoutBlock => ({ ...b, box: shiftRect(b.box) });
export const shiftText = (t: LayoutText): LayoutText => ({ ...t, box: shiftRect(t.box) });
