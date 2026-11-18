// The wizard's Design step (Task 5): which page shape + book style are shown as chosen, and what to
// save. Pure and client-safe (no React, no zod).
//
// Rule: AI / the app RECOMMENDS, the user decides.
//   - `stored`  = the book's format / design_style (a new book gets a provisional design: the default
//                 shape + the occasion's style).
//   - `pick`    = what the user chose by hand on this step (null per field = not chosen yet).
//   - the recommendation (src/lib/design/recommend.ts) is preselected ONLY for a field the user has
//     not chosen; a manual pick always wins, also over a later recommendation.
// Saving happens only when the chosen design differs from the stored one (designPatch).

import { OCCASION_LABELS, type Occasion } from "@/lib/book/options";
import {
  DEFAULT_FORM_FORMAT,
  defaultStyleFor,
  FORM_DESIGN_STYLES,
  FORM_FORMATS,
  type FormDesignStyle,
} from "@/lib/design/defaults";
import type { DesignRecommendation } from "@/lib/design/recommend";

export type DesignFormat = (typeof FORM_FORMATS)[number];

export type DesignChoice = { format: DesignFormat; designStyle: FormDesignStyle };
/** The user's own picks; null = not chosen (the recommendation / stored value shows). */
export type DesignPick = { format: DesignFormat | null; designStyle: FormDesignStyle | null };
export type StoredDesign = { format: DesignFormat | null; designStyle: FormDesignStyle | null };

export const NO_DESIGN_PICK: DesignPick = { format: null, designStyle: null };

const isFormat = (v: unknown): v is DesignFormat => typeof v === "string" && (FORM_FORMATS as readonly string[]).includes(v);
const isStyle = (v: unknown): v is FormDesignStyle =>
  typeof v === "string" && (FORM_DESIGN_STYLES as readonly string[]).includes(v);

/** The recommendation narrowed to what the form offers (anything else → no recommendation for that field). */
export function recommendedChoice(rec: DesignRecommendation | null | undefined): DesignPick {
  if (!rec) return NO_DESIGN_PICK;
  return { format: isFormat(rec.format) ? rec.format : null, designStyle: isStyle(rec.designStyle) ? rec.designStyle : null };
}

/** What the step shows as selected: the user's pick, else the recommendation, else the stored design, else the defaults. */
export function resolveDesignChoice(input: {
  stored: StoredDesign;
  pick: DesignPick;
  recommendation: DesignRecommendation | null | undefined;
  occasion: Occasion | null;
}): DesignChoice {
  const rec = recommendedChoice(input.recommendation);
  return {
    format: input.pick.format ?? rec.format ?? input.stored.format ?? (DEFAULT_FORM_FORMAT as DesignFormat),
    designStyle: input.pick.designStyle ?? rec.designStyle ?? input.stored.designStyle ?? defaultStyleFor(input.occasion),
  };
}

/** What to send to updateBookSetupAction, or null when nothing differs from the stored book (no save). */
export function designPatch(chosen: DesignChoice, stored: StoredDesign): DesignChoice | null {
  if (chosen.format === stored.format && chosen.designStyle === stored.designStyle) return null;
  return { format: chosen.format, designStyle: chosen.designStyle };
}

/**
 * The picks a (re)load starts with: what this browser session remembered for the book, else — a
 * stored design that isn't the provisional one any more can only come from the user's own saved
 * choice — the stored value. A provisional design is "not chosen yet".
 */
export function initialDesignPick(input: {
  stored: StoredDesign;
  occasion: Occasion | null;
  remembered?: DesignPick | null;
}): DesignPick {
  const provisionalStyle = defaultStyleFor(input.occasion);
  return {
    format:
      input.remembered?.format ?? (input.stored.format !== null && input.stored.format !== DEFAULT_FORM_FORMAT ? input.stored.format : null),
    designStyle:
      input.remembered?.designStyle ??
      (input.stored.designStyle !== null && input.stored.designStyle !== provisionalStyle ? input.stored.designStyle : null),
  };
}

// ---- wording (the UI owns it; the recommendation carries reason codes only) -------------------------

export const RECOMMENDED_BADGE = "Recommended";

/** One plain line for the recommended shape. `mixed` / `no_photos` make no claim about the photos. */
export function shapeReasonText(rec: DesignRecommendation | null | undefined): string | null {
  if (!rec || !isFormat(rec.format)) return null;
  switch (rec.formatReason) {
    case "mostly_landscape":
      return "Most of your photos are wide.";
    case "mostly_portrait":
      return "Most of your photos are tall.";
    case "mixed":
    case "no_photos":
      return "A good all-round shape.";
  }
}

/** One plain line for the recommended style ("A good fit for a travel book."). */
export function styleReasonText(rec: DesignRecommendation | null | undefined, occasion: Occasion | null): string | null {
  if (!rec || !isStyle(rec.designStyle)) return null;
  if (occasion === null || occasion === "other") return "A good fit for your book.";
  return `A good fit for a ${OCCASION_LABELS[occasion].toLowerCase()} book.`;
}

// ---- sessionStorage (so a refresh on the step keeps the user's own pick) ------------------------------

export function designPickStorageKey(bookId: string): string {
  return `photobook:design-pick:${bookId}`;
}

export function serializeDesignPick(pick: DesignPick): string {
  return JSON.stringify({ v: 1, format: pick.format, designStyle: pick.designStyle });
}

/** Anything unexpected → null (no remembered pick). */
export function parseDesignPick(raw: string | null | undefined): DesignPick | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    if (r.v !== 1) return null;
    const format = r.format === null ? null : isFormat(r.format) ? r.format : undefined;
    const designStyle = r.designStyle === null ? null : isStyle(r.designStyle) ? r.designStyle : undefined;
    if (format === undefined || designStyle === undefined) return null;
    return { format, designStyle };
  } catch {
    return null;
  }
}
