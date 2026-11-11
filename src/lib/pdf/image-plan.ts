// Print image plan (D-049): for every photo the PDF shows, the pixel size of the in-memory print
// copy. Pure — no I/O, no sharp — so the maths is unit-testable and shared by the renderer.
//
// Per use (cover + every page slot): the printed box is printSlotSizeMm() from book/bleed.ts —
// the slot INCLUDING bleed on sides touching a trim edge, the same box the print renderer covers (D-050), the photo is
// cover-fitted to that box and scaled by the slot's zoom (crop.ts maths), and we need `dpi` px
// per printed inch on both axes. A photo used more than once gets the largest need. The result
// is capped by the original's pixels (never upscale) and by `maxLongEdge`, keeping the photo's
// aspect ratio, then rounded to integers.
//
// Background photos (M10a A6): a faded photo background cover-fits the whole bleed sheet
// (sheetMm) under a ≥ 50 % veil, so it is planned at BACKGROUND_PRINT_DPI (150, like the texture
// washes; capped by the pass dpi). A photo that is also in a slot gets the larger of both needs.
//
// Spreads (M10b A14): a spread's slots live on its LEFT page (x 0..200 across both halves; the
// right half stores slots []), so each spread slot is ONE use sized from the whole spread box
// (spreadBleedRect: bleed on the outer edges only, never at the fold). Both halves are then
// printed from the SAME print copy (one URL → one PDF image XObject, finalize dedupes it across
// chunks). The long-edge cap scales with the box: a spread box is two pages wide, so it gets
// SPREAD_LONG_EDGE_FACTOR × maxLongEdge = 4500 px (a full portrait panorama needs 3567 px at
// 300 dpi → full 300 dpi; a landscape one 5031 px → ~268 dpi) instead of ~250 / ~180 dpi at the
// single-page cap. Factor 1.5, not 2 (M10b final memory measurement, 100-page Modern landscape
// book of 6000×4000 originals): 2 × let spread copies stay at the full 6000 px (~+300 MB Node
// peak, ~+29 MB PDF — a book that fitted after the size fallback became too_large); 1.5 trims
// the copy to 56 % of the pixels. Single-page uses (≤ 3000 px from 6000 px originals) keep
// libvips' JPEG shrink-on-load (factor ≥ 2) in encodePrintImage.

import { bleedRect, printSlotSizeMm, spreadBleedRect } from "@/lib/book/bleed";
import { clampCrop, DEFAULT_CROP } from "@/lib/book/crop";
import { pageMm, sheetMm } from "@/lib/book/format";
import type { BookDoc, BookFormat, Crop, Layout, Rect } from "@/lib/book/types";
import { BLEED_MM, getLayout } from "@/lib/layouts";

const MM_PER_INCH = 25.4;

export interface PlanPhoto {
  id: string;
  /** Display-oriented (EXIF rotation applied) size of the stored original; null = unknown. */
  width: number | null;
  height: number | null;
}

export interface PrintImageTarget {
  width: number;
  height: number;
}

/** photoId → target pixel size of the print copy (display-oriented, aspect of the original). */
export type PrintImagePlan = Map<string, PrintImageTarget>;

export interface PlanOptions {
  dpi?: number;
  bleedMm?: number;
  maxLongEdge?: number;
}

export const PRINT_DPI = 300;
/** Faded photo backgrounds: full sheet under a veil — 150 dpi is plenty (A7: washes at 150). */
export const BACKGROUND_PRINT_DPI = 150;
export const PRINT_MAX_LONG_EDGE = 3000;
/** Long-edge cap multiplier for a photo printed across a spread (box = 2 page widths); see header. */
export const SPREAD_LONG_EDGE_FACTOR = 1.5;

