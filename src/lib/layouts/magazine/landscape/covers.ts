// Magazine A5 LANDSCAPE covers (M30 T5, ref docs/design/refs/mg-5.jpg). Pure data, drawn in page
// mm (210 × 148) through ../geometry. Every cover text starts ≥ 12 mm from the spine (left) edge and
// ≥ 6 mm inside the other trims. `caption` = the title + subtitle area (edit-mode tap target).
//
// Cover lines are chapter titles (coverLine n = chapter index); a line without a chapter is not
// drawn. A block with `when: "coverLine"` goes when the book has no chapter at all, so only texts
// that include line 0 sit on such a block.

import type { Layout } from "@/lib/book/types";
import { LANDSCAPE } from "../geometry";

const { W, H, rect, block, text } = LANDSCAPE;
const COVER = { role: "cover", style: "magazine", format: "A5_LANDSCAPE" } as const;

/** Cover-line tabs down the right edge: 12 mm tall, flush with the trim; tab i starts at y. */
const TAB_Y = [76, 91, 106];
const tab = (i: number, fill: "panel" | "accent") => block(138, TAB_Y[i], W, TAB_Y[i] + 12, fill, "over", "coverLine", i + 1);
const tabLine = (i: number, ink: "paper" | "ink") =>
  text("coverLine", [144, TAB_Y[i] + 1.5, 198, TAB_Y[i] + 10.5], "chapter", ink, { n: i + 1, align: "end" });

/**
 * The auto cover: full-bleed photo under a magazine head — a dark top bar with the issue line in
 * the accent, an accent hairline and the white masthead on a flat scrim band (legible on any
 * photo). Cover lines sit on tabs flush with the right edge (dark / accent / dark, each only with
 * its line) and a paper foot strip carries up to three teaser columns.
 */
export const magazineLandscapeCover: Layout = {
  id: "mg-l-cover",
  name: "Cover: masthead over full-bleed photo",
  ...COVER,
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W, H)],
  caption: rect(14, 4.5, 196, 66),
  blocks: [
    block(0, 0, W, 13, "panel", "over"),
    block(0, 13, W, 13.8, "accent", "over"),
    block(0, 13.8, W, 70, "scrim", "over"),
    tab(0, "panel"),
    tab(1, "accent"),
    tab(2, "panel"),
    // Foot strip: line 0 always prints on it, so it never stands empty.
    block(0, 127, W, H, "paper", "over", "coverLine"),
    block(14, 131.5, 15.2, 143.5, "ink", "over", "coverLine"),
  ],
  texts: [
    text("coverSubtitle", [14, 4.5, 196, 10], "year", "accentOnDark"),
    text("coverTitle", [14, 18, 196, 66], "masthead", "paper"),
    tabLine(0, "paper"),
    tabLine(1, "ink"),
    tabLine(2, "paper"),
    text("coverLine", [19, 131.5, 74, 143.5], "subtitle", "ink", { n: 0 }),
    text("coverLine", [80, 131.5, 136, 143.5], "subtitle", "ink", { n: 4 }),
    text("coverLine", [142, 131.5, 198, 143.5], "subtitle", "ink", { n: 5 }),
  ],
};

/** Dark panel on the left (96 mm) with the masthead and cover lines; the photo fills the rest. */
export const magazineLandscapeCoverPanel: Layout = {
  id: "mg-l-cover-panel",
  name: "Cover: dark panel + photo",
  ...COVER,
  photoCount: 1,
  prefers: ["any"],
  slots: [rect(96, 0, W, H)],
  caption: rect(12, 11, 88, 86),
  blocks: [
    block(0, 0, 96, H, "panel"),
    block(12, 19.5, 30, 20.7, "accent"),
  ],
  texts: [
    text("coverSubtitle", [12, 11, 88, 16.5], "year", "accentOnDark"),
    text("coverTitle", [12, 25, 88, 86], "masthead", "paper"),
    text("coverLine", [12, 94, 88, 106], "chapter", "paper", { n: 0 }),
    text("coverLine", [12, 109, 88, 121], "chapter", "accentOnDark", { n: 1 }),
    text("coverLine", [12, 124, 88, 136], "chapter", "paper", { n: 2 }),
  ],
  autoPick: false,
};

/** Masthead in ink on a white band above a wide photo; cover lines on a dark box in the photo's corner. */
export const magazineLandscapeCoverBand: Layout = {
  id: "mg-l-cover-band",
  name: "Cover: masthead band above photo",
  ...COVER,
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 50, W, H)],
  caption: rect(12, 7, 198, 44),
  blocks: [
    block(12, 46, 198, 47.2, "ink"),
    block(134, 92, W, H, "panel", "over", "coverLine"),
    block(134, 92, 135.6, H, "accent", "over", "coverLine"),
  ],
  texts: [
    text("coverTitle", [12, 7, 198, 36], "masthead", "ink"),
    text("coverSubtitle", [12, 38.5, 198, 44], "year", "accent"),
    text("coverLine", [142, 99, 198, 111], "chapter", "paper", { n: 0 }),
    text("coverLine", [142, 114, 198, 126], "chapter", "accentOnDark", { n: 1 }),
    text("coverLine", [142, 129, 198, 141], "chapter", "paper", { n: 2 }),
  ],
  autoPick: false,
};

/** Full-bleed photo with a dark band along the foot: masthead bottom-left, cover lines bottom-right. */
export const magazineLandscapeCoverFoot: Layout = {
  id: "mg-l-cover-foot",
  name: "Cover: masthead on dark foot band",
  ...COVER,
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W, H)],
  caption: rect(14, 100, 146, 142),
  blocks: [
    block(0, 94, W, H, "panel", "over"),
    block(0, 92.8, W, 94, "accent", "over"),
    block(152, 101, 152.6, 141, "accent", "over", "coverLine"),
  ],
  texts: [
    text("coverSubtitle", [14, 100, 146, 105.5], "year", "accentOnDark"),
    text("coverTitle", [14, 108, 146, 142], "masthead", "paper"),
    text("coverLine", [158, 101, 198, 113], "chapter", "paper", { n: 0 }),
    text("coverLine", [158, 115, 198, 127], "chapter", "accentOnDark", { n: 1 }),
    text("coverLine", [158, 129, 198, 141], "chapter", "paper", { n: 2 }),
  ],
  autoPick: false,
};
