"use client";

// The big editor page: the shared <BookPage> in "edit" mode plus tap targets for selection.
// - Photo slot → selects { slot } (cover photo → { cover, photo }); tap again deselects (with the
//   desktop tool sidebar it stays selected, so the photo picker beside the page stays open).
// - Crop tool open → the selected slot IS the crop area (CropInPlace: drag / pinch / scroll on the
//   page itself). Double-click a photo to start cropping it.
// - Caption area → selects { caption } (placeholder "Tap to add a caption" when empty).
// - Chapter description area (M30 magazine / editorial layouts) → selects { description }; where the
//   chapter has no description yet a quiet "Add a few lines about this chapter" hint shows (edit
//   mode only — nothing is drawn there in the viewer or the PDF).
// - Cover title/subtitle area → selects { cover, text }.
// - Tap on empty page space → clears the selection.
// Read-only: no tap targets, static captions.
// Cover text → CoverTextTarget overlay (Task 10; cover-text tool opens on select).
// Task 9 can add slot badges (low-res etc.) inside SlotOverlay; Task 10 replaces CaptionTarget's
// content (or opens its panel via a tool with openOnSelect).
// M10c T14 — shaped / tilted / overlapping slots:
// - The slot overlay sits inside the slot element, which carries the tilt and the shape clip, so the
//   tap target IS the visible shape; a tap is then resolved with slotAt (shape, tilt, z) so where
//   bounding boxes overlap the visible top slot wins. Shadows / decorations are pointer-events-none;
//   in geometric / scrapbook books text panels (label plates) let taps through to the photo below.
// - The selection outline follows the shape (inset ring with inherited border-radius, or an SVG
//   polygon outline for clip-path shapes).
// - Drag a photo onto another slot of the same page / spread to swap them (dnd-kit; press-and-hold
//   on touch). Collision = the visible slot under the pointer (slotCollision → slotAt).
//   Drag-swap has no keyboard path (no KeyboardSensor); the keyboard alternative is selecting a
//   slot and choosing its new photo in the photo picker.

import { DndContext, DragOverlay, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { BookPage, type RenderCaption } from "@/components/book/BookPage";
import { INK_TEXT } from "@/components/book/PageParts";
import type { Ink } from "@/lib/design/backgrounds";
import { replacePhoto } from "@/lib/book/edit-ops";
import { CAPTION_LINE_HEIGHT, captionSizeCqw, resolveCoverBackground } from "@/lib/book/render";
import type { Caption, Layout } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import {
  layoutPointFromClient,
  resolveSlotTap,
  slotCollision,
  slotOutline,
  type SlotDropData,
  type SlotHitContext,
  type SlotOutline,
} from "@/lib/editor/shaped-slots";
import type { EditorPosition, EditorSelection } from "@/lib/editor/store";
import { cn } from "@/lib/utils";
import { DesktopPointerSensor, MOUSE_CONSTRAINT, TOUCH_CONSTRAINT } from "./dnd-sensors";
import { useEditor } from "./editor-context";
import { CROP_TOOL_ID, CropInPlace } from "./tools/crop-mode";
import { LowResBadge } from "./tools/low-res-badge";

/** Styles whose text panels (plates, tilted labels) may sit over photos: taps pass through them. */
const PASS_THROUGH_TEXT_STYLES = new Set(["geometric", "scrapbook"]);
/** A click right after a drag is the drag's own pointer-up, not a tap. */
const DRAG_CLICK_GUARD_MS = 400;

/** The rendered page box + spread side of the element `el` sits in. */
function pageBoxOf(el: Element | null): { rect: DOMRect; side: "left" | "right" | null } | null {
  const frame = el?.closest<HTMLElement>("[data-page]");
  if (!frame) return null;
  const side = frame.dataset.spreadSide;
  return { rect: frame.getBoundingClientRect(), side: side === "left" || side === "right" ? side : null };
}

function sameSelection(a: EditorSelection, b: EditorSelection): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "slot" && b.kind === "slot") return a.pageIdx === b.pageIdx && a.slotIdx === b.slotIdx;
  if (a.kind === "caption" && b.kind === "caption") return a.pageIdx === b.pageIdx;
  if (a.kind === "description" && b.kind === "description") return a.pageIdx === b.pageIdx;
  if (a.kind === "cover" && b.kind === "cover") return a.part === b.part;
  return false;
}

