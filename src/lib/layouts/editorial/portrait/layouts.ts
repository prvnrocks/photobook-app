// Editorial A5 PORTRAIT layouts (M30 T6, D-090). Pure data, original artwork in the manner of
// docs/design/refs/mg-covers.jpg: lots of white, one confident photo cut by a diagonal, heavy sans
// titles (masthead role = Poppins 700 sentence case), small quiet text, hairlines, a vertical strip
// with the date turned a quarter.
//
// Drawn in page mm (148 × 210, y down) through ./geometry. Text keeps 12 mm from the left/right
// trim and 14 mm from top/bottom. Rules are `ink` (the default colourway's accent is near-white).
// Text panels centre their text vertically, so boxes are kept close to the expected text height.
// Every chapter opener still reads as a finished page when the chapter has no description: the
// short rule collapses with it (`when`) and the description sits where white space is natural.

import type { Layout, LayoutBlock, LayoutText } from "@/lib/book/types";
import { diagRule, hRule, poly, rect, vRule, H, W, type Pt } from "./geometry";

// --- the style's diagonal ---------------------------------------------------------------------------
/** Slope of every big cut: rises 54 mm across the page width. */
const SLOPE = -54 / W;
/** A line of the style's slope through (0, y0), from x0 to x1. */
const cutLine = (y0: number, x0 = 0, x1 = W): [Pt, Pt] => [
  [x0, y0 + SLOPE * x0],
  [x1, y0 + SLOPE * x1],
];
/** Photo below a cut starting at (0, y0): bleeds left / right / bottom. */
const below = (y0: number): Pt[] => [...cutLine(y0), [W, H], [0, H]];
/** Photo above a cut starting at (0, y0): bleeds left / right / top. */
const above = (y0: number): Pt[] => [[0, 0], [W, 0], cutLine(y0)[1], cutLine(y0)[0]];
/** Distance (mm, vertical) between a cut and its echo hairline. */
const ECHO = 7;

// --- the Swiss grid pages: date strip + hairline on the left, photos in two 52 mm columns -----------
const STRIP_DATE: LayoutText = { bind: "dateLabel", box: rect(12, 14, 20, 84), align: "end", font: "year", ink: "muted", rotate: -90 };
const STRIP_RULE: LayoutBlock = vRule(23, 14, 196);
const COL1: [number, number] = [28, 80];
const COL2: [number, number] = [84, 136];

// --- cover ------------------------------------------------------------------------------------------

/**
 * Auto cover: white page, heavy title top left, the date turned a quarter on the right, two small
 * cover lines under a short rule, and the photo as a large trapezoid rising from the foot with a
 * hairline echoing its cut.
 */
export const editorialPortraitCover: Layout = {
  id: "ed-p-cover",
  name: "Cover: diagonal photo, heavy title",
  role: "cover",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [poly(below(140))],
  caption: rect(12, 16, 120, 66),
  blocks: [diagRule(...cutLine(140 - ECHO)), hRule(12, 26, 73, { when: "coverLine", mm: 0.6 })],
  texts: [
    { bind: "coverTitle", box: rect(12, 16, 120, 66), align: "start", font: "masthead", ink: "ink" },
    { bind: "coverSubtitle", box: rect(128, 16, 136, 72), align: "start", font: "year", ink: "muted", rotate: 90 },
    { bind: "coverLine", n: 0, box: rect(12, 78, 84, 84.5), align: "start", font: "subtitle", ink: "ink" },
    { bind: "coverLine", n: 1, box: rect(12, 86, 84, 92.5), align: "start", font: "subtitle", ink: "muted" },
  ],
};

// --- 1 photo ----------------------------------------------------------------------------------------

/** Chapter opener: title, short rule and description on white, the diagonal photo below; date turned a quarter. */
export const editorialPortraitOneOpener: Layout = {
  id: "ed-p-one-opener",
  name: "Chapter opener: text above a diagonal photo",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [poly(below(138))],
  caption: null,
  blocks: [diagRule(...cutLine(138 - ECHO)), hRule(12, 26, 47, { when: "chapterDescription", mm: 0.6 })],
  texts: [
    { bind: "chapterTitle", box: rect(12, 14, 116, 42), align: "start", font: "masthead", ink: "ink" },
    { bind: "chapterDescription", box: rect(12, 53, 98, 91), align: "start", font: "body", ink: "muted" },
    { bind: "dateLabel", box: rect(128, 14, 136, 66), align: "start", font: "year", ink: "muted", rotate: 90 },
  ],
};

