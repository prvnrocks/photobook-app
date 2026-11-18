// Editorial A5 LANDSCAPE covers (M30 T7). Minimal Swiss posters turned to the wide page (ref
// docs/design/refs/mg-covers.jpg): white paper, one photo cut by a diagonal, a heavy sans title,
// hairlines that echo or cross the cut, the date turned a quarter in a strip. All cover text keeps
// ≥ 12 mm from the spine (left) edge. Drawn in page mm through ../geometry.

import type { Layout } from "@/lib/book/types";
import { BAR, hairline, LANDSCAPE, LINE, rule } from "../geometry";

const { W, H, rect, poly, block, text } = LANDSCAPE;

const base = { role: "cover", style: "editorial", format: "A5_LANDSCAPE", photoCount: 1 } as const;

/**
 * Auto cover: the photo is a trapezoid on the right (bleeds top/right/bottom) cut by a steep
 * diagonal; a hairline runs parallel to the cut; a white strip through the photo carries the date
 * turned a quarter; title, short rule and two cover lines sit on the white left side.
 */
export const editorialLandscapeCover: Layout = {
  ...base,
  id: "ed-l-cover",
  name: "Cover: diagonal photo, title on white, date strip",
  prefers: ["any"],
  slots: [poly([[124, 0], [W, 0], [W, H], [76, H]])],
  caption: rect(14, 16, 90, 72),
  blocks: [
    hairline([117, 0], [69, H]),
    block(14, 9, 14 + BAR.len, 9 + BAR.t, LINE),
    block(184, 0, 197, H, "paper", "over"),
    rule(14, 80, "coverLine"),
  ],
  texts: [
    text("coverTitle", [14, 16, 90, 72], "masthead", "ink"),
    text("coverLine", [14, 85, 78, 92], "subtitle", "accent", { n: 0 }),
    text("coverLine", [14, 93, 78, 100], "subtitle", "muted", { n: 1 }),
    text("coverSubtitle", [186.5, 50, 194.5, 138], "year", "accent", { rotate: -90 }),
  ],
};

/**
 * Full-bleed photo; a flat scrim band over its lower part carries one small cover line and the
 * huge white title (legible on snow and sky); a white strip down the right with the date turned a
 * quarter, and a light hairline rising across the photo above the band.
 */
export const editorialLandscapeCoverBleed: Layout = {
  ...base,
  id: "ed-l-cover-bleed",
  name: "Cover: full photo, big white title, date strip",
  prefers: ["landscape"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: rect(14, 83, 162, 138),
  blocks: [
    hairline([0, 62], [176, 10], { fill: "paper", layer: "over" }),
    block(0, 66, 176, H, "scrim", "over"),
    block(176, 0, 190, H, "paper", "over"),
  ],
  texts: [
    text("coverTitle", [14, 83, 162, 138], "masthead", "paper"),
    text("coverLine", [14, 73, 162, 80], "subtitle", "paper", { n: 0 }),
    text("coverSubtitle", [179, 12, 187, 100], "year", "accent", { rotate: 90 }),
  ],
  autoPick: false,
};

/**
 * Triangle photo in the lower right corner; two hairlines — one parallel to the cut, one crossing
 * it — make the poster's X; title top left, the date turned a quarter at the lower left.
 */
export const editorialLandscapeCoverCorner: Layout = {
  ...base,
  id: "ed-l-cover-corner",
  name: "Cover: triangle photo corner, crossing hairlines",
  prefers: ["landscape"],
  slots: [poly([[40, H], [W, 20], [W, H]])],
  caption: rect(14, 14, 118, 60),
  blocks: [
    // Parallel to the cut, 8 mm above it (same slope: 128 mm rise over 170 mm).
    hairline([29.375, H], [W, 12]),
    // The crossing line: falls from the left edge and ends under the photo.
    hairline([0, 70], [84, 124.6]),
  ],
  texts: [
    text("coverTitle", [14, 14, 118, 60], "masthead", "ink"),
    text("coverLine", [14, 62, 96, 69], "subtitle", "accent", { n: 0 }),
    text("coverSubtitle", [12, 92, 19, 140], "year", "accent", { rotate: -90 }),
  ],
  autoPick: false,
};

/** Centred and calm: a wide photo in a hairline frame, the title below, a short rule, the date. */
export const editorialLandscapeCoverFrame: Layout = {
  ...base,
  id: "ed-l-cover-frame",
  name: "Cover: framed wide photo, centred title",
  prefers: ["landscape"],
  slots: [rect(34, 18, 186, 84)],
  caption: rect(30, 93, 190, 124),
  blocks: [
    block(30, 14, 190, 88, LINE),
    block(30.35, 14.35, 189.65, 87.65, "paper"),
    block(99, 127, 111, 128, LINE),
  ],
  texts: [
    text("coverTitle", [30, 93, 190, 124], "masthead", "ink", { align: "center" }),
    text("coverSubtitle", [30, 130, 190, 138], "year", "accent", { align: "center" }),
  ],
  autoPick: false,
};
