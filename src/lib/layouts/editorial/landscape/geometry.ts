// mm → layout-unit helpers of the editorial A5 LANDSCAPE layouts (M30 T7). Pure, types only: the
// layouts stay plain data. Designs are drawn in page mm (210 × 148, y down; spreads run on to
// x = 420, fold at 210) and stored as % rects + polygon points in % of their own box.

import type { LayoutBlock, LayoutSlotDef, LayoutText, Rect, TextBinding } from "@/lib/book/types";

export const W = 210;
export const H = 148;

/** A point in page mm [x, y], y down. */
export type Pt = readonly [number, number];

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const px = (mm: number) => r4((mm / W) * 100);
const py = (mm: number) => r4((mm / H) * 100);

/** Rect from its edges in mm. */
export function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = px(x0);
  const y = py(y0);
  return { x, y, w: r4(px(x1) - x), h: r4(py(y1) - y) };
}

function relative(points: readonly Pt[], x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return points.map((p) => [clamp(r3(((p[0] - x0) / (x1 - x0)) * 100)), clamp(r3(((p[1] - y0) / (y1 - y0)) * 100))]);
}

/** Polygon photo slot from page-mm points: bounding box + points in % of the box. */
export function poly(points: readonly Pt[]): LayoutSlotDef {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return { ...rect(x0, y0, x1, y1), shape: { kind: "polygon", points: relative(points, x0, y0, x1, y1) } };
}

type Fill = LayoutBlock["fill"];
type Layer = LayoutBlock["layer"];

/** Hairline thickness (mm): prints as a clean thin rule, ≥ 0.3 mm. */
export const HAIR = 0.35;
/** Short heavy rule that opens a text block (mm). */
export const RULE = { len: 12, t: 0.6 } as const;
/** Slack around a diagonal line's box, so its ends can run on into the bleed along their own slope. */
const SLACK = 2.4;

/**
 * Diagonal hairline from a to b (mm), `t` mm thick, as a thin polygon block. `maxX` = right end of
 * the area the box may use (a page: 210; the left page of a spread: 210, its right page: 420).
 */
export function hairline(a: Pt, b: Pt, opts: { fill?: Fill; layer?: Layer; t?: number; minX?: number; maxX?: number; when?: TextBinding } = {}): LayoutBlock {
  const { fill = "ink", layer = "under", t = HAIR, minX = 0, maxX = W, when } = opts;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const nx = (-dy / len) * (t / 2);
  const ny = (dx / len) * (t / 2);
  const pts: Pt[] = [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ];
  const x0 = Math.max(minX, Math.min(a[0], b[0]) - SLACK);
  const x1 = Math.min(maxX, Math.max(a[0], b[0]) + SLACK);
  const y0 = Math.max(0, Math.min(a[1], b[1]) - SLACK);
  const y1 = Math.min(H, Math.max(a[1], b[1]) + SLACK);
  return { box: rect(x0, y0, x1, y1), fill, layer, points: relative(pts, x0, y0, x1, y1), ...(when ? { when } : {}) };
}

/** Flat rect block from its edges in mm. */
export function block(x0: number, y0: number, x1: number, y1: number, fill: Fill, layer: Layer, when?: TextBinding): LayoutBlock {
  return { box: rect(x0, y0, x1, y1), fill, layer, ...(when ? { when } : {}) };
}

/** Short heavy ink rule starting at (x, y); goes with `when`'s text. */
export function rule(x: number, y: number, when?: TextBinding, len: number = RULE.len): LayoutBlock {
  return block(x, y, x + len, y + RULE.t, "ink", "under", when);
}

/** Text panel from its edges in mm. */
export function text(
  bind: TextBinding,
  box: readonly [number, number, number, number],
  font: LayoutText["font"],
  ink: NonNullable<LayoutText["ink"]>,
  rest: Partial<Pick<LayoutText, "align" | "rotate" | "n" | "fit">> = {},
): LayoutText {
  return { bind, box: rect(...box), align: rest.align ?? "start", font, ink, ...(rest.rotate ? { rotate: rest.rotate } : {}), ...(rest.n !== undefined ? { n: rest.n } : {}), ...(rest.fit ? { fit: rest.fit } : {}) };
}