const COLUMN_CAPTION = rect(84, 148, 136, 180);
/** Chapter opener: tall photo bleeding on the left, text column on the right with a short rule. */
export const editorialPortraitOneColumn: Layout = {
  id: "ed-p-one-column",
  name: "Chapter opener: tall photo + text column",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [rect(0, 0, 72, H)],
  caption: COLUMN_CAPTION,
  blocks: [hRule(84, 98, 66, { when: "chapterDescription", mm: 0.6 })],
  texts: [
    { bind: "chapterTitle", box: rect(84, 14, 136, 60), align: "start", font: "masthead", ink: "ink" },
    { bind: "chapterDescription", box: rect(84, 72, 136, 132), align: "start", font: "body", ink: "muted" },
    { bind: "pageCaption", box: COLUMN_CAPTION, align: "start", font: "caption", ink: "ink" },
    { bind: "dateLabel", box: rect(84, 189, 136, 196), align: "start", font: "year", ink: "muted" },
  ],
};

const DIAGONAL_PHOTO = above(172);
const DIAGONAL_CAPTION = rect(12, 180, 104, 198);
const DIAGONAL_DATE = rect(128, 138, 136, 196);
/** One photo from the top, cut by the diagonal; caption in the white wedge below, date turned a quarter. */
export const editorialPortraitOneDiagonal: Layout = {
  id: "ed-p-one-diagonal",
  name: "1 photo, diagonal cut + caption",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [poly(DIAGONAL_PHOTO)],
  caption: DIAGONAL_CAPTION,
  blocks: [diagRule(...cutLine(172 + ECHO))],
  texts: [
    { bind: "pageCaption", box: DIAGONAL_CAPTION, align: "start", font: "caption", ink: "ink" },
    { bind: "dateLabel", box: DIAGONAL_DATE, align: "start", font: "year", ink: "muted", rotate: -90 },
  ],
};

/** Full-bleed photo with a white vertical strip carrying the date and the chapter title, both turned a quarter. */
export const editorialPortraitOneStrip: Layout = {
  id: "ed-p-one-strip",
  name: "1 photo, full bleed + white strip",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: null,
  blocks: [{ box: rect(112, 0, 132, 152), fill: "paper", layer: "over" }],
  texts: [
    { bind: "dateLabel", box: rect(118, 12, 126, 58), align: "start", font: "year", ink: "muted", rotate: 90 },
    { bind: "chapterTitle", box: rect(116, 64, 128, 144), align: "start", font: "chapter", ink: "ink", rotate: 90 },
  ],
};

// --- 2 photos ---------------------------------------------------------------------------------------

const TWO_CUT = 116;
const TWO_GAP = 5;
const TWO_FOOT = 168;
const TWO_CAPTION = rect(12, 176, 100, 198);
/** Two photos cut by the same diagonal: complementary trapezoids with a white gap; caption and date below. */
export const editorialPortraitTwoDiagonal: Layout = {
  id: "ed-p-two-diagonal",
  name: "2 photos, one diagonal",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["any", "any"],
  slots: [poly(above(TWO_CUT)), poly([...cutLine(TWO_CUT + TWO_GAP), [W, TWO_FOOT], [0, TWO_FOOT]])],
  caption: TWO_CAPTION,
  texts: [
    { bind: "pageCaption", box: TWO_CAPTION, align: "start", font: "caption", ink: "ink" },
    { bind: "dateLabel", box: rect(104, 176, 136, 183), align: "end", font: "year", ink: "muted" },
  ],
};

const STACK_CAPTION = rect(100, 150, 136, 196);
/** Swiss stack: a wide photo bleeding right, a portrait photo below it, chapter title and caption beside; date strip. */
export const editorialPortraitTwoStack: Layout = {
  id: "ed-p-two-stack",
  name: "2 photos, Swiss stack + date strip",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["landscape", "portrait"],
  slots: [rect(28, 14, W, 98), rect(28, 104, 92, 196)],
  caption: STACK_CAPTION,
  blocks: [STRIP_RULE],
  texts: [
    STRIP_DATE,
    { bind: "chapterTitle", box: rect(100, 104, 136, 140), align: "start", font: "chapter", ink: "ink" },
    { bind: "pageCaption", box: STACK_CAPTION, align: "start", font: "caption", ink: "ink" },
  ],
};

