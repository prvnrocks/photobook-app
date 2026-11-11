// mm → % helpers for the modern A5 PORTRAIT layouts (M10b A5a). Pure, no imports: the layouts are
// still plain data, these only turn a design drawn in millimetres into the catalogue's % rects.
//
// Page = 148 × 210 mm (trim). Single-page and cover rects are % of one page (0..100). Spread rects
// use the same unit across both pages: x 0..200 (= 0..296 mm, fold at x 100 = 148 mm), y 0..100.

/** Trim page in mm (A5 portrait). */
export const PAGE_W_MM = 148;
export const PAGE_H_MM = 210;

/** The modern grid: thin white gutters between photos (both directions) and the outer margin. */
export const GUTTER_MM = 2.5;
export const MARGIN_MM = 8;

/** Spread fold in mm from the left edge of the left page. */
export const FOLD_MM = PAGE_W_MM;
/** Inner edge of a full-bleed spread photo: the gutter is centred on the fold. */
export const FOLD_LEFT_MM = FOLD_MM - GUTTER_MM / 2;
export const FOLD_RIGHT_MM = FOLD_MM + GUTTER_MM / 2;

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Horizontal mm → % of the page width (spreads: may exceed 100). */
export const pctX = (mm: number): number => round((mm / PAGE_W_MM) * 100);
/** Vertical mm → % of the page height. */
export const pctY = (mm: number): number => round((mm / PAGE_H_MM) * 100);

/** Rect from its edges in mm (left, top, right, bottom) → % rect. Edges on the trim stay exact 0/100/200. */
export function mmRect(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number } {
  const x = pctX(x0);
  const y = pctY(y0);
  return { x, y, w: round(pctX(x1) - x), h: round(pctY(y1) - y) };
}

/** Split [a, b] mm into `n` equal cells separated by GUTTER_MM → [[start, end], …]. */
export function cells(a: number, b: number, n: number): Array<[number, number]> {
  const size = (b - a - GUTTER_MM * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => {
    const s = a + i * (size + GUTTER_MM);
    return [s, i === n - 1 ? b : s + size] as [number, number];
  });
}
