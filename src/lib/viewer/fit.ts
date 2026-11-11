// Flipbook stage sizing: fit pages of the book's format (A5 portrait 148×210 by default, landscape
// 210×148 via pageRatio(doc.format)) into the space left for the book. Pure.

import { pageMm } from "@/lib/book/format";
import type { BookFormat } from "@/lib/book/types";

/** Viewport width (px) from which the viewer shows a two-page spread (D-040). */
export const SPREAD_MIN_WIDTH = 768;
export const SPREAD_MEDIA_QUERY = `(min-width: ${SPREAD_MIN_WIDTH}px)`;

/** A5 portrait page ratio (compat default). Format-aware callers use pageRatio(doc.format). */
export const PAGE_RATIO_W = 148;
export const PAGE_RATIO_H = 210;

export interface PageRatio {
  readonly w: number;
  readonly h: number;
}

/** Page width:height of `format` as whole mm (portrait 148:210, landscape 210:148). */
export function pageRatio(format?: BookFormat | null): PageRatio {
  const p = pageMm(format);
  return { w: p.w, h: p.h };
}

export interface BookBox {
  /** Whole book (one page, or both pages of a spread) in CSS px. */
  width: number;
  height: number;
  pageWidth: number;
}

/**
 * Largest book that fits `avail` (CSS px). Whole-pixel page width; the height is rounded UP so
 * page-flip ("stretch": pageHeight = pageWidth / ratio, shrunk to the block height only when taller)
 * keeps exactly `pageWidth` per page. A height rounded down made page-flip shrink the pages to a
 * fractional width (e.g. 482.42 px), and two fractional page boxes snap to device pixels on their
 * own — a 1 px light seam through a panorama spread at the fold (M10b A13). The height uses the
 * whole pixels of `avail.height` so rounding up never exceeds it.
 */
export function fitBook(
  avail: { width: number; height: number },
  spread: boolean,
  ratio: PageRatio = { w: PAGE_RATIO_W, h: PAGE_RATIO_H },
): BookBox | null {
  const cols = spread ? 2 : 1;
  const byWidth = avail.width / cols;
  const byHeight = (Math.floor(avail.height) * ratio.w) / ratio.h;
  const pageWidth = Math.floor(Math.min(byWidth, byHeight));
  if (!Number.isFinite(pageWidth) || pageWidth < 40) return null;
  return {
    width: pageWidth * cols,
    height: pageHeightPx(pageWidth, ratio),
    pageWidth,
  };
}

/** Whole-pixel height that holds a `pageWidth` page of `ratio` (rounded up; float noise ignored). */
export function pageHeightPx(pageWidth: number, ratio: PageRatio): number {
  return Math.ceil((pageWidth * ratio.h) / ratio.w - 1e-9);
}
