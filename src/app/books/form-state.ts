// State shapes for the books server actions (useActionState). Lives outside the
// "use server" file because those may only export async functions.

export type NewBookField = "title" | "occasion" | "tone" | "captionLang";

export type NewBookFormState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<NewBookField, string>>;
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
