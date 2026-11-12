// The book's name as the app chrome shows it (M13 T6 + polish). Before M13 one book had four names
// ("Your book" / "Untitled book" / the draft cover "Our Photobook" / the AI cover "Our Story").
// One rule everywhere (upload, build, review, editor header, dashboard):
//   1. the user's own title;
//   2. else, once an album exists (rule draft, AI album or user-edited doc), its cover title —
//      the name the book itself shows on its cover;
//   3. else the neutral "Your book" (no album yet: books.doc is still '{}').
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
  const isAlbum = meta?.generator === "ai" || meta?.generator === "rule" || meta?.userEdited === true;
  const cover = obj(d?.cover);
  const coverTitle = typeof cover?.title === "string" ? cover.title.trim() : "";
  if (isAlbum && coverTitle) return coverTitle;
  return UNTITLED_BOOK_LABEL;
}
