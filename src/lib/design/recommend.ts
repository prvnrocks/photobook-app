// Design recommendation for the wizard (Task 5). Pure, client-safe.
//
// A RECOMMENDATION only: the wizard may preselect it, the user's own pick always wins and nothing
// here forces a choice. Shape follows the photos (what most of them look like), style follows the
// occasion default (D-068 / D-090). Reasons are codes — the UI owns the wording.

import type { Occasion } from "@/lib/book/options";
import type { BookFormat } from "@/lib/book/types";
import { DEFAULT_FORM_FORMAT, defaultStyleFor, type FormDesignStyle } from "@/lib/design/defaults";

/** A photo counts as landscape above this width/height ratio (portrait below its inverse). */
export const RECOMMEND_ASPECT_THRESHOLD = 1.05;
/** Share of the measurable photos that must agree before a shape is recommended. */
export const RECOMMEND_MAJORITY = 0.6;

export type FormatReason = "mostly_landscape" | "mostly_portrait" | "mixed" | "no_photos";
export type StyleReason = "occasion_default";

export type DesignRecommendationInput = {
  occasion: Occasion | null;
  photos: { width: number | null; height: number | null }[];
};

export type DesignRecommendation = {
  format: BookFormat;
  formatReason: FormatReason;
  designStyle: FormDesignStyle;
  styleReason: StyleReason;
};

const measurable = (n: number | null): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function recommendDesign(input: DesignRecommendationInput): DesignRecommendation {
  let known = 0;
  let landscape = 0;
  let portrait = 0;
  for (const p of input.photos) {
    if (!measurable(p.width) || !measurable(p.height)) continue;
    known++;
    const ratio = p.width / p.height;
    if (ratio > RECOMMEND_ASPECT_THRESHOLD) landscape++;
    else if (ratio < 1 / RECOMMEND_ASPECT_THRESHOLD) portrait++;
  }

  let format: BookFormat = DEFAULT_FORM_FORMAT;
  let formatReason: FormatReason = "mixed";
  if (known === 0) formatReason = "no_photos";
  else if (landscape >= known * RECOMMEND_MAJORITY) {
    format = "A5_LANDSCAPE";
    formatReason = "mostly_landscape";
  } else if (portrait >= known * RECOMMEND_MAJORITY) {
    format = "A5_PORTRAIT";
    formatReason = "mostly_portrait";
  }

  return { format, formatReason, designStyle: defaultStyleFor(input.occasion), styleReason: "occasion_default" };
}
