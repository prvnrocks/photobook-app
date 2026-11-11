// Slot geometry for shaped / tilted / framed slots (M10c T1). Pure maths, no React/DOM, no runtime
// imports from ./schema (schema.ts imports this file for layout validation).
//
// Units: "layout units" = the units of layout data — % of ONE trim page (x, w per page width; y, h
// per page height). Spread layouts use the same unit with x running 0..200 across both pages, so
// every function here works for spreads unchanged. mm come from the layout's format (pageMm).
//
// Single sources (use these, never re-derive):
// - photoRectOf: the box the photo covers = slot minus frame inset. Render, crop panel, low-res
//   check and the print image plan must all size the photo from it, or print drifts from screen.
// - clipPathFor: CSS clip-path of a shape, relative to the box actually rendered (which may be the
//   bleed-extended box in print). Page-space edges stay where they are; edges on a trim side the
//   render box was extended past continue into the bleed.
// - pointInSlot / slotAt: hit tests that honour rotation, shape and paint order (z).
//
// Rotation: CSS `rotate(deg)` about the slot centre, positive = clockwise on screen (y down).

import { pageMm as formatPageMm, type SizeMm } from "./format";
import type { BookFormat, Layout, LayoutSlotDef, Rect, SlotFrame, SlotShape } from "./types";

/** Tolerance for mm comparisons (layout % are rounded to 4 decimals → ≤ 0.0002 mm noise). */
export const MM_EPS = 0.01;
/** rounded / circle / ellipse slots keep at least this gap to the trim (they never bleed). */
export const EDGE_GAP_MM = 1;
/** A circle slot's width and height (mm) may differ by at most this. */
export const CIRCLE_TOLERANCE_MM = 0.2;
/** A framed slot must leave a photo area at least this big (mm) on each axis. */
export const MIN_PHOTO_MM = 5;

