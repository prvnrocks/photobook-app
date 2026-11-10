// Removing references to photos that no longer exist from a book doc (M10a review B1 / S3).
// Pure, no I/O. Safe on client and server.
//
// - stripMissingBackgrounds: photo backgrounds whose photo is gone. Book default → white colour
//   (no earlier colour is stored), page override → removed (page falls back to the book default).
// - stripPhotoFromDoc: everything that points at one deleted photo — cover/slot photoId → null
//   (pages and layouts stay as they are, an empty slot is valid), plus its backgrounds as above.
// Both return the input object unchanged (changed:false) when nothing references the photo(s).

import type { Background, BookDoc } from "./types";

/** Book default that replaces a removed photo background. */
export const FALLBACK_BOOK_BACKGROUND: Background = { kind: "color", hex: "#FFFFFF" };

export interface StripResult {
  doc: BookDoc;
  changed: boolean;
}

/** Drops photo backgrounds (book default + page overrides) whose photo `exists` rejects. */
export function stripMissingBackgrounds(doc: BookDoc, exists: (photoId: string) => boolean): StripResult {
  let changed = false;
  let style = doc.style;
  if (style.background.kind === "photo" && !exists(style.background.photoId)) {
    style = { ...style, background: { ...FALLBACK_BOOK_BACKGROUND } };
    changed = true;
  }
  const pages = doc.pages.map((page) => {
    if (page.background?.kind !== "photo" || exists(page.background.photoId)) return page;
    changed = true;
    const rest = { ...page };
    delete rest.background;
    return rest;
  });
  return changed ? { doc: { ...doc, style, pages }, changed } : { doc, changed };
}

/** Removes every reference to `photoId`: cover/slots → null, its backgrounds removed. */
export function stripPhotoFromDoc(doc: BookDoc, photoId: string): StripResult {
  let changed = false;
  let cover = doc.cover;
  if (cover.photoId === photoId) {
    cover = { ...cover, photoId: null };
    changed = true;
  }
  const pages = doc.pages.map((page) => {
    if (!page.slots.some((s) => s.photoId === photoId)) return page;
    changed = true;
    return { ...page, slots: page.slots.map((s) => (s.photoId === photoId ? { ...s, photoId: null } : s)) };
  });
  const bg = stripMissingBackgrounds({ ...doc, cover, pages }, (id) => id !== photoId);
  if (!changed && !bg.changed) return { doc, changed: false };
  return { doc: bg.doc, changed: true };
}
