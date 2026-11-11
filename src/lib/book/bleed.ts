// Print bleed maths (D-050). Pure, no React/DOM — shared by the render model (print mode) and the
// print image plan (T4), so the PDF photo boxes and the pixel sizes we prepare always agree.
//
// The print sheet is the trim page plus BLEED_MM on every side (portrait 148×210 → 154×216 mm,
// landscape 210×148 → 216×154 mm; geometry in ./format.ts). A photo
// slot whose edge lies on a trim edge (within EDGE_EPS_PCT) is extended by BLEED_MM past that
// edge, so the photo runs off the page after trimming instead of leaving a white hairline.
//
// Crop choice: cover-fit, zoom and focal point (crop.x/y) are applied to the EXTENDED box — the
// photo covers the bigger rect exactly as it covers the slot on screen, focal point at the
// bigger box's centre. The trim window shows almost the same framing as the viewer (the box is
// only 3 mm larger per touching side). The image plan must size print copies for the extended
// box: use printSlotSizeMm().
//
// Shaped / tilted / framed slots (M10c T8c): the photo box is photoRectOf() (slot minus frame
// inset, slot-geometry.ts — the single source shared with render, crop and low-res). A FRAMED or
// TILTED slot never bleeds (slotBleeds: the frame / tilt is the design, and layout validation keeps
// them inside the safe zone anyway), so its print box is the photo rect itself at trim size.
// Polygon slots bleed like rects (the render box is bleed-extended and clipPathFor carries the
// shape's edges into the bleed); rounded / circle / ellipse never reach the trim (EDGE_GAP_MM).
// Rotation never changes the box the photo covers: the photo is cover-fitted to the UNROTATED
// photo rect and the whole slot is rotated as one vector transform (no resampling in the PDF), so
// px per printed mm along the photo's own axes = px per mm of the unrotated rect.

import { BLEED_MM, getLayout } from "@/lib/layouts";
import { pageMm as formatPageMm } from "./format";
import { photoRectOf } from "./slot-geometry";
import type { BookFormat, Layout, LayoutSlotDef, Rect } from "./types";

/** A slot edge within this many % of a trim edge counts as touching it. */
export const EDGE_EPS_PCT = 0.01;

export interface PageMm {
  w: number;
  h: number;
}

export interface BleedRect {
  /** % of the TRIM page (of the given page size); may run past 0 / 100 into the bleed. */
  pct: Rect;
  /** mm on the print sheet (origin = sheet top-left = trim top-left − bleed). */
  sheetMm: Rect;
  /** Which trim edges the slot touches (and was extended past). */
  edges: { left: boolean; top: boolean; right: boolean; bottom: boolean };
}

/**
 * Slot rect (% of the trim page) → the rect it covers on the print sheet: sides touching a trim
 * edge are pushed `bleedMm` outwards, inner sides are unchanged.
 */
export function bleedRect(rect: Rect, pageMm: PageMm = formatPageMm(), bleedMm: number = BLEED_MM): BleedRect {
  const edges = {
    left: rect.x <= EDGE_EPS_PCT,
    top: rect.y <= EDGE_EPS_PCT,
    right: rect.x + rect.w >= 100 - EDGE_EPS_PCT,
    bottom: rect.y + rect.h >= 100 - EDGE_EPS_PCT,
  };
  // Trim-page mm.
  let x = (rect.x / 100) * pageMm.w;
  let y = (rect.y / 100) * pageMm.h;
  let w = (rect.w / 100) * pageMm.w;
  let h = (rect.h / 100) * pageMm.h;
  if (edges.left) {
    x -= bleedMm;
    w += bleedMm;
  }
  if (edges.right) w += bleedMm;
  if (edges.top) {
    y -= bleedMm;
    h += bleedMm;
  }
  if (edges.bottom) h += bleedMm;
  // Untouched axes keep the exact layout numbers (no mm round-trip float noise), so inner slots
  // render byte-identically to the viewer.
  const xAxis = edges.left || edges.right;
  const yAxis = edges.top || edges.bottom;
  return {
    pct: {
      x: edges.left ? (x / pageMm.w) * 100 : rect.x,
      y: edges.top ? (y / pageMm.h) * 100 : rect.y,
      w: xAxis ? (w / pageMm.w) * 100 : rect.w,
      h: yAxis ? (h / pageMm.h) * 100 : rect.h,
    },
    sheetMm: { x: x + bleedMm, y: y + bleedMm, w, h },
    edges,
  };
}

/**
 * Spread slot rect (% of ONE page width, x 0..200 across both facing pages, M10b) → its print box.
 * The spread is treated as one sheet of 2 × page width: only the OUTER trim edges (x 0, x 200,
 * top, bottom) get bleed — never the fold, so a photo that stops short of the fold stays short
 * and one that crosses it (panorama) keeps one box, i.e. the same crop on both halves. `pct` stays
 * in spread units (x may run below 0 / past 200); `sheetMm` origin = the LEFT sheet's top-left.
 */
export function spreadBleedRect(rect: Rect, pageMm: PageMm = formatPageMm(), bleedMm: number = BLEED_MM): BleedRect {
  // Halving / doubling x is exact in binary floating point, so untouched edges keep their numbers.
  const b = bleedRect({ x: rect.x / 2, y: rect.y, w: rect.w / 2, h: rect.h }, { w: pageMm.w * 2, h: pageMm.h }, bleedMm);
  return { pct: { x: b.pct.x * 2, y: b.pct.y, w: b.pct.w * 2, h: b.pct.h }, sheetMm: b.sheetMm, edges: b.edges };
}

/**
 * May this slot run into the print bleed? false for framed (border / polaroid) and tilted slots —
 * a frame stays a frame on paper. Every M1–M10b slot → true (unchanged behaviour).
 */
export function slotBleeds(slot: Pick<LayoutSlotDef, "frame" | "rotate">): boolean {
  return !(slot.frame && slot.frame.kind !== "none") && !slot.rotate;
}

/**
 * Printed size in mm of `slotIndex` of a layout (object or id) — the box the photo must cover in
 * the PDF, on a page of `format` (default portrait), with `bleedMm` (default BLEED_MM) on sides
 * touching a trim edge. Spread slots use spreadBleedRect (whole box across both halves, no bleed
 * at the fold). Framed / tilted slots: photoRectOf at trim size (no bleed; see header). null for
 * an unknown layout / slot.
 */
export function printSlotSizeMm(
  layout: Layout | string,
  slotIndex: number,
  format?: BookFormat | null,
  bleedMm: number = BLEED_MM,
): { w: number; h: number } | null {
  const l = typeof layout === "string" ? getLayout(layout) : layout;
  const rect = l?.slots[slotIndex];
  if (!rect) return null;
  if (!slotBleeds(rect)) {
    // Frame mm → % and % → mm on the same page (the doc's format, else the layout's own).
    const f = format ?? l.format;
    const page = formatPageMm(f);
    const photo = photoRectOf(l, slotIndex, f) ?? rect;
    return { w: (photo.w / 100) * page.w, h: (photo.h / 100) * page.h };
  }
  const page = formatPageMm(format);
  const { sheetMm } = l.role === "spread" ? spreadBleedRect(rect, page, bleedMm) : bleedRect(rect, page, bleedMm);
  return { w: sheetMm.w, h: sheetMm.h };
}
