// State shapes for the books server actions (useActionState). Lives outside the
// "use server" file because those may only export async functions.

import type { WizardStep5Data } from "@/lib/books/wizard-data";

export type NewBookField = "title" | "occasion" | "tone" | "captionLang" | "format" | "designStyle";

export type NewBookFormState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<NewBookField, string>>;
  /** Success only (M19 BUG-2): the new book's id … */
  bookId?: string;
  /**
   * … the book's step 5 URL (/books/new?book=<id>&step=5, with the one-shot &_ev=book_created when
   * analytics is on — the wizard reads the flash from it; no navigation goes there) …
   */
  next?: string;
  /** … and the wizard's step-5 data for the new book (M20 T6: step 5 shows in place). */
  step5?: WizardStep5Data;
};

export const initialNewBookFormState: NewBookFormState = { ok: false };

/** Result of deletePhotoAction / deleteUnfinishedAction. */
export type PhotoActionResult = { ok: true } | { ok: false; error: string };

export const TITLE_MAX_CHARS = 120;

/**
 * Book title as stored: tabs/newlines → space, other control characters
 * (Unicode Cc) removed, trimmed; empty → null. Length is checked separately in
 * code points (Postgres char_length), see TITLE_MAX_CHARS.
 */
export function cleanTitle(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\t\n\r\v\f]/g, " ").replace(/\p{Cc}/gu, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function titleLength(title: string): number {
  return [...title].length;
}