export function EditablePage({ page, priority }: { page: EditorPosition; priority?: boolean }) {
  const { state, actions, photos, readOnly, book, sidebar, activeTool, openTool } = useEditor();
  const { doc, selection } = state;
  const wrapper = useRef<HTMLDivElement>(null);
  const lastDrag = useRef(0);
  const [dragging, setDragging] = useState<{ slotIdx: number; url: string | null } | null>(null);

  const toggle = (sel: EditorSelection) => (e: MouseEvent) => {
    e.stopPropagation();
    actions.select(sameSelection(selection, sel) ? null : sel);
  };

  // The doc page whose slots this page shows (a spread's right half: its left partner).
  const ownerPage = (owner: number | "cover"): Layout | undefined =>
    getLayout(owner === "cover" ? doc.cover.layout : (doc.pages[owner]?.layout ?? ""));

  /** Tap on a slot overlay → the visible top slot under the pointer (slotAt), then toggle. */
  const tapSlot = (slotIdx: number, owner: number | "cover") => (e: MouseEvent) => {
    e.stopPropagation();
    if (Date.now() - lastDrag.current < DRAG_CLICK_GUARD_MS) return;
    let idx = slotIdx;
    // detail 0 = keyboard activation (no pointer position): keep the focused slot.
    if (owner !== "cover" && e.detail > 0) {
      const box = pageBoxOf(e.currentTarget as Element);
      const pt = box ? layoutPointFromClient(box.rect, { x: e.clientX, y: e.clientY }, box.side) : null;
      idx = resolveSlotTap(ownerPage(owner), slotIdx, pt);
    }
    const sel = slotSel(idx, owner);
    // Desktop sidebar: a second tap keeps the photo selected (its panel stays open until closed).
    actions.select(!sidebar && sameSelection(selection, sel) ? null : sel);
  };

  /** Double-click a photo → crop it in place. */
  const cropSlot = (slotIdx: number, owner: number | "cover") => (e: MouseEvent) => {
    e.stopPropagation();
    if (owner === "cover" || (doc.pages[owner]?.slots[slotIdx]?.photoId ?? null) === null) return;
    actions.select({ kind: "slot", pageIdx: owner, slotIdx });
    openTool(CROP_TOOL_ID);
  };

  // `owner` = the doc page holding the slot/caption (a spread's right half shows its left page's).
  const slotSel = (slotIdx: number, owner: number | "cover" = page): EditorSelection =>
    owner === "cover" ? { kind: "cover", part: "photo" } : { kind: "slot", pageIdx: owner, slotIdx };

  const label = page === "cover" ? "cover" : `page ${page + 1}`;

  const onBackground = (e: MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (Date.now() - lastDrag.current < DRAG_CLICK_GUARD_MS) return;
    const target = e.target as HTMLElement;
    if (page === "cover" && target.closest("[data-cover-text]")) {
      actions.select(sameSelection(selection, { kind: "cover", part: "text" }) ? null : { kind: "cover", part: "text" });
      return;
    }
    if (selection !== null) actions.select(null);
  };

  const coverTextSelected = page === "cover" && sameSelection(selection, { kind: "cover", part: "text" });

  // Drag-swap (pages only; the cover has one photo). Owner = the doc page holding the slots.
  const dragOwner = page === "cover" || readOnly ? null : (() => {
    const p = doc.pages[page];
    if (p?.side === "right" && doc.pages[page - 1]?.side === "left" && doc.pages[page - 1]?.layout === p.layout) return page - 1;
    return page;
  })();
  const dragLayout = dragOwner === null ? undefined : ownerPage(dragOwner);
  const sensors = useSensors(
    useSensor(DesktopPointerSensor, { activationConstraint: MOUSE_CONSTRAINT }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_CONSTRAINT }),
  );
  const layoutRef = useRef<Layout | undefined>(dragLayout);
  layoutRef.current = dragLayout;
  const collision = useMemo(
    () =>
      slotCollision((): SlotHitContext | null => {
        const layout = layoutRef.current;
        const box = pageBoxOf(wrapper.current?.querySelector("[data-page]") ?? null);
        return layout && box ? { layout, rect: box.rect, side: box.side } : null;
      }),
    [],
  );

  const onDragStart = (e: DragStartEvent) => {
    lastDrag.current = Date.now();
    const from = (e.active.data.current as SlotDropData | undefined)?.slotIdx;
    const id = dragOwner === null || from === undefined ? null : (doc.pages[dragOwner]?.slots[from]?.photoId ?? null);
    setDragging(from === undefined ? null : { slotIdx: from, url: id ? (photos.web[id]?.url ?? null) : null });
  };
  const onDragEnd = (e: DragEndEvent) => {
    lastDrag.current = Date.now();
    setDragging(null);
    const from = (e.active.data.current as SlotDropData | undefined)?.slotIdx;
    const to = (e.over?.data.current as SlotDropData | undefined)?.slotIdx;
    if (dragOwner === null || from === undefined || to === undefined || from === to) return;
    const photoId = doc.pages[dragOwner]?.slots[from]?.photoId ?? null;
    if (photoId === null) return;
    const owner = dragOwner;
    actions.edit((d) => replacePhoto(d, owner, to, photoId), { select: { kind: "slot", pageIdx: owner, slotIdx: to } });
  };
  const onDragCancel = () => {
    lastDrag.current = Date.now();
    setDragging(null);
  };

  const passThroughText = PASS_THROUGH_TEXT_STYLES.has(doc.style.designStyle ?? "classic");

  const content = (
      <BookPage
        doc={doc}
        page={page}
        mode="edit"
        photos={photos.web}
        captionLang={book.captionLang}
        priority={priority}
        renderSlotOverlay={
          readOnly
            ? undefined
            : (slotIdx, owner) => {
                const props: SlotOverlayProps = {
                  selected: sameSelection(selection, slotSel(slotIdx, owner)),
                  label: `Photo ${slotIdx + 1} on ${label}`,
                  onClick: tapSlot(slotIdx, owner),
                  onDoubleClick: cropSlot(slotIdx, owner),
                  outline: slotOutline(ownerPage(owner)?.slots[slotIdx]),
                };
                const hasPhoto = owner !== "cover" && (doc.pages[owner]?.slots[slotIdx]?.photoId ?? null) !== null;
                if (props.selected && hasPhoto && activeTool === CROP_TOOL_ID) {
                  // Crop in place: this slot is the crop area (no tap target, no drag-swap).
                  return (
                    <>
                      <CropInPlace label={props.label} className={props.outline.kind === "box" ? CROP_RING : "outline-none"}>
                        <PolygonOutline outline={props.outline} selected />
                      </CropInPlace>
                      <LowResBadge page={owner} slotIdx={slotIdx} />
                    </>
                  );
                }
                return (
                  <>
                    {dragOwner !== null && owner === dragOwner ? (
                      <DraggableSlotOverlay {...props} id={`${owner}:${slotIdx}`} slotIdx={slotIdx} canDrag={hasPhoto} dragSource={dragging?.slotIdx === slotIdx} />
                    ) : (
                      <SlotOverlay {...props} />
                    )}
                    <LowResBadge page={owner} slotIdx={slotIdx} />
                  </>
                );
              }
        }
        renderCoverTextOverlay={
          readOnly || page !== "cover"
            ? undefined
            : () => (
                <CoverTextTarget
                  empty={!doc.cover.title && !doc.cover.subtitle}
                  ink={resolveCoverBackground(doc).ink}
                  selected={coverTextSelected}
                  onClick={toggle({ kind: "cover", part: "text" })}
                />
              )
        }
        renderDescription={
          readOnly || page === "cover"
            ? undefined
            : (area) => (
                <DescriptionTarget
                  empty={area.empty}
                  hintCqw={area.hintCqw}
                  selected={sameSelection(selection, { kind: "description", pageIdx: area.ownerIndex })}
                  onClick={toggle({ kind: "description", pageIdx: area.ownerIndex })}
                />
              )
        }
        renderCaption={
          readOnly || page === "cover"
            ? undefined
            : (caption, model, ink, owner) => (
                <CaptionTarget
                  caption={caption}
                  model={model}
                  ink={ink}
                  selected={sameSelection(selection, { kind: "caption", pageIdx: owner })}
                  onClick={toggle({ kind: "caption", pageIdx: owner })}
                />
              )
        }
      />
  );

  return (
    // The wrapper only receives taps that no slot/caption target handled (they stop propagation).
    <div
      ref={wrapper}
      onClick={onBackground}
      className={cn(
        "relative w-full shadow-md ring-1 ring-black/5",
        coverTextSelected && "[&_[data-cover-text]]:outline-4 [&_[data-cover-text]]:outline-solid [&_[data-cover-text]]:outline-[#0e3b2e] [&_[data-cover-text]]:-outline-offset-4",
        passThroughText && !readOnly && "[&_[data-text-panel]]:pointer-events-none",
      )}
      data-testid="editor-page"
      data-position={String(page)}
    >
      {dragOwner === null ? (
        content
      ) : (
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
          {content}
          {dragging && typeof document !== "undefined"
            ? createPortal(
                <DragOverlay dropAnimation={null}>
                  <div className="size-full overflow-hidden rounded-md opacity-80 shadow-lg ring-2 ring-primary" data-testid="slot-drag-preview">
                    {dragging.url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs
                      <img src={dragging.url} alt="" draggable={false} className="block size-full object-cover" />
                    ) : null}
                  </div>
                </DragOverlay>,
                document.body,
              )
            : null}
        </DndContext>
      )}
    </div>
  );
}

