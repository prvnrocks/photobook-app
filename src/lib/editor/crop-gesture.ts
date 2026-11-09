// Pointer → crop maths for the editor's crop mode (M5 Task 9). Pure, no DOM.
// Works on top of cropToStyle (src/lib/book/crop.ts), the same maths every renderer uses, so
// what the user drags is exactly what the big page, the strip and print show.
//
// The stored focal point (x, y) can sit outside the range the renderer can honour (cropToStyle
// clamps so no gap shows). Gestures start from the EFFECTIVE focal point — the one matching
// what is on screen — so a drag never has a dead zone, and results are clamped to the valid
// range so stored values stay canonical.

import { clampCrop, CROP_ZOOM_MAX, CROP_ZOOM_MIN, cropToStyle } from "@/lib/book/crop";
import type { Crop } from "@/lib/book/types";

export interface CropFrame {
  /** Photo pixel size (aspect is what matters; original dims are fine). */
  photoW: number;
  photoH: number;
  /** Slot size in mm (slotSizeMm of the layout rect). */
  slotWmm: number;
  slotHmm: number;
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const tidy = (v: number) => Number(round(v, 1e-4).toFixed(4));

/** Valid focal range on one axis for an image `size`% of the slot (size ≤ 100 → no slack). */
function axisRange(size: number): [number, number] | null {
  if (!(size > 100 + 1e-9)) return null;
  return [50 / size, (size - 50) / size];
}

/** The focal point the renderer actually shows for `crop` (x, y in 0..1 of the photo). */
export function effectiveFocal(f: CropFrame, crop: Partial<Crop>): { x: number; y: number } {
  const c = clampCrop(crop);
  const s = cropToStyle(f.photoW, f.photoH, f.slotWmm, f.slotHmm, c);
  return {
    // No slack on an axis → the photo is centred on it, whatever is stored.
    x: axisRange(s.width) ? (50 - s.left) / s.width : 0.5,
    y: axisRange(s.height) ? (50 - s.top) / s.height : 0.5,
  };
}

function canonical(f: CropFrame, x: number, y: number, zoom: number): Crop {
  const z = clamp(zoom, CROP_ZOOM_MIN, CROP_ZOOM_MAX);
  const s = cropToStyle(f.photoW, f.photoH, f.slotWmm, f.slotHmm, { x: 0.5, y: 0.5, zoom: z });
  const rx = axisRange(s.width);
  const ry = axisRange(s.height);
  return clampCrop({
    x: tidy(rx ? clamp(x, rx[0], rx[1]) : 0.5),
    y: tidy(ry ? clamp(y, ry[0], ry[1]) : 0.5),
    zoom: Number(round(z, 0.01).toFixed(2)),
  });
}

/**
 * Pan: the user dragged by (dx, dy) as a FRACTION of the slot's on-screen width/height
 * (dragging right moves the photo right = focal point moves left). Always computed from the
 * crop at gesture start + total delta, so there is no drift.
 */
export function panCrop(f: CropFrame, start: Partial<Crop>, dxFrac: number, dyFrac: number): Crop {
  const c = clampCrop(start);
  const s = cropToStyle(f.photoW, f.photoH, f.slotWmm, f.slotHmm, c);
  const e = effectiveFocal(f, c);
  const dx = Number.isFinite(dxFrac) ? dxFrac : 0;
  const dy = Number.isFinite(dyFrac) ? dyFrac : 0;
  return canonical(f, e.x - (dx * 100) / s.width, e.y - (dy * 100) / s.height, c.zoom);
}

/** Zoom to `zoom` (clamped 1–4) keeping the visible centre where it is (as far as possible). */
export function zoomCrop(f: CropFrame, crop: Partial<Crop>, zoom: number): Crop {
  const c = clampCrop(crop);
  const e = effectiveFocal(f, c);
  return canonical(f, e.x, e.y, Number.isFinite(zoom) ? zoom : c.zoom);
}

/** Pinch: zoom at gesture start scaled by finger distance ratio, clamped 1–4. */
export function pinchZoom(startZoom: number, startDist: number, dist: number): number {
  if (!(startDist > 0) || !(dist > 0) || !Number.isFinite(startZoom)) return clamp(startZoom || 1, CROP_ZOOM_MIN, CROP_ZOOM_MAX);
  return clamp((startZoom * dist) / startDist, CROP_ZOOM_MIN, CROP_ZOOM_MAX);
}
