// Pure helpers for the internal print route (M8 T5): which sheets a token range covers and the
// render photo map with every src on the print-asset origin. Isomorphic, no React, no DOM.

import type { RenderPhotos } from "@/lib/book/render";
import { printAssetUrl } from "./print-assets";

/** One print sheet: the cover or an index into doc.pages. */
export type PrintSheetTarget = "cover" | number;

/**
 * Sheets from..to inclusive (0 = cover, sheet i = doc.pages[i - 1]) for a doc with `pageCount`
 * pages, or null when the range is malformed or runs past the last sheet (token / doc mismatch).
 */
export function printSheetTargets(pageCount: number, from: number, to: number): PrintSheetTarget[] | null {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) return null;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return null;
  if (to > pageCount) return null;
  const out: PrintSheetTarget[] = [];
  for (let s = from; s <= to; s++) out.push(s === 0 ? "cover" : s - 1);
  return out;
}

export interface PrintPhotoDims {
  id: string;
  width: number | null;
  height: number | null;
}

function positiveInt(n: unknown): number | null {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** RenderPhotos for print: stored pixel size (for the crop maths) + src = printAssetUrl(id). */
export function printRenderPhotos(rows: Iterable<PrintPhotoDims>): RenderPhotos {
  const out: Record<string, { url: string; width: number | null; height: number | null }> = {};
  for (const r of rows) {
    out[r.id] = { url: printAssetUrl(r.id), width: positiveInt(r.width), height: positiveInt(r.height) };
  }
  return out;
}

/** Photo ids the given sheets show (cover photo + page slots), deduplicated, in order. */
export function printPhotoIds(
  doc: { cover: { photoId: string | null }; pages: { slots: { photoId: string | null }[] }[] },
  targets: readonly PrintSheetTarget[],
): string[] {
  const ids = new Set<string>();
  for (const t of targets) {
    if (t === "cover") {
      if (doc.cover.photoId) ids.add(doc.cover.photoId);
    } else {
      for (const s of doc.pages[t]?.slots ?? []) if (s.photoId) ids.add(s.photoId);
    }
  }
  return [...ids];
}