const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Printed size (mm) of a slot rect incl. bleed extension on sides touching a trim edge. Only for
 * a non-default `bleedMm`; the plan itself uses printSlotSizeMm (T3, the renderer's own box).
 * `rect` is % of the trim page of `format` (default portrait); `spread` = a spread layout's rect
 * (x 0..200, bleed only on the spread's outer edges — book/bleed.ts spreadBleedRect).
 */
export function printBoxMm(
  rect: Rect,
  bleedMm: number = BLEED_MM,
  format?: BookFormat | null,
  spread = false,
): { w: number; h: number } {
  const { sheetMm } = (spread ? spreadBleedRect : bleedRect)(rect, pageMm(format), bleedMm);
  return { w: sheetMm.w, h: sheetMm.h };
}

/** Box the photo must cover in the PDF: the renderer's printSlotSizeMm for the default bleed. */
function slotBoxMm(layout: Layout, slotIndex: number, bleedMm: number, format: BookFormat): { w: number; h: number } | null {
  if (bleedMm === BLEED_MM) return printSlotSizeMm(layout, slotIndex, format);
  const rect = layout.slots[slotIndex];
  return rect ? printBoxMm(rect, bleedMm, format, layout.role === "spread") : null;
}

/**
 * Pixels (unrounded, original aspect) a photo of `photoW`×`photoH` needs to print at `dpi` when
 * it cover-fits a `boxWmm`×`boxHmm` box at `zoom`. Same scale as cropToStyle().
 */
export function neededPx(
  photoW: number,
  photoH: number,
  boxWmm: number,
  boxHmm: number,
  zoom: number,
  dpi: number,
): { w: number; h: number } {
  const mmPerPx = Math.max(boxWmm / photoW, boxHmm / photoH) * zoom; // printed mm per photo px
  const pxPerPx = (mmPerPx / MM_PER_INCH) * dpi; // needed px per original px
  return { w: photoW * pxPerPx, h: photoH * pxPerPx };
}

/** Caps `need` (aspect = photo aspect) by the original and the long-edge limit; integer px ≥ 1. */
function capTarget(need: { w: number; h: number }, photoW: number, photoH: number, maxLongEdge: number): PrintImageTarget {
  const s = Math.min(1, photoW / need.w, photoH / need.h, maxLongEdge / Math.max(need.w, need.h));
  return {
    width: Math.max(1, Math.min(Math.floor(photoW), Math.round(need.w * s))),
    height: Math.max(1, Math.min(Math.floor(photoH), Math.round(need.h * s))),
  };
}

interface Use {
  photoId: string;
  layout: Layout;
  slotIndex: number;
  crop: Crop;
}

/**
 * Background photo ids the doc shows: the cover (book default) and every page (its override,
 * else the book default) — pages with unknown layouts too, they render blank on their background.
 */
export function backgroundPhotoUses(doc: Pick<BookDoc, "style" | "pages">): string[] {
  const ids = new Set<string>();
  const bookBg = doc.style.background.kind === "photo" ? doc.style.background.photoId : null;
  if (bookBg) ids.add(bookBg); // the cover always shows the book default
  for (const page of doc.pages) {
    const bg = page.background ?? doc.style.background;
    if (bg.kind === "photo") ids.add(bg.photoId);
  }
  return [...ids];
}

function usesOf(doc: BookDoc): Use[] {
  const uses: Use[] = [];
  const cover = getLayout(doc.cover.layout);
  // The cover renders with DEFAULT_CROP (render.ts coverRenderModel).
  if (cover?.role === "cover" && cover.slots[0] && doc.cover.photoId) {
    uses.push({ photoId: doc.cover.photoId, layout: cover, slotIndex: 0, crop: DEFAULT_CROP });
  }
  for (const page of doc.pages) {
    const layout = getLayout(page.layout);
    // Unknown / cover layouts render blank. Spread right halves store slots [] — the left page
    // owns every slot, so each spread photo is counted once, at the whole spread box.
    if (!layout || (layout.role !== "page" && layout.role !== "spread")) continue;
    layout.slots.forEach((_rect, i) => {
      const slot = page.slots[i];
      if (slot?.photoId) uses.push({ photoId: slot.photoId, layout, slotIndex: i, crop: slot.crop ?? DEFAULT_CROP });
    });
  }
  return uses;
}

/**
 * Target px for every photo the doc shows, sized for the print boxes of `doc.format`. Photos the doc references but `photos` lacks are
 * skipped (the renderer shows an empty slot). A photo with unknown size gets a
 * maxLongEdge × maxLongEdge box (SPREAD_LONG_EDGE_FACTOR × for a spread use; resize "inside", never enlarged).
 */
export function planPrintImages(
  doc: BookDoc,
  photos: readonly PlanPhoto[],
  opts: PlanOptions = {},
): PrintImagePlan {
  const dpi = finitePos(opts.dpi) ? opts.dpi : PRINT_DPI;
  const bleedMm = typeof opts.bleedMm === "number" && Number.isFinite(opts.bleedMm) && opts.bleedMm >= 0 ? opts.bleedMm : BLEED_MM;
  const maxLongEdge = finitePos(opts.maxLongEdge) ? Math.floor(opts.maxLongEdge) : PRINT_MAX_LONG_EDGE;

  const byId = new Map(photos.map((p) => [p.id, p]));
  const need = new Map<string, { w: number; h: number }>();
  /** photoId → its long-edge cap (largest over its uses: spread uses get SPREAD_LONG_EDGE_FACTOR ×). */
  const capOf = new Map<string, number>();
  const plan: PrintImagePlan = new Map();

  for (const use of usesOf(doc)) {
    const photo = byId.get(use.photoId);
    if (!photo) continue;
    const cap = use.layout.role === "spread" ? maxLongEdge * SPREAD_LONG_EDGE_FACTOR : maxLongEdge;
    capOf.set(photo.id, Math.max(capOf.get(photo.id) ?? 0, cap));
    if (!finitePos(photo.width) || !finitePos(photo.height)) {
      const c = capOf.get(photo.id)!;
      plan.set(photo.id, { width: c, height: c });
      continue;
    }
    const box = slotBoxMm(use.layout, use.slotIndex, bleedMm, doc.format);
    if (!box) continue;
    const n = neededPx(photo.width, photo.height, box.w, box.h, clampCrop(use.crop).zoom, dpi);
    const prev = need.get(photo.id);
    // Same photo ⇒ same aspect, so the larger width is the larger need on both axes.
    if (!prev || n.w > prev.w) need.set(photo.id, n);
  }

  // Background photos: cover-fit the full sheet at zoom 1, BACKGROUND_PRINT_DPI (≤ pass dpi).
  const sheet = sheetMm(doc.format);
  const bgDpi = Math.min(BACKGROUND_PRINT_DPI, dpi);
  for (const id of backgroundPhotoUses(doc)) {
    const photo = byId.get(id);
    if (!photo || plan.has(id)) continue; // unknown size already planned as a max box
    if (!finitePos(photo.width) || !finitePos(photo.height)) {
      plan.set(id, { width: maxLongEdge, height: maxLongEdge });
      continue;
    }
    const n = neededPx(photo.width, photo.height, sheet.w, sheet.h, 1, bgDpi);
    const prev = need.get(id);
    if (!prev || n.w > prev.w) need.set(id, n);
  }

  for (const [id, n] of need) {
    const p = byId.get(id)!;
    plan.set(id, capTarget(n, p.width as number, p.height as number, capOf.get(id) ?? maxLongEdge));
  }
  return plan;
}
