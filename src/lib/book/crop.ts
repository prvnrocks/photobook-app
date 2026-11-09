// Crop maths shared by editor, flipbook viewer and print (identical output everywhere).
// Pure, no DOM. The photo covers the slot (object-fit: cover), is scaled by `zoom` (1–4), and
// is positioned so the focal point (x, y as 0..1 of the photo) sits as close to the slot centre
// as possible without ever exposing a gap at a slot edge.

import type { Crop } from "./types";

export const DEFAULT_CROP: Crop = { x: 0.5, y: 0.5, zoom: 1 };
export const CROP_ZOOM_MIN = 1;
export const CROP_ZOOM_MAX = 4;

/** Image box as % of the slot: use as `position:absolute; width/height/left/top: N%`. */
export interface CropStyle {
  width: number;
  height: number;
  left: number;
  top: number;
}

const FILL: CropStyle = { width: 100, height: 100, left: 0, top: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finitePos = (v: number) => Number.isFinite(v) && v > 0;

/** Crop clamped to schema bounds; non-finite values fall back to the default. */
export function clampCrop(crop: Partial<Crop> | null | undefined): Crop {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    x: clamp(num(crop?.x, DEFAULT_CROP.x), 0, 1),
    y: clamp(num(crop?.y, DEFAULT_CROP.y), 0, 1),
    zoom: clamp(num(crop?.zoom, DEFAULT_CROP.zoom), CROP_ZOOM_MIN, CROP_ZOOM_MAX),
  };
}

/**
 * Size and offset of the photo inside a slot, in % of the slot. Width/height are always ≥ 100
 * on both axes and left/top always within [100 − size, 0], so the photo covers the slot.
 * Unknown photo or slot sizes → the photo just fills the slot (100 %, no offset).
 */
export function cropToStyle(
  photoW: number,
  photoH: number,
  slotWmm: number,
  slotHmm: number,
  crop: Partial<Crop> | null | undefined,
): CropStyle {
  if (!finitePos(photoW) || !finitePos(photoH) || !finitePos(slotWmm) || !finitePos(slotHmm)) {
    return { ...FILL };
  }
  const c = clampCrop(crop);
  // mm per photo px when covering the slot, then zoomed.
  const scale = Math.max(slotWmm / photoW, slotHmm / photoH) * c.zoom;
  const width = ((photoW * scale) / slotWmm) * 100;
  const height = ((photoH * scale) / slotHmm) * 100;
  const left = clamp(50 - c.x * width, 100 - width, 0);
  const top = clamp(50 - c.y * height, 100 - height, 0);
  return { width, height, left: left + 0, top: top + 0 }; // + 0 turns -0 into 0
}
