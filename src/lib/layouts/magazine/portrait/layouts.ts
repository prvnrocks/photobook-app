// Magazine A5 PORTRAIT pages + spreads (M30 T4, D-090; ref docs/design/refs/mg-5.jpg = ideas only:
// full-bleed photos, white headline boxes, dark panels with an accent heading, strips, a circle
// inset). Pure data, drawn in page mm (148 × 210, y down) through ../geometry.
//
// Rules of this file: text keeps ≥ 10 mm from the left/right trim (either side may be the fold) and
// ≥ 8 mm from top/bottom; photos are separated by a 3 mm gutter; the caption never sits on a photo.
// The page caption is the standfirst (always above or beside the chapter description), and the
// description is the LAST element of its column or sits on a block with `when`, so a page without a
// description (rule-built books) only ends earlier — it never shows a hole between two elements.

import type { Layout, LayoutBlock, LayoutText } from "@/lib/book/types";
import { cells, G, M, PORTRAIT, shift } from "../geometry";

const { W, H, rect, circle, text, block } = PORTRAIT;
const PAGE = { role: "page", style: "magazine", format: "A5_PORTRAIT" } as const;
const SPREAD = { role: "spread", style: "magazine", format: "A5_PORTRAIT" } as const;

const FULL = rect(0, 0, W, H);

// --- 1 photo --------------------------------------------------------------------------------------

/** One photo, full bleed. No text. Left page of mg-p-spread-feature, right twin of the panorama. */
export const magazinePortraitFull: Layout = {
  id: "mg-p-full",
  name: "1 photo, full bleed",
  ...PAGE,
  photoCount: 1,
  prefers: ["portrait"],
  slots: [FULL],
  caption: null,
};

const COLUMN = {
  bar: rect(M, 134, 24, 135.2),
  chapter: rect(M, 139, 62, 160),
  date: rect(M, 162, 62, 167.5),
  caption: rect(70, 137, W - M, 167),
  rule: rect(M, 173, W - M, 173.3),
  description: rect(M, 177, W - M, 202),
};

/**
 * Text-column page: a wide photo on top (bleeds top/left/right), then the heading + date on the
 * left, the caption as a standfirst on the right and the chapter description across the foot.
 */
export const magazinePortraitOneColumn: Layout = {
  id: "mg-p-one-column",
  name: "1 photo on top, heading + text columns",
  ...PAGE,
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W, 124)],
  caption: COLUMN.caption,
  blocks: [
    { box: COLUMN.bar, fill: "ink", layer: "under" },
    { box: COLUMN.rule, fill: "ink", layer: "under", when: "chapterDescription" },
  ],
  texts: [
    text("chapterTitle", COLUMN.chapter, "chapter", "ink"),
    text("dateLabel", COLUMN.date, "year", "accent"),
    text("pageCaption", COLUMN.caption, "caption", "muted"),
    text("chapterDescription", COLUMN.description, "body", "ink"),
  ],
};

const HEADLINE = {
  caption: rect(M, 180, W - M, 201),
};

/**
 * Chapter opener: a tall photo (bleeds top/left/right) with a white headline box over its upper
 * left — date + chapter title; with a chapter description the box runs on down the photo and
 * carries it. Caption under the photo.
 */
export const magazinePortraitOneHeadline: Layout = {
  id: "mg-p-one-headline",
  name: "Chapter opener: photo with white headline box",
  ...PAGE,
  photoCount: 1,
  prefers: ["portrait"],
  slots: [rect(0, 0, W, 172)],
  caption: HEADLINE.caption,
  blocks: [
    block(M, 26, 78, 84, "paper", "over"),
    block(M, 84, 78, 160, "paper", "over", "chapterDescription"),
    block(16, 86, 30, 86.8, "ink", "over", "chapterDescription"),
  ],
  texts: [
    text("dateLabel", [16, 33, 72, 38.5], "year", "accent"),
    text("chapterTitle", [16, 42, 72, 78], "title", "ink"),
    text("chapterDescription", [16, 91, 72, 154], "body", "ink"),
    text("pageCaption", HEADLINE.caption, "caption", "muted"),
  ],
};

