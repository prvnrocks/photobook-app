// Build screen draft preview (M13 T7, D-070 (3)): which pages of the rule-based draft to show
// while the AI run works, and which photos they need. Pure: no React, no server imports.
// Only photo ids travel through here; the page signs thumbs for exactly these ids.

import type { BookDoc } from "@/lib/book/types";
import type { RenderPhotos } from "@/lib/book/render";

/** Cover + this many pages: enough to recognise the book, small enough to sign quickly. */
export const DRAFT_PREVIEW_PAGES = 5;

export type DraftPreviewItem = "cover" | number;

/** Cover first, then the first pages in book order. */
export function draftPreviewItems(doc: BookDoc, maxPages = DRAFT_PREVIEW_PAGES): DraftPreviewItem[] {
  const n = Math.max(0, Math.min(doc.pages.length, maxPages));
  return ["cover", ...Array.from({ length: n }, (_, i) => i)];
}

function collectPhotoIds(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectPhotoIds(v, into, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === "photoId" && typeof v === "string" && v.length > 0) into.add(v);
    else collectPhotoIds(v, into, depth + 1);
  }
}

/**
 * Every photo the shown items render: slot photos, the cover photo and photo backgrounds (book
 * default + page overrides). A spread's right half reads its slots from the left page, which is
 * always shown before it.
 */
export function draftPreviewPhotoIds(doc: BookDoc, items: readonly DraftPreviewItem[]): string[] {
  const ids = new Set<string>();
  collectPhotoIds(doc.style, ids);
  for (const item of items) {
    if (item === "cover") collectPhotoIds(doc.cover, ids);
    else collectPhotoIds(doc.pages[item], ids);
  }
  return [...ids];
}

export type DraftPreviewPhoto = { id: string; thumbUrl: string | null; width: number | null; height: number | null };

/** Render map of 512 px thumbs for the wanted ids only (unsigned photos are left out → empty slot). */
export function draftPreviewPhotos(wanted: readonly string[], photos: readonly DraftPreviewPhoto[]): RenderPhotos {
  const want = new Set(wanted);
  const out: Record<string, { url: string; width: number | null; height: number | null }> = {};
  for (const p of photos) {
    if (want.has(p.id) && p.thumbUrl) out[p.id] = { url: p.thumbUrl, width: p.width, height: p.height };
  }
  return out;
}
