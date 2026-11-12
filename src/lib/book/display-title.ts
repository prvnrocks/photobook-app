// The book's name as the app chrome shows it (M13 T6). Before M13 a book without a title showed
// "Untitled book" while its cover already said "Our Story" (T1 copy nit). Rule: the user's title;
// else the cover title the AI wrote (or the user edited) once an AI / edited album exists; else the
// neutral "Your book" — never the rule draft's placeholder title (it isn't the user's or the AI's).
// Pure raw read (no schema parse), client- and server-safe.

export const UNTITLED_BOOK_LABEL = "Your book";

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function displayBookTitle(title: string | null | undefined, doc?: unknown): string {
  const own = typeof title === "string" ? title.trim() : "";
  if (own) return own;
  const d = obj(doc);
  const meta = obj(d?.meta);
  const fromAiOrUser = meta?.generator === "ai" || meta?.userEdited === true;
  const cover = obj(d?.cover);
  const coverTitle = typeof cover?.title === "string" ? cover.title.trim() : "";
  if (fromAiOrUser && coverTitle) return coverTitle;
  return UNTITLED_BOOK_LABEL;
}
