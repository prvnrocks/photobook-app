// Magazine A5 LANDSCAPE single pages (M30 T5, ref docs/design/refs/mg-5.jpg). Pure data, drawn in
// page mm (210 × 148, y down) through ./geometry.
//
// Grid: photos bleed off the trim or are separated by a 3 mm gutter; text keeps ≥ 12 mm from the
// left / right trim (either can be the fold) and ≥ 6 mm from top / bottom. Text panels centre their
// lines vertically in the box, so boxes are cut close to the type they hold. Dark `panel` blocks
// carry paper / accentOnDark text; white areas carry ink / muted / accent text. Everything bound
// to the chapter description (text, its rule, its backing block) carries `when` or is simply not
// drawn, and each page is composed to stand without it.

import type { Layout, LayoutBlock, LayoutSlotDef, LayoutText, Rect } from "@/lib/book/types";
import { H, W, circle, rect } from "./geometry";

const G = 3; // photo gutter (mm)

// --- 1 photo ----------------------------------------------------------------------------------------

/** Parts of the chapter opener, shared with the spreads (the feature spread's left page is this page). */
export const OPENER: { slot: LayoutSlotDef; blocks: LayoutBlock[]; texts: LayoutText[] } = {
  slot: rect(0, 0, W, H),
  blocks: [
    // Headline box: stands alone when the chapter has no description…
    { box: rect(14, 56, 112, 102), fill: "paper", layer: "over" },
    { box: rect(14, 56, 16, 102), fill: "accent", layer: "over" },
    // …and runs on to the foot of the page under the description.
    { box: rect(14, 102, 112, H), fill: "paper", layer: "over", when: "chapterDescription" },
    { box: rect(14, 102, 16, H), fill: "accent", layer: "over", when: "chapterDescription" },
  ],
  texts: [
    { bind: "dateLabel", box: rect(23, 62, 105, 67.5), align: "start", font: "year", ink: "accent" },
    { bind: "chapterTitle", box: rect(23, 70, 105, 97), align: "start", font: "masthead", ink: "ink" },
    { bind: "chapterDescription", box: rect(23, 102, 105, 142), align: "start", font: "body", ink: "muted" },
  ],
};

/** Chapter opener: full-bleed photo with a white headline box (date, heavy headline, description) laid over it. */
export const magazineLandscapeOneOpener: Layout = {
  id: "mg-l-one-opener",
  name: "Opener: full-bleed photo + headline box",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [OPENER.slot],
  caption: null,
  blocks: OPENER.blocks,
  texts: OPENER.texts,
};

/** Parts of the foot-band page, shared with the panorama spread (its right page keeps this caption band). */
export const BAND = {
  top: 112,
  caption: rect(20, 118, 146, 142),
  date: rect(152, 127, 198, 133),
};

/** Wide photo bleeding off three edges over a dark foot band with the caption and the date. */
export const magazineLandscapeOneBand: Layout = {
  id: "mg-l-one-band",
  name: "1 photo over a dark caption band",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W, BAND.top)],
  caption: BAND.caption,
  blocks: [
    { box: rect(0, BAND.top, W, H), fill: "panel", layer: "under" },
    { box: rect(14, 121, 15.2, 139), fill: "accent", layer: "under" },
  ],
  texts: [
    { bind: "pageCaption", box: BAND.caption, align: "start", font: "caption", ink: "paper" },
    { bind: "dateLabel", box: BAND.date, align: "end", font: "year", ink: "accentOnDark" },
  ],
};

const COLUMN_CAPTION = rect(12, 76, 70, 110);

/** Text column on white (date, chapter title, accent rule, caption) beside a tall photo bleeding right. */
export const magazineLandscapeOneColumn: Layout = {
  id: "mg-l-one-column",
  name: "1 photo + text column",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["any"],
  slots: [rect(82, 0, W, H)],
  caption: COLUMN_CAPTION,
  blocks: [
    { box: rect(12, 69, 34, 70.4), fill: "accent", layer: "under" },
  ],
  texts: [
    { bind: "dateLabel", box: rect(12, 38, 70, 43.5), align: "start", font: "year", ink: "accent" },
    { bind: "chapterTitle", box: rect(12, 46, 70, 65), align: "start", font: "chapter", ink: "ink" },
    { bind: "pageCaption", box: COLUMN_CAPTION, align: "start", font: "caption", ink: "muted" },
  ],
};

