// Editorial A5 LANDSCAPE spreads (M30 T7). x runs 0..420 mm (fold at 210). Only the plain-rect
// panorama crosses the fold; polygon slots, hairlines and turned text stay on one page.

import type { Layout } from "@/lib/book/types";
import { H, W, hairline, poly, rect, rule, text } from "./geometry";
import { DIAGONAL_TEXT, twoNotes } from "./pages";

const base = { role: "spread", style: "editorial", format: "A5_LANDSCAPE" } as const;

/** Shifts a [x0, y0, x1, y1] mm box onto the right page. */
const right = (b: readonly [number, number, number, number]) => [b[0] + W, b[1], b[2] + W, b[3]] as const;

/**
 * Panorama: one photo runs from the left trim across the fold and stops 108 mm into the right page;
 * the rest of the right page is white with date, heading, description and caption (the text
 * column of ed-l-one-diagonal). A split leaves the photo on the left twin.
 */
export const editorialLandscapeSpreadPano: Layout = {
  ...base,
  id: "ed-l-spread-pano",
  name: "Panorama across the fold + title block",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [rect(0, 0, W + 108, H)],
  caption: rect(...right(DIAGONAL_TEXT.caption)),
  twin: ["ed-l-one-bleed", "ed-l-one-diagonal"],
  blocks: [rule(W + 132, DIAGONAL_TEXT.ruleY, "chapterDescription")],
  texts: [
    text("dateLabel", right(DIAGONAL_TEXT.date), "year", "muted"),
    text("chapterTitle", right(DIAGONAL_TEXT.title), "masthead", "ink"),
    text("chapterDescription", right(DIAGONAL_TEXT.description), "body", "muted"),
    text("pageCaption", right(DIAGONAL_TEXT.caption), "caption", "ink"),
  ],
};

const notes = twoNotes(W);

/**
 * Chapter opener: the left page is one big photo cut by a diagonal near the fold (bleeds
 * top/left/bottom) with a hairline parallel to the cut; the right page is ed-l-two-notes
 * (heading, description, caption, two stacked photos, date strip).
 */
export const editorialLandscapeSpreadOpener: Layout = {
  ...base,
  id: "ed-l-spread-opener",
  name: "Opener: big diagonal photo + story page",
  photoCount: 3,
  prefers: ["landscape", "any", "any"],
  slots: [poly([[0, 0], [196, 0], [150, H], [0, H]]), ...notes.slots],
  caption: notes.caption,
  twin: ["ed-l-one-diagonal", "ed-l-two-notes"],
  blocks: [hairline([203, 0], [157, H]), ...notes.blocks],
  texts: notes.texts,
};
