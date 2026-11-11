// Book format + design style authority (M10b A6, D-063). Pure: no React/DOM/server imports.
//
// books.format / books.design_style (migration 1900, insert-only for users) are the ONLY source
// of a book's doc.format and doc.style.designStyle. Every server writer of books.doc (editor save,
// finalize fallback album, AI orchestrator build/rule fallback, Update album relayout, photo
// delete strip) stamps the doc with the row's design via withBookDesign BEFORE validating and
// serialising, so a client can never change them and the stored doc always agrees with the
// columns (rls_check has a live check for that).
//
// v1 compatibility: a classic A5 portrait book stamps format "A5_PORTRAIT" + designStyle
// "classic" — exactly what parseBookDoc already gives a v1 doc — so serializeDoc still writes v1
// and the stored JSON stays byte-identical (usesV2Features treats designStyle "classic" as v1).
//
// Layout style rule (strict, validateBookDoc): a book only uses layouts of its own design style —
// classic books classic layouts, modern books modern layouts — in addition to the A2 rule that
// layouts match the book's format. Every book created before M10b is classic portrait and every
// shipping classic layout is classic portrait, so existing books are unaffected.

import { DEFAULT_FORMAT } from "./format";
import { BookFormatSchema, DEFAULT_DESIGN_STYLE, DesignStyleSchema, parseBookDoc } from "./schema";
import type { BookDoc, BookFormat, DesignStyle } from "./types";

export interface BookDesign {
  format: BookFormat;
  designStyle: DesignStyle;
}

export const DEFAULT_BOOK_DESIGN: Readonly<BookDesign> = { format: DEFAULT_FORMAT, designStyle: DEFAULT_DESIGN_STYLE };

// --- Supported designs (M10b A19, review S1) ------------------------------------------------------
// The schema + DB accept every DESIGN_STYLES value (geometric / scrapbook are reserved for M10c, and
// a row with one can be inserted directly through PostgREST — the New book form refuses them), but
// the layout catalogue only has classic + modern layouts. Every doc WRITER that lays pages out
// (autolayout, fillPages, relayoutDoc, planToDoc / prunePlan, photo-delete reflow, cover / full-page
// picks) calls assertSupportedDesign first and throws the typed UnsupportedDesignError, which each
// caller turns into a clean refusal (finalize: no fallback album; AI start: 422; a queued run:
// failed with error_code 'unsupported_design'; Update album: error; editor save: 422). The style is
// never remapped: the stored doc must keep agreeing with books.design_style (rls_check).
// Extend this list in the same change that ships a style's layouts (a test checks every supported
// style × format has a cover, a one-photo page and a full-page layout).

export const SUPPORTED_DESIGN_STYLES = ["classic", "modern"] as const satisfies readonly DesignStyle[];

export function isSupportedDesign(design: BookDesign): boolean {
  return (SUPPORTED_DESIGN_STYLES as readonly string[]).includes(design.designStyle);
}

/** A writer was asked to lay out a book whose design style has no layouts yet. Message has ids only. */
export class UnsupportedDesignError extends Error {
  readonly code = "unsupported_design" as const;
  readonly design: BookDesign;
  constructor(design: BookDesign) {
    super(`unsupported_design ${design.format}/${design.designStyle}`);
    this.name = "UnsupportedDesignError";
    this.design = design;
  }
}

/** Throws UnsupportedDesignError unless `design` has a layout catalogue. */
export function assertSupportedDesign(design: BookDesign): void {
  if (!isSupportedDesign(design)) throw new UnsupportedDesignError(design);
}

export function isUnsupportedDesignError(e: unknown): e is UnsupportedDesignError {
  return e instanceof UnsupportedDesignError;
}

/** The design a stored doc names (parseBookDoc upgrades v1 → classic portrait); default when unparsable / `{}`. */
export function designOfDoc(doc: unknown): BookDesign {
  const parsed = parseBookDoc(doc);
  if (!parsed.ok) return { ...DEFAULT_BOOK_DESIGN };
  return { format: parsed.doc.format, designStyle: parsed.doc.style.designStyle ?? DEFAULT_DESIGN_STYLE };
}

/**
 * A book row's design: the columns when present and valid (always, once migration 1900 is
 * applied — not null + check constraints), else — only in a pre-1900 window or for a row loaded
 * without the columns — what the stored doc names, else the default (portrait / classic).
 */
export function bookDesignOf(row: { format?: unknown; design_style?: unknown; doc?: unknown }): BookDesign {
  const format = BookFormatSchema.safeParse(row.format);
  const style = DesignStyleSchema.safeParse(row.design_style);
  if (format.success && style.success) return { format: format.data, designStyle: style.data };
  const fromDoc = designOfDoc(row.doc);
  return {
    format: format.success ? format.data : fromDoc.format,
    designStyle: style.success ? style.data : fromDoc.designStyle,
  };
}

/** True when `doc` already carries `design` (an absent designStyle counts as classic). */
export function hasBookDesign(doc: BookDoc, design: BookDesign): boolean {
  return doc.format === design.format && (doc.style.designStyle ?? DEFAULT_DESIGN_STYLE) === design.designStyle;
}

/**
 * `doc` with format + style.designStyle forced to `design`. Returns the SAME object when it already
 * matches (callers use identity to detect "nothing changed"); never mutates `doc`.
 */
export function withBookDesign(doc: BookDoc, design: BookDesign): BookDoc {
  if (hasBookDesign(doc, design) && doc.style.designStyle !== undefined) return doc;
  return { ...doc, format: design.format, style: { ...doc.style, designStyle: design.designStyle } };
}
