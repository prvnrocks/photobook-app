"use client";

// Crop (M5 Task 9; in place since 2026-11-17): the photo is adjusted right where it sits on the
// page. While the Crop tool is open, the selected slot on the big page becomes the crop area
// (CropInPlace, rendered by EditablePage instead of the slot's tap target): drag to move the photo
// (pointer events, focal point x/y), pinch or scroll to zoom 1–4, arrow keys nudge. The panel only
// holds the zoom slider, Reset and Done — docked under the page on phones, in the sidebar on
// desktop — so the page stays visible. Every gesture is one undo step (coalesceKey).
// Same cropToStyle maths as <BookPage> (big page, strip and print match).
// M10c T14: shaped / tilted / framed slots crop in the UNROTATED photo rect (layoutSlotMm =
// photoRectOf: frame excluded, same box the render model cover-fits). The on-screen size of that
// rect comes from the rendered page box (mm → px), and a drag on a tilted slot is turned back by
// the tilt, so the photo follows the finger. The slot's own shape clips the photo on the page, so
// no separate mask is needed.

import { Crop as CropIcon, RotateCcw } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { CROP_ZOOM_MAX, CROP_ZOOM_MIN, DEFAULT_CROP } from "@/lib/book/crop";
import { setCrop } from "@/lib/book/edit-ops";
import { pageMm } from "@/lib/book/format";
import { isSlotLowRes, layoutSlotMm } from "@/lib/book/resolution";
import type { Crop } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { panCrop, pinchZoom, zoomCrop, type CropFrame } from "@/lib/editor/crop-gesture";
import { cx } from "@/lib/cx";
import { ED_CTA_EMERALD, ED_CTA_QUIET, ED_PANEL_EYEBROW } from "../editor-classes";
import { useEditor, type EditorContextValue } from "../editor-context";
import type { EditorPanelProps, EditorTool } from "./types";

/** Id of the Crop tool: while it is the active tool, the selected slot is cropped in place. */
export const CROP_TOOL_ID = "crop";

type CropTarget = {
  pageIdx: number;
  slotIdx: number;
  pageId: string;
  layoutId: string;
  crop: Crop;
  url: string;
  photo: { width: number; height: number };
  frame: CropFrame;
  /** Slot tilt in degrees (drags are turned back by it). */
  rotate: number;
};

const finitePos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The selected slot if it can be cropped (has a photo with a URL and known size), else null. */
export function cropTarget(ctx: Pick<EditorContextValue, "state" | "photos">): CropTarget | null {
  const sel = ctx.state.selection;
  if (sel?.kind !== "slot") return null;
  const page = ctx.state.doc.pages[sel.pageIdx];
  const slot = page?.slots[sel.slotIdx];
  if (!page || !slot || slot.photoId === null) return null;
  const p = ctx.photos.web[slot.photoId];
  const mm = layoutSlotMm(page.layout, sel.slotIdx, ctx.state.doc.format);
  if (!p?.url || !mm || !finitePos(p.width) || !finitePos(p.height)) return null;
  const layout = getLayout(page.layout);
  return {
    pageIdx: sel.pageIdx,
    slotIdx: sel.slotIdx,
    pageId: page.id,
    layoutId: page.layout,
    crop: slot.crop,
    url: p.url,
    photo: { width: p.width, height: p.height },
    frame: { photoW: p.width, photoH: p.height, slotWmm: mm.w, slotHmm: mm.h },
    rotate: layout?.slots[sel.slotIdx]?.rotate ?? 0,
  };
}

type Gesture =
  | { kind: "pan"; id: number; x: number; y: number; start: Crop; w: number; h: number; key: string }
  | { kind: "pinch"; dist: number; zoom: number; key: string };

type CropCtx = Pick<EditorContextValue, "state" | "photos" | "actions" | "readOnly">;

