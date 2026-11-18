// Magazine A5 LANDSCAPE single pages (M30 T5, ref docs/design/refs/mg-5.jpg). Pure data, drawn in
// page mm (210 × 148, y down) through ../geometry.
//
// Grid: photos bleed off the trim or are separated by a 3 mm gutter; text keeps ≥ 12 mm from the
// left / right trim (either can be the fold) and ≥ 6 mm from top / bottom. Text panels centre their
// lines vertically in the box, so boxes are cut close to the type they hold. Dark `panel` blocks
// carry paper / accentOnDark text; white areas carry ink / muted / accent text. Everything bound
// to the chapter description (text, its rule, its backing block) carries `when` or is simply not
// drawn, and each page is composed to stand without it.

import type { Layout, LayoutBlock, LayoutSlotDef, LayoutText, Rect } from "@/lib/book/types";
import { LANDSCAPE } from "../geometry";

const { W, H, rect, circle, text, block } = LANDSCAPE;
const PAGE = { role: "page", style: "magazine", format: "A5_LANDSCAPE" } as const;

const G = 3; // photo gutter (mm)

// --- 1 photo ----------------------------------------------------------------------------------------

/** Parts of the chapter opener, shared with the spreads (the feature spread's left page is this page). */
export const OPENER: { slot: LayoutSlotDef; blocks: LayoutBlock[]; texts: LayoutText[] } = {
  slot: rect(0, 0, W, H),
  blocks: [
    // Headline box: stands alone when the chapter has no description…
    block(14, 56, 112, 102, "paper", "over"),
    block(14, 56, 16, 102, "accent", "over"),
    // …and runs on to the foot of the page under the description.
    block(14, 102, 112, H, "paper", "over", "chapterDescription"),
    block(14, 102, 16, H, "accent", "over", "chapterDescription"),
  ],
  texts: [
    text("dateLabel", [23, 62, 105, 67.5], "year", "accent"),
    text("chapterTitle", [23, 70, 105, 97], "masthead", "ink"),
    text("chapterDescription", [23, 102, 105, 142], "body", "muted"),
  ],
};

/** Chapter opener: full-bleed photo with a white headline box (date, heavy headline, description) laid over it. */
export const magazineLandscapeOneOpener: Layout = {
  id: "mg-l-one-opener",
  name: "Opener: full-bleed photo + headline box",
  ...PAGE,
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
  ...PAGE,
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W, BAND.top)],
  caption: BAND.caption,
  blocks: [
    block(0, BAND.top, W, H, "panel"),
    block(14, 121, 15.2, 139, "accent"),
  ],
  texts: [
    text("pageCaption", BAND.caption, "caption", "paper"),
    text("dateLabel", BAND.date, "year", "accentOnDark", { align: "end" }),
  ],
};

const COLUMN_CAPTION = rect(12, 76, 70, 110);

