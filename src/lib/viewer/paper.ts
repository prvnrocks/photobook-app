// Viewer-only "real book" paint (M27): which side of the fold each flip page sits on (for the
// gutter shading + corner curl overlay FlipPage draws over the page) and where the page-block
// edges (stacked paper lines) go on the stage beside the book. Pure; never used by BookPage,
// the editor or print.
//
// page-flip (showCover) shows the cover alone on the right, then pairs [1,2], [3,4], …: odd flip
// indexes are left pages, even ones right pages, and an unpaired last page (the end card) stands
// alone on the left. Phones show one page at a time with the spine on its left. Page order is LTR
// for every book in v1 (D-040), so Arabic books use the same sides.

import { fitBook, type PageRatio } from "./fit";
import type { StageMetrics } from "./stage-pool";

/**
 * - left / right: a page of an open spread (fold on its right / left edge)
 * - cover: the front cover alone on the right of a spread (hinge on its left edge)
 * - back: the last page alone on the left of a spread (hinge on its right edge)
 * - single: phone, one page at a time (spine on its left edge)
 */
export type PaperSide = "left" | "right" | "cover" | "back" | "single";

export interface PaperInfo {
  side: PaperSide;
  /** Static page-curl hint at the top-right corner (never on the last page). */
  curl: boolean;
}

export function paperFor(index: number, count: number, spread: boolean): PaperInfo {
  const last = index >= count - 1;
  if (!spread) return { side: "single", curl: !last };
  if (index <= 0) return { side: "cover", curl: !last };
  if (index % 2 === 1) return { side: last ? "back" : "left", curl: false };
  return { side: "right", curl: !last };
}

/** Absolute placement + paint of the page-block edges element (stage padding-box px). */
export interface BookEdgesStyle {
  left: number;
  top: number;
  width: number;
  height: number;
  /** One no-repeat layer per side with a stack. */
  background: string;
}

/** Thickest stack (px) for a page `pageWidth` wide: ~2.2 %, 3–10 px. */
export function maxStackPx(pageWidth: number): number {
  return Math.min(10, Math.max(3, Math.round(pageWidth * 0.022)));
}

/** Paper leaves (2 px light, 1 px line) `t` px thick at `pos`; `dir` points away from the book. */
function stackLayer(dir: "left" | "right", t: number, pos: string): string {
  return t > 0 ? `repeating-linear-gradient(to ${dir},#fdfcf9 0 2px,#cfc8ba 2px 3px) ${pos}/${t}px 100% no-repeat` : "";
}

/**
 * Page-block edges beside the visible book: read pages stacked under the left page, pages to come
 * under the right one (phones: only the right, the spine is on the left). Thickness follows
 * progress; no stack where nothing is left (cover alone has none on the left, the last page none
 * on the right). Mirrors the Flipbook's own fit (fitBook on the stage content box, centred), like
 * stagePoolStyle. Null when the book doesn't fit or there is nothing to draw.
 */
export function bookEdgesStyle(
  stage: StageMetrics,
  spread: boolean,
  ratio: PageRatio,
  visible: readonly number[],
  count: number,
): BookEdgesStyle | null {
  const avail = {
    width: stage.width - stage.padLeft - stage.padRight,
    height: stage.height - stage.padTop - stage.padBottom,
  };
  if (!(avail.width > 0 && avail.height > 0) || visible.length === 0 || count < 2) return null;
  const box = fitBook(avail, spread, ratio);
  if (!box) return null;

  const first = Math.min(...visible);
  const last = Math.max(...visible);
  const span = count - 1;
  const max = maxStackPx(box.pageWidth);
  const thick = (frac: number) => (frac > 0 ? Math.max(2, Math.round(max * frac)) : 0);
  const tL = spread ? thick(first / span) : 0;
  const tR = thick((span - last) / span);
  if (tL === 0 && tR === 0) return null;

  const bookLeft = stage.padLeft + (avail.width - box.width) / 2;
  const bookTop = stage.padTop + (avail.height - box.height) / 2;
  const alone = spread && visible.length === 1;
  const visLeft = alone && first === 0 ? bookLeft + box.pageWidth : bookLeft;
  const visWidth = alone ? box.pageWidth : box.width;

  return {
    left: visLeft - tL,
    top: bookTop,
    width: visWidth + tL + tR,
    height: box.height,
    background: [stackLayer("left", tL, "0 0"), stackLayer("right", tR, "100% 0")].filter(Boolean).join(","),
  };
}
