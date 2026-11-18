// mm → layout-unit helpers shared by the M30 magazine + editorial layouts (both formats). Pure,
// types only: layouts are drawn in page millimetres (y down; a spread runs on to x = 2 × W, fold at
// W = 100 %) and stored as the catalogue's % rects. One instance per page size: pageMm(148, 210)
// for A5 portrait, pageMm(210, 148) for A5 landscape (see <style>/geometry.ts).

import type { LayoutBlock, LayoutSlotDef, LayoutText, Rect, TextBinding } from "@/lib/book/types";

/** A point in page mm [x, y], y down. */
export type Pt = readonly [number, number];
/** A box by its edges in page mm: [x0, y0, x1, y1]. */
export type Box = readonly [number, number, number, number];
type Fill = LayoutBlock["fill"];
type Layer = LayoutBlock["layer"];

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** `points` in % of the box x0..x1 × y0..y1 (clamped to it). */
export function relative(points: readonly Pt[], x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return points.map((p) => [clamp(r3(((p[0] - x0) / (x1 - x0)) * 100)), clamp(r3(((p[1] - y0) / (y1 - y0)) * 100))]);
}

/** A rect / slot moved onto the right page of a spread (x + 100). */
export function shift<T extends Rect>(r: T): T {
  return { ...r, x: r4(r.x + 100) };
}
export const shiftBlock = (b: LayoutBlock): LayoutBlock => ({ ...b, box: shift(b.box) });
export const shiftText = (t: LayoutText): LayoutText => ({ ...t, box: shift(t.box) });

export function pageMm(W: number, H: number) {
  const px = (mm: number) => r4((mm / W) * 100);
  const py = (mm: number) => r4((mm / H) * 100);

  /** Rect from its edges in mm. Edges on the trim stay exact 0 / 100 / 200. */
  function rect(x0: number, y0: number, x1: number, y1: number): Rect {
    const x = px(x0);
    const y = py(y0);
    return { x, y, w: r4(px(x1) - x), h: r4(py(y1) - y) };
  }

  /** Circle slot of radius r mm (box square in mm). */
  function circle(cx: number, cy: number, r: number): LayoutSlotDef {
    return { ...rect(cx - r, cy - r, cx + r, cy + r), shape: { kind: "circle" } };
  }

  /** Polygon photo slot from page-mm points: bounding box + points in % of the box. */
  function poly(points: readonly Pt[]): LayoutSlotDef {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return { ...rect(x0, y0, x1, y1), shape: { kind: "polygon", points: relative(points, x0, y0, x1, y1) } };
  }

  /** Flat rect block from its edges in mm; `when` (+ cover line `n`) hides it with that text. */
  function block(x0: number, y0: number, x1: number, y1: number, fill: Fill, layer: Layer = "under", when?: TextBinding, n?: number): LayoutBlock {
    return { box: rect(x0, y0, x1, y1), fill, layer, ...(when ? { when } : {}), ...(n !== undefined ? { n } : {}) };
  }

  /** Text panel from its edges in mm, or a ready rect (align defaults to "start"). */
  function text(
    bind: TextBinding,
    box: Box | Rect,
    font: LayoutText["font"],
    ink: NonNullable<LayoutText["ink"]>,
    rest: Partial<Pick<LayoutText, "align" | "rotate" | "n" | "fit">> = {},
  ): LayoutText {
    return {
      bind,
      box: "x" in box ? box : rect(...box),
      align: rest.align ?? "start",
      font,
      ink,
      ...(rest.rotate ? { rotate: rest.rotate } : {}),
      ...(rest.n !== undefined ? { n: rest.n } : {}),
      ...(rest.fit ? { fit: rest.fit } : {}),
    };
  }

  return { W, H, rect, circle, poly, block, text };
}