/** Text column on white (date, chapter title, accent rule, caption) beside a tall photo bleeding right. */
export const magazineLandscapeOneColumn: Layout = {
  id: "mg-l-one-column",
  name: "1 photo + text column",
  ...PAGE,
  photoCount: 1,
  prefers: ["any"],
  slots: [rect(82, 0, W, H)],
  caption: COLUMN_CAPTION,
  blocks: [
    block(12, 69, 34, 70.4, "accent"),
  ],
  texts: [
    text("dateLabel", [12, 38, 70, 43.5], "year", "accent"),
    text("chapterTitle", [12, 46, 70, 65], "chapter", "ink"),
    text("pageCaption", COLUMN_CAPTION, "caption", "muted"),
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
  ...PAGE,
  photoCount: 2,
  prefers: ["any", "landscape"],
  slots: [rect(0, 0, 120, H), rect(130, 46, 198, 84)],
  caption: null,
  blocks: [
    block(120, 0, W, H, "panel"),
    block(130, 90, 148, 91.2, "accent", "under", "chapterDescription"),
  ],
  texts: [
    text("dateLabel", [130, 12, 198, 17.5], "year", "paper"),
    text("chapterTitle", [130, 20, 198, 41], "chapter", "accentOnDark"),
    text("chapterDescription", [130, 94, 198, 142], "body", "paper"),
  ],
};

const CIRCLE_CAPTION = rect(20, 120, 126, 142);

/** Wide photo with a white-ringed circle inset hanging over its lower edge; date and caption beneath. */
export const magazineLandscapeTwoCircle: Layout = {
  id: "mg-l-two-circle",
  name: "2 photos, circle inset",
  ...PAGE,
  photoCount: 2,
  prefers: ["landscape", "any"],
  slots: [
    rect(0, 0, W, 104),
    { ...circle(164, 102, 30), z: 1 },
  ],
  caption: CIRCLE_CAPTION,
  blocks: [block(14, 112, 15.2, 142, "accent")],
  texts: [
    text("dateLabel", [20, 112, 126, 117.5], "year", "accent"),
    text("pageCaption", CIRCLE_CAPTION, "caption", "ink"),
  ],
};

// --- 3 photos ---------------------------------------------------------------------------------------

const HERO3_CAPTION = rect(137, 118, 198, 142);

/** Tall hero bleeding left, two stacked photos bleeding right, caption under an accent rule. */
export const magazineLandscapeThreeHero: Layout = {
  id: "mg-l-three-hero",
  name: "3 photos, hero + two stacked",
  ...PAGE,
  photoCount: 3,
  prefers: ["any", "landscape", "landscape"],
  slots: [rect(0, 0, 128, H), rect(128 + G, 0, W, 54), rect(128 + G, 54 + G, W, 108)],
  caption: HERO3_CAPTION,
  blocks: [block(137, 113, 155, 114.2, "accent")],
  texts: [text("pageCaption", HERO3_CAPTION, "caption", "ink")],
};

/** Parts of the feature page, shared with the feature spread (its right page is this page). */
export const FEATURE: { slots: LayoutSlotDef[]; blocks: LayoutBlock[]; texts: LayoutText[] } = {
  // Three photos in a row, hanging over the lower edge of the dark panel.
  slots: [rect(14, 80, 72, 134), rect(76, 80, 134, 134), rect(138, 80, 196, 134)],
  blocks: [
    block(0, 0, W, 104, "panel"),
    block(104, 14, 104.6, 68, "accent", "under", "chapterDescription"),
  ],
  texts: [
    text("dateLabel", [14, 14, 96, 19.5], "year", "paper"),
    text("chapterTitle", [14, 23, 96, 68], "masthead", "accentOnDark"),
    text("chapterDescription", [112, 14, 196, 68], "body", "paper"),
  ],
};

/** Feature page: dark panel with a heavy accent headline and the description, three photos hanging from it. */
export const magazineLandscapeThreeFeature: Layout = {
  id: "mg-l-three-feature",
  name: "Feature: dark panel + three photos",
  ...PAGE,
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
  ...PAGE,
  photoCount: 4,
  prefers: ["landscape", "landscape", "landscape", "landscape"],
  slots: [
    rect(0, 0, W, 80),
    rect(0, 80 + G, third, 126),
    rect(third + G, 80 + G, 2 * third + G, 126),
    rect(2 * (third + G), 80 + G, W, 126),
  ],
  caption: STRIP_CAPTION,
  blocks: [block(14, 131, 15.2, 143, "accent")],
  texts: [text("pageCaption", STRIP_CAPTION, "caption", "ink")],
};

const GRID4_CAPTION = rect(14, 118, 112, 142);

/** Hero top-left, two photos stacked beside it, a fourth photo bottom-right and a dark caption panel bottom-left. */
export const magazineLandscapeFourGrid: Layout = {
  id: "mg-l-four-grid",
  name: "4 photos, hero grid + caption panel",
  ...PAGE,
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
    block(0, 98 + G, 124, H, "panel"),
    block(14, 114, 32, 115.2, "accent"),
  ],
  texts: [
    text("dateLabel", [14, 106, 112, 111.5], "year", "accentOnDark"),
    text("pageCaption", GRID4_CAPTION, "caption", "paper"),
  ],
};

// --- 5 photos ---------------------------------------------------------------------------------------

const FIVE_CAPTION = rect(113, 124, 198, 142);
const fiveCol = (W - 104 - 2 * G) / 2; // 50 mm

/** Tall hero bleeding left, four photos in a 2 × 2 block bleeding top and right, caption beneath them. */
export const magazineLandscapeFive: Layout = {
  id: "mg-l-five",
  name: "5 photos, hero + four",
  ...PAGE,
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
  blocks: [block(107, 124, 108.2, 142, "accent")],
  texts: [text("pageCaption", FIVE_CAPTION, "caption", "ink")],
};

// --- 6 photos ---------------------------------------------------------------------------------------

const SIX_CAPTION = rect(149, 54, 198, 84);
const quarter = (W - 3 * G) / 4; // 50.25 mm

/** Hero top-left, one photo and a dark caption cell beside it, four photos in a row along the foot. */
export const magazineLandscapeSix: Layout = {
  id: "mg-l-six",
  name: "6 photos, hero + caption cell + row of four",
  ...PAGE,
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
    block(138 + G, 43.5 + G, W, 90, "panel"),
    block(149, 51, 163, 52.2, "accent"),
  ],
  texts: [text("pageCaption", SIX_CAPTION, "caption", "paper")],
};