// --- 2 photos -------------------------------------------------------------------------------------
const PANEL_X = 78;
const PANEL_L = PANEL_X + 8; // text + inset photo column: 86..138 mm
const PANEL = {
  caption: rect(PANEL_L, 117, W - M, 139),
};

/**
 * Chapter opener: a tall photo (full height, bleeds) beside a dark panel column — date, the chapter
 * title in the accent, a small second photo with the caption, then the chapter description.
 */
export const magazinePortraitTwoPanel: Layout = {
  id: "mg-p-two-panel",
  name: "Chapter opener: tall photo + dark panel column",
  ...PAGE,
  photoCount: 2,
  prefers: ["portrait", "any"],
  slots: [rect(0, 0, PANEL_X, H), rect(PANEL_L, 58, W - M, 112)],
  caption: PANEL.caption,
  blocks: [
    block(PANEL_X, 0, W, H, "panel"),
    block(PANEL_L, 144, PANEL_L + 14, 144.8, "accent", "under", "chapterDescription"),
  ],
  texts: [
    text("dateLabel", [PANEL_L, 14, W - M, 19.5], "year", "paper"),
    text("chapterTitle", [PANEL_L, 23, W - M, 52], "title", "accentOnDark"),
    text("pageCaption", PANEL.caption, "caption", "paper"),
    text("chapterDescription", [PANEL_L, 149, W - M, 203], "body", "paper"),
  ],
};

const CIRCLE = { cx: 108, cy: 128, r: 29 };
const CIRCLE_TEXT = {
  bar: rect(M, 138, 24, 139.2),
  chapter: rect(M, 143, 74, 163),
  date: rect(M, 165, 74, 170.5),
  caption: rect(M, 177, W - M, 201),
};

/**
 * A wide photo on top (bleeds top/left/right) with a circle photo sitting on its lower
 * edge; heading, date and caption on the white below.
 */
export const magazinePortraitTwoCircle: Layout = {
  id: "mg-p-two-circle",
  name: "2 photos, circle inset on a large photo",
  ...PAGE,
  photoCount: 2,
  prefers: ["landscape", "any"],
  slots: [
    rect(0, 0, W, CIRCLE.cy),
    // No white ring: a framed slot outside the geometric / scrapbook styles fails the shared
    // print-plumbing test (tests/m10c-print-plumbing.test.ts), so the circle overlaps the photo directly.
    { ...circle(CIRCLE.cx, CIRCLE.cy, CIRCLE.r), z: 1 },
  ],
  caption: CIRCLE_TEXT.caption,
  blocks: [{ box: CIRCLE_TEXT.bar, fill: "ink", layer: "under" }],
  texts: [
    text("chapterTitle", CIRCLE_TEXT.chapter, "chapter", "ink"),
    text("dateLabel", CIRCLE_TEXT.date, "year", "accent"),
    text("pageCaption", CIRCLE_TEXT.caption, "caption", "muted"),
  ],
};

// --- 3 photos -------------------------------------------------------------------------------------
// Feature page (= right page of mg-p-spread-feature): dark panel head, three tall photos standing
// across its lower edge, caption + description on the white below.
const featureCols = cells(M, W - M, 3, 4);
const FEATURE = {
  slots: featureCols.map(([x0, x1]) => rect(x0, 58, x1, 140)),
  panel: rect(0, 0, W, 112),
  date: rect(M, 14, W - M, 19.5),
  chapter: rect(M, 23, W - M, 50),
  caption: rect(M, 147, W - M, 165),
  rule: rect(M, 170, 24, 170.8),
  description: rect(M, 175, W - M, 202),
};
const featureBlocks = (at: <T extends { x: number; y: number; w: number; h: number }>(r: T) => T): LayoutBlock[] => [
  { box: at(FEATURE.panel), fill: "panel", layer: "under" },
  { box: at(FEATURE.rule), fill: "ink", layer: "under", when: "chapterDescription" },
];
const featureTexts = (at: <T extends { x: number; y: number; w: number; h: number }>(r: T) => T): LayoutText[] => [
  text("dateLabel", at(FEATURE.date), "year", "paper"),
  text("chapterTitle", at(FEATURE.chapter), "title", "accentOnDark"),
  text("pageCaption", at(FEATURE.caption), "caption", "muted"),
  text("chapterDescription", at(FEATURE.description), "body", "ink"),
];
const same = <T,>(r: T) => r;

