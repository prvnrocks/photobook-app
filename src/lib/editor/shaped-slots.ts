// Editor geometry for shaped / tilted / framed slots (M10c T14). Pure, no React/DOM.
// Everything is derived from the layout data via src/lib/book/slot-geometry.ts (single source):
// - tap + drop targets: client point → layout units → slotAt (rotation, shape, paint order z);
// - selection outline: the slot's own shape (outline drawn inside the shaped, rotated element);
// - crop mask: the shape over the UNROTATED photo rect (photoRectOf; frame excluded), the same box
//   the render model cover-fits, so a crop saved here renders identically in viewer and print;
// - layout-picker diagram styles (shape, tilt, frame) so geometric / scrapbook options read at 44 px.

import type { CollisionDetection, UniqueIdentifier } from "@dnd-kit/core";
import { pageMm } from "@/lib/book/format";
import { frameInsetMm, photoRectOf, shapePoints, slotAt, type Point } from "@/lib/book/slot-geometry";
import type { BookFormat, Layout, LayoutSlotDef, Rect } from "@/lib/book/types";

// --- Hit tests ------------------------------------------------------------------------------------

/** On-screen box of the rendered trim page (getBoundingClientRect shape). */
export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Client point → layout units (% of one page; a spread's right half adds 100, as spread layouts
 * run x 0..200). null for an empty page box.
 */
export function layoutPointFromClient(page: ClientRect, client: { x: number; y: number }, side?: "left" | "right" | null): Point | null {
  if (!(page.width > 0) || !(page.height > 0)) return null;
  const x = ((client.x - page.left) / page.width) * 100 + (side === "right" ? 100 : 0);
  const y = ((client.y - page.top) / page.height) * 100;
  return { x, y };
}

/**
 * The slot a tap at `pt` means: the visible top slot there (slotAt — shape, tilt, z). Falls back to
 * the slot whose element received the tap when the maths finds none (anti-aliased edge pixels) or
 * when there is no point (keyboard activation).
 */
export function resolveSlotTap(layout: Layout | undefined, tapped: number, pt: Point | null): number {
  if (!layout || !pt) return tapped;
  return slotAt(layout, pt) ?? tapped;
}

/** Data each slot droppable carries (EditablePage). */
export interface SlotDropData {
  slotIdx: number;
}

/** What the slot collision needs at drag time: the page's layout and on-screen box. */
export interface SlotHitContext {
  layout: Layout;
  rect: ClientRect;
  side?: "left" | "right" | null;
}

/**
 * dnd-kit collision detection for photo slots: the droppable whose slot is the visible top slot
 * under the POINTER (pointInSlot via slotAt), never a bounding-box overlap — so dropping onto
 * overlapping, tilted or shaped slots targets the one the user sees. No pointer (keyboard) or no
 * slot under it → no collision (the drop is a no-op).
 */
export function slotCollision(context: () => SlotHitContext | null): CollisionDetection {
  return ({ droppableContainers, pointerCoordinates }) => {
    const c = context();
    if (!c || !pointerCoordinates) return [];
    const pt = layoutPointFromClient(c.rect, pointerCoordinates, c.side);
    const hit = pt ? slotAt(c.layout, pt) : null;
    if (hit === null) return [];
    const target = droppableContainers.find((d) => (d.data.current as SlotDropData | undefined)?.slotIdx === hit);
    return target ? [{ id: target.id as UniqueIdentifier, data: { droppableContainer: target, value: 0 } }] : [];
  };
}

// --- Selection outline ----------------------------------------------------------------------------

/**
 * How the selection outline follows a slot's shape. The overlay sits inside the slot element, which
 * already carries the tilt and the shape clip, so:
 * - "box": the inset ring with `border-radius: inherit` (rect / rounded / circle / ellipse — the
 *   slot element's border-radius);
 * - "polygon": an SVG polygon outline (points as "x,y" in % of the slot box), because an inset ring
 *   on a clip-path element is clipped away except at the vertices.
 */
export type SlotOutline = { kind: "box" } | { kind: "polygon"; points: string };

export function slotOutline(slot: LayoutSlotDef | undefined): SlotOutline {
  const pts = shapePoints(slot?.shape);
  if (!pts) return { kind: "box" };
  return { kind: "polygon", points: pts.map(([x, y]) => `${x},${y}`).join(" ") };
}

// --- Crop mask ------------------------------------------------------------------------------------

/**
 * Visible part of the photo rect (coordinates in % of the photo rect, 0..100 per axis):
 * - none: the whole rect shows (plain / framed rect slots);
 * - ellipse: inscribed ellipse (circle / ellipse shapes);
 * - rounded: rounded rect with radii rx / ry (% of the photo rect's width / height);
 * - polygon: the shape's points.
 */
