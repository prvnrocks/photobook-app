// modern/portrait layouts (M10b A5). Pure data, original artwork. Append-only order (AI catalogue / prompt cache).
//
// Designed in millimetres on the A5 portrait trim (148 × 210 mm) and converted to % by ./geometry:
// thin white gutters of GUTTER_MM (2.5 mm) between photos in both directions, MARGIN_MM (8 mm) outer
// margin on the framed layouts; full-bleed photos sit exactly on the trim edge so book/bleed.ts
// extends them 3 mm into the bleed (same rule as classic full-page).
//
// Text panels (`texts`) bind to existing doc data only. Rules (tests/layouts-modern-portrait.test.ts):
// - a `pageCaption` panel has exactly the layout's `caption` box (same area, typed with a font role
//   and alignment) → renderers draw the page caption once, in that panel's style;
// - cover `caption` = the union of the coverTitle + coverSubtitle panels, so today's <BookCover>
//   (which positions title + subtitle in layout.caption) keeps working until panels render (A9);
// - text stays ≥ 4 mm inside the trim and ≥ 8 mm from the fold (single pages: from both side edges,
//   since a page may land on either side; spreads: from x = 100).
//
// Split-strip covers (m-p-cover-strips): `doc.cover` holds ONE photo, so the cover has one slot
// (the union box of the strips) and `slices` = the strip windows (A9 slice model, shared with the
// landscape m-l-cover-strip). The renderer lays the photo out cover-fit over the slot and clips it
// to each slice.
//
// Spreads: x runs 0..200 across both pages (fold at 100). The fold carries the same thin gutter,
// centred on it (1.25 mm per page). Slots are ordered left page first, then right page, so the
// halves are contiguous; `twin` single layouts hold at least the photos whose slot centre lies in
// their half (rectHalf), and the left twin has a caption area when the spread's caption is left.

import type { Layout } from "@/lib/book/types";
import { cells, FOLD_LEFT_MM, FOLD_RIGHT_MM, GUTTER_MM, MARGIN_MM as M, mmRect, PAGE_H_MM as H, PAGE_W_MM as W } from "./geometry";

const SPREAD_W = 2 * W;

// --- Single pages --------------------------------------------------------------------------------

/** One photo bleeding off every edge. */
export const modernFull: Layout = {
  id: "m-p-full",
  name: "Full-bleed photo",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [mmRect(0, 0, W, H)],
  caption: null,
};

const bandCaption = mmRect(14, 162, 134, 190);
/** A wide landscape band bleeding left/right, chapter title + date above, caption below. */
export const modernOneBand: Layout = {
  id: "m-p-one-band",
  name: "1 wide photo with title and caption",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [mmRect(0, 54, W, 152)],
  caption: bandCaption,
  texts: [
    { bind: "chapterTitle", box: mmRect(12, 22, 136, 36), align: "center", font: "chapter" },
    { bind: "dateLabel", box: mmRect(12, 37, 136, 45), align: "center", font: "subtitle" },
    { bind: "pageCaption", box: bandCaption, align: "center", font: "caption" },
  ],
};

const halfRows = cells(0, H, 2);
/** Two landscape photos stacked, full bleed, one thin gutter. */
export const modernTwoStack: Layout = {
  id: "m-p-two-stack",
  name: "2 wide photos stacked",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["landscape", "landscape"],
  slots: halfRows.map(([y0, y1]) => mmRect(0, y0, W, y1)),
  caption: null,
};

const halfCols = cells(0, W, 2);
const twoPanelCaption = mmRect(12, 158, 136, 196);
/** Two tall photos bleeding off the top, text panel (chapter, date, caption) below. */
export const modernTwoPanel: Layout = {
  id: "m-p-two-panel",
  name: "2 tall photos with text panel",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["portrait", "portrait"],
  slots: halfCols.map(([x0, x1]) => mmRect(x0, 0, x1, 118)),
  caption: twoPanelCaption,
  texts: [
    { bind: "chapterTitle", box: mmRect(12, 128, 136, 142), align: "start", font: "chapter" },
    { bind: "dateLabel", box: mmRect(12, 143, 136, 151), align: "start", font: "subtitle" },
    { bind: "pageCaption", box: twoPanelCaption, align: "start", font: "caption" },
  ],
};