export const magazinePortraitThreeFeature: Layout = {
  id: "mg-p-three-feature",
  name: "3 photos across a dark panel head + text",
  ...PAGE,
  photoCount: 3,
  prefers: ["portrait", "portrait", "portrait"],
  slots: FEATURE.slots,
  caption: FEATURE.caption,
  blocks: featureBlocks(same),
  texts: featureTexts(same),
};

const HERO3_Y = 104;
const hero3Rows = cells(HERO3_Y + G, H, 2);
const HERO3 = {
  caption: rect(M, 163, 54, 202),
};

/**
 * Hero photo on top (bleeds), below it a dark panel cell (date, accent heading, caption) beside
 * two stacked photos that bleed right.
 */
export const magazinePortraitThreeHero: Layout = {
  id: "mg-p-three-hero",
  name: "3 photos, hero + dark caption cell",
  ...PAGE,
  photoCount: 3,
  prefers: ["landscape", "landscape", "landscape"],
  slots: [rect(0, 0, W, HERO3_Y), ...hero3Rows.map(([y0, y1]) => rect(63, y0, W, y1))],
  caption: HERO3.caption,
  blocks: [
    block(0, HERO3_Y + G, 60, H, "panel"),
    block(M, 157, 24, 157.8, "accent"),
  ],
  texts: [
    text("dateLabel", [M, 116, 54, 121.5], "year", "paper"),
    text("chapterTitle", [M, 125, 54, 153], "chapter", "accentOnDark"),
    text("pageCaption", HERO3.caption, "caption", "paper"),
  ],
};

// --- 4–6 photos: hero + grid, shared white foot (bar, heading, date | caption) -----------------------
const FOOT = {
  bar: rect(M, 170, 24, 171.2),
  chapter: rect(M, 175, 62, 194),
  date: rect(M, 196, 62, 201.5),
  caption: rect(70, 171, W - M, 201),
};
const FOOT_BLOCKS: LayoutBlock[] = [{ box: FOOT.bar, fill: "ink", layer: "under" }];
const FOOT_TEXTS: LayoutText[] = [
  text("chapterTitle", FOOT.chapter, "chapter", "ink"),
  text("dateLabel", FOOT.date, "year", "accent"),
  text("pageCaption", FOOT.caption, "caption", "muted"),
];
const thirds = cells(0, W, 3);

/** Big photo on top and a strip of three under it (all bleed left/right); heading + caption foot. */
export const magazinePortraitFourStrip: Layout = {
  id: "mg-p-four-strip",
  name: "4 photos, big photo + strip of three",
  ...PAGE,
  photoCount: 4,
  prefers: ["landscape", "any", "any", "any"],
  slots: [rect(0, 0, W, 112), ...thirds.map(([x0, x1]) => rect(x0, 112 + G, x1, 162))],
  caption: FOOT.caption,
  blocks: FOOT_BLOCKS,
  texts: FOOT_TEXTS,
};

const HERO4_Y = 144;
const hero4Rows = cells(0, HERO4_Y, 3);
const HERO4 = {
  caption: rect(70, 157, W - M, 202),
};

/** Tall hero on the left, three stacked photos on the right (all bleed), a dark foot band with heading + caption. */
export const magazinePortraitFourHero: Layout = {
  id: "mg-p-four-hero",
  name: "4 photos, tall hero + column of three, dark foot",
  ...PAGE,
  photoCount: 4,
  prefers: ["portrait", "landscape", "landscape", "landscape"],
  slots: [rect(0, 0, 92, HERO4_Y), ...hero4Rows.map(([y0, y1]) => rect(92 + G, y0, W, y1))],
  caption: HERO4.caption,
  blocks: [
    block(0, HERO4_Y + G, W, H, "panel"),
    block(M, 157, 24, 157.8, "accent"),
  ],
  texts: [
    text("chapterTitle", [M, 162, 62, 190], "chapter", "accentOnDark"),
    text("dateLabel", [M, 194, 62, 199.5], "year", "paper"),
    text("pageCaption", HERO4.caption, "caption", "paper"),
  ],
};

