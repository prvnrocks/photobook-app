// Print image plan (D-049): for every photo the PDF shows, the pixel size of the in-memory print
// copy. Pure — no I/O, no sharp — so the maths is unit-testable and shared by the renderer.
//
// Per use (cover + every page slot): the printed box is printSlotSizeMm() from book/bleed.ts —
// the slot INCLUDING bleed on sides touching a trim edge, the same box the print renderer covers (D-050), the photo is
// cover-fitted to that box and scaled by the slot's zoom (crop.ts maths), and we need `dpi` px
// per printed inch on both axes. A photo used more than once gets the largest need. The result
// is capped by the original's pixels (never upscale) and by `maxLongEdge`, keeping the photo's
// aspect ratio, then rounded to integers.

import { bleedRect, printSlotSizeMm } from "@/lib/book/bleed";
import { clampCrop, DEFAULT_CROP } from "@/lib/book/crop";
import { pageMm } from "@/lib/book/format";
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
export const PRINT_MAX_LONG_EDGE = 3000;

const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Printed size (mm) of a slot rect incl. bleed extension on sides touching a trim edge. Only for
 * a non-default `bleedMm`; the plan itself uses printSlotSizeMm (T3, the renderer's own box).
 * `rect` is % of the trim page of `format` (default portrait).
 */
export function printBoxMm(rect: Rect, bleedMm: number = BLEED_MM, format?: BookFormat | null): { w: number; h: number } {
  const { sheetMm } = bleedRect(rect, pageMm(format), bleedMm);
  return { w: sheetMm.w, h: sheetMm.h };
}

/** Box the photo must cover in the PDF: the renderer's printSlotSizeMm for the default bleed. */
function slotBoxMm(layout: Layout, slotIndex: number, bleedMm: number, format: BookFormat): { w: number; h: number } | null {
  if (bleedMm === BLEED_MM) return printSlotSizeMm(layout, slotIndex, format);
  const rect = layout.slots[slotIndex];
  return rect ? printBoxMm(rect, bleedMm, format) : null;
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

function usesOf(doc: BookDoc): Use[] {
  const uses: Use[] = [];
  const cover = getLayout(doc.cover.layout);
  // The cover renders with DEFAULT_CROP (render.ts coverRenderModel).
  if (cover?.role === "cover" && cover.slots[0] && doc.cover.photoId) {
    uses.push({ photoId: doc.cover.photoId, layout: cover, slotIndex: 0, crop: DEFAULT_CROP });
  }
  for (const page of doc.pages) {
    const layout = getLayout(page.layout);
    if (!layout || layout.role !== "page") continue; // renders blank
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
 * maxLongEdge × maxLongEdge box (resize "inside", never enlarged).
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
  const plan: PrintImagePlan = new Map();

  for (const use of usesOf(doc)) {
    const photo = byId.get(use.photoId);
    if (!photo) continue;
    if (!finitePos(photo.width) || !finitePos(photo.height)) {
      plan.set(photo.id, { width: maxLongEdge, height: maxLongEdge });
      continue;
    }
    const box = slotBoxMm(use.layout, use.slotIndex, bleedMm, doc.format);
    if (!box) continue;
    const n = neededPx(photo.width, photo.height, box.w, box.h, clampCrop(use.crop).zoom, dpi);
    const prev = need.get(photo.id);
    // Same photo ⇒ same aspect, so the larger width is the larger need on both axes.
    if (!prev || n.w > prev.w) need.set(photo.id, n);
  }

  for (const [id, n] of need) {
    const p = byId.get(id)!;
    plan.set(id, capTarget(n, p.width as number, p.height as number, maxLongEdge));
  }
  return plan;
}