// --- 2 photos ---------------------------------------------------------------------------------------

/**
 * Chapter opener: a photo bleeding left beside a dark panel column — date, accent heading, a small
 * second photo, then the description under its rule (the panel simply ends dark without it).
 */
export const magazineLandscapeTwoPanel: Layout = {
  id: "mg-l-two-panel",
  name: "Opener: photo + dark panel column",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 2,
  prefers: ["any", "landscape"],
  slots: [rect(0, 0, 120, H), rect(130, 46, 198, 84)],
  caption: null,
  blocks: [
    { box: rect(120, 0, W, H), fill: "panel", layer: "under" },
    { box: rect(130, 90, 148, 91.2), fill: "accent", layer: "under", when: "chapterDescription" },
  ],
  texts: [
    { bind: "dateLabel", box: rect(130, 12, 198, 17.5), align: "start", font: "year", ink: "paper" },
    { bind: "chapterTitle", box: rect(130, 20, 198, 41), align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "chapterDescription", box: rect(130, 94, 198, 142), align: "start", font: "body", ink: "paper" },
  ],
};

const CIRCLE_CAPTION = rect(20, 120, 126, 142);

/** Wide photo with a white-ringed circle inset hanging over its lower edge; date and caption beneath. */
export const magazineLandscapeTwoCircle: Layout = {
  id: "mg-l-two-circle",
  name: "2 photos, circle inset",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 2,
  prefers: ["landscape", "any"],
  slots: [
    rect(0, 0, W, 104),
    { ...circle(164, 102, 30), z: 1 },
  ],
  caption: CIRCLE_CAPTION,
  blocks: [{ box: rect(14, 112, 15.2, 142), fill: "accent", layer: "under" }],
  texts: [
    { bind: "dateLabel", box: rect(20, 112, 126, 117.5), align: "start", font: "year", ink: "accent" },
    { bind: "pageCaption", box: CIRCLE_CAPTION, align: "start", font: "caption", ink: "ink" },
  ],
};

// --- 3 photos ---------------------------------------------------------------------------------------

const HERO3_CAPTION = rect(137, 118, 198, 142);

/** Tall hero bleeding left, two stacked photos bleeding right, caption under an accent rule. */
export const magazineLandscapeThreeHero: Layout = {
  id: "mg-l-three-hero",
  name: "3 photos, hero + two stacked",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 3,
  prefers: ["any", "landscape", "landscape"],
  slots: [rect(0, 0, 128, H), rect(128 + G, 0, W, 54), rect(128 + G, 54 + G, W, 108)],
  caption: HERO3_CAPTION,
  blocks: [{ box: rect(137, 113, 155, 114.2), fill: "accent", layer: "under" }],
  texts: [{ bind: "pageCaption", box: HERO3_CAPTION, align: "start", font: "caption", ink: "ink" }],
};

/** Parts of the feature page, shared with the feature spread (its right page is this page). */
export const FEATURE: { slots: LayoutSlotDef[]; blocks: LayoutBlock[]; texts: LayoutText[] } = {
  // Three photos in a row, hanging over the lower edge of the dark panel.
  slots: [rect(14, 80, 72, 134), rect(76, 80, 134, 134), rect(138, 80, 196, 134)],
  blocks: [
    { box: rect(0, 0, W, 104), fill: "panel", layer: "under" },
    { box: rect(104, 14, 104.6, 68), fill: "accent", layer: "under", when: "chapterDescription" },
  ],
  texts: [
    { bind: "dateLabel", box: rect(14, 14, 96, 19.5), align: "start", font: "year", ink: "paper" },
    { bind: "chapterTitle", box: rect(14, 23, 96, 68), align: "start", font: "masthead", ink: "accentOnDark" },
    { bind: "chapterDescription", box: rect(112, 14, 196, 68), align: "start", font: "body", ink: "paper" },
  ],
};

/** Feature page: dark panel with a heavy accent headline and the description, three photos hanging from it. */
export const magazineLandscapeThreeFeature: Layout = {
  id: "mg-l-three-feature",
  name: "Feature: dark panel + three photos",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 3,
  prefers: ["any", "any", "any"],
  slots: FEATURE.slots,
  caption: null,
  blocks: FEATURE.blocks,
  texts: FEATURE.texts,
};

// --- 4 photos ---------------------------------------------------------------------------------------

const STRIP_CAPTION: Rect = rect(20, 131, 196, 143);
const third = (W - 2 * G) / 3; // 68 mm