function applyCrop(ctx: CropCtx, t: Pick<CropTarget, "pageIdx" | "slotIdx">, crop: Crop, coalesceKey?: string) {
  if (ctx.readOnly) return;
  const { pageIdx, slotIdx } = t;
  ctx.actions.edit((d) => setCrop(d, pageIdx, slotIdx, crop), { coalesceKey, select: { kind: "slot", pageIdx, slotIdx } });
}

/**
 * On-screen size (px, before the tilt) of the slot's photo rect, from the rendered page box that
 * `el` sits in: page px per mm × the photo rect's mm. null when the page isn't laid out.
 */
function photoRectPx(el: Element, t: CropTarget, format: EditorContextValue["state"]["doc"]["format"]): { w: number; h: number } | null {
  const rect = el.closest<HTMLElement>("[data-page]")?.getBoundingClientRect();
  const mm = pageMm(format);
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  return { w: (rect.width / mm.w) * t.frame.slotWmm, h: (rect.height / mm.h) * t.frame.slotHmm };
}

/** A screen-space drag turned back by the slot's tilt (CSS rotate, clockwise degrees). Exported for tests. */
export function untilt(dx: number, dy: number, rotateDeg: number): { dx: number; dy: number } {
  if (!rotateDeg) return { dx, dy };
  const a = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { dx: dx * cos + dy * sin, dy: -dx * sin + dy * cos };
}

/** Wheel → zoom factor per pixel scrolled (scroll up = zoom in). */
const WHEEL_ZOOM = 0.002;

/**
 * The crop area ON the page: covers the selected slot while the Crop tool is open (EditablePage
 * renders it in place of the slot's tap target). `children` = the slot's shape outline, if any.
 */
export function CropInPlace({ label, className, children }: { label: string; className?: string; children?: ReactNode }) {
  const ctx = useEditor();
  const t = cropTarget(ctx);
  const boxRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const seq = useRef(0);
  const live = useRef({ t, ctx });
  live.current = { t, ctx };

  // Wheel zoom needs a non-passive listener (React's onWheel can't preventDefault the page scroll).
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { t: cur, ctx: c } = live.current;
      if (!cur) return;
      e.preventDefault();
      const zoom = cur.crop.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM);
      applyCrop(c, cur, zoomCrop(cur.frame, cur.crop, zoom), `crop:${cur.pageId}:${cur.slotIdx}:zoom`);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keyboard users: the slot's button was replaced by this area — take the focus it lost.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) boxRef.current?.focus({ preventScroll: true });
  }, []);

  if (!t) return null;

  const keyFor = (kind: string) => `crop:${t.pageId}:${t.slotIdx}:${kind}:${++seq.current}`;
  const apply = (crop: Crop, coalesceKey?: string) => {
    const { t: cur, ctx: c } = live.current;
    if (cur) applyCrop(c, cur, crop, coalesceKey);
  };

  const startPan = (id: number, x: number, y: number) => {
    const cur = live.current.t;
    const size = cur && boxRef.current ? photoRectPx(boxRef.current, cur, ctx.state.doc.format) : null;
    if (!cur || !size) return;
    gesture.current = { kind: "pan", id, x, y, start: cur.crop, w: size.w, h: size.h, key: keyFor("pan") };
  };

  const startPinch = () => {
    const cur = live.current.t;
    const [a, b] = Array.from(pointers.current.values());
    if (!cur || !a || !b) return;
    gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: cur.crop.zoom, key: keyFor("pinch") };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) startPan(e.pointerId, e.clientX, e.clientY);
    else if (pointers.current.size === 2) startPinch();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const cur = live.current.t;
    if (!g || !cur) return;
    if (g.kind === "pan" && g.id === e.pointerId) {
      const d = untilt(e.clientX - g.x, e.clientY - g.y, cur.rotate);
      apply(panCrop(cur.frame, g.start, d.dx / g.w, d.dy / g.h), g.key);
    } else if (g.kind === "pinch") {
      const [a, b] = Array.from(pointers.current.values());
      if (a && b) apply(zoomCrop(cur.frame, cur.crop, pinchZoom(g.zoom, g.dist, Math.hypot(a.x - b.x, a.y - b.y))), g.key);
    }
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const rest = Array.from(pointers.current.entries());
    if (rest.length === 1) startPan(rest[0][0], rest[0][1].x, rest[0][1].y);
    else if (rest.length === 0) gesture.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    apply(panCrop(t.frame, t.crop, d[0], d[1]), `crop:${t.pageId}:${t.slotIdx}:keys`);
  };

  // A click here is the end of a drag (or a tap on the photo being cropped): never a deselect.
  const swallow = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      ref={boxRef}
      role="application"
      aria-label={`${label}: drag to move the photo, scroll or pinch to zoom, arrow keys to nudge`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      onClick={swallow}
      onDoubleClick={swallow}
      className={cx("absolute inset-0 block cursor-grab touch-none select-none active:cursor-grabbing", className ?? "outline-none")}
      style={{ borderRadius: "inherit" }}
      data-testid="crop-area"
      data-zoom={t.crop.zoom}
    >
      {/* Rule-of-thirds guide. */}
      <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} className="border-[0.5px] border-white/60" />
        ))}
      </div>
      {children}
    </div>
  );
}

