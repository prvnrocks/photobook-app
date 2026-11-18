// Geometry of the magazine layouts (M30, D-090: bold travel magazine, ref docs/design/refs/mg-5.jpg).
// Pure, no runtime imports beyond the shared mm helpers — layouts stay plain data. Both formats of
// the style import from here; nothing else in the app does.

import { pageMm } from "../page-mm";

export { shift, shiftBlock, shiftText } from "../page-mm";

/** A5 portrait page in mm (148 × 210; spreads run on to x = 296, fold at 148). */
export const PORTRAIT = pageMm(148, 210);
/** A5 landscape page in mm (210 × 148; spreads run on to x = 420, fold at 210). */
export const LANDSCAPE = pageMm(210, 148);

/** Portrait: side margin of text and inset photos (either side may be the fold). */
export const M = 10;
/** Portrait: gutter between neighbouring photos. */
export const G = 3;

/** `n` equal cells between a and b (mm) separated by the photo gutter: [start, end] pairs. */
export function cells(a: number, b: number, n: number, gap = G): Array<[number, number]> {
  const size = (b - a - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => [a + i * (size + gap), a + i * (size + gap) + size]);
}
