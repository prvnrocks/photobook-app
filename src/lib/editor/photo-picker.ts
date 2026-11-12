// Pure helpers for the editor's photo tools (M5 Task 9): picker tabs and the layout-change
// notice. No React, no DOM — unit-tested in node.

import type { ChangeLayoutResult } from "@/lib/book/edit-ops";
import type { BookDoc } from "@/lib/book/types";
import type { EditorShellPhoto } from "./types";

export type PickerTab = "inBook" | "notUsed" | "dropped";

export const PICKER_TABS: readonly { id: PickerTab; label: string; empty: string }[] = [
  { id: "inBook", label: "In book", empty: "No photos in the book yet." },
  { id: "notUsed", label: "Not used", empty: "Every kept photo is already in the book." },
  { id: "dropped", label: "Left out by AI", empty: "The AI didn't leave out any photos." },
];

export type PickerGroups = Record<PickerTab, EditorShellPhoto[]>;

/**
 * Split the book's photos into the picker tabs. Placement wins over AI status: a dropped photo
 * the user placed is "In book" (the server marks it kept on save, D-037 4); taking it out puts it
 * back under "Left out by AI". In book = doc order (cover first, then pages); the other tabs keep
 * the photos' own order. Ids in the doc without a photo row (deleted) are skipped.
 */
export function groupPickerPhotos(photos: readonly EditorShellPhoto[], doc: BookDoc): PickerGroups {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null) => {
    if (id === null || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  add(doc.cover.photoId);
  for (const page of doc.pages) for (const slot of page.slots) add(slot.photoId);

  const inBook = order.map((id) => byId.get(id)).filter((p): p is EditorShellPhoto => p !== undefined);
  const notUsed: EditorShellPhoto[] = [];
  const dropped: EditorShellPhoto[] = [];
  for (const p of photos) {
    if (seen.has(p.id)) continue;
    (p.status === "dropped" ? dropped : notUsed).push(p);
  }
  return { inBook, notUsed, dropped };
}

/** Tab to open first: where a new photo most likely comes from. */
export function defaultPickerTab(groups: PickerGroups): PickerTab {
  if (groups.notUsed.length > 0) return "notUsed";
  if (groups.dropped.length > 0) return "dropped";
  return "inBook";
}

/**
 * Toast copy after a layout change, from changeLayout's result; null when nothing was lost
 * (no toast needed). E.g. "1 photo moved to Not used", "Caption removed",
 * "2 photos moved to Not used · caption removed".
 */
export function layoutChangeNotice(result: Pick<ChangeLayoutResult, "removedPhotoIds" | "droppedCaption">): string | null {
  const n = result.removedPhotoIds.length;
  const photos = n > 0 ? `${n} ${n === 1 ? "photo" : "photos"} moved to Not used` : null;
  const caption = result.droppedCaption !== null;
  if (photos && caption) return `${photos} · caption removed`;
  if (photos) return photos;
  if (caption) return "Caption removed";
  return null;
}