const mosaicTopEnd = 112;
/** One landscape on top, two portraits below, full bleed. */
export const modernThreeMosaic: Layout = {
  id: "m-p-three-mosaic",
  name: "1 wide + 2 tall, full bleed",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["landscape", "portrait", "portrait"],
  slots: [mmRect(0, 0, W, mosaicTopEnd), ...halfCols.map(([x0, x1]) => mmRect(x0, mosaicTopEnd + GUTTER_MM, x1, H))],
  caption: null,
};

const threePanelBigRight = 88;
const threePanelBottom = 150;
const threePanelCaption = mmRect(M, 184, W - M, 202);
/** One tall photo + two stacked on the right inside a margin, text panel underneath. */
export const modernThreePanel: Layout = {
  id: "m-p-three-panel",
  name: "3 photos with text panel",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["portrait", "portrait", "portrait"],
  slots: [
    mmRect(M, M, threePanelBigRight, threePanelBottom),
    ...cells(M, threePanelBottom, 2).map(([y0, y1]) => mmRect(threePanelBigRight + GUTTER_MM, y0, W - M, y1)),
  ],
  caption: threePanelCaption,
  texts: [
    { bind: "chapterTitle", box: mmRect(M, 160, W - M, 172), align: "start", font: "chapter" },
    { bind: "dateLabel", box: mmRect(M, 173, W - M, 180), align: "start", font: "subtitle" },
    { bind: "pageCaption", box: threePanelCaption, align: "start", font: "caption" },
  ],
};

const marginCols = cells(M, W - M, 2);
const fourCaption = mmRect(M, 178, W - M, 200);
/** 2×2 grid inside the margin, caption below. */
export const modernFourGrid: Layout = {
  id: "m-p-four-grid",
  name: "4 photo grid with caption",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 4,
  prefers: ["any", "any", "any", "any"],
  slots: cells(M, 170, 2).flatMap(([y0, y1]) => marginCols.map(([x0, x1]) => mmRect(x0, y0, x1, y1))),
  caption: fourCaption,
  texts: [{ bind: "pageCaption", box: fourCaption, align: "center", font: "caption" }],
};

const fiveSplit = 90;
/** Two photos stacked on the left, three on the right, full bleed — every cell near square. */
export const modernFiveMosaic: Layout = {
  id: "m-p-five-mosaic",
  name: "5 photo mosaic, full bleed",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 5,
  prefers: ["any", "any", "any", "any", "any"],
  slots: [
    ...cells(0, H, 2).map(([y0, y1]) => mmRect(0, y0, fiveSplit, y1)),
    ...cells(0, H, 3).map(([y0, y1]) => mmRect(fiveSplit + GUTTER_MM, y0, W, y1)),
  ],
  caption: null,
};

const sixCaption = mmRect(M, 184, W - M, 202);
/** 2 columns × 3 rows inside the margin, caption below. */
export const modernSixGrid: Layout = {
  id: "m-p-six-grid",
  name: "6 photo grid with caption",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 6,
  prefers: ["any", "any", "any", "any", "any", "any"],
  slots: cells(M, 176, 3).flatMap(([y0, y1]) => marginCols.map(([x0, x1]) => mmRect(x0, y0, x1, y1))),
  caption: sixCaption,
  texts: [{ bind: "pageCaption", box: sixCaption, align: "center", font: "caption" }],
};

// --- Spreads (x 0..200) --------------------------------------------------------------------------

const leftPageCols = cells(0, FOLD_LEFT_MM, 2);
const rightPageCols = cells(FOLD_RIGHT_MM, SPREAD_W, 2);
const thirdRows = cells(0, H, 3);
/** 4 columns × 3 rows across both pages, full bleed, thin gutters (12 photos). */
export const modernSpreadGrid: Layout = {
  id: "m-p-spread-grid",
  name: "12 photo grid across two pages",
  role: "spread",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 12,
  prefers: Array.from({ length: 12 }, () => "any" as const),
  slots: [leftPageCols, rightPageCols].flatMap((cols) =>
    thirdRows.flatMap(([y0, y1]) => cols.map(([x0, x1]) => mmRect(x0, y0, x1, y1))),
  ),
  caption: null,
  twin: ["m-p-six-grid", "m-p-six-grid"],
};

