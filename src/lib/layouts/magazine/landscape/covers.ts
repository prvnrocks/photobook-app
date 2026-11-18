// Magazine A5 LANDSCAPE covers (M30 T5, ref docs/design/refs/mg-5.jpg). Pure data, drawn in page
// mm (210 × 148) through ./geometry. Every cover text starts ≥ 12 mm from the spine (left) edge and
// ≥ 6 mm inside the other trims. `caption` = the title + subtitle area (edit-mode tap target).
//
// Cover lines are chapter titles (coverLine n = chapter index); a line without a chapter is not
// drawn. A block with `when: "coverLine"` goes when the book has no chapter at all, so only texts
// that include line 0 sit on such a block.

import type { Layout } from "@/lib/book/types";
import { H, W, rect } from "./geometry";

/**
 * The auto cover: full-bleed photo, white masthead top-left under the issue line + accent rule,
 * cover lines stacked down the right edge (the middle one in the accent) and a paper foot strip
 * with up to three teaser columns.
 */
export const magazineLandscapeCover: Layout = {
  id: "mg-l-cover",
  name: "Cover: masthead over full-bleed photo",
  role: "cover",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W, H)],
  caption: rect(14, 9, 148, 68),
  blocks: [
    { box: rect(14, 17, 40, 18.2), fill: "accent", layer: "over" },
    // Foot strip: line 0 always prints on it, so it never stands empty.
    { box: rect(0, 127, W, H), fill: "paper", layer: "over", when: "coverLine" },
    { box: rect(14, 131.5, 15.2, 143.5), fill: "ink", layer: "over", when: "coverLine" },
  ],
  texts: [
    { bind: "coverSubtitle", box: rect(14, 9, 148, 14.5), align: "start", font: "year", ink: "accentOnDark" },
    { bind: "coverTitle", box: rect(14, 22, 148, 68), align: "start", font: "masthead", ink: "paper" },
    { bind: "coverLine", n: 1, box: rect(104, 74, 198, 87), align: "end", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 2, box: rect(104, 90, 198, 103), align: "end", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 3, box: rect(104, 106, 198, 119), align: "end", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 0, box: rect(19, 131.5, 74, 143.5), align: "start", font: "subtitle", ink: "ink" },
    { bind: "coverLine", n: 4, box: rect(80, 131.5, 136, 143.5), align: "start", font: "subtitle", ink: "ink" },
    { bind: "coverLine", n: 5, box: rect(142, 131.5, 198, 143.5), align: "start", font: "subtitle", ink: "ink" },
  ],
};

/** Dark panel on the left third with the masthead and cover lines; the photo fills the right two thirds. */
export const magazineLandscapeCoverPanel: Layout = {
  id: "mg-l-cover-panel",
  name: "Cover: dark panel + photo",
  role: "cover",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["any"],
  slots: [rect(78, 0, W, H)],
  caption: rect(12, 11, 70, 82),
  blocks: [
    { box: rect(0, 0, 78, H), fill: "panel", layer: "under" },
    { box: rect(12, 19.5, 30, 20.7), fill: "accent", layer: "under" },
  ],
  texts: [
    { bind: "coverSubtitle", box: rect(12, 11, 70, 16.5), align: "start", font: "year", ink: "accentOnDark" },
    { bind: "coverTitle", box: rect(12, 25, 70, 82), align: "start", font: "masthead", ink: "paper" },
    { bind: "coverLine", n: 0, box: rect(12, 92, 70, 104), align: "start", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 1, box: rect(12, 108, 70, 120), align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 2, box: rect(12, 124, 70, 136), align: "start", font: "chapter", ink: "paper" },
  ],
  autoPick: false,
};

/** Masthead in ink on a white band above a wide photo; cover lines on a dark box in the photo's corner. */
export const magazineLandscapeCoverBand: Layout = {
  id: "mg-l-cover-band",
  name: "Cover: masthead band above photo",
  role: "cover",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 50, W, H)],
  caption: rect(12, 7, 198, 44),
  blocks: [
    { box: rect(12, 46, 198, 47.2), fill: "ink", layer: "under" },
    { box: rect(134, 92, W, H), fill: "panel", layer: "over", when: "coverLine" },
    { box: rect(134, 92, 135.6, H), fill: "accent", layer: "over", when: "coverLine" },
  ],
  texts: [
    { bind: "coverTitle", box: rect(12, 7, 198, 36), align: "start", font: "masthead", ink: "ink" },
    { bind: "coverSubtitle", box: rect(12, 38.5, 198, 44), align: "start", font: "year", ink: "accent" },
    { bind: "coverLine", n: 0, box: rect(142, 99, 198, 111), align: "start", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 1, box: rect(142, 114, 198, 126), align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 2, box: rect(142, 129, 198, 141), align: "start", font: "chapter", ink: "paper" },
  ],
  autoPick: false,
};

/** Full-bleed photo with a dark band along the foot: masthead bottom-left, cover lines bottom-right. */
export const magazineLandscapeCoverFoot: Layout = {
  id: "mg-l-cover-foot",
  name: "Cover: masthead on dark foot band",
  role: "cover",
  style: "magazine",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W, H)],
  caption: rect(14, 100, 146, 142),
  blocks: [
    { box: rect(0, 94, W, H), fill: "panel", layer: "over" },
    { box: rect(0, 92.8, W, 94), fill: "accent", layer: "over" },
    { box: rect(152, 101, 152.6, 141), fill: "accent", layer: "over", when: "coverLine" },
  ],
  texts: [
    { bind: "coverSubtitle", box: rect(14, 100, 146, 105.5), align: "start", font: "year", ink: "accentOnDark" },
    { bind: "coverTitle", box: rect(14, 108, 146, 142), align: "start", font: "masthead", ink: "paper" },
    { bind: "coverLine", n: 0, box: rect(158, 101, 198, 113), align: "start", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 1, box: rect(158, 115, 198, 127), align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 2, box: rect(158, 129, 198, 141), align: "start", font: "chapter", ink: "paper" },
  ],
  autoPick: false,
};
