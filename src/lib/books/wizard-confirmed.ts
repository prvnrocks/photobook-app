// "Generate album" happened in this tab (M20c). Dependency-free (first-load client island safe).
//
// The server's truth is books.album_confirmed_at (migration 2000): every hard load of a wizard URL for
// a confirmed book redirects to the editor. But confirmAlbumAction's redirect is a soft navigation,
// so browser Back from the editor restores /books/new from Next's router cache — the old Review tree
// with its old server props, no request. This sessionStorage hint lets NewBookWizard recognise that
// case on mount and leave for the editor with location.replace (no history loop). Book ids only;
// best effort (storage blocked → the server gate still answers "editor" on the next fetch / load).

export const WIZARD_CONFIRMED_STORAGE_KEY = "photobook:wizard-confirmed";

/** Most recent ids kept (a tab confirms a handful of books at most). */
const MAX_IDS = 20;

function read(): string[] {
  try {
    const raw = window.sessionStorage.getItem(WIZARD_CONFIRMED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(-MAX_IDS) : [];
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    if (ids.length === 0) window.sessionStorage.removeItem(WIZARD_CONFIRMED_STORAGE_KEY);
    else window.sessionStorage.setItem(WIZARD_CONFIRMED_STORAGE_KEY, JSON.stringify(ids.slice(-MAX_IDS)));
  } catch {
    // storage unavailable: the server gate still decides
  }
}

/** Step 7 is about to call confirmAlbumAction for this book. */
export function rememberAlbumConfirmed(bookId: string): void {
  if (typeof window === "undefined" || !bookId) return;
  write([...read().filter((id) => id !== bookId), bookId]);
}

/** confirmAlbumAction failed without navigating: the book was not confirmed. */
export function forgetAlbumConfirmed(bookId: string): void {
  if (typeof window === "undefined" || !bookId) return;
  const ids = read();
  if (ids.includes(bookId)) write(ids.filter((id) => id !== bookId));
}

/** This tab generated the album of `bookId` (so a wizard view of it is a stale history entry). */
export function wasAlbumConfirmedHere(bookId: string): boolean {
  if (typeof window === "undefined" || !bookId) return false;
  return read().includes(bookId);
}
