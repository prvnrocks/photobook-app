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

/** A background as print-doc needs it (v2 union, or a v1 hex string = colour). */
type BackgroundRef = { kind: string; photoId?: string } | string | null | undefined;

function backgroundPhotoId(bg: BackgroundRef): string | null {
  return bg && typeof bg === "object" && bg.kind === "photo" && typeof bg.photoId === "string" ? bg.photoId : null;
}

/**
 * Photo ids the given sheets show, deduplicated, in order: per sheet its content photos (cover
 * photo / page slots) then its background photo (M10a A6: the cover shows the book default
 * background; a page its own override, else the book default).
 */
export function printPhotoIds(
  doc: {
    cover: { photoId: string | null };
    pages: { slots: { photoId: string | null }[]; background?: BackgroundRef }[];
    style?: { background?: BackgroundRef };
  },
  targets: readonly PrintSheetTarget[],
): string[] {
  const ids = new Set<string>();
  const bookBg = backgroundPhotoId(doc.style?.background);
  for (const t of targets) {
    if (t === "cover") {
      if (doc.cover.photoId) ids.add(doc.cover.photoId);
      if (bookBg) ids.add(bookBg);
    } else {
      const page = doc.pages[t];
      if (!page) {
        if (bookBg) ids.add(bookBg); // a missing page renders blank on the book default
        continue;
      }
      for (const s of page.slots) if (s.photoId) ids.add(s.photoId);
      const bg = page.background ? backgroundPhotoId(page.background) : bookBg;
      if (bg) ids.add(bg);
    }
  }
  return [...ids];
}
