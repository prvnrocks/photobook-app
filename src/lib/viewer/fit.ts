// Flipbook stage sizing: fit A5 pages (148×210) into the space left for the book. Pure.

/** Viewport width (px) from which the viewer shows a two-page spread (D-040). */
export const SPREAD_MIN_WIDTH = 768;
export const SPREAD_MEDIA_QUERY = `(min-width: ${SPREAD_MIN_WIDTH}px)`;

export const PAGE_RATIO_W = 148;
export const PAGE_RATIO_H = 210;

export interface BookBox {
  /** Whole book (one page, or both pages of a spread) in CSS px. */
  width: number;
  height: number;
  pageWidth: number;
}

/** Largest book that fits `avail` (CSS px). Whole pixels so page edges stay crisp. */
export function fitBook(avail: { width: number; height: number }, spread: boolean): BookBox | null {
  const cols = spread ? 2 : 1;
  const byWidth = avail.width / cols;
  const byHeight = (avail.height * PAGE_RATIO_W) / PAGE_RATIO_H;
  const pageWidth = Math.floor(Math.min(byWidth, byHeight));
  if (!Number.isFinite(pageWidth) || pageWidth < 40) return null;
  return {
    width: pageWidth * cols,
    height: Math.round((pageWidth * PAGE_RATIO_H) / PAGE_RATIO_W),
    pageWidth,
  };
}
