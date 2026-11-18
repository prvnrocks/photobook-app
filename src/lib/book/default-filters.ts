// Default photo looks for a freshly built album (D-089): about a third of the placed photos get one
// of the gentle filters (src/lib/design/photo-filters.ts defaultPhotoFilters — decided by a hash of
// the photo id, so a rebuild of the same photos gives the same looks). Called by the two album
// builders only (rule autolayout, AI planToDoc); relayouts and edits keep whatever doc.filters holds.
// The user changes or removes any of them in the editor's Filter tool.

import { defaultPhotoFilters } from "@/lib/design/photo-filter-defaults";
import type { BookDoc } from "./types";

/** Ids of the photos the doc places: cover first, then slots in page order (no backgrounds). */
export function placedPhotoIds(doc: Pick<BookDoc, "cover" | "pages">): string[] {
  const ids = new Set<string>();
  if (doc.cover.photoId) ids.add(doc.cover.photoId);
  for (const page of doc.pages) for (const slot of page.slots) if (slot.photoId) ids.add(slot.photoId);
  return [...ids];
}

/** `doc` with default looks on some of its placed photos (replaces any existing doc.filters). */
export function withDefaultFilters(doc: BookDoc): BookDoc {
  const filters = defaultPhotoFilters(placedPhotoIds(doc));
  if (Object.keys(filters).length === 0) {
    if (doc.filters === undefined) return doc;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop the key
    const { filters: _drop, ...rest } = doc;
    return rest;
  }
  return { ...doc, filters };
}