/** Chapter opener for two photos: the pair on top, title, short rule and description below; date turned a quarter. */
export const editorialPortraitTwoOpener: Layout = {
  id: "ed-p-two-opener",
  name: "Chapter opener: two photos above the text",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["portrait", "portrait"],
  slots: [rect(12, 14, 72, 104), rect(76, 14, 136, 104)],
  caption: null,
  blocks: [hRule(12, 26, 147, { when: "chapterDescription", mm: 0.6 })],
  texts: [
    { bind: "chapterTitle", box: rect(12, 114, 120, 142), align: "start", font: "masthead", ink: "ink" },
    { bind: "chapterDescription", box: rect(12, 153, 104, 193), align: "start", font: "body", ink: "muted" },
    { bind: "dateLabel", box: rect(128, 114, 136, 170), align: "start", font: "year", ink: "muted", rotate: 90 },
  ],
};

// --- 3 photos ---------------------------------------------------------------------------------------

const THREE_COL_CAPTION = rect(28, 168, 124, 196);
/** Swiss grid: one tall photo and two stacked beside it; date strip and caption. */
export const editorialPortraitThreeColumn: Layout = {
  id: "ed-p-three-column",
  name: "3 photos, tall + two stacked",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["portrait", "portrait", "portrait"],
  slots: [rect(28, 14, 86, 160), rect(90, 14, 136, 85), rect(90, 89, 136, 160)],
  caption: THREE_COL_CAPTION,
  blocks: [STRIP_RULE],
  texts: [STRIP_DATE, { bind: "pageCaption", box: THREE_COL_CAPTION, align: "start", font: "caption", ink: "ink" }],
};

// A flatter diagonal shared by all three photos: the big one ends on it, the two below start 5 mm under it.
const T3_SLOPE = -40 / W;
const t3 = (x: number, off = 0): Pt => [x, 104 + off + T3_SLOPE * x];
const T3_FOOT = 174;
const T3_CAPTION = rect(12, 180, 100, 198);
/** One diagonal for three photos: a wide photo cut along it, two smaller ones stepping up under it. */
export const editorialPortraitThreeDiagonal: Layout = {
  id: "ed-p-three-diagonal",
  name: "3 photos under one diagonal",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["any", "portrait", "portrait"],
  slots: [
    poly([[0, 0], [W, 0], t3(W), t3(0)]),
    poly([t3(12, 5), t3(72, 5), [72, T3_FOOT], [12, T3_FOOT]]),
    poly([t3(76, 5), t3(136, 5), [136, T3_FOOT], [76, T3_FOOT]]),
  ],
  caption: T3_CAPTION,
  texts: [
    { bind: "pageCaption", box: T3_CAPTION, align: "start", font: "caption", ink: "ink" },
    { bind: "dateLabel", box: rect(104, 180, 136, 187), align: "end", font: "year", ink: "muted" },
  ],
};

// --- 4 / 5 / 6 photos -------------------------------------------------------------------------------

const FOUR_CAPTION = rect(COL1[0], 172, COL1[1], 196);
/** Swiss grid, staggered: two columns of two, the right one set 20 mm lower under the chapter title. */
export const editorialPortraitFourStagger: Layout = {
  id: "ed-p-four-stagger",
  name: "4 photos, staggered columns",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 4,
  prefers: ["portrait", "portrait", "portrait", "portrait"],
  slots: [
    rect(COL1[0], 14, COL1[1], 88),
    rect(COL2[0], 34, COL2[1], 108),
    rect(COL1[0], 92, COL1[1], 166),
    rect(COL2[0], 112, COL2[1], 186),
  ],
  caption: FOUR_CAPTION,
  blocks: [STRIP_RULE],
  texts: [
    STRIP_DATE,
    { bind: "chapterTitle", box: rect(COL2[0], 14, COL2[1], 30), align: "start", font: "chapter", ink: "ink" },
    { bind: "pageCaption", box: FOUR_CAPTION, align: "start", font: "caption", ink: "ink" },
  ],
};

