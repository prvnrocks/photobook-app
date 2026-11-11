// Pure helpers for the internal print route (M8 T5): which sheets a token range covers and the
// render photo map with every src on the print-asset origin. Isomorphic, no React, no DOM.

import type { RenderPhotos } from "@/lib/book/render";
import { getLayout } from "@/lib/layouts";
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

/** A page as printPhotoIds needs it (structural, so tests and the prefetch schedule can pass slim docs). */
interface PhotoIdsPage {
  slots: { photoId: string | null }[];
  background?: BackgroundRef;
  /** Layout id (M10b): spread layouts put both halves' photos on the left page. */
  layout?: string;
  side?: string;
}

/** True when a spread rect (x 0..200) seen from a half (offset 0 / 100) overlaps that page — render.ts onPage. */
function onHalf(rect: { x: number; w: number }, offset: number): boolean {
  const x = rect.x - offset;
  return x < 100 - 1e-9 && x + rect.w > 1e-9;
}

/**
 * Content photo ids one page sheet shows. Single pages: its slots. Spread halves (M10b): the slots
 * of the OWNER (left half = itself, right half = the matching left page before it, as render.ts
 * spreadHalfOf) whose rect is visible on this half — a panorama is listed on both halves, a
 * photo of the grid's right half only on the right sheet. So a spread straddling a chunk
 * boundary (left = last sheet of chunk k, right = first sheet of chunk k + 1) gets its photos on
 * both chunks' print routes and in both chunks' prefetch schedules.
 */
function pagePhotoIds(pages: readonly PhotoIdsPage[], index: number): (string | null)[] {
  const page = pages[index];
  const layout = page.layout ? getLayout(page.layout) : undefined;
  if (layout?.role !== "spread") return page.slots.map((s) => s.photoId);
  let owner: PhotoIdsPage | null = page;
  let offset = 0;
  if (page.side === "right") {
    const prev = pages[index - 1];
    owner = prev && prev.side === "left" && prev.layout === page.layout ? prev : null;
    offset = 100;
  }
  if (!owner) return []; // orphaned right half renders background only
  return layout.slots.map((rect, i) => (onHalf(rect, offset) ? (owner.slots[i]?.photoId ?? null) : null));
}

/**
 * Photo ids the given sheets show, deduplicated, in order: per sheet its content photos (cover
 * photo / page slots — spread halves: the owner's slots visible on that half) then its background
 * photo (M10a A6: the cover shows the book default background; a page its own override, else the
 * book default).
 */
export function printPhotoIds(
  doc: {
    cover: { photoId: string | null };
    pages: readonly PhotoIdsPage[];
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
      for (const id of pagePhotoIds(doc.pages, t)) if (id) ids.add(id);
      const bg = page.background ? backgroundPhotoId(page.background) : bookBg;
      if (bg) ids.add(bg);
    }
  }
  return [...ids];
}