/** Axis-aligned bounds in layout units. */
export interface BoundsPct {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface InsetMm {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Fixed shapes as polygons, [x, y] in % of the slot box. Hexagon: flat top/bottom, points left/right. */
export const SHAPE_POLYGONS = {
  hexagon: [
    [25, 0],
    [75, 0],
    [100, 50],
    [75, 100],
    [25, 100],
    [0, 50],
  ],
  diamond: [
    [50, 0],
    [100, 50],
    [50, 100],
    [0, 50],
  ],
} as const satisfies Record<string, ReadonlyArray<readonly [number, number]>>;

/** Polygon points (% of the slot box) of a polygonal shape; null for rect / rounded / circle / ellipse. */
export function shapePoints(shape: SlotShape | undefined): ReadonlyArray<readonly [number, number]> | null {
  switch (shape?.kind) {
    case "polygon":
      return shape.points;
    case "hexagon":
      return SHAPE_POLYGONS.hexagon;
    case "diamond":
      return SHAPE_POLYGONS.diamond;
    default:
      return null;
  }
}

/** Frame inset in mm per side (no frame → zeros). */
export function frameInsetMm(frame: SlotFrame | undefined): InsetMm {
  switch (frame?.kind) {
    case "border":
      return { left: frame.mm, top: frame.mm, right: frame.mm, bottom: frame.mm };
    case "polaroid":
      return { left: frame.side, top: frame.side, right: frame.side, bottom: frame.bottom };
    default:
      return { left: 0, top: 0, right: 0, bottom: 0 };
  }
}

/**
 * Bounds (layout units) of `rect` rotated by `deg` about its centre, measured in mm so the page's
 * aspect is respected. deg 0 → the rect's own edges, exactly.
 */
export function rotatedBoundsPct(rect: Rect, deg: number, page: SizeMm): BoundsPct {
  if (!deg) return { x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h };
  const rad = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const wMm = (rect.w / 100) * page.w;
  const hMm = (rect.h / 100) * page.h;
  const halfW = ((wMm * c + hMm * s) / 2 / page.w) * 100;
  const halfH = ((wMm * s + hMm * c) / 2 / page.h) * 100;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { x0: cx - halfW, y0: cy - halfH, x1: cx + halfW, y1: cy + halfH };
}

/**
 * The rect the photo covers in slot `i` (layout units, unrotated — rotation applies to the whole
 * slot about the SLOT centre): the slot minus its frame inset. Unframed slots return the slot's
 * own numbers unchanged (byte-identical render). null for a missing slot.
 */
export function photoRectOf(layout: Layout, i: number, format: BookFormat = layout.format): Rect | null {
  const s = layout.slots[i];
  if (!s) return null;
  if (!s.frame || s.frame.kind === "none") return { x: s.x, y: s.y, w: s.w, h: s.h };
  const page = formatPageMm(format);
  const inset = frameInsetMm(s.frame);
  const dx0 = (inset.left / page.w) * 100;
  const dx1 = (inset.right / page.w) * 100;
  const dy0 = (inset.top / page.h) * 100;
  const dy1 = (inset.bottom / page.h) * 100;
  return { x: s.x + dx0, y: s.y + dy0, w: Math.max(0, s.w - dx0 - dx1), h: Math.max(0, s.h - dy0 - dy1) };
}

// --- clip-path -----------------------------------------------------------------------------------

const fmt = (n: number): string => {
  const r = Math.round(n * 10000) / 10000;
  return `${Object.is(r, -0) ? 0 : r}%`;
};

/** Side of the shape box the render box was extended past (print bleed). */
type Side = "left" | "top" | "right" | "bottom";

/**
 * CSS clip-path for `shape` drawn over `slotRect`, written relative to `renderRect` — the box the
 * element is actually rendered in (same units as slotRect; equal to it on screen, the bleed-
 * extended box from bleedRect / spreadBleedRect in print). undefined for rect / no shape (no clip,
 * so existing slots render byte-identically).
 *
 * - circle / ellipse: `ellipse()` inscribed in slotRect (page-space position kept).
 * - rounded: `inset(… round rx / ry)`; `page` converts the mm radius to % of the render box.
 * - polygon / hexagon / diamond: `polygon()`. Where the render box extends past a side of slotRect
 *   (a trim edge with bleed), vertices on that side are carried into the bleed ALONG their
 *   interior edges (and boundary edges pushed out), so every edge inside the trim stays exactly
 *   where it is in page space and the shape runs off the page instead of leaving a hairline.
 *
 * Layout validation keeps rounded / circle / ellipse off the trim, so only polygons ever meet an
 * extended render box in practice.
 */
export function clipPathFor(shape: SlotShape | undefined, slotRect: Rect, renderRect: Rect, page: SizeMm): string | undefined {
  if (!shape || shape.kind === "rect") return undefined;
  const lx = (x: number) => ((x - renderRect.x) / renderRect.w) * 100;
  const ly = (y: number) => ((y - renderRect.y) / renderRect.h) * 100;

  if (shape.kind === "circle" || shape.kind === "ellipse") {
    const rx = (slotRect.w / 2 / renderRect.w) * 100;
    const ry = (slotRect.h / 2 / renderRect.h) * 100;
    return `ellipse(${fmt(rx)} ${fmt(ry)} at ${fmt(lx(slotRect.x + slotRect.w / 2))} ${fmt(ly(slotRect.y + slotRect.h / 2))})`;
  }

  if (shape.kind === "rounded") {
    const slotWmm = (slotRect.w / 100) * page.w;
    const slotHmm = (slotRect.h / 100) * page.h;
    const r = Math.min(shape.r, slotWmm / 2, slotHmm / 2);
    const renderWmm = (renderRect.w / 100) * page.w;
    const renderHmm = (renderRect.h / 100) * page.h;
    const top = ly(slotRect.y);
    const left = lx(slotRect.x);
    const right = 100 - lx(slotRect.x + slotRect.w);
    const bottom = 100 - ly(slotRect.y + slotRect.h);
    return `inset(${fmt(top)} ${fmt(right)} ${fmt(bottom)} ${fmt(left)} round ${fmt((r / renderWmm) * 100)} / ${fmt((r / renderHmm) * 100)})`;
  }

  const pts = shapePoints(shape);
  if (!pts) return undefined;
  const pagePts = polygonInPage(pts, slotRect);
  const extended = extendIntoBleed(pagePts, slotRect, renderRect);
  return `polygon(${extended.map((p) => `${fmt(lx(p.x))} ${fmt(ly(p.y))}`).join(", ")})`;
}

/** Polygon points (% of the slot) → layout units. */
export function polygonInPage(pts: ReadonlyArray<readonly [number, number]>, slot: Rect): Point[] {
  return pts.map(([u, v]) => ({ x: slot.x + (u / 100) * slot.w, y: slot.y + (v / 100) * slot.h }));
}

/** Absolute tolerance in layout units for "lies on a side" (points come from u × w float maths). */
const ON_SIDE_EPS = 1e-6;
/** The render box must extend a side by more than this (layout units) to count as bleed. */
const EXTENDED_EPS = 1e-6;

/**
 * Carries a page-space polygon into the parts of `render` that extend past `slot` (see
 * clipPathFor). Inside the slot box the result equals the input polygon exactly: new points only
 * lie outside it, on the continuation of the original edges. Works in layout units (lines and
 * axis-aligned boxes are preserved by the per-axis % scaling, so no mm needed).
 */
export function extendIntoBleed(poly: readonly Point[], slot: Rect, render: Rect): Point[] {
  const sideLine: Record<Side, number> = { left: slot.x, top: slot.y, right: slot.x + slot.w, bottom: slot.y + slot.h };
  const touched: Side[] = [];
  if (render.x < slot.x - EXTENDED_EPS) touched.push("left");
  if (render.y < slot.y - EXTENDED_EPS) touched.push("top");
  if (render.x + render.w > slot.x + slot.w + EXTENDED_EPS) touched.push("right");
  if (render.y + render.h > slot.y + slot.h + EXTENDED_EPS) touched.push("bottom");
  if (touched.length === 0) return poly.map((p) => ({ ...p }));

  const onSide = (p: Point, side: Side) =>
    Math.abs((side === "left" || side === "right" ? p.x : p.y) - sideLine[side]) <= ON_SIDE_EPS;
  const sidesOf = (p: Point) => touched.filter((s) => onSide(p, s));
  const boundaryEdge = (a: Point, b: Point) => touched.some((s) => onSide(a, s) && onSide(b, s));
  const push = (p: Point): Point => {
    const q = { ...p };
    for (const s of sidesOf(p)) {
      if (s === "left") q.x = render.x;
      else if (s === "right") q.x = render.x + render.w;
      else if (s === "top") q.y = render.y;
      else q.y = render.y + render.h;
    }
    return q;
  };
  /**
   * Where the ray from `from` through `v` reaches the bleed line of the first EXTENDED side it
   * heads for (v itself when it heads for none). Only extended sides stop it: a diagonal edge
   * meeting a non-extended side keeps going, so the bleed strip next to it is filled right up to
   * that side. The point may then lie outside the render box on that side — harmless, the element
   * never paints outside its own box (clip-path coordinates may run past 0 / 100 %).
   */
  const bleedLine: Record<Side, number> = { left: render.x, top: render.y, right: render.x + render.w, bottom: render.y + render.h };
  const exit = (from: Point, v: Point): Point => {
    const dx = v.x - from.x;
    const dy = v.y - from.y;
    let t = Infinity;
    for (const s of touched) {
      if (s === "left" && dx < 0) t = Math.min(t, (bleedLine.left - v.x) / dx);
      if (s === "right" && dx > 0) t = Math.min(t, (bleedLine.right - v.x) / dx);
      if (s === "top" && dy < 0) t = Math.min(t, (bleedLine.top - v.y) / dy);
      if (s === "bottom" && dy > 0) t = Math.min(t, (bleedLine.bottom - v.y) / dy);
    }
    if (!Number.isFinite(t) || t <= 0) return { ...v };
    return { x: v.x + t * dx, y: v.y + t * dy };
  };

  const out: Point[] = [];
  const emit = (p: Point) => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > ON_SIDE_EPS || Math.abs(last.y - p.y) > ON_SIDE_EPS) out.push(p);
  };
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const v = poly[i];
    if (sidesOf(v).length === 0) {
      emit({ ...v });
      continue;
    }
    const prev = poly[(i - 1 + n) % n];
    const next = poly[(i + 1) % n];
    const inBoundary = boundaryEdge(prev, v);
    const outBoundary = boundaryEdge(v, next);
    if (inBoundary && outBoundary) {
      emit(push(v));
      continue;
    }
    if (!inBoundary) emit(exit(prev, v));
    if (!outBoundary) emit(exit(next, v));
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && Math.abs(first.x - last.x) <= ON_SIDE_EPS && Math.abs(first.y - last.y) <= ON_SIDE_EPS) out.pop();
  return out;
}

