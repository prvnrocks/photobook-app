// Print resolution check (D-037 (9)): warn below 150 dpi effective at A5 (either format), never block.
// Pure. effective dpi = original px ÷ (slot mm × zoom ÷ 25.4) on the limiting axis after
// cover-fit (the axis where the photo has the fewest px per printed mm).

import { getLayout } from "@/lib/layouts";
import { pageMm } from "./format";
import type { BookFormat, Rect } from "./types";

export const LOW_RES_DPI = 150;
const MM_PER_INCH = 25.4;

export interface SlotMm {
  w: number;
  h: number;
}

/** Slot size in mm on the trim page of `format` (default portrait 148×210), from a rect in % of the page. */
export function slotSizeMm(rect: Pick<Rect, "w" | "h">, format?: BookFormat | null): SlotMm {
  const page = pageMm(format);
  return { w: (rect.w / 100) * page.w, h: (rect.h / 100) * page.h };
}

/** Slot size in mm for `layoutId` slot `slotIdx` (cover or page layout) on `format`; null if unknown. */
export function layoutSlotMm(layoutId: string, slotIdx: number, format?: BookFormat | null): SlotMm | null {
  const rect = getLayout(layoutId)?.slots[slotIdx];
  return rect ? slotSizeMm(rect, format) : null;
}

const finitePos = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Effective print dpi of an original photo (px) in a slot (mm) at `zoom`. Format-agnostic: pass
 * mm from slotSizeMm / layoutSlotMm for the doc's format. null when any size is
 * unknown or invalid (callers show no warning then). Zoom is clamped to 1–4.
 */
export function effectiveDpi(
  photoW: number | null | undefined,
  photoH: number | null | undefined,
  slotWmm: number,
  slotHmm: number,
  zoom = 1,
): number | null {
  if (!finitePos(photoW) || !finitePos(photoH) || !finitePos(slotWmm) || !finitePos(slotHmm)) return null;
  const z = Number.isFinite(zoom) ? Math.min(4, Math.max(1, zoom)) : 1;
  return Math.min(photoW / ((slotWmm * z) / MM_PER_INCH), photoH / ((slotHmm * z) / MM_PER_INCH));
}

/** True only for a known dpi below 150. Unknown (null) is never low-res. */
export function isLowRes(dpi: number | null): boolean {
  return dpi !== null && dpi < LOW_RES_DPI;
}

/** Convenience: low-res check for a photo in a layout slot on `format`. Unknown layout/size → false. */
export function isSlotLowRes(
  photo: { width: number | null; height: number | null },
  layoutId: string,
  slotIdx: number,
  zoom = 1,
  format?: BookFormat | null,
): boolean {
  const mm = layoutSlotMm(layoutId, slotIdx, format);
  if (!mm) return false;
  return isLowRes(effectiveDpi(photo.width, photo.height, mm.w, mm.h, zoom));
}
