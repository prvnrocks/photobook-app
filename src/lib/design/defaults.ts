// New book form design defaults + labels (M10b A12, D-063, D-065; M10c T13, D-068). Pure data,
// client-safe.
//
// The form offers a shape (format) and a design style. Both are fixed at creation (D-063): the
// editor only shows them (designLabel). Every style is offered for every occasion (M10c: four;
// M30, D-090: + Magazine and Editorial); each occasion picks its default (D-068; travel → Magazine,
// D-090) until the user chooses one.

import type { Occasion } from "@/lib/book/options";
import type { BookFormat, DesignStyle } from "@/lib/book/types";

/**
 * Styles a user can pick on the New book form, in display order (two columns on phones; D-068).
 * The first four keep their M10c order; the M30 styles follow (D-090).
 */
export const FORM_DESIGN_STYLES = ["modern", "classic", "geometric", "scrapbook", "magazine", "editorial"] as const satisfies readonly DesignStyle[];
export type FormDesignStyle = (typeof FORM_DESIGN_STYLES)[number];

/** Shapes offered on the form, in display order (portrait first = default). */
export const FORM_FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const satisfies readonly BookFormat[];

export const DEFAULT_FORM_FORMAT: BookFormat = "A5_PORTRAIT";

/** Default style per occasion (D-068, replaces D-065's all-Modern; travel → Magazine, D-090). */
export const DEFAULT_STYLE_BY_OCCASION: Record<Occasion, FormDesignStyle> = {
  wedding: "modern",
  travel: "magazine",
  baby: "scrapbook",
  birthday: "scrapbook",
  graduation: "geometric",
  family: "scrapbook",
  other: "modern",
};

/** Style shown before an occasion is chosen. */
export const DEFAULT_FORM_STYLE: FormDesignStyle = "modern";

export function defaultStyleFor(occasion: Occasion | null | undefined): FormDesignStyle {
  return (occasion && DEFAULT_STYLE_BY_OCCASION[occasion]) || DEFAULT_FORM_STYLE;
}

/** The style the form shows: the user's pick wins; otherwise the occasion's default. */
export function effectiveStyle(manual: FormDesignStyle | null, occasion: Occasion | null): FormDesignStyle {
  return manual ?? defaultStyleFor(occasion);
}

export function isFormDesignStyle(value: unknown): value is FormDesignStyle {
  return typeof value === "string" && (FORM_DESIGN_STYLES as readonly string[]).includes(value);
}

/** Short shape names for the form controls. */
export const FORMAT_SHORT_LABELS: Record<BookFormat, string> = {
  A5_PORTRAIT: "Portrait",
  A5_LANDSCAPE: "Landscape",
};

export const FORMAT_LABELS: Record<BookFormat, string> = {
  A5_PORTRAIT: "A5 Portrait",
  A5_LANDSCAPE: "A5 Landscape",
};

export const FORMAT_HINTS: Record<BookFormat, string> = {
  A5_PORTRAIT: "148 × 210 mm",
  A5_LANDSCAPE: "210 × 148 mm",
};

export const DESIGN_STYLE_LABELS: Record<DesignStyle, string> = {
  modern: "Modern",
  classic: "Classic",
  geometric: "Geometric",
  scrapbook: "Scrapbook",
  magazine: "Magazine",
  editorial: "Editorial",
};

export const DESIGN_STYLE_HINTS: Record<FormDesignStyle, string> = {
  modern: "Edge-to-edge photos, script titles",
  classic: "Framed photos, simple captions",
  geometric: "Bold shapes, clean colour blocks",
  scrapbook: "Tilted prints, tape and stickers",
  magazine: "Big cover title, bold colour panels",
  editorial: "White pages, diagonal cuts, thin rules",
};

/** Read-only editor label, e.g. "A5 Landscape · Modern". */
export function designLabel(format: BookFormat, style: DesignStyle | null | undefined): string {
  return `${FORMAT_LABELS[format]} · ${DESIGN_STYLE_LABELS[style ?? "classic"]}`;
}
