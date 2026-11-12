"use client";

// "Pages" tool (M5 Task 11): sortable grid of <BookPage> thumbnails (view mode, 512px thumbs).
// - Reorder: drag (dnd-kit — touch needs a 250 ms press so the grid still scrolls; mouse after
//   6 px; keyboard: Space to pick up, arrows, Space to drop) or the Move earlier/later buttons.
//   Both go through movePage (D-037 #5 chapter rules live in edit-ops).
// - Tap a thumbnail → jump to that page and close the sheet.
// Read-only: navigation still works, reordering is off.
// Spreads (M10b A15, D-064): a spread is ONE 2-wide tile (both halves side by side) that drags and
// moves as a unit (movePageResult with book.maxPages lands it on a left page); moving a single page
// past a spread never splits it, but spreads a move shifts onto a right page are split → toast
// with Undo. The view follows the moved unit (result.pageIdx).

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { BookPage } from "@/components/book/BookPage";
import { movePageResult, type PageOpResult } from "@/lib/book/edit-ops";
import { designLabel } from "@/lib/design/defaults";
import type { BookDoc } from "@/lib/book/types";
import { pageCountLabel, pageUnits, splitNotice, unitMoveTarget, type PageTileUnit } from "@/lib/editor/pages";
import { cn } from "@/lib/utils";
import type { EditorContextValue } from "../editor-context";
import { DesktopPointerSensor, MOUSE_CONSTRAINT, TOUCH_CONSTRAINT } from "../dnd-sensors";
import { showEditorToast } from "../EditorToast";
import type { EditorPanelProps, EditorTool } from "./types";

const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space"] };

const INSTRUCTIONS =
  "To move a page, press Space to pick it up, use the arrow keys to move it, then Space to drop or Escape to cancel. Press Enter to open the page.";

/** "page 3" or "pages 3–4" (a spread tile). */
function unitName(units: readonly PageTileUnit[], id: string | number): string {
  const u = units.find((x) => x.id === id);
  if (!u) return "page";
  return u.count === 2 ? `pages ${u.start + 1}–${u.start + 2}` : `page ${u.start + 1}`;
}