const mLeftSplit = 88;
const mLeftBottom = 140;
const mRightTopEnd = 96;
const mRightRows = cells(mRightTopEnd + GUTTER_MM, H, 2);
const mosaicCaption = mmRect(12, 176, 136, 202);
/**
 * Mosaic: left page = tall photo + two stacked, text panel underneath; right page = wide photo
 * over a tall one and two stacked (7 photos).
 */
export const modernSpreadMosaic: Layout = {
  id: "m-p-spread-mosaic",
  name: "7 photo mosaic with text panel",
  role: "spread",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 7,
  prefers: ["portrait", "any", "any", "landscape", "portrait", "landscape", "landscape"],
  slots: [
    mmRect(0, 0, mLeftSplit, mLeftBottom),
    ...cells(0, mLeftBottom, 2).map(([y0, y1]) => mmRect(mLeftSplit + GUTTER_MM, y0, FOLD_LEFT_MM, y1)),
    mmRect(FOLD_RIGHT_MM, 0, SPREAD_W, mRightTopEnd),
    mmRect(rightPageCols[0][0], mRightTopEnd + GUTTER_MM, rightPageCols[0][1], H),
    ...mRightRows.map(([y0, y1]) => mmRect(rightPageCols[1][0], y0, rightPageCols[1][1], y1)),
  ],
  caption: mosaicCaption,
  twin: ["m-p-three-panel", "m-p-four-grid"],
  texts: [
    { bind: "chapterTitle", box: mmRect(12, 150, 136, 162), align: "start", font: "chapter" },
    { bind: "dateLabel", box: mmRect(12, 163, 136, 170), align: "start", font: "subtitle" },
    { bind: "pageCaption", box: mosaicCaption, align: "start", font: "caption" },
  ],
};

/** One panorama across both pages and the fold, full bleed. */
export const modernSpreadPanorama: Layout = {
  id: "m-p-spread-panorama",
  name: "Panorama across two pages",
  role: "spread",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [mmRect(0, 0, SPREAD_W, H)],
  caption: null,
  twin: ["m-p-full", "m-p-full"],
};

// --- Covers --------------------------------------------------------------------------------------

const stripTops = [64, 56, 72];
const stripTitle = mmRect(M, 12, W - M, 38);
const stripYear = mmRect(16, 39, W - 16, 50);
/**
 * Split-strip cover: the ONE cover photo laid out over the strip area (slot = union box) and cut
 * into three vertical slices with staggered tops and thin gutters, bleeding off the sides and
 * bottom; script title and serif subtitle/year above. The renderer clips the photo to `slices`.
 */
export const modernCoverStrips: Layout = {
  id: "m-p-cover-strips",
  name: "Cover: photo strips",
  role: "cover",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [mmRect(0, Math.min(...stripTops), W, H)],
  slices: cells(0, W, 3).map(([x0, x1], i) => mmRect(x0, stripTops[i], x1, H)),
  caption: mmRect(M, 12, W - M, 50),
  texts: [
    { bind: "coverTitle", box: stripTitle, align: "center", font: "title" },
    { bind: "coverSubtitle", box: stripYear, align: "center", font: "year" },
  ],
};

const windowTitle = mmRect(M, 158, W - M, 182);
const windowYear = mmRect(16, 183, W - 16, 194);
/** Gallery cover: the photo in a white frame, script title and serif subtitle/year below. */
export const modernCoverWindow: Layout = {
  id: "m-p-cover-window",
  name: "Cover: framed photo",
  role: "cover",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [mmRect(16, 16, W - 16, 150)],
  caption: mmRect(M, 158, W - M, 194),
  texts: [
    { bind: "coverTitle", box: windowTitle, align: "center", font: "title" },
    { bind: "coverSubtitle", box: windowYear, align: "center", font: "year" },
  ],
};

export const MODERN_PORTRAIT_LAYOUTS: readonly Layout[] = [
  modernCoverStrips,
  modernCoverWindow,
  modernFull,
  modernOneBand,
  modernTwoStack,
  modernTwoPanel,
  modernThreeMosaic,
  modernThreePanel,
  modernFourGrid,
  modernFiveMosaic,
  modernSixGrid,
  modernSpreadGrid,
  modernSpreadMosaic,
  modernSpreadPanorama,
];