// --- Hit tests -----------------------------------------------------------------------------------

/** Even-odd point-in-polygon. */
export function pointInPolygon(pt: Point, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Is `pt` (layout units) inside the shape of `slot` (unrotated)? Includes the frame area. */
function pointInShape(slot: LayoutSlotDef, pt: Point, page: SizeMm): boolean {
  const u = (pt.x - slot.x) / slot.w;
  const v = (pt.y - slot.y) / slot.h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  const shape = slot.shape;
  switch (shape?.kind) {
    case undefined:
    case "rect":
      return true;
    case "circle":
    case "ellipse":
      return (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.25;
    case "rounded": {
      const wMm = (slot.w / 100) * page.w;
      const hMm = (slot.h / 100) * page.h;
      const r = Math.min(shape.r, wMm / 2, hMm / 2);
      const x = u * wMm;
      const y = v * hMm;
      const cx = Math.min(Math.max(x, r), wMm - r);
      const cy = Math.min(Math.max(y, r), hMm - r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    }
    default: {
      const pts = shapePoints(shape);
      return pts ? pointInPolygon({ x: u * 100, y: v * 100 }, pts.map(([x, y]) => ({ x, y }))) : true;
    }
  }
}

/**
 * Hit test for slot `i` of `layout`: `pt` in layout units (% of the page; spreads x 0..200).
 * Undoes the slot's rotation (in mm, about the slot centre) and tests the shape — frame included,
 * since a tap on a polaroid border means that photo. false for a missing slot.
 */
export function pointInSlot(layout: Layout, i: number, pt: Point): boolean {
  const slot = layout.slots[i];
  if (!slot) return false;
  const page = formatPageMm(layout.format);
  let p = pt;
  if (slot.rotate) {
    const rad = (slot.rotate * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cxMm = ((slot.x + slot.w / 2) / 100) * page.w;
    const cyMm = ((slot.y + slot.h / 2) / 100) * page.h;
    const dx = (pt.x / 100) * page.w - cxMm;
    const dy = (pt.y / 100) * page.h - cyMm;
    // Inverse of CSS rotate(θ) (clockwise, y down): rotate by −θ.
    p = { x: ((cxMm + dx * cos + dy * sin) / page.w) * 100, y: ((cyMm - dx * sin + dy * cos) / page.h) * 100 };
  }
  return pointInShape(slot, p, page);
}

/** Slot indices bottom → top: by `z` (absent = 0), ties in slot order. */
export function paintOrder(layout: Layout): number[] {
  return layout.slots.map((s, i) => ({ i, z: s.z ?? 0 })).sort((a, b) => a.z - b.z || a.i - b.i).map((e) => e.i);
}

/** The top-most slot under `pt` (layout units), or null — what a tap on overlapping slots selects. */
export function slotAt(layout: Layout, pt: Point): number | null {
  const order = paintOrder(layout);
  for (let k = order.length - 1; k >= 0; k--) if (pointInSlot(layout, order[k], pt)) return order[k];
  return null;
}