const hero5Rows = cells(0, 100, 2);
const halves = cells(0, W, 2);

/** Hero top left, two stacked on its right, two wide photos below (all bleed); heading + caption foot. */
export const magazinePortraitFiveHero: Layout = {
  id: "mg-p-five-hero",
  name: "5 photos, hero + four",
  ...PAGE,
  photoCount: 5,
  prefers: ["any", "landscape", "landscape", "landscape", "landscape"],
  slots: [
    rect(0, 0, 96, 100),
    ...hero5Rows.map(([y0, y1]) => rect(96 + G, y0, W, y1)),
    ...halves.map(([x0, x1]) => rect(x0, 100 + G, x1, 162)),
  ],
  caption: FOOT.caption,
  blocks: FOOT_BLOCKS,
  texts: FOOT_TEXTS,
};

const hero6Rows = cells(0, 104, 2);

/** Hero over two columns, two stacked on its right, a strip of three below (all bleed); heading + caption foot. */
export const magazinePortraitSixHero: Layout = {
  id: "mg-p-six-hero",
  name: "6 photos, hero + two + strip of three",
  ...PAGE,
  photoCount: 6,
  prefers: ["any", "any", "any", "any", "any", "any"],
  slots: [
    rect(0, 0, thirds[1][1], 104),
    ...hero6Rows.map(([y0, y1]) => rect(thirds[2][0], y0, W, y1)),
    ...thirds.map(([x0, x1]) => rect(x0, 104 + G, x1, 162)),
  ],
  caption: FOOT.caption,
  blocks: FOOT_BLOCKS,
  texts: FOOT_TEXTS,
};

// --- spreads ----------------------------------------------------------------------------------------
const PANO_Y = 160;
const PANO = {
  caption: rect(M, 169, W - M, 201),
};

/**
 * Panorama across the fold (bleeds top/left/right) with a white headline box on the left page —
 * date + chapter title — standing on the photo's lower edge; caption under it on the left page,
 * chapter description on the right page.
 */
export const magazinePortraitSpreadPanorama: Layout = {
  id: "mg-p-spread-panorama",
  name: "Panorama across both pages + headline box",
  ...SPREAD,
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, 2 * W, PANO_Y)],
  caption: PANO.caption,
  twin: ["mg-p-one-column", "mg-p-full"],
  blocks: [
    block(M, 104, 92, PANO_Y, "paper", "over"),
    { box: shift(rect(M, 169, 24, 169.8)), fill: "ink", layer: "under", when: "chapterDescription" },
  ],
  texts: [
    text("dateLabel", [16, 111, 86, 116.5], "year", "accent"),
    text("chapterTitle", [16, 120, 86, 156], "title", "ink"),
    text("pageCaption", PANO.caption, "caption", "muted"),
    { bind: "chapterDescription", box: shift(rect(M, 174, W - M, 202)), align: "start", font: "body", ink: "ink" },
  ],
};

/**
 * Feature opener: a full-bleed photo on the left page; on the right the dark panel head with date +
 * chapter title, three tall photos, caption and chapter description (= mg-p-full + mg-p-three-feature).
 */
export const magazinePortraitSpreadFeature: Layout = {
  id: "mg-p-spread-feature",
  name: "Feature opener: full photo + panel page",
  ...SPREAD,
  photoCount: 4,
  prefers: ["portrait", "portrait", "portrait", "portrait"],
  slots: [FULL, ...FEATURE.slots.map(shift)],
  caption: shift(FEATURE.caption),
  twin: ["mg-p-full", "mg-p-three-feature"],
  blocks: featureBlocks(shift),
  texts: featureTexts(shift),
};
