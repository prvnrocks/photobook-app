// Print bleed maths (D-050). Pure, no React/DOM — shared by the render model (print mode) and the
// print image plan (T4), so the PDF photo boxes and the pixel sizes we prepare always agree.
//
// The print sheet is the 148×210 mm trim page plus BLEED_MM on every side (154×216 mm). A photo
// slot whose edge lies on a trim edge (within EDGE_EPS_PCT) is extended by BLEED_MM past that
// edge, so the photo runs off the page after trimming instead of leaving a white hairline.
//
// Crop choice: cover-fit, zoom and focal point (crop.x/y) are applied to the EXTENDED box — the
// photo covers the bigger rect exactly as it covers the slot on screen, focal point at the
// bigger box's centre. The trim window shows almost the same framing as the viewer (the box is
// only 3 mm larger per touching side). The image plan must size print copies for the extended
// box: use printSlotSizeMm().

import { BLEED_MM, getLayout, PAGE_MM } from "@/lib/layouts";
import type { Layout, Rect } from "./types";

/** A slot edge within this many % of a trim edge counts as touching it. */
export const EDGE_EPS_PCT = 0.01;

export interface PageMm {
  w: number;
  h: number;
}

export interface BleedRect {
  /** % of the TRIM page (148×210); may run past 0 / 100 into the bleed. */
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
export function bleedRect(rect: Rect, pageMm: PageMm = PAGE_MM, bleedMm: number = BLEED_MM): BleedRect {
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
 * Printed size in mm of `slotIndex` of a layout (object or id), including bleed extension —
 * the box the photo must cover in the PDF. null for an unknown layout / slot.
 */
export function printSlotSizeMm(layout: Layout | string, slotIndex: number): { w: number; h: number } | null {
  const l = typeof layout === "string" ? getLayout(layout) : layout;
  const rect = l?.slots[slotIndex];
  if (!rect) return null;
  const { sheetMm } = bleedRect(rect);
  return { w: sheetMm.w, h: sheetMm.h };
}
