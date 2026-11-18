// Magazine A5 PORTRAIT covers (M30 T4, D-090; ref docs/design/refs/mg-5.jpg = ideas only). Pure
// data, drawn in page mm through ../geometry. The auto cover (mg-p-cover) + three user-chosen styles
// (autoPick: false). Masthead = cover title (Archivo Black caps), issue line = cover subtitle,
// cover lines = chapter titles (coverLine n).
//
// A block's `when: "coverLine"` looks at chapter 0 only, so every block that exists for cover lines
// carries line n = 0 (the foot strip's first teaser, the window cover's tab): a book without
// chapters loses the block, and no white strip is ever left empty.

import type { Layout } from "@/lib/book/types";
import { M, PORTRAIT } from "../geometry";

const { W, H, rect, block, text } = PORTRAIT;
const COVER = { role: "cover", style: "magazine", format: "A5_PORTRAIT" } as const;

const FULL = rect(0, 0, W, H);
/** Three teaser columns across the page foot (40 mm each). */
const footCols = (y0: number, y1: number) => [rect(M, y0, 50, y1), rect(54, y0, 94, y1), rect(98, y0, W - M, y1)] as const;

// --- auto cover -----------------------------------------------------------------------------------
const COVER_FOOT = footCols(189, 203);
/** Cover-line tabs down the right edge: 16 mm tall, flush with the trim; tab i starts at y. */
const TAB_Y = [88, 107, 126];
const tab = (i: number, fill: "panel" | "accent") => block(78, TAB_Y[i], W, TAB_Y[i] + 16, fill, "over", "coverLine", i + 1);
const tabLine = (i: number, ink: "paper" | "ink") =>
  text("coverLine", [84, TAB_Y[i] + 2, W - M, TAB_Y[i] + 14], "chapter", ink, { n: i + 1, align: "end" });

/**
 * Full-bleed photo under a magazine head: a dark top bar with the issue line in the accent, an
 * accent hairline, then the huge white masthead on a flat scrim band — legible on any photo (pale
 * sky, snow, busy streets). Up to three cover lines sit on tabs flush with the right edge (dark /
 * accent / dark, each tab only with its line); a white foot strip carries up to three teaser
 * columns (the strip goes when the book has no chapters).
 */
export const magazinePortraitCover: Layout = {
  id: "mg-p-cover",
  name: "Cover: masthead over full-bleed photo",
  ...COVER,
  photoCount: 1,
  prefers: ["portrait"],
  slots: [FULL],
  caption: rect(M, 4.5, W - M, 72),
  blocks: [
    block(0, 0, W, 15, "panel", "over"),
    block(0, 15, W, 16, "accent", "over"),
    block(0, 16, W, 76, "scrim", "over"),
    tab(0, "panel"),
    tab(1, "accent"),
    tab(2, "panel"),
    block(0, 178, W, H, "paper", "over", "coverLine"),
    block(M, 184, 22, 185, "ink", "over", "coverLine"),
  ],
  texts: [
    text("coverSubtitle", [M, 4.5, W - M, 10.5], "year", "accentOnDark"),
    text("coverTitle", [M, 20, W - M, 72], "masthead", "paper"),
    tabLine(0, "paper"),
    tabLine(1, "ink"),
    tabLine(2, "paper"),
    text("coverLine", COVER_FOOT[0], "chapter", "ink", { n: 0 }),
    text("coverLine", COVER_FOOT[1], "chapter", "ink", { n: 4 }),
    text("coverLine", COVER_FOOT[2], "chapter", "ink", { n: 5 }),
  ],
};

// --- user covers (autoPick: false) ----------------------------------------------------------------
const BAND_FOOT = footCols(190, 203);

/** Photo above a dark band: issue line, accent rule and masthead on the band, three cover lines at its foot. */
export const magazinePortraitCoverBand: Layout = {
  id: "mg-p-cover-band",
  name: "Cover: masthead on a dark band below the photo",
  ...COVER,
  photoCount: 1,
  prefers: ["any"],
  slots: [rect(0, 0, W, 128)],
  caption: rect(M, 136, W - M, 186),
  blocks: [
    block(0, 128, W, H, "panel"),
    block(M, 143.6, 28, 144.6, "accent"),
  ],
  texts: [
    text("coverSubtitle", [M, 136, W - M, 141.5], "year", "accentOnDark"),
    text("coverTitle", [M, 148, W - M, 186], "masthead", "paper"),
    text("coverLine", BAND_FOOT[0], "chapter", "paper", { n: 0 }),
    text("coverLine", BAND_FOOT[1], "chapter", "accentOnDark", { n: 1 }),
    text("coverLine", BAND_FOOT[2], "chapter", "paper", { n: 2 }),
  ],
  autoPick: false,
};

const WINDOW_FOOT = footCols(187, 202);

/**
 * White paper: issue line, ink rule and the masthead in ink above a photo window; a dark tab on the
 * window's lower right edge carries the first cover line, three more sit under the window.
 */
export const magazinePortraitCoverWindow: Layout = {
  id: "mg-p-cover-window",
  name: "Cover: ink masthead above a photo window",
  ...COVER,
  photoCount: 1,
  prefers: ["any"],
  slots: [rect(M, 72, W - M, 180)],
  caption: rect(M, 10, W - M, 66),
  blocks: [
    block(M, 17.6, 28, 18.6, "ink"),
    block(86, 148, W, 174, "panel", "over", "coverLine"),
  ],
  texts: [
    text("coverSubtitle", [M, 10, W - M, 15.5], "year", "accent"),
    text("coverTitle", [M, 21, W - M, 66], "masthead", "ink"),
    text("coverLine", [92, 152, 142, 170], "chapter", "accentOnDark", { n: 0 }),
    text("coverLine", WINDOW_FOOT[0], "chapter", "ink", { n: 1 }),
    text("coverLine", WINDOW_FOOT[1], "chapter", "accent", { n: 2 }),
    text("coverLine", WINDOW_FOOT[2], "chapter", "ink", { n: 3 }),
  ],
  autoPick: false,
};

const SPLIT_X = 96;
const SPLIT_Y = 74;
const splitLine = (i: number) => rect(SPLIT_X + 6, 86 + i * 26, W - 8, 106 + i * 26);

/**
 * Split cover: a dark page with the issue line and the masthead across the top, the photo in the
 * lower left and four cover lines down the dark side column on the right.
 */
export const magazinePortraitCoverSplit: Layout = {
  id: "mg-p-cover-split",
  name: "Cover: photo + dark side column of cover lines",
  ...COVER,
  photoCount: 1,
  prefers: ["portrait"],
  slots: [rect(0, SPLIT_Y, SPLIT_X, H)],
  caption: rect(M, 10, W - M, 68),
  blocks: [
    block(0, 0, W, H, "panel"),
    block(M, 17.6, 28, 18.6, "accent", "over"),
    block(SPLIT_X + 6, 80, SPLIT_X + 20, 81, "accent", "over", "coverLine"),
  ],
  texts: [
    text("coverSubtitle", [M, 10, W - M, 15.5], "year", "accentOnDark"),
    text("coverTitle", [M, 22, W - M, 68], "masthead", "paper"),
    text("coverLine", splitLine(0), "chapter", "accentOnDark", { n: 0 }),
    text("coverLine", splitLine(1), "chapter", "paper", { n: 1 }),
    text("coverLine", splitLine(2), "chapter", "paper", { n: 2 }),
    text("coverLine", splitLine(3), "chapter", "paper", { n: 3 }),
  ],
  autoPick: false,
};
