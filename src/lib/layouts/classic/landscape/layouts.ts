// Classic A5 LANDSCAPE layouts (M10b A5b). Pure data, original geometry.
//
// Rects are % of a 210×148 mm trim page (x: 1 % = 2.1 mm, y: 1 % = 1.48 mm). Classic look,
// re-proportioned for landscape: outer margins 4 % × 6 % (8.4 mm sides, 8.9 mm top/bottom),
// gutters 2 % horizontal (4.2 mm) / 3 % vertical (4.4 mm), caption band at the bottom
// (y 84–94 %, 14.8 mm tall — the same height in mm as the portrait caption band). Text rects
// stay ≥ 8 mm from the left/right edges (either one can be the fold) and ≥ 4 mm from top/bottom.

import type { Layout } from "@/lib/book/types";

/** Cover: full-bleed photo on the top 70 %, title + subtitle block below. */
export const classicLandscapeCover: Layout = {
  id: "c-l-cover",
  name: "Cover",
  role: "cover",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [{ x: 0, y: 0, w: 100, h: 70 }], // 210 × 103.6 mm, bleeds top/left/right
  caption: { x: 8, y: 74, w: 84, h: 20 }, // 16.8 mm from the sides, 8.9 mm from the bottom
};

/** One photo bleeding to all edges, no caption. */
export const classicLandscapeFullPage: Layout = {
  id: "c-l-full-page",
  name: "Full page photo",
  role: "page",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: null,
};

/** One framed landscape photo with a caption underneath. */
export const classicLandscapeOnePhoto: Layout = {
  id: "c-l-one-photo",
  name: "1 photo with caption",
  role: "page",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [{ x: 14, y: 6, w: 72, h: 75 }], // 151.2 × 111 mm
  caption: { x: 14, y: 84, w: 72, h: 10 },
};

/** Two tall photos side by side, caption below. */
export const classicLandscapeTwoSide: Layout = {
  id: "c-l-two-side",
  name: "2 photos side by side",
  role: "page",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 2,
  prefers: ["portrait", "portrait"],
  slots: [
    { x: 4, y: 6, w: 45, h: 75 }, // 94.5 × 111 mm
    { x: 51, y: 6, w: 45, h: 75 },
  ],
  caption: { x: 4, y: 84, w: 92, h: 10 },
};

/**
 * Two wide photos stacked on the left, caption beside the lower one (a full-width stack would
 * be a 3.6:1 panorama on a landscape page; this keeps each photo near 2:1).
 */
export const classicLandscapeTwoStacked: Layout = {
  id: "c-l-two-stacked",
  name: "2 photos stacked",
  role: "page",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 2,
  prefers: ["landscape", "landscape"],
  slots: [
    { x: 4, y: 6, w: 64, h: 42 }, // 134.4 × 62.2 mm
    { x: 4, y: 52, w: 64, h: 42 },
  ],
  caption: { x: 71, y: 74, w: 25, h: 20 }, // 52.5 × 29.6 mm, bottom-aligned with the lower photo
};

/** One tall photo on the left, two wide photos stacked on the right, caption at the bottom. */
export const classicLandscapeThreeMixed: Layout = {
  id: "c-l-three-mixed",
  name: "1 tall + 2 wide",
  role: "page",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 3,
  prefers: ["portrait", "landscape", "landscape"],
  slots: [
    { x: 4, y: 6, w: 40, h: 75 }, // 84 × 111 mm
    { x: 46, y: 6, w: 50, h: 36 }, // 105 × 53.3 mm
    { x: 46, y: 45, w: 50, h: 36 },
  ],
  caption: { x: 4, y: 84, w: 92, h: 10 },
};

/** 2×2 grid, caption at the bottom. */
export const classicLandscapeFourGrid: Layout = {
  id: "c-l-four-grid",
  name: "4 photo grid",
  role: "page",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 4,
  prefers: ["any", "any", "any", "any"],
  slots: [
    { x: 4, y: 6, w: 45, h: 36 }, // 94.5 × 53.3 mm
    { x: 51, y: 6, w: 45, h: 36 },
    { x: 4, y: 45, w: 45, h: 36 },
    { x: 51, y: 45, w: 45, h: 36 },
  ],
  caption: { x: 4, y: 84, w: 92, h: 10 },
};
