// mm → layout-unit helpers for the geometric layouts (M10c T5). Pure, no runtime imports: the
// layouts stay plain data, these only turn a design drawn in millimetres (page space, y down) into
// the catalogue's % rects and slot-relative polygon points.
//
// Geometric slots are drawn as polygons in PAGE mm (diagonal bands, notched rects, petals) and
// stored as { bounding box %, shape.points % of that box } — so neighbouring slots share a clean
// diagonal gutter even though their bounding boxes overlap. Spread pages use x 0..2·W mm (fold at W).

import type { LayoutSlotDef, Rect } from "@/lib/book/types";

export interface PageSizeMm {
  w: number;
  h: number;
}

/** A point in page mm [x, y], y down. */
export type Pt = readonly [number, number];

/** Photo gutter of the geometric style (perpendicular gap between neighbouring shapes). */
export const GEO_GUTTER_MM = 3;

const round = (n: number) => Math.round(n * 10000) / 10000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Points on a circular arc around (cx, cy), angles in radians (y down: π/2 points down), both ends included. */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / (n - 1);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });
}

/** Vertical offset that makes a gutter of `perpMm` across a line of slope dy/dx (half each side: pass perp/2). */
export function verticalGap(perpMm: number, slope: number): number {
  return perpMm * Math.sqrt(1 + slope * slope);
}

/** Layout-unit helpers for one page size. Spread x runs on to 2·w (fold at w). */
export function geo(page: PageSizeMm) {
  const px = (mm: number) => round((mm / page.w) * 100);
  const py = (mm: number) => round((mm / page.h) * 100);

  /** Rect from its edges in mm. Edges on the trim stay exact 0/100/200. */
  function rect(x0: number, y0: number, x1: number, y1: number): Rect {
    const x = px(x0);
    const y = py(y0);
    return { x, y, w: round(px(x1) - x), h: round(py(y1) - y) };
  }

  /** Polygon slot from page-mm points: bounding box + shape points (% of the box, 3 decimals). */
  function poly(points: readonly Pt[]): LayoutSlotDef {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const x1 = Math.max(...xs);
    const y1 = Math.max(...ys);
    const box = rect(x0, y0, x1, y1);
    const rel = points.map(
      (p) => [round3(((p[0] - x0) / (x1 - x0)) * 100), round3(((p[1] - y0) / (y1 - y0)) * 100)] as [number, number],
    );
    return { ...box, shape: { kind: "polygon", points: rel } };
  }

  /** Circle slot of radius r mm (box square in mm). */
  function circle(cx: number, cy: number, r: number): LayoutSlotDef {
    return { ...rect(cx - r, cy - r, cx + r, cy + r), shape: { kind: "circle" } };
  }

  /** Regular flat-top hexagon of width `wMm` (height w·√3/2) centred on (cx, cy). */
  function hexagon(cx: number, cy: number, wMm: number): LayoutSlotDef {
    const h = (wMm * Math.sqrt(3)) / 2;
    return { ...rect(cx - wMm / 2, cy - h / 2, cx + wMm / 2, cy + h / 2), shape: { kind: "hexagon" } };
  }

  /** Square diamond (diagonals `dMm`, horizontal and vertical) centred on (cx, cy). */
  function diamond(cx: number, cy: number, dMm: number): LayoutSlotDef {
    return { ...rect(cx - dMm / 2, cy - dMm / 2, cx + dMm / 2, cy + dMm / 2), shape: { kind: "diamond" } };
  }

  /**
   * Petal: a box with one big rounded corner (`outer`, radius R), the two neighbouring corners
   * slightly rounded (r) and the opposite (inner) corner sharp — four of them make a clover.
   * 16 points (the polygon maximum): 9 on the big arc, 3 on each small one, 1 sharp corner.
   */
  function petal(x0: number, y0: number, x1: number, y1: number, outer: "tl" | "tr" | "bl" | "br", R: number, r: number): LayoutSlotDef {
    const H = Math.PI / 2;
    // Corners clockwise from top-left; each with its arc (centre inset by radius) start angle.
    const corners = {
      tl: { c: [x0, y0], a: 2 * H },
      tr: { c: [x1, y0], a: 3 * H },
      br: { c: [x1, y1], a: 0 },
      bl: { c: [x0, y1], a: H },
    } as const;
    const inner = ({ tl: "br", tr: "bl", br: "tl", bl: "tr" } as const)[outer];
    const pts: Pt[] = [];
    for (const k of ["tl", "tr", "br", "bl"] as const) {
      const { c, a } = corners[k];
      if (k === inner) {
        pts.push([c[0], c[1]]);
        continue;
      }
      const rad = k === outer ? R : r;
      const n = k === outer ? 9 : 3;
      const sx = k === "tl" || k === "bl" ? 1 : -1;
      const sy = k === "tl" || k === "tr" ? 1 : -1;
      pts.push(...arc(c[0] + sx * rad, c[1] + sy * rad, rad, a, a + H, n));
    }
    return poly(pts);
  }

  /** Shift a slot / rect by `dx` page widths in layout units (right page of a spread: +100). */
  function shift<T extends Rect>(r: T, dx = 100): T {
    return { ...r, x: round(r.x + dx) };
  }

  return { px, py, rect, poly, circle, hexagon, diamond, petal, shift };
}

export const PORTRAIT_MM: PageSizeMm = { w: 148, h: 210 };
export const LANDSCAPE_MM: PageSizeMm = { w: 210, h: 148 };