export function CropPanel({ ctx, close }: EditorPanelProps) {
  const t = cropTarget(ctx);
  if (!t) return null;

  const lowRes = isSlotLowRes(t.photo, t.layoutId, t.slotIdx, t.crop.zoom, ctx.state.doc.format);
  const zoomKey = `crop:${t.pageId}:${t.slotIdx}:zoom`;

  return (
    <div className="flex flex-col items-center gap-3" data-testid="crop-mode">
      <p className="w-full max-w-sm text-sm text-[#56625a]" data-testid="crop-hint">
        Drag the photo on the page to move it. Pinch, scroll or use the slider to zoom.
      </p>

      <label className="flex w-full max-w-sm items-center gap-3 text-sm">
        <span className={cx(ED_PANEL_EYEBROW, "shrink-0")}>Zoom</span>
        <input
          type="range"
          min={CROP_ZOOM_MIN}
          max={CROP_ZOOM_MAX}
          step={0.01}
          value={t.crop.zoom}
          onChange={(e) => applyCrop(ctx, t, zoomCrop(t.frame, t.crop, Number(e.target.value)), zoomKey)}
          className="min-h-11 flex-1 accent-[#0e3b2e]"
          data-testid="crop-zoom"
        />
        <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-[#0e3b2e]">{t.crop.zoom.toFixed(1)}×</span>
      </label>

      {lowRes ? (
        <p className="w-full max-w-sm rounded-xl border border-warning-border bg-warning-soft px-3 py-2 text-xs text-foreground" data-testid="crop-low-res">
          This photo may look blurry when printed at this size.
        </p>
      ) : null}

      <div className="grid w-full max-w-sm grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => applyCrop(ctx, t, { ...DEFAULT_CROP })}
          className={cx(ED_CTA_QUIET, "border border-[#e9dfca]")}
          data-testid="crop-reset"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Reset
        </button>
        <button type="button" onClick={close} className={ED_CTA_EMERALD} data-testid="crop-done">
          Done
        </button>
      </div>
    </div>
  );
}

export const cropTool: EditorTool = {
  id: CROP_TOOL_ID,
  label: "Crop",
  icon: CropIcon,
  scopes: ["slot"],
  order: 12,
  tier: "primary",
  panelTitle: "Crop photo",
  // The photo is cropped on the page itself: keep the page visible above the controls on phones.
  dockOnMobile: true,
  // Tapping another photo keeps this panel open on the new photo.
  keepOnSelect: true,
  isAvailable: (ctx) => cropTarget(ctx) !== null,
  Panel: CropPanel,
};