/** Wide hero bleeding off the top over a strip of three photos; caption line at the foot. */
export const magazineLandscapeFourStrip: Layout = {
  id: "mg-l-four-strip",
  name: "4 photos, hero + strip of three",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 4,
  prefers: ["landscape", "landscape", "landscape", "landscape"],
  slots: [
    rect(0, 0, W, 80),
    rect(0, 80 + G, third, 126),
    rect(third + G, 80 + G, 2 * third + G, 126),
    rect(2 * (third + G), 80 + G, W, 126),
  ],
  caption: STRIP_CAPTION,
  blocks: [{ box: rect(14, 131, 15.2, 143), fill: "accent", layer: "under" }],
  texts: [{ bind: "pageCaption", box: STRIP_CAPTION, align: "start", font: "caption", ink: "ink" }],
};

const GRID4_CAPTION = rect(14, 118, 112, 142);

/** Hero top-left, two photos stacked beside it, a fourth photo bottom-right and a dark caption panel bottom-left. */
export const magazineLandscapeFourGrid: Layout = {
  id: "mg-l-four-grid",
  name: "4 photos, hero grid + caption panel",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 4,
  prefers: ["landscape", "landscape", "landscape", "landscape"],
  slots: [
    rect(0, 0, 124, 98),
    rect(124 + G, 0, W, 47.5),
    rect(124 + G, 47.5 + G, W, 98),
    rect(124 + G, 98 + G, W, H),
  ],
  caption: GRID4_CAPTION,
  blocks: [
    { box: rect(0, 98 + G, 124, H), fill: "panel", layer: "under" },
    { box: rect(14, 114, 32, 115.2), fill: "accent", layer: "under" },
  ],
  texts: [
    { bind: "dateLabel", box: rect(14, 106, 112, 111.5), align: "start", font: "year", ink: "accentOnDark" },
    { bind: "pageCaption", box: GRID4_CAPTION, align: "start", font: "caption", ink: "paper" },
  ],
};

// --- 5 photos ---------------------------------------------------------------------------------------

const FIVE_CAPTION = rect(113, 124, 198, 142);
const fiveCol = (W - 104 - 2 * G) / 2; // 50 mm

/** Tall hero bleeding left, four photos in a 2 × 2 block bleeding top and right, caption beneath them. */
export const magazineLandscapeFive: Layout = {
  id: "mg-l-five",
  name: "5 photos, hero + four",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 5,
  prefers: ["portrait", "any", "any", "any", "any"],
  slots: [
    rect(0, 0, 104, H),
    rect(104 + G, 0, 104 + G + fiveCol, 56),
    rect(W - fiveCol, 0, W, 56),
    rect(104 + G, 56 + G, 104 + G + fiveCol, 115),
    rect(W - fiveCol, 56 + G, W, 115),
  ],
  caption: FIVE_CAPTION,
  blocks: [{ box: rect(107, 124, 108.2, 142), fill: "accent", layer: "under" }],
  texts: [{ bind: "pageCaption", box: FIVE_CAPTION, align: "start", font: "caption", ink: "ink" }],
};

// --- 6 photos ---------------------------------------------------------------------------------------

const SIX_CAPTION = rect(149, 54, 198, 84);
const quarter = (W - 3 * G) / 4; // 50.25 mm

/** Hero top-left, one photo and a dark caption cell beside it, four photos in a row along the foot. */
export const magazineLandscapeSix: Layout = {
  id: "mg-l-six",
  name: "6 photos, hero + caption cell + row of four",
  role: "page",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 6,
  prefers: ["landscape", "landscape", "any", "any", "any", "any"],
  slots: [
    rect(0, 0, 138, 90),
    rect(138 + G, 0, W, 43.5),
    rect(0, 90 + G, quarter, H),
    rect(quarter + G, 90 + G, 2 * quarter + G, H),
    rect(2 * (quarter + G), 90 + G, 3 * quarter + 2 * G, H),
    rect(3 * (quarter + G), 90 + G, W, H),
  ],
  caption: SIX_CAPTION,
  blocks: [
    { box: rect(138 + G, 43.5 + G, W, 90), fill: "panel", layer: "under" },
    { box: rect(149, 51, 163, 52.2), fill: "accent", layer: "under" },
  ],
  texts: [{ bind: "pageCaption", box: SIX_CAPTION, align: "start", font: "caption", ink: "paper" }],
};
