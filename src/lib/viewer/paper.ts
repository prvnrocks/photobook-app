// Viewer-only "real book" paint (M27): which side of the fold each flip page sits on (for the
// gutter shading + corner curl overlay FlipPage draws over the page) and where the page-block
// edges (stacked paper lines) go on the stage beside the book. M28: the book is a hardcover — the
// front cover and the back (last page) are hard boards (hinge groove, no curl), and the stage
// paints the case around the visible pages (bookCase): boards under an open book, the cover's
// board edge (bleed + wrap) and the closed book's thickness around a closed one. Pure; never used
// by BookPage, the editor or print.
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
  /** Static page-curl hint at the top-right corner (never on the last page or a hard board). */
  curl: boolean;
  /**
   * M28: the page is the outside of a hard board (front cover = index 0, back = last index) and
   * this is its hinge side, where the squeeze groove runs. Phones keep the spine on the left.
   */
  board?: "left" | "right";
}

/** True for the flip pages that turn as hard boards (front cover and back / end page). */
export function isBoardPage(index: number, count: number): boolean {
  return count > 0 && (index <= 0 || index >= count - 1);
}

export function paperFor(index: number, count: number, spread: boolean): PaperInfo {
  const last = index >= count - 1;
  if (!spread) return isBoardPage(index, count) ? { side: "single", curl: false, board: "left" } : { side: "single", curl: true };
  if (index <= 0) return last ? { side: "cover", curl: false } : { side: "cover", curl: false, board: "left" };
  if (index % 2 === 1) return last ? { side: "back", curl: false, board: "right" } : { side: "left", curl: false };
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

/** Absolute placement of one case element (stage padding-box px). */
export interface CaseBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * - open: pages of an open book; the boards lie under them (a rim beyond the text block on top,
 *   bottom and the outer sides; the page-block edges sit on the boards beside the pages).
 * - front: the closed book showing its front cover (spread: cover alone; phone: index 0).
 * - back: the closed book showing its back (spread: end page alone on the left; phone: last page).
 */
export type CaseState = "open" | "front" | "back";

export interface BookCase {
  state: CaseState;
  /** Spine / hinge side of what is shown (phones: always left). */
  hinge: "left" | "right";
  /** Open: the square — how far the boards reach beyond the text block (top, bottom, outer sides
   * beyond the page-block edges). Closed: the face's wrapped edge round the cover page. px. */
  square: number;
  /** Open: both boards under the spread. Closed: the far board, seen past the page block. */
  boards: CaseBox;
  /** Open spread: x of the spine inside `boards` (px from its left edge); else null. */
  spineX: number | null;
  /** Closed: the shown board's face — the cover page plus its bleed / wrapped edge. Else null. */
  face: CaseBox | null;
  /** Spine-side part of `face` (the board edge rounding into the spine), px. */
  spine: number;
  /** Page-block edges (stacked paper lines): beside the pages when open, the closed book's fore-edge when closed. */
  edges: BookEdgesStyle | null;
  /** How far the case reaches beyond the visible pages on each side (ground shadow), px. */
  grow: { left: number; right: number; top: number; bottom: number };
}

/** Square for a page `pageHeight` px tall: ~2 % of the page height, 3–14 px (before clamping). */
export function squarePx(pageHeight: number): number {
  return Math.min(14, Math.max(3, Math.round(pageHeight * 0.02)));
}

const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The hardcover case round the visible pages, all paint behind the flipbook (stage padding-box
 * px). Mirrors the Flipbook's own fit (fitBook on the stage content box, centred), like
 * stagePoolStyle; the book box itself never changes. Every part stays inside the stage: each side
 * reaches at most to the stage edge (≥ the stage padding — 8 px phone, 16 px ≥ sm).
 * Null when the book doesn't fit or nothing is visible.
 */
export function bookCase(
  stage: StageMetrics,
  spread: boolean,
  ratio: PageRatio,
  visible: readonly number[],
  count: number,
): BookCase | null {
  const avail = {
    width: stage.width - stage.padLeft - stage.padRight,
    height: stage.height - stage.padTop - stage.padBottom,
  };
  if (!(avail.width > 0 && avail.height > 0) || visible.length === 0 || count < 2) return null;
  const box = fitBook(avail, spread, ratio);
  if (!box) return null;

  const first = Math.min(...visible);
  const last = Math.max(...visible);
  const P = box.pageWidth;
  const H = box.height;
  const bookLeft = stage.padLeft + (avail.width - box.width) / 2;
  const bookTop = stage.padTop + (avail.height - box.height) / 2;
  const alone = spread && visible.length === 1;
  const visLeft = alone && first === 0 ? bookLeft + P : bookLeft;
  const visWidth = alone ? P : box.width;
  // Room to the stage's padding-box edges round the visible pages.
  const sL = Math.floor(visLeft);
  const sR = Math.floor(stage.width - (visLeft + visWidth));
  const sT = Math.floor(bookTop);
  const sB = Math.floor(stage.height - (bookTop + H));
  const max = maxStackPx(P);
  const target = squarePx(H);

  const closedFront = first === 0 && (alone || !spread);
  const closedBack = !closedFront && last === count - 1 && (alone || !spread);

  if (closedFront || closedBack) {
    // Spread back: the end page alone on the left, hinge on its right. Phones keep the hinge left.
    const hinge: "left" | "right" = closedBack && spread ? "right" : "left";
    const sFore = hinge === "left" ? sR : sL;
    const sSpine = hinge === "left" ? sL : sR;
    // r: the face's wrapped edge (cover art bled round the board edge, ~half a square); e: the far
    // board peeking past the page block; band: the closed page block's fore-edge between them.
    const r = Math.max(0, Math.min(Math.max(2, Math.round(target * 0.5)), sT, sB - 2, Math.floor(sFore * 0.3)));
    const e = Math.max(0, Math.min(r >= 5 ? 3 : 2, sB - r, sFore - r));
    const band = clampN(sFore - r - e, 0, max);
    const sp = Math.max(0, Math.min(Math.round(r * 0.8), sSpine));
    const faceLeft = hinge === "left" ? visLeft - sp : visLeft - r;
    const faceWidth = P + sp + r;
    const far = r + band + e; // fore-edge reach: board edge, page block, far board
    const edges: BookEdgesStyle | null =
      band > 0
        ? {
            left: hinge === "left" ? visLeft + P + r : visLeft - r - band,
            top: bookTop + Math.round(e / 2),
            width: band,
            height: H,
            background: stackLayer(hinge === "left" ? "right" : "left", band, "0 0"),
          }
        : null;
    return {
      state: closedFront ? "front" : "back",
      hinge,
      square: r,
      boards: {
        left: hinge === "left" ? visLeft - sp : visLeft - far,
        top: bookTop - r + e,
        width: P + sp + far,
        height: H + 2 * r,
      },
      spineX: null,
      face: { left: faceLeft, top: bookTop - r, width: faceWidth, height: H + 2 * r },
      spine: sp,
      edges,
      grow: {
        left: hinge === "left" ? sp : far,
        right: hinge === "left" ? far : sp,
        top: r,
        bottom: r + e,
      },
    };
  }

  // Open: page-block stacks beside the pages (read pages left, pages to come right; phones only
  // the right), the boards one square beyond them.
  const span = count - 1;
  const thick = (frac: number) => (frac > 0 ? Math.max(2, Math.round(max * frac)) : 0);
  const r = Math.max(0, Math.min(target, sT, sB, Math.floor(sR * 0.5), spread ? Math.floor(sL * 0.5) : target));
  const tL = spread ? Math.max(0, Math.min(thick(first / span), sL - r)) : 0;
  const tR = Math.max(0, Math.min(thick((span - last) / span), sR - r));
  const left = spread ? tL + r : 0;
  const right = tR + r;
  return {
    state: "open",
    hinge: "left",
    square: r,
    boards: { left: visLeft - left, top: bookTop - r, width: visWidth + left + right, height: H + 2 * r },
    spineX: spread ? left + P : null,
    face: null,
    spine: 0,
    edges:
      tL > 0 || tR > 0
        ? {
            left: visLeft - tL,
            top: bookTop,
            width: visWidth + tL + tR,
            height: H,
            background: [stackLayer("left", tL, "0 0"), stackLayer("right", tR, "100% 0")].filter(Boolean).join(","),
          }
        : null,
    grow: { left, right, top: r, bottom: r },
  };
}

/** Page-block edges only (M27 API): `bookCase(…).edges`. */
export function bookEdgesStyle(
  stage: StageMetrics,
  spread: boolean,
  ratio: PageRatio,
  visible: readonly number[],
  count: number,
): BookEdgesStyle | null {
  return bookCase(stage, spread, ratio, visible, count)?.edges ?? null;
}
