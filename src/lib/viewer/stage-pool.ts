// Where the stage's ground-shadow "pool" sits (M23 T2, D-075). Pure.
//
// VW_STAGE (src/components/viewer/viewer-classes.ts) paints the pool as its FIRST background layer:
// `radial-gradient(ellipse 44% 7% at 50% 93%, …)`. By default that layer fills the stage, so the
// pool sits at 93 % of the stage height — right under a height-limited book (portrait), but far
// below a width-limited one (landscape on phones, landscape spreads on desktop), which is centred.
// This helper sizes and places that first layer (background-size / -position / -repeat for layer 1;
// layer 2, the vignette, keeps `auto`) so the ellipse's centre sits on the foot of the VISIBLE book:
// the whole spread, or only the right page (cover alone) / left page (end card alone).
// Paint only: nothing here touches the stage's or the flipbook's geometry (page-flip touch coords).

import { fitBook, type PageRatio } from "./fit";

/** VW_STAGE's pool ellipse inside its layer box (fractions) — keep in sync with the recipe. */
export const POOL_RX = 0.44;
export const POOL_RY = 0.07;
export const POOL_CY = 0.93;

export type PoolSide = "center" | "left" | "right";

export interface StageMetrics {
  /** Stage padding box (clientWidth / clientHeight), CSS px. */
  width: number;
  height: number;
  /** Stage padding (the flipbook fills the content box inside it). */
  padTop: number;
  padRight: number;
  padBottom: number;
  padLeft: number;
}

export interface PoolStyle {
  backgroundSize: string;
  backgroundPosition: string;
  backgroundRepeat: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Which part of a spread is visible: cover alone (right page), end card alone (left page) or both. */
export function poolSide(spread: boolean, visible: readonly number[]): PoolSide {
  if (!spread || visible.length !== 1) return "center";
  return visible[0] === 0 ? "right" : "left";
}

/**
 * Layer-1 background geometry that puts the pool under the visible book, or null when the book
 * doesn't fit (the recipe's default 93 % placement then applies). Mirrors the Flipbook's own fit:
 * fitBook on the stage content box, centred both ways.
 */
export function stagePoolStyle(
  stage: StageMetrics,
  spread: boolean,
  ratio: PageRatio,
  side: PoolSide,
  /** M28: the hardcover case reaches this far beyond the visible pages — the pool sits under it. */
  grow?: { left: number; right: number; bottom: number },
): PoolStyle | null {
  const avail = {
    width: stage.width - stage.padLeft - stage.padRight,
    height: stage.height - stage.padTop - stage.padBottom,
  };
  if (!(avail.width > 0 && avail.height > 0)) return null;
  const box = fitBook(avail, spread, ratio);
  if (!box) return null;

  const bookLeft = stage.padLeft + (avail.width - box.width) / 2;
  const bookTop = stage.padTop + (avail.height - box.height) / 2;
  const bookBottom = bookTop + box.height + (grow?.bottom ?? 0);
  const halfOnly = spread && side !== "center";
  const visLeft = (side === "right" && spread ? bookLeft + box.pageWidth : bookLeft) - (grow?.left ?? 0);
  const visWidth = (halfOnly ? box.pageWidth : box.width) + (grow?.left ?? 0) + (grow?.right ?? 0);

  // Ellipse a little wider than the book (rx = 0.55 × width), 10–24 px tall radius, centre tucked
  // 30 % of that radius under the book's foot so the shadow reads as contact, not a halo.
  const rx = visWidth * 0.55;
  const ry = Math.min(24, Math.max(10, visWidth * 0.05));
  const layerW = rx / POOL_RX;
  const layerH = ry / POOL_RY;
  const cx = visLeft + visWidth / 2;
  const cy = bookBottom - ry * 0.3;

  return {
    backgroundSize: `${round(layerW)}px ${round(layerH)}px, auto`,
    backgroundPosition: `${round(cx - layerW / 2)}px ${round(cy - layerH * POOL_CY)}px, 0 0`,
    backgroundRepeat: "no-repeat, repeat",
  };
}
