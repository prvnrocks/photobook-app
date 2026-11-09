"use client";

// Crop (M5 Task 9): explicit crop mode for a page slot. The panel shows the slot at its real
// aspect ratio, rendered with the same cropToStyle maths as <BookPage> (big page, strip and print
// match). Drag to pan (pointer events, focal point x/y), pinch or slider to zoom 1–4, arrow keys
// nudge. Every gesture is one undo step (coalesceKey); the big page updates live behind the sheet.
// While the panel is open on mobile its backdrop blocks the carousel, so pages can't swipe.

import { Crop as CropIcon, RotateCcw } from "lucide-react";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { CROP_ZOOM_MAX, CROP_ZOOM_MIN, cropToStyle, DEFAULT_CROP } from "@/lib/book/crop";
import { setCrop } from "@/lib/book/edit-ops";
import { isSlotLowRes, layoutSlotMm } from "@/lib/book/resolution";
import { cropBoxStyle } from "@/lib/book/render";
import type { Crop } from "@/lib/book/types";
import { panCrop, pinchZoom, zoomCrop, type CropFrame } from "@/lib/editor/crop-gesture";
import type { EditorContextValue } from "../editor-context";
import type { EditorPanelProps, EditorTool } from "./types";

type CropTarget = {
  pageIdx: number;
  slotIdx: number;
  pageId: string;
  layoutId: string;
  crop: Crop;
  url: string;
  photo: { width: number; height: number };
  frame: CropFrame;
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
  const mm = layoutSlotMm(page.layout, sel.slotIdx);
  if (!p?.url || !mm || !finitePos(p.width) || !finitePos(p.height)) return null;
  return {
    pageIdx: sel.pageIdx,
    slotIdx: sel.slotIdx,
    pageId: page.id,
    layoutId: page.layout,
    crop: slot.crop,
    url: p.url,
    photo: { width: p.width, height: p.height },
    frame: { photoW: p.width, photoH: p.height, slotWmm: mm.w, slotHmm: mm.h },
  };
}

type Gesture =
  | { kind: "pan"; id: number; x: number; y: number; start: Crop; w: number; h: number; key: string }
  | { kind: "pinch"; dist: number; zoom: number; key: string };

export function CropPanel({ ctx, close }: EditorPanelProps) {
  const t = cropTarget(ctx);
  const boxRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const seq = useRef(0);
  const live = useRef(t);
  live.current = t;

  if (!t) return null;

  const keyFor = (kind: string) => `crop:${t.pageId}:${t.slotIdx}:${kind}:${++seq.current}`;
  const apply = (crop: Crop, coalesceKey?: string) => {
    const cur = live.current;
    if (!cur || ctx.readOnly) return;
    const { pageIdx, slotIdx } = cur;
    ctx.actions.edit((d) => setCrop(d, pageIdx, slotIdx, crop), { coalesceKey, select: { kind: "slot", pageIdx, slotIdx } });
  };

  const startPan = (id: number, x: number, y: number) => {
    const cur = live.current;
    const rect = boxRef.current?.getBoundingClientRect();
    if (!cur || !rect || rect.width === 0 || rect.height === 0) return;
    gesture.current = { kind: "pan", id, x, y, start: cur.crop, w: rect.width, h: rect.height, key: keyFor("pan") };
  };

  const startPinch = () => {
    const cur = live.current;
    const [a, b] = Array.from(pointers.current.values());
    if (!cur || !a || !b) return;
    gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: cur.crop.zoom, key: keyFor("pinch") };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) startPan(e.pointerId, e.clientX, e.clientY);
    else if (pointers.current.size === 2) startPinch();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const cur = live.current;
    if (!g || !cur) return;
    if (g.kind === "pan" && g.id === e.pointerId) {
      apply(panCrop(cur.frame, g.start, (e.clientX - g.x) / g.w, (e.clientY - g.y) / g.h), g.key);
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

  const style = cropToStyle(t.frame.photoW, t.frame.photoH, t.frame.slotWmm, t.frame.slotHmm, t.crop);
  const aspect = t.frame.slotWmm / t.frame.slotHmm;
  const lowRes = isSlotLowRes(t.photo, t.layoutId, t.slotIdx, t.crop.zoom);
  const zoomKey = `crop:${t.pageId}:${t.slotIdx}:zoom`;

  return (
    <div className="flex flex-col items-center gap-3" data-testid="crop-mode">
      <div
        ref={boxRef}
        role="application"
        aria-label="Crop area: drag to move the photo, arrow keys to nudge"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        className="relative cursor-grab touch-none overflow-hidden rounded-sm bg-neutral-200 outline-none select-none focus-visible:ring-4 focus-visible:ring-primary/60 active:cursor-grabbing"
        style={{ aspectRatio: String(aspect), width: `min(100%, calc(36dvh * ${aspect}))` }}
        data-testid="crop-area"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs */}
        <img
          src={t.url}
          alt=""
          draggable={false}
          className="pointer-events-none absolute block"
          style={{ ...cropBoxStyle(style), maxWidth: "none" }}
          data-testid="crop-image"
        />
        {/* Rule-of-thirds guide. */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3" aria-hidden="true">
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} className="border-[0.5px] border-white/50" />
          ))}
        </div>
      </div>

      <label className="flex w-full max-w-sm items-center gap-3 text-sm">
        <span className="shrink-0 font-medium">Zoom</span>
        <input
          type="range"
          min={CROP_ZOOM_MIN}
          max={CROP_ZOOM_MAX}
          step={0.01}
          value={t.crop.zoom}
          onChange={(e) => apply(zoomCrop(t.frame, t.crop, Number(e.target.value)), zoomKey)}
          className="min-h-11 flex-1 accent-primary"
          data-testid="crop-zoom"
        />
        <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{t.crop.zoom.toFixed(1)}×</span>
      </label>

      {lowRes ? (
        <p className="w-full max-w-sm rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="crop-low-res">
          This photo may look blurry when printed at this size.
        </p>
      ) : null}

      <div className="grid w-full max-w-sm grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => apply({ ...DEFAULT_CROP })}
          className="flex min-h-11 items-center justify-center gap-2 rounded-lg border text-sm font-medium hover:bg-muted"
          data-testid="crop-reset"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Reset
        </button>
        <button
          type="button"
          onClick={close}
          className="min-h-11 rounded-lg bg-primary text-sm font-medium text-primary-foreground"
          data-testid="crop-done"
        >
          Done
        </button>
      </div>
    </div>
  );
}

export const cropTool: EditorTool = {
  id: "crop",
  label: "Crop",
  icon: CropIcon,
  scopes: ["slot"],
  order: 12,
  panelTitle: "Crop photo",
  isAvailable: (ctx) => cropTarget(ctx) !== null,
  Panel: CropPanel,
};