export type CropMask =
  | { kind: "none" }
  | { kind: "ellipse" }
  | { kind: "rounded"; rx: number; ry: number }
  | { kind: "polygon"; points: ReadonlyArray<readonly [number, number]> };

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Crop mask of slot `i`: the slot's shape drawn over its photo rect, exactly as the render model
 * clips it (render.ts slotLook — unframed: the slot's shape; framed: the same shape on the photo
 * rect, rounded radius minus the frame band). Rotation is not applied: the crop panel works in the
 * unrotated photo rect.
 */
export function cropMaskOf(layout: Layout | undefined, i: number, format?: BookFormat | null): CropMask {
  const s = layout?.slots[i];
  if (!layout || !s?.shape || s.shape.kind === "rect") return { kind: "none" };
  const shape = s.shape;
  if (shape.kind === "circle" || shape.kind === "ellipse") return { kind: "ellipse" };
  if (shape.kind === "rounded") {
    const fmt = format ?? layout.format;
    const pr = photoRectOf(layout, i, fmt);
    if (!pr) return { kind: "none" };
    const page = pageMm(fmt);
    const wMm = (pr.w / 100) * page.w;
    const hMm = (pr.h / 100) * page.h;
    const framed = !!s.frame && s.frame.kind !== "none";
    const inset = frameInsetMm(s.frame);
    const r = Math.max(0, Math.min(shape.r - (framed ? Math.max(inset.left, inset.top) : 0), wMm / 2, hMm / 2));
    if (!(r > 0) || !(wMm > 0) || !(hMm > 0)) return { kind: "none" };
    return { kind: "rounded", rx: r4((r / wMm) * 100), ry: r4((r / hMm) * 100) };
  }
  const pts = shapePoints(shape);
  return pts ? { kind: "polygon", points: pts } : { kind: "none" };
}

/** SVG path (viewBox 0 0 100 100, preserveAspectRatio none) of the mask's visible area; null = none. */
export function cropMaskPath(mask: CropMask): string | null {
  switch (mask.kind) {
    case "none":
      return null;
    case "ellipse":
      return "M0,50 A50,50 0 1,0 100,50 A50,50 0 1,0 0,50 Z";
    case "rounded": {
      const { rx, ry } = mask;
      return [
        `M${rx},0`,
        `H${r4(100 - rx)}`,
        `A${rx},${ry} 0 0,1 100,${ry}`,
        `V${r4(100 - ry)}`,
        `A${rx},${ry} 0 0,1 ${r4(100 - rx)},100`,
        `H${rx}`,
        `A${rx},${ry} 0 0,1 0,${r4(100 - ry)}`,
        `V${ry}`,
        `A${rx},${ry} 0 0,1 ${rx},0`,
        "Z",
      ].join(" ");
    }
    case "polygon":
      return `M${mask.points.map(([x, y]) => `${x},${y}`).join(" L")} Z`;
  }
}

// --- Layout-picker diagrams -----------------------------------------------------------------------

/**
 * Diagram look of a slot with M10c look fields (null for plain slots, which keep their M5 markup):
 * the shape as border-radius / clip-path (% of the slot box), the tilt, and for a frame the photo
 * rect in % of the slot box (the slot is drawn as the frame card, the photo inside it).
 */
export interface DiagramSlotLook {
  borderRadius?: string;
  clipPath?: string;
  rotate?: number;
  /** Framed: photo rect in % of the slot box. */
  photo?: Rect;
}

export function diagramSlotLook(layout: Layout, i: number, format?: BookFormat | null): DiagramSlotLook | null {
  const s = layout.slots[i];
  if (!s) return null;
  const shaped = !!s.shape && s.shape.kind !== "rect";
  const framed = !!s.frame && s.frame.kind !== "none";
  if (!shaped && !s.rotate && !framed) return null;
  const look: DiagramSlotLook = {};
  if (s.rotate) look.rotate = s.rotate;
  const shape = s.shape;
  if (shape?.kind === "circle" || shape?.kind === "ellipse") look.borderRadius = "50%";
  else if (shape?.kind === "rounded") {
    const page = pageMm(format ?? layout.format);
    const wMm = (s.w / 100) * page.w;
    const hMm = (s.h / 100) * page.h;
    const r = Math.max(0, Math.min(shape.r, wMm / 2, hMm / 2));
    if (r > 0 && wMm > 0 && hMm > 0) look.borderRadius = `${r4((r / wMm) * 100)}% / ${r4((r / hMm) * 100)}%`;
  } else {
    const pts = shapePoints(shape);
    if (pts) look.clipPath = `polygon(${pts.map(([x, y]) => `${x}% ${y}%`).join(", ")})`;
  }
  if (framed) {
    const pr = photoRectOf(layout, i, format ?? layout.format);
    if (pr && s.w > 0 && s.h > 0) {
      look.photo = {
        x: r4(((pr.x - s.x) / s.w) * 100),
        y: r4(((pr.y - s.y) / s.h) * 100),
        w: r4((pr.w / s.w) * 100),
        h: r4((pr.h / s.h) * 100),
      };
    }
  }
  return look;
}
