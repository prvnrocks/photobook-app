// Magazine A5 LANDSCAPE spreads (M30 T5). Pure data, drawn in mm over both pages (420 × 148, fold
// at x = 210) through ./geometry. Text stays ≥ 12 mm from the fold and the outer trims; only the
// panorama photo and plain rect blocks cross the fold.

import type { Layout } from "@/lib/book/types";
import { H, W, rect, shiftBlock, shiftRect, shiftText } from "./geometry";
import { BAND, FEATURE, OPENER } from "./pages";

/** The right page's caption band of mg-l-one-band, in spread coordinates. */
const PANO_CAPTION = shiftRect(BAND.caption);

/**
 * Panorama across the fold over a dark foot band. Left page: a white headline box (date + heavy
 * headline) overlapping the photo and running to the foot. Right page: caption + date on the band,
 * exactly as on mg-l-one-band.
 */
export const magazineLandscapeSpreadPano: Layout = {
  id: "mg-l-spread-pano",
  name: "Panorama + headline box",
  role: "spread",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, 2 * W, BAND.top)],
  caption: PANO_CAPTION,
  twin: ["mg-l-one-opener", "mg-l-one-band"],
  blocks: [
    { box: rect(0, BAND.top, 2 * W, H), fill: "panel", layer: "under" },
    { box: rect(14, 88, 116, H), fill: "paper", layer: "over" },
    { box: rect(14, 88, 16, H), fill: "accent", layer: "over" },
    { box: rect(W + 14, 121, W + 15.2, 139), fill: "accent", layer: "under" },
  ],
  texts: [
    { bind: "dateLabel", box: rect(23, 95, 109, 100.5), align: "start", font: "year", ink: "accent" },
    { bind: "chapterTitle", box: rect(23, 104, 109, 141), align: "start", font: "masthead", ink: "ink" },
    { bind: "pageCaption", box: PANO_CAPTION, align: "start", font: "caption", ink: "paper" },
  ],
};

/**
 * Feature opener: the left page is a full-bleed photo, the right page the feature page — dark panel
 * with the accent headline and the description, three small photos hanging from it
 * (= mg-l-three-feature). The headline lives on the right page only.
 */
export const magazineLandscapeSpreadFeature: Layout = {
  id: "mg-l-spread-feature",
  name: "Feature opener: photo page + dark panel page",
  role: "spread",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 4,
  prefers: ["landscape", "any", "any", "any"],
  slots: [OPENER.slot, ...FEATURE.slots.map(shiftRect)],
  caption: null,
  twin: ["mg-l-one-opener", "mg-l-three-feature"],
  blocks: FEATURE.blocks.map(shiftBlock),
  texts: FEATURE.texts.map(shiftText),
};
