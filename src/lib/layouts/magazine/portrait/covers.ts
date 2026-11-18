// Magazine A5 PORTRAIT covers (M30 T4, D-090; ref docs/design/refs/mg-5.jpg = ideas only). Pure
// data, drawn in page mm through ./geometry. The auto cover (mg-p-cover) + three user-chosen styles
// (autoPick: false). Masthead = cover title (Archivo Black caps), issue line = cover subtitle,
// cover lines = chapter titles (coverLine n).
//
// A block's `when: "coverLine"` looks at chapter 0 only, so every block that exists for cover lines
// carries line n = 0 (the foot strip's first teaser, the window cover's tab): a book without
// chapters loses the block, and no white strip is ever left empty.

import type { Layout } from "@/lib/book/types";
import { H, M, rect, W } from "./geometry";

const FULL = rect(0, 0, W, H);
/** Three teaser columns across the page foot (40 mm each). */
const footCols = (y0: number, y1: number) => [rect(M, y0, 50, y1), rect(54, y0, 94, y1), rect(98, y0, W - M, y1)] as const;

// --- auto cover -----------------------------------------------------------------------------------
const COVER_FOOT = footCols(189, 203);

/**
 * Full-bleed photo; issue line + accent rule and the huge white masthead across the top; three
 * cover lines stacked down the right edge (the middle one in the vivid accent); a white foot strip
 * with up to three teaser columns (the strip goes when the book has no chapters).
 */
export const magazinePortraitCover: Layout = {
  id: "mg-p-cover",
  name: "Cover: masthead over full-bleed photo",
  role: "cover",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [FULL],
  caption: rect(M, 9, W - M, 72),
  blocks: [
    { box: rect(M, 16.6, 28, 17.6), fill: "accent", layer: "over" },
    { box: rect(0, 178, W, H), fill: "paper", layer: "over", when: "coverLine" },
    { box: rect(M, 184, 22, 185), fill: "ink", layer: "over", when: "coverLine" },
  ],
  texts: [
    { bind: "coverSubtitle", box: rect(M, 9, W - M, 14.5), align: "start", font: "year", ink: "accentOnDark" },
    { bind: "coverTitle", box: rect(M, 20, W - M, 72), align: "start", font: "masthead", ink: "paper" },
    { bind: "coverLine", n: 1, box: rect(76, 86, W - M, 104), align: "end", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 2, box: rect(76, 107, W - M, 125), align: "end", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 3, box: rect(76, 128, W - M, 146), align: "end", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 0, box: COVER_FOOT[0], align: "start", font: "chapter", ink: "ink" },
    { bind: "coverLine", n: 4, box: COVER_FOOT[1], align: "start", font: "chapter", ink: "ink" },
    { bind: "coverLine", n: 5, box: COVER_FOOT[2], align: "start", font: "chapter", ink: "ink" },
  ],
};

// --- user covers (autoPick: false) ----------------------------------------------------------------
const BAND_FOOT = footCols(190, 203);

/** Photo above a dark band: issue line, accent rule and masthead on the band, three cover lines at its foot. */
export const magazinePortraitCoverBand: Layout = {
  id: "mg-p-cover-band",
  name: "Cover: masthead on a dark band below the photo",
  role: "cover",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [rect(0, 0, W, 128)],
  caption: rect(M, 136, W - M, 186),
  blocks: [
    { box: rect(0, 128, W, H), fill: "panel", layer: "under" },
    { box: rect(M, 143.6, 28, 144.6), fill: "accent", layer: "under" },
  ],
  texts: [
    { bind: "coverSubtitle", box: rect(M, 136, W - M, 141.5), align: "start", font: "year", ink: "accentOnDark" },
    { bind: "coverTitle", box: rect(M, 148, W - M, 186), align: "start", font: "masthead", ink: "paper" },
    { bind: "coverLine", n: 0, box: BAND_FOOT[0], align: "start", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 1, box: BAND_FOOT[1], align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 2, box: BAND_FOOT[2], align: "start", font: "chapter", ink: "paper" },
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
  role: "cover",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [rect(M, 72, W - M, 180)],
  caption: rect(M, 10, W - M, 66),
  blocks: [
    { box: rect(M, 17.6, 28, 18.6), fill: "ink", layer: "under" },
    { box: rect(86, 148, W, 174), fill: "panel", layer: "over", when: "coverLine" },
  ],
  texts: [
    { bind: "coverSubtitle", box: rect(M, 10, W - M, 15.5), align: "start", font: "year", ink: "accent" },
    { bind: "coverTitle", box: rect(M, 21, W - M, 66), align: "start", font: "masthead", ink: "ink" },
    { bind: "coverLine", n: 0, box: rect(92, 152, 142, 170), align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 1, box: WINDOW_FOOT[0], align: "start", font: "chapter", ink: "ink" },
    { bind: "coverLine", n: 2, box: WINDOW_FOOT[1], align: "start", font: "chapter", ink: "accent" },
    { bind: "coverLine", n: 3, box: WINDOW_FOOT[2], align: "start", font: "chapter", ink: "ink" },
  ],
  autoPick: false,
};

const SPLIT_X = 96;
const splitLine = (i: number) => rect(SPLIT_X + 6, 86 + i * 26, W - 8, 106 + i * 26);

/**
 * Split cover: the photo on the left, a dark side column on the right with four cover lines; the
 * masthead runs across both under the issue line.
 */
export const magazinePortraitCoverSplit: Layout = {
  id: "mg-p-cover-split",
  name: "Cover: photo + dark side column of cover lines",
  role: "cover",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [rect(0, 0, SPLIT_X, H)],
  caption: rect(M, 10, W - M, 68),
  blocks: [
    { box: rect(SPLIT_X, 0, W, H), fill: "panel", layer: "under" },
    { box: rect(M, 17.6, 28, 18.6), fill: "accent", layer: "over" },
    { box: rect(SPLIT_X + 6, 80, SPLIT_X + 20, 81), fill: "accent", layer: "over", when: "coverLine" },
  ],
  texts: [
    { bind: "coverSubtitle", box: rect(M, 10, W - M, 15.5), align: "start", font: "year", ink: "accentOnDark" },
    { bind: "coverTitle", box: rect(M, 22, W - M, 68), align: "start", font: "masthead", ink: "paper" },
    { bind: "coverLine", n: 0, box: splitLine(0), align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 1, box: splitLine(1), align: "start", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 2, box: splitLine(2), align: "start", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 3, box: splitLine(3), align: "start", font: "chapter", ink: "paper" },
  ],
  autoPick: false,
};