interface SlotOverlayProps {
  selected: boolean;
  label: string;
  onClick: (e: MouseEvent) => void;
  /** Double-click → crop in place. */
  onDoubleClick?: (e: MouseEvent) => void;
  /** How the selection outline follows the slot's shape (M10c). */
  outline: SlotOutline;
}

/**
 * Selection / focus outline. "box": inset ring on the button, whose border-radius is inherited from
 * the shaped slot element (rect, rounded, circle). "polygon": the ring would be clipped away by the
 * slot's clip-path, so an SVG outline of the polygon is drawn (the slot's clip hides the outer half
 * of the stroke; non-scaling stroke keeps it 4 px wide on any page size).
 */
/**
 * M22 (D-074): the selected ring is an emerald inset *outline* (follows the inherited border-radius
 * like the ring did) so box-shadow stays free for ed-select-glow's one-off pulse — an animated
 * box-shadow would otherwise blank a box-shadow ring for its duration. Opacity/box-shadow only.
 * The INSET glow variant (M22 T7): the slot clips anything drawn outside the overlay.
 */
const SELECTED_RING = "outline-4 outline-solid outline-[#0e3b2e] -outline-offset-4 ed-select-glow-inset";

/** Selected chapter description: the emerald line sits just outside the text box, so no letter is covered. */
const DESCRIPTION_RING = "outline-3 outline-solid outline-[#0e3b2e] outline-offset-2";