function announcements(units: readonly PageTileUnit[]): Announcements {
  const name = (id: string | number) => unitName(units, id);
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  return {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${cap(name(active.id))} is over ${name(over.id)}.` : `${cap(name(active.id))} is not over a position.`,
    onDragEnd: ({ active, over }) => (over ? `${cap(name(active.id))} moved to ${name(over.id)}.` : `${cap(name(active.id))} dropped.`),
    onDragCancel: ({ active }) => `Move cancelled. ${cap(name(active.id))} stays where it was.`,
  };
}

export function PagesSheet({ ctx, close }: EditorPanelProps) {
  const { state, actions, photos, book, readOnly } = ctx;
  const pages = state.doc.pages;
  const units = pageUnits(state.doc);
  const lastDragEnd = useRef(0);

  const sensors = useSensors(
    useSensor(DesktopPointerSensor, { activationConstraint: MOUSE_CONSTRAINT }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_CONSTRAINT }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  );

  /** Move the unit starting at `from` so its first page lands at `to` (resolved again by id at apply time). */
  const runMove = (from: number, to: number) => {
    if (readOnly || to < 0 || to >= pages.length || from === to) return;
    const base = state.doc;
    const movedId = base.pages[from]?.id;
    if (!movedId) return;
    let r: PageOpResult;
    try {
      r = movePageResult(base, from, to, book.maxPages);
    } catch {
      actions.edit((d) => movePageResult(d, from, to, book.maxPages).doc, { select: null }); // records the error
      return;
    }
    if (r.doc === base) return;
    const maxPages = book.maxPages;
    actions.edit(
      (d: BookDoc) => {
        if (d === base) return r.doc;
        const f = d.pages.findIndex((p) => p.id === movedId);
        return f < 0 ? d : movePageResult(d, f, Math.min(to, d.pages.length - 1), maxPages).doc;
      },
      { select: null, goTo: r.pageIdx },
    );
    const split = splitNotice(r.splitCount);
    if (split) showEditorToast({ message: split, action: { label: "Undo", run: actions.undo }, dismissOnEdit: true });
  };

  const moveOnto = (u: PageTileUnit, target: PageTileUnit | undefined) => {
    if (!target) return;
    const t = unitMoveTarget(state.doc, u.id, target.id);
    if (t) runMove(t.from, t.to);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    lastDragEnd.current = Date.now();
    if (readOnly || !over || active.id === over.id) return;
    const t = unitMoveTarget(state.doc, String(active.id), String(over.id));
    if (t) runMove(t.from, t.to);
  };

  const open = (idx: number) => {
    // A drop ends with a click on the dragged tile — don't treat it as a tap.
    if (Date.now() - lastDragEnd.current < 300) return;
    actions.goTo(idx);
    close();
  };

  if (pages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="pages-empty">
        This book has no pages yet. Use Add page to start one.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="pages-sheet">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground" data-testid="pages-count">
          {pageCountLabel(pages.length, book.maxPages)}
        </span>
        {readOnly ? " · Tap a page to open it." : " · Hold and drag to reorder, or use the arrows. Tap a page to open it."}
      </p>
      {/* D-063: shape + style are fixed at creation — shown, never editable here. */}
      <p className="text-xs text-muted-foreground" data-testid="editor-book-design">
        <span className="sr-only">Book shape and style (set when the book was created): </span>
        {designLabel(state.doc.format, state.doc.style.designStyle)}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => {
          lastDragEnd.current = Date.now();
        }}
        onDragCancel={() => {
          lastDragEnd.current = Date.now();
        }}
        onDragEnd={onDragEnd}
        accessibility={{ announcements: announcements(units), screenReaderInstructions: { draggable: INSTRUCTIONS } }}
      >
        <SortableContext items={units.map((u) => u.id)} strategy={rectSortingStrategy} disabled={readOnly}>
          <ol className="grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-4 lg:grid-cols-2" data-testid="pages-grid">
            {units.map((u, k) => (
              <PageTile
                key={u.id}
                ctx={ctx}
                unit={u}
                count={pages.length}
                current={state.page !== "cover" && state.page >= u.start && state.page < u.start + u.count}
                readOnly={readOnly}
                onOpen={() => open(u.start)}
                // Earlier / later = drop on the neighbouring tile (spreads land on a left page).
                onEarlier={() => moveOnto(u, units[k - 1])}
                onLater={() => moveOnto(u, units[k + 1])}
                thumbs={photos.thumbs}
                captionLang={book.captionLang}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function PageTile({
  ctx,
  unit,
  count,
  current,
  readOnly,
  onOpen,
  onEarlier,
  onLater,
  thumbs,
  captionLang,
}: {
  ctx: EditorContextValue;
  unit: PageTileUnit;
  count: number;
  current: boolean;
  readOnly: boolean;
  onOpen(): void;
  onEarlier(): void;
  onLater(): void;
  thumbs: EditorContextValue["photos"]["thumbs"];
  captionLang: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: unit.id, disabled: readOnly });
  const spread = unit.count === 2;
  const n = unit.start + 1;
  const name = spread ? `Pages ${n}–${n + 1}` : `Page ${n}`;
  const last = unit.start + unit.count - 1;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen();
      return;
    }
    listeners?.onKeyDown?.(e);
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative flex min-w-0 flex-col gap-1", spread && "col-span-2", isDragging && "z-10")}
      data-testid="pages-tile"
      data-page-id={unit.id}
      data-spread={spread ? "true" : undefined}
    >
      <div
        {...attributes}
        {...listeners}
        onKeyDown={onKeyDown}
        onClick={onOpen}
        role="button"
        tabIndex={0}
        aria-label={`${name}${spread ? ", two-page layout" : ""}${current ? ", current page" : ""}`}
        aria-current={current ? "page" : undefined}
        className={cn(
          "relative cursor-pointer touch-manipulation select-none rounded-sm outline-none [-webkit-touch-callout:none]",
          "ring-offset-2 ring-offset-card focus-visible:ring-2 focus-visible:ring-ring",
          current ? "ring-2 ring-primary" : "ring-1 ring-border",
          isDragging && "scale-105 opacity-90 shadow-lift",
          !readOnly && "cursor-grab active:cursor-grabbing",
        )}
        data-testid="pages-thumb"
      >
        <div className={cn("pointer-events-none", spread && "grid grid-cols-2")}>
          {Array.from({ length: unit.count }, (_, k) => (
            <BookPage key={k} doc={ctx.state.doc} page={unit.start + k} mode="view" photos={thumbs} captionLang={captionLang} />
          ))}
        </div>
        <span className="pointer-events-none absolute left-1 top-1 rounded bg-primary/85 px-1.5 text-xs font-medium text-primary-foreground">
          {spread ? `${n}–${n + 1}` : n}
        </span>
      </div>
      {readOnly ? null : (
        <div className="flex justify-between">
          <button
            type="button"
            onClick={onEarlier}
            disabled={unit.start === 0}
            aria-label={`Move ${name.toLowerCase()} earlier`}
            className="flex size-11 items-center justify-center rounded-lg outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
            data-testid="pages-move-earlier"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onLater}
            disabled={last >= count - 1}
            aria-label={`Move ${name.toLowerCase()} later`}
            className="flex size-11 items-center justify-center rounded-lg outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
            data-testid="pages-move-later"
          >
            <ChevronRight className="size-5" aria-hidden="true" />
          </button>
        </div>
      )}
    </li>
  );
}

/** Toolbar entry. Navigation works read-only too (editsDoc false); reordering checks ctx.readOnly. */
export const pagesTool: EditorTool = {
  id: "pages",
  label: "Pages",
  icon: LayoutGrid,
  scopes: ["none"],
  order: 70,
  tier: "primary",
  editsDoc: false,
  Panel: PagesSheet,
  panelTitle: "Pages",
};
