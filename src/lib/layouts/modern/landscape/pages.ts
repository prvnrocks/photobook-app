// Modern A5 LANDSCAPE single-page layouts (M10b A5b). Pure data, original geometry.
//
// Rects are % of a 210×148 mm trim page (x: 1 % = 2.1 mm, y: 1 % = 1.48 mm), rounded to 3
// decimals from the mm values in the comments. Modern look: clean grids with a 6 mm outer
// margin and thin 2.5 mm gutters, or full bleed. Captioned grids end at 124 mm and keep a
// caption band at 128–142 mm (10 mm from the sides — either side may be the fold — 6 mm from
// the bottom). Several spreads (./spreads.ts) are built from exactly these halves, so a spread
// that has to split (D-064) looks the same as its twins.

import type { Layout } from "@/lib/book/types";

/** Caption band shared by the captioned grids: 10 → 200 mm × 128 → 142 mm. */
const CAPTION_BAND = { x: 4.762, y: 86.486, w: 90.476, h: 9.46 } as const;

/** One photo bleeding to all edges, no caption. */
export const modernLandscapeFullBleed: Layout = {
  id: "m-l-full-bleed",
  name: "Full bleed photo",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: null,
};

/** One wide photo inside the margins, caption band below. */
export const modernLandscapeOne: Layout = {
  id: "m-l-one",
  name: "1 photo with caption",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [{ x: 2.857, y: 4.054, w: 94.286, h: 79.73 }], // 6 6 198×118 mm
  caption: { ...CAPTION_BAND },
};

/**
 * Text panel: a tall photo bleeding off the top, bottom and one side; the chapter title, its
 * date and the page caption stacked in the open panel (ref5 feel, original geometry).
 * The paragraph is the layout's caption rect (pageCaption); title/date are texts[].
 */
export const modernLandscapeOneText: Layout = {
  id: "m-l-one-text",
  name: "1 photo + text panel",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 0, y: 0, w: 60, h: 100 }], // 0 0 126×148 mm
  caption: { x: 64.762, y: 48.649, w: 30.476, h: 27.027 }, // 136 72 64×40 mm
  texts: [
    { bind: "chapterTitle", box: { x: 64.762, y: 27.027, w: 30.476, h: 10.811 }, align: "start", font: "chapter" }, // 136 40 64×16 mm
    { bind: "dateLabel", box: { x: 64.762, y: 39.189, w: 30.476, h: 5.406 }, align: "start", font: "subtitle" }, // 136 58 64×8 mm
  ],
};

/** Two tall photos side by side, caption band below. */
export const modernLandscapeTwo: Layout = {
  id: "m-l-two",
  name: "2 photos side by side",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 2,
  prefers: ["portrait", "portrait"],
  slots: [
    { x: 2.857, y: 4.054, w: 46.548, h: 79.73 }, // 6 6 97.75×118 mm
    { x: 50.595, y: 4.054, w: 46.548, h: 79.73 }, // 106.25 6 97.75×118 mm
  ],
  caption: { ...CAPTION_BAND },
};

/** One big photo on the left, two stacked on the right, caption band below. */
export const modernLandscapeThree: Layout = {
  id: "m-l-three",
  name: "1 big + 2 small",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 3,
  prefers: ["landscape", "landscape", "landscape"],
  slots: [
    { x: 2.857, y: 4.054, w: 61.905, h: 79.73 }, // 6 6 130×118 mm
    { x: 65.952, y: 4.054, w: 31.191, h: 39.02 }, // 138.5 6 65.5×57.75 mm
    { x: 65.952, y: 44.764, w: 31.191, h: 39.02 }, // 138.5 66.25 65.5×57.75 mm
  ],
  caption: { ...CAPTION_BAND },
};

/** Mirror of m-l-three: two stacked on the left, one big photo on the right, caption band below. */
export const modernLandscapeThreeB: Layout = {
  id: "m-l-three-b",
  name: "2 small + 1 big",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 3,
  prefers: ["landscape", "landscape", "landscape"],
  slots: [
    { x: 2.857, y: 4.054, w: 31.191, h: 39.02 }, // 6 6 65.5×57.75 mm
    { x: 2.857, y: 44.764, w: 31.191, h: 39.02 }, // 6 66.25 65.5×57.75 mm
    { x: 35.238, y: 4.054, w: 61.905, h: 79.73 }, // 74 6 130×118 mm
  ],
  caption: { ...CAPTION_BAND },
};

/** Three tall photos in a row, caption band below. */
export const modernLandscapeThreeRow: Layout = {
  id: "m-l-three-row",
  name: "3 photos in a row",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 3,
  prefers: ["portrait", "portrait", "portrait"],
  slots: [
    { x: 2.857, y: 4.054, w: 30.635, h: 79.73 }, // 6 6 64.33×118 mm
    { x: 34.683, y: 4.054, w: 30.634, h: 79.73 }, // 72.83 6 64.33×118 mm
    { x: 66.508, y: 4.054, w: 30.635, h: 79.73 }, // 139.67 6 64.33×118 mm
  ],
  caption: { ...CAPTION_BAND },
};

/** 2×2 grid, caption band below. */
export const modernLandscapeFour: Layout = {
  id: "m-l-four",
  name: "4 photo grid",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 4,
  prefers: ["landscape", "landscape", "landscape", "landscape"],
  slots: [
    { x: 2.857, y: 4.054, w: 46.548, h: 39.02 }, // 6 6 97.75×57.75 mm
    { x: 50.595, y: 4.054, w: 46.548, h: 39.02 }, // 106.25 6
    { x: 2.857, y: 44.764, w: 46.548, h: 39.02 }, // 6 66.25
    { x: 50.595, y: 44.764, w: 46.548, h: 39.02 }, // 106.25 66.25
  ],
  caption: { ...CAPTION_BAND },
};

/** One tall photo on the left + a 2×2 grid, edge to edge inside the margins, no caption. */
export const modernLandscapeFive: Layout = {
  id: "m-l-five",
  name: "1 tall + 4 grid",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 5,
  prefers: ["portrait", "portrait", "portrait", "portrait", "portrait"],
  slots: [
    { x: 2.857, y: 4.054, w: 38.095, h: 91.892 }, // 6 6 80×136 mm
    { x: 42.143, y: 4.054, w: 26.905, h: 45.101 }, // 88.5 6 56.5×66.75 mm
    { x: 70.238, y: 4.054, w: 26.905, h: 45.101 }, // 147.5 6
    { x: 42.143, y: 50.845, w: 26.905, h: 45.101 }, // 88.5 75.25
    { x: 70.238, y: 50.845, w: 26.905, h: 45.101 }, // 147.5 75.25
  ],
  caption: null,
};

/** 3×2 grid of near-square photos inside the margins, no caption. */
export const modernLandscapeSix: Layout = {
  id: "m-l-six",
  name: "6 photo grid",
  role: "page",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 6,
  prefers: ["any", "any", "any", "any", "any", "any"],
  slots: [
    { x: 2.857, y: 4.054, w: 30.635, h: 45.101 }, // 6 6 64.33×66.75 mm
    { x: 34.683, y: 4.054, w: 30.634, h: 45.101 }, // 72.83 6
    { x: 66.508, y: 4.054, w: 30.635, h: 45.101 }, // 139.67 6
    { x: 2.857, y: 50.845, w: 30.635, h: 45.101 }, // 6 75.25
    { x: 34.683, y: 50.845, w: 30.634, h: 45.101 }, // 72.83 75.25
    { x: 66.508, y: 50.845, w: 30.635, h: 45.101 }, // 139.67 75.25
  ],
  caption: null,
};
