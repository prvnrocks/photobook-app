// Editorial A5 LANDSCAPE single pages (M30 T7). Minimal Swiss: 12 mm margins, white paper, photos
// on a strict grid or cut by one diagonal, a heavy sans heading, quiet text, short ink rules and
// the date turned a quarter in a strip at the page edge. Drawn in page mm through ../geometry.
// Either side of a page may be the fold: text keeps ≥ 12 mm from left and right.

import type { Layout, LayoutBlock, LayoutText } from "@/lib/book/types";
import { hairline, HAIR, LANDSCAPE, LINE, rule } from "../geometry";

const { W, H, rect, poly, block, text } = LANDSCAPE;

const base = { role: "page", style: "editorial", format: "A5_LANDSCAPE" } as const;

// --- shared grid ----------------------------------------------------------------------------------
const M = 12; // margin
const G = 4; // gutter between photos
const GRID = { x0: M, x1: 186, y0: M, y1: 118 }; // photo field of the grid pages (the date strip sits right of it)
const CAPTION = [M, 125, 160, 138] as const; // caption line under the photo field
/** The date turned a quarter, reading downwards, right of the photo field. */
const dateStrip = (y0 = M, y1 = 72): LayoutText => text("dateLabel", [193, y0, 200, y1], "year", "accent", { rotate: 90 });
/** Caption under the photo field with its short rule (the rule goes when there is no caption). */
const captionBlocks: LayoutBlock[] = [rule(M, 121.6, "pageCaption")];
const captionText = text("pageCaption", CAPTION, "caption", "ink");

/** `n` equal columns across x0..x1 with gutter G: the [left, right] of column i. */
const col = (i: number, n: number, x0: number = GRID.x0, x1: number = GRID.x1): [number, number] => {
  const w = (x1 - x0 - G * (n - 1)) / n;
  return [x0 + i * (w + G), x0 + i * (w + G) + w];
};
const ROWS: readonly [number, number][] = [
  [GRID.y0, 63],
  [67, GRID.y1],
];

// --- 1 photo --------------------------------------------------------------------------------------

/** One-diagonal text column (also the right-hand column of the pano spread). */
export const DIAGONAL_TEXT = {
  date: [132, 14, 198, 19],
  title: [132, 22, 198, 58],
  ruleY: 62,
  description: [132, 66, 198, 114],
  caption: [132, 118, 198, 138],
} as const;

/**
 * Chapter opener: the photo fills the left of the page and is cut by a diagonal (bleeds
 * top/left/bottom); a hairline runs parallel to the cut; date, heading, description and caption
 * in the column on white.
 */
export const editorialLandscapeOneDiagonal: Layout = {
  ...base,
  id: "ed-l-one-diagonal",
  name: "1 photo, diagonal cut + heading and story",
  photoCount: 1,
  prefers: ["any"],
  slots: [poly([[0, 0], [118, 0], [84, H], [0, H]])],
  caption: rect(...DIAGONAL_TEXT.caption),
  blocks: [hairline([125, 0], [91, H]), rule(132, DIAGONAL_TEXT.ruleY, "chapterDescription")],
  texts: [
    text("dateLabel", DIAGONAL_TEXT.date, "year", "accent"),
    text("chapterTitle", DIAGONAL_TEXT.title, "masthead", "ink"),
    text("chapterDescription", DIAGONAL_TEXT.description, "body", "muted"),
    text("pageCaption", DIAGONAL_TEXT.caption, "caption", "ink"),
  ],
};

/**
 * Chapter opener: a wide photo across the top (bleeds top/left/right) with the date in a white
 * strip; below it the heading on the left and the description, under a short rule, on the right.
 */
export const editorialLandscapeOneWide: Layout = {
  ...base,
  id: "ed-l-one-wide",
  name: "1 wide photo above heading + story columns",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W, 86)],
  caption: null,
  blocks: [block(182, 0, 195, 86, "paper", "over"), rule(102, 96, "chapterDescription")],
  texts: [
    text("dateLabel", [184.5, 8, 192.5, 78], "year", "accent", { rotate: 90 }),
    text("chapterTitle", [M, 96, 90, 138], "masthead", "ink"),
    text("chapterDescription", [102, 101, 198, 138], "body", "muted"),
  ],
};

/** Full-bleed photo with a white strip down the right: chapter title and date turned a quarter. */
export const editorialLandscapeOneBleed: Layout = {
  ...base,
  id: "ed-l-one-bleed",
  name: "1 photo full page, white strip with title",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: null,
  blocks: [block(172, 0, 188, H, "paper", "over")],
  texts: [
    text("chapterTitle", [175, 12, 185, 92], "chapter", "ink", { rotate: 90 }),
    text("dateLabel", [176.5, 98, 183.5, 136], "year", "accent", { rotate: 90, align: "end" }),
  ],
};

// --- 2 photos -------------------------------------------------------------------------------------

// One diagonal through the photo field: seam from (112, top) to (86, bottom), 3.2 mm of white.
const SEAM = { top: 112, bottom: 86, half: 1.6 };

/** Two photos cut by the same diagonal (complementary trapezoids, white gap); caption below. */
export const editorialLandscapeTwoDiagonal: Layout = {
  ...base,
  id: "ed-l-two-diagonal",
  name: "2 photos split by one diagonal",
  photoCount: 2,
  prefers: ["any", "any"],
  slots: [
    poly([[GRID.x0, GRID.y0], [SEAM.top - SEAM.half, GRID.y0], [SEAM.bottom - SEAM.half, GRID.y1], [GRID.x0, GRID.y1]]),
    poly([[SEAM.top + SEAM.half, GRID.y0], [GRID.x1, GRID.y0], [GRID.x1, GRID.y1], [SEAM.bottom + SEAM.half, GRID.y1]]),
  ],
  caption: rect(...CAPTION),
  blocks: captionBlocks,
  texts: [captionText, dateStrip()],
};