/** Crop-in-place ring: gold dashes inside the emerald line, so "adjusting" reads differently from "selected". */
const CROP_RING = "outline-4 outline-dashed outline-[#e3c766] -outline-offset-4";

function overlayClass(outline: SlotOutline, selected: boolean, dropTarget = false) {
  return cn(
    "group absolute inset-0 block cursor-pointer outline-none [-webkit-touch-callout:none]",
    outline.kind === "box" && "focus-visible:ring-4 focus-visible:ring-[#0e3b2e]/60 focus-visible:ring-inset",
    selected && "bg-[#0e3b2e]/10",
    selected && outline.kind === "box" && SELECTED_RING,
    dropTarget && "bg-[#0e3b2e]/20",
    dropTarget && outline.kind === "box" && "ring-4 ring-[#0e3b2e]/80 ring-inset",
  );
}

function PolygonOutline({ outline, selected, dropTarget }: { outline: SlotOutline; selected: boolean; dropTarget?: boolean }) {
  if (outline.kind !== "polygon") return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={cn(
        "pointer-events-none absolute inset-0 block size-full overflow-visible text-[#0e3b2e]",
        selected || dropTarget ? "opacity-100" : "opacity-0 group-focus-visible:opacity-60",
      )}
      data-testid="slot-outline"
      data-shape="polygon"
    >
      <polygon points={outline.points} fill="none" stroke="currentColor" strokeWidth={8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function SlotOverlay({ selected, label, onClick, onDoubleClick, outline }: SlotOverlayProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      aria-label={label}
      aria-pressed={selected}
      className={overlayClass(outline, selected)}
      style={{ borderRadius: "inherit" }}
      data-testid="slot-target"
      data-selected={selected ? "true" : undefined}
    >
      <PolygonOutline outline={outline} selected={selected} />
    </button>
  );
}

/** SlotOverlay that is also a drag source (when it holds a photo) and a drop target. */
function DraggableSlotOverlay({
  id,
  slotIdx,
  canDrag,
  dragSource,
  selected,
  label,
  onClick,
  onDoubleClick,
  outline,
}: SlotOverlayProps & { id: string; slotIdx: number; canDrag: boolean; dragSource: boolean }) {
  const data: SlotDropData = { slotIdx };
  const drag = useDraggable({ id, data, disabled: !canDrag });
  const drop = useDroppable({ id, data });
  const setRef = (el: HTMLButtonElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };
  const dropTarget = drop.isOver && !dragSource;
  return (
    <button
      ref={setRef}
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      aria-label={label}
      aria-pressed={selected}
      className={cn(overlayClass(outline, selected, dropTarget), dragSource && "bg-white/40")}
      style={{ borderRadius: "inherit" }}
      data-testid="slot-target"
      data-selected={selected ? "true" : undefined}
      data-drop-target={dropTarget ? "true" : undefined}
      data-drag-source={dragSource ? "true" : undefined}
      {...(canDrag ? drag.listeners : {})}
    >
      <PolygonOutline outline={outline} selected={selected} dropTarget={dropTarget} />
    </button>
  );
}

function CoverTextTarget({
  empty,
  ink,
  selected,
  onClick,
}: {
  empty: boolean;
  ink: Ink;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={empty ? "Add a cover title" : "Edit cover title"}
      className={cn(
        "absolute inset-0 flex cursor-pointer items-center justify-center outline-none focus-visible:ring-4 focus-visible:ring-primary/60 focus-visible:ring-inset",
        !selected && "hover:bg-black/5",
      )}
      data-testid="cover-text-target"
      data-selected={selected ? "true" : undefined}
    >
      {empty ? (
        <span className={cn("italic", ink === "light" ? "text-white/70" : "text-neutral-400")} style={{ fontSize: "4cqw" }}>
          Tap to add a title
        </span>
      ) : null}
    </button>
  );
}

/** Hint in an empty chapter description area (exported for tests). */
export const DESCRIPTION_PLACEHOLDER = "Add a few lines about this chapter";

/**
 * Tap target over a chapter description area (M30). With text: a clear button over the rendered
 * panel. Without: a dashed outline + hint on a white chip, readable on a white page, a dark panel
 * or a photo alike. Only the editor draws this — the viewer and the PDF leave the area empty.
 */
function DescriptionTarget({
  empty,
  hintCqw,
  selected,
  onClick,
}: {
  empty: boolean;
  hintCqw: number;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={empty ? DESCRIPTION_PLACEHOLDER : "Edit the text about this chapter"}
      className={cn(
        "absolute inset-0 flex cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-4 focus-visible:ring-[#0e3b2e]/60",
        selected ? DESCRIPTION_RING : empty ? "outline-1 outline-dashed outline-neutral-400 hover:bg-black/5" : "hover:bg-black/5",
      )}
      data-testid="description-target"
      data-selected={selected ? "true" : undefined}
      data-empty={empty ? "true" : undefined}
    >
      {empty ? (
        <span
          className="max-w-full rounded-sm bg-white/85 px-[1.5cqw] py-[0.5cqw] text-center text-neutral-600 italic"
          style={{ fontSize: `${hintCqw}cqw`, lineHeight: 1.25 }}
          data-testid="description-placeholder"
        >
          {DESCRIPTION_PLACEHOLDER}
        </span>
      ) : null}
    </button>
  );
}

function CaptionTarget({
  caption,
  model,
  ink,
  selected,
  onClick,
}: {
  caption: Caption | null;
  model: RenderCaption;
  /** Page background's text ink (M10a A6): same colour as the static caption. */
  ink: Ink;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={caption ? undefined : "Add a caption"}
      className={cn(
        "flex h-full w-full cursor-pointer flex-col justify-center rounded-sm outline-none focus-visible:ring-4 focus-visible:ring-[#0e3b2e]/60",
        selected ? SELECTED_RING : "hover:bg-black/5",
      )}
      data-testid="caption-target"
      data-selected={selected ? "true" : undefined}
    >
      {caption ? (
        <span
          dir="auto"
          lang={model.lang}
          className={cn("block w-full whitespace-pre-line break-words", model.color ? undefined : INK_TEXT.caption[ink])}
          style={{
            fontFamily: model.fontFamily,
            textAlign: model.align,
            fontSize: `${captionSizeCqw(model)}cqw`,
            lineHeight: CAPTION_LINE_HEIGHT,
            ...model.typography,
            // M30: the layout's caption ink role (e.g. white on a dark panel) — same as the static caption.
            ...(model.color ? { color: model.color } : {}),
          }}
          data-testid="page-caption"
        >
          {caption.text}
        </span>
      ) : (
        <span
          className={cn("block w-full text-center italic", ink === "light" ? "text-white/70" : "text-neutral-400")}
          style={{ fontSize: `${captionSizeCqw(model)}cqw`, lineHeight: CAPTION_LINE_HEIGHT }}
        >
          Tap to add a caption
        </span>
      )}
    </button>
  );
}