const FIVE_CAPTION = rect(28, 182, 136, 198);
/** Swiss grid: one wide photo over a 2 × 2 block; date strip and caption. */
export const editorialPortraitFiveGrid: Layout = {
  id: "ed-p-five-grid",
  name: "5 photos, wide + four",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 5,
  prefers: ["landscape", "landscape", "landscape", "landscape", "landscape"],
  slots: [
    rect(28, 14, 136, 84),
    rect(COL1[0], 88, COL1[1], 130),
    rect(COL2[0], 88, COL2[1], 130),
    rect(COL1[0], 134, COL1[1], 176),
    rect(COL2[0], 134, COL2[1], 176),
  ],
  caption: FIVE_CAPTION,
  blocks: [STRIP_RULE],
  texts: [STRIP_DATE, { bind: "pageCaption", box: FIVE_CAPTION, align: "start", font: "caption", ink: "ink" }],
};

const SIX_CAPTION = rect(28, 184, 136, 198);
/** Swiss grid: 2 × 3 squares with generous margins; date strip and caption. */
export const editorialPortraitSixGrid: Layout = {
  id: "ed-p-six-grid",
  name: "6 photos, square grid",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 6,
  prefers: ["any", "any", "any", "any", "any", "any"],
  slots: [14, 70, 126].flatMap((y) => [rect(COL1[0], y, COL1[1], y + 52), rect(COL2[0], y, COL2[1], y + 52)]),
  caption: SIX_CAPTION,
  blocks: [STRIP_RULE],
  texts: [STRIP_DATE, { bind: "pageCaption", box: SIX_CAPTION, align: "start", font: "caption", ink: "ink" }],
};

// --- spreads (x 0..296 mm, fold at 148) ---------------------------------------------------------------

const PANO_CAPTION = rect(W + 84, 84, W + 136, 130);
/**
 * Panorama across the fold (plain rect, full height, bleeding left) with a title block on the
 * white column at the right: date, heavy chapter title, short rule, caption and a small photo.
 * Splits into the full-bleed strip page and the photo + text-column page.
 */
export const editorialPortraitSpreadPanorama: Layout = {
  id: "ed-p-spread-panorama",
  name: "Spread: panorama + title column",
  role: "spread",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["landscape", "any"],
  slots: [rect(0, 0, W + 72, H), rect(W + 84, 140, W + 136, 196)],
  caption: PANO_CAPTION,
  twin: ["ed-p-one-strip", "ed-p-one-column"],
  blocks: [hRule(W + 84, W + 98, 76, { mm: 0.6 })],
  texts: [
    { bind: "dateLabel", box: rect(W + 84, 14, W + 136, 21), align: "start", font: "year", ink: "muted" },
    { bind: "chapterTitle", box: rect(W + 84, 24, W + 136, 70), align: "start", font: "masthead", ink: "ink" },
    { bind: "pageCaption", box: PANO_CAPTION, align: "start", font: "caption", ink: "ink" },
  ],
};

/**
 * Opener spread: the big diagonal-cut photo fills the left page (caption and date in the wedge
 * below), the right page carries two photos above the chapter title, short rule and description.
 * Exactly ed-p-one-diagonal + ed-p-two-opener.
 */
export const editorialPortraitSpreadOpener: Layout = {
  id: "ed-p-spread-opener",
  name: "Spread: diagonal photo + chapter opener",
  role: "spread",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["any", "portrait", "portrait"],
  slots: [poly(DIAGONAL_PHOTO), rect(W + 12, 14, W + 72, 104), rect(W + 76, 14, W + 136, 104)],
  caption: DIAGONAL_CAPTION,
  twin: ["ed-p-one-diagonal", "ed-p-two-opener"],
  blocks: [diagRule(...cutLine(172 + ECHO)), hRule(W + 12, W + 26, 147, { when: "chapterDescription", mm: 0.6 })],
  texts: [
    { bind: "pageCaption", box: DIAGONAL_CAPTION, align: "start", font: "caption", ink: "ink" },
    { bind: "dateLabel", box: DIAGONAL_DATE, align: "start", font: "year", ink: "muted", rotate: -90 },
    { bind: "chapterTitle", box: rect(W + 12, 114, W + 136, 142), align: "start", font: "masthead", ink: "ink" },
    { bind: "chapterDescription", box: rect(W + 12, 153, W + 104, 193), align: "start", font: "body", ink: "muted" },
  ],
};