/** Two-notes geometry in page mm; `dx` shifts it onto the right page of the opener spread. */
export const twoNotes = (dx: number) => ({
  slots: [rect(dx + 118, M, dx + 186, 72), rect(dx + 118, 76, dx + 186, 136)],
  caption: rect(dx + M, 112, dx + 106, 136),
  blocks: [rule(dx + M, 52, "chapterDescription")],
  texts: [
    text("chapterTitle", [dx + M, 14, dx + 106, 47], "masthead", "ink"),
    text("chapterDescription", [dx + M, 57, dx + 106, 104], "body", "muted"),
    text("pageCaption", [dx + M, 112, dx + 106, 136], "caption", "ink"),
    text("dateLabel", [dx + 193, M, dx + 200, 72], "year", "accent", { rotate: 90 }),
  ],
});

/** Heading, description and caption on the left, two stacked photos on the right, date strip. */
export const editorialLandscapeTwoNotes: Layout = {
  ...base,
  id: "ed-l-two-notes",
  name: "2 photos stacked beside heading and story",
  photoCount: 2,
  prefers: ["any", "any"],
  ...twoNotes(0),
};

// --- 3 photos -------------------------------------------------------------------------------------

/** One tall photo and two stacked on a strict grid; caption under a short rule; date strip. */
export const editorialLandscapeThreeGrid: Layout = {
  ...base,
  id: "ed-l-three-grid",
  name: "3 photos, one tall + two stacked",
  photoCount: 3,
  prefers: ["portrait", "landscape", "landscape"],
  slots: [rect(GRID.x0, GRID.y0, 100, GRID.y1), rect(104, ROWS[0][0], GRID.x1, ROWS[0][1]), rect(104, ROWS[1][0], GRID.x1, ROWS[1][1])],
  caption: rect(...CAPTION),
  blocks: captionBlocks,
  texts: [captionText, dateStrip()],
};

/** Heading and caption over a full-width hairline, three tall photos in a row below. */
export const editorialLandscapeThreeRow: Layout = {
  ...base,
  id: "ed-l-three-row",
  name: "3 tall photos in a row under a heading",
  photoCount: 3,
  prefers: ["portrait", "portrait", "portrait"],
  slots: [0, 1, 2].map((i) => rect(col(i, 3)[0], 46, col(i, 3)[1], 136)),
  caption: rect(132, M, GRID.x1, 38),
  blocks: [block(M, 41.4, GRID.x1, 41.4 + HAIR, LINE)],
  texts: [
    text("chapterTitle", [M, M, 124, 38], "masthead", "ink"),
    text("pageCaption", [132, M, GRID.x1, 38], "caption", "ink", { align: "end" }),
    dateStrip(46, 106),
  ],
};

// --- 4 photos -------------------------------------------------------------------------------------

/** A narrow text column (heading, rule, caption, date turned a quarter) beside a 2 × 2 grid. */
export const editorialLandscapeFourGrid: Layout = {
  ...base,
  id: "ed-l-four-grid",
  name: "4 photos in a grid beside a text column",
  photoCount: 4,
  prefers: ["any", "any", "any", "any"],
  slots: [0, 1, 2, 3].map((i) => {
    const [x0, x1] = col(i % 2, 2, 68, 198);
    const y0 = i < 2 ? M : 76;
    return rect(x0, y0, x1, y0 + 60);
  }),
  caption: rect(M, 50, 60, 92),
  blocks: [rule(M, 45.6, "pageCaption")],
  texts: [
    text("chapterTitle", [M, M, 60, 42], "masthead", "ink"),
    text("pageCaption", [M, 50, 60, 92], "caption", "ink"),
    text("dateLabel", [M, 98, 19, 136], "year", "accent", { rotate: -90 }),
  ],
};

// --- 5 photos -------------------------------------------------------------------------------------

/** One tall photo and a 2 × 2 grid of small ones; caption under a short rule; date strip. */
export const editorialLandscapeFiveGrid: Layout = {
  ...base,
  id: "ed-l-five-grid",
  name: "5 photos, one tall + four small",
  photoCount: 5,
  prefers: ["portrait", "portrait", "portrait", "portrait", "portrait"],
  slots: [
    rect(GRID.x0, GRID.y0, 90, GRID.y1),
    ...[0, 1, 2, 3].map((i) => rect(col(i % 2, 2, 94)[0], ROWS[i < 2 ? 0 : 1][0], col(i % 2, 2, 94)[1], ROWS[i < 2 ? 0 : 1][1])),
  ],
  caption: rect(...CAPTION),
  blocks: captionBlocks,
  texts: [captionText, dateStrip()],
};

// --- 6 photos -------------------------------------------------------------------------------------

/** Six photos on a 3 × 2 grid with generous margins; caption under a short rule; date strip. */
export const editorialLandscapeSixGrid: Layout = {
  ...base,
  id: "ed-l-six-grid",
  name: "6 photos, 3 × 2 grid",
  photoCount: 6,
  prefers: ["landscape", "landscape", "landscape", "landscape", "landscape", "landscape"],
  slots: [0, 1, 2, 3, 4, 5].map((i) => rect(col(i % 3, 3)[0], ROWS[i < 3 ? 0 : 1][0], col(i % 3, 3)[1], ROWS[i < 3 ? 0 : 1][1])),
  caption: rect(...CAPTION),
  blocks: captionBlocks,
  texts: [captionText, dateStrip()],
};
