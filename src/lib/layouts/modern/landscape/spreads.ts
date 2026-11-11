// Modern A5 LANDSCAPE spread layouts (M10b A5b). Pure data, original geometry.
//
// Spread coordinates (lib/book/schema.ts): x 0..200 % across both pages (0..100 = left page,
// 100..200 = right page; 1 % = 2.1 mm), y 0..100 % (1 % = 1.48 mm). Each half of the grid and
// mosaic spreads is exactly one single-page layout of ./pages.ts, slots in the same order
// (left half first) — so the `twin` split of repairSpreads (slot → half by its centre,
// rectHalf) puts every photo into the same box it had. No photo or text crosses the fold
// except the panorama's one edge-to-edge photo; text keeps 10 mm from the fold.

import type { Layout } from "@/lib/book/types";

/** Dense grid: 3×2 on each page, 12 photos, thin gutters, no caption (= m-l-six + m-l-six). */
export const modernLandscapeSpreadGrid: Layout = {
  id: "m-l-spread-grid",
  name: "12 photo grid across both pages",
  role: "spread",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 12,
  prefers: Array.from({ length: 12 }, () => "any" as const),
  slots: [
    // left page (m-l-six)
    { x: 2.857, y: 4.054, w: 30.635, h: 45.101 },
    { x: 34.683, y: 4.054, w: 30.634, h: 45.101 },
    { x: 66.508, y: 4.054, w: 30.635, h: 45.101 },
    { x: 2.857, y: 50.845, w: 30.635, h: 45.101 },
    { x: 34.683, y: 50.845, w: 30.634, h: 45.101 },
    { x: 66.508, y: 50.845, w: 30.635, h: 45.101 },
    // right page (m-l-six, x + 100)
    { x: 102.857, y: 4.054, w: 30.635, h: 45.101 },
    { x: 134.683, y: 4.054, w: 30.634, h: 45.101 },
    { x: 166.508, y: 4.054, w: 30.635, h: 45.101 },
    { x: 102.857, y: 50.845, w: 30.635, h: 45.101 },
    { x: 134.683, y: 50.845, w: 30.634, h: 45.101 },
    { x: 166.508, y: 50.845, w: 30.635, h: 45.101 },
  ],
  caption: null,
  twin: ["m-l-six", "m-l-six"],
};

/**
 * Mosaic: two big photos meet at the fold, two small ones stacked at each outer edge; caption
 * band under the left page, chapter title + date under the right page (= m-l-three-b + m-l-three).
 */
export const modernLandscapeSpreadMosaic: Layout = {
  id: "m-l-spread-mosaic",
  name: "Mosaic across both pages",
  role: "spread",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 6,
  prefers: ["landscape", "landscape", "landscape", "landscape", "landscape", "landscape"],
  slots: [
    // left page (m-l-three-b): 2 small at the outer edge, big next to the fold
    { x: 2.857, y: 4.054, w: 31.191, h: 39.02 },
    { x: 2.857, y: 44.764, w: 31.191, h: 39.02 },
    { x: 35.238, y: 4.054, w: 61.905, h: 79.73 },
    // right page (m-l-three, x + 100): big next to the fold, 2 small at the outer edge
    { x: 102.857, y: 4.054, w: 61.905, h: 79.73 },
    { x: 165.952, y: 4.054, w: 31.191, h: 39.02 },
    { x: 165.952, y: 44.764, w: 31.191, h: 39.02 },
  ],
  caption: { x: 4.762, y: 86.486, w: 90.476, h: 9.46 }, // left page band, 10 → 200 mm
  twin: ["m-l-three-b", "m-l-three"],
  texts: [
    { bind: "chapterTitle", box: { x: 104.762, y: 86.486, w: 59.524, h: 9.46 }, align: "start", font: "chapter" }, // right page 10 → 135 mm
    { bind: "dateLabel", box: { x: 166.667, y: 86.486, w: 28.571, h: 9.46 }, align: "end", font: "subtitle" }, // right page 140 → 200 mm
  ],
};

/**
 * Panorama: one photo edge to edge across both pages (bleeds on every outer edge). Its centre
 * sits on the fold, so a split (rectHalf: x < 100 → left) puts the photo on the right twin and
 * leaves the left twin's slot empty — the page count stays the same, no photo is lost.
 */
export const modernLandscapeSpreadPanorama: Layout = {
  id: "m-l-spread-panorama",
  name: "Panorama across both pages",
  role: "spread",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [{ x: 0, y: 0, w: 200, h: 100 }], // 420 × 148 mm
  caption: null,
  twin: ["m-l-full-bleed", "m-l-full-bleed"],
};
