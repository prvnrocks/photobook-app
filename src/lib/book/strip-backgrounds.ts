// Photo backgrounds whose photo no longer exists (M10a review B1). Pure, no I/O.
// Split out of strip-photos.ts (M10b A19) so relayout.ts can use it while strip-photos.ts uses
// relayout's removal step (no import cycle). strip-photos.ts re-exports both names.

import { styleDefaultBackground } from "@/lib/design/background-suggest";
import type { Background, BookDoc } from "./types";

/** Book default that replaces a removed photo background. */
export const FALLBACK_BOOK_BACKGROUND: Background = { kind: "color", hex: "#FFFFFF" };

export interface StripResult {
  doc: BookDoc;
  changed: boolean;
}

/**
 * Drops photo backgrounds (book default + page overrides) whose photo `exists` rejects. Book
 * default → white colour (no earlier colour is stored; style default when backgroundSource "ai"), page override → removed (page falls back
 * to the book default). Returns the input object (changed:false) when nothing is removed.
 */
export function stripMissingBackgrounds(doc: BookDoc, exists: (photoId: string) => boolean): StripResult {
  let changed = false;
  let style = doc.style;
  if (style.background.kind === "photo" && !exists(style.background.photoId)) {
    // An AI-chosen book background falls back to the style default (M10c T11); a user/legacy one to white.
    const fallback = style.backgroundSource === "ai" ? styleDefaultBackground(style.designStyle) : { ...FALLBACK_BOOK_BACKGROUND };
    style = { ...style, background: fallback };
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
