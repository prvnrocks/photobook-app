// New book form design defaults + labels (M10b A12, D-063, D-065). Pure data, client-safe.
//
// The form offers a shape (format) and a design style. Both are fixed at creation (D-063): the
// editor only shows them (designLabel). M10b offers Modern + Classic only; geometric and scrapbook
// exist in the schema but arrive in M10c (add them to FORM_DESIGN_STYLES and pick per occasion
// in DEFAULT_STYLE_BY_OCCASION then).

import type { Occasion } from "@/lib/book/options";
import type { BookFormat, DesignStyle } from "@/lib/book/types";

/** Styles a user can pick on the New book form, in display order (D-065). */
export const FORM_DESIGN_STYLES = ["modern", "classic"] as const satisfies readonly DesignStyle[];
export type FormDesignStyle = (typeof FORM_DESIGN_STYLES)[number];

/** Shapes offered on the form, in display order (portrait first = default). */
export const FORM_FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const satisfies readonly BookFormat[];

export const DEFAULT_FORM_FORMAT: BookFormat = "A5_PORTRAIT";

/** Default style per occasion (D-065): every occasion → modern for now; M10c refines. */
export const DEFAULT_STYLE_BY_OCCASION: Record<Occasion, FormDesignStyle> = {
  wedding: "modern",
  travel: "modern",
  baby: "modern",
  graduation: "modern",
  family: "modern",
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
};

export const DESIGN_STYLE_HINTS: Record<FormDesignStyle, string> = {
  modern: "Edge-to-edge photos, script titles",
  classic: "Framed photos, simple captions",
};

/** Read-only editor label, e.g. "A5 Landscape · Modern". */
export function designLabel(format: BookFormat, style: DesignStyle | null | undefined): string {
  return `${FORMAT_LABELS[format]} · ${DESIGN_STYLE_LABELS[style ?? "classic"]}`;
}
