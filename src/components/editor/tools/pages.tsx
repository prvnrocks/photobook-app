"use client";

// "Pages" tool (M5 Task 11): sortable grid of <BookPage> thumbnails (view mode, 512px thumbs).
// - Reorder: drag (dnd-kit — touch needs a 250 ms press so the grid still scrolls; mouse after
//   6 px; keyboard: Space to pick up, arrows, Space to drop) or the Move earlier/later buttons.
//   Both go through movePage (D-037 #5 chapter rules live in edit-ops).
// - Tap a thumbnail → jump to that page and close the sheet.
// Read-only: navigation still works, reordering is off.

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type PointerActivationConstraint,
} from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BookPage } from "@/components/book/BookPage";
import { movePage } from "@/lib/book/edit-ops";
import { designLabel } from "@/lib/design/defaults";
import type { BookPage as DocPage } from "@/lib/book/types";
import { movePageById, pageCountLabel, positionAfterMove } from "@/lib/editor/pages";
import { cn } from "@/lib/utils";
import type { EditorContextValue } from "../editor-context";
import type { EditorPanelProps, EditorTool } from "./types";

/** Pointer sensor for mouse / pen only — touch goes through TouchSensor (press-and-hold). */
class DesktopPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent: e }: ReactPointerEvent) => e.isPrimary && e.button === 0 && e.pointerType !== "touch",
    },
  ];
}

const MOUSE_CONSTRAINT: PointerActivationConstraint = { distance: 6 };
const TOUCH_CONSTRAINT: PointerActivationConstraint = { delay: 250, tolerance: 8 };
const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space"] };

const INSTRUCTIONS =
  "To move a page, press Space to pick it up, use the arrow keys to move it, then Space to drop or Escape to cancel. Press Enter to open the page.";

function announcements(pages: readonly DocPage[]): Announcements {
  const pos = (id: string | number) => pages.findIndex((p) => p.id === id) + 1;
  return {
    onDragStart: ({ active }) => `Picked up page ${pos(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `Page ${pos(active.id)} is over position ${pos(over.id)}.` : `Page ${pos(active.id)} is not over a position.`,
    onDragEnd: ({ active, over }) =>
      over ? `Page ${pos(active.id)} moved to position ${pos(over.id)}.` : `Page ${pos(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Move cancelled. Page ${pos(active.id)} stays where it was.`,
  };
}

export function PagesSheet({ ctx, close }: EditorPanelProps) {
  const { state, actions, photos, book, readOnly } = ctx;
  const pages = state.doc.pages;
  const lastDragEnd = useRef(0);

  const sensors = useSensors(
    useSensor(DesktopPointerSensor, { activationConstraint: MOUSE_CONSTRAINT }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_CONSTRAINT }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  );

  const move = (from: number, to: number) => {
    if (readOnly || to < 0 || to >= pages.length) return;
    actions.edit((d) => movePage(d, from, to), { select: null, goTo: positionAfterMove(state.page, from, to) });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    lastDragEnd.current = Date.now();
    if (readOnly || !over || active.id === over.id) return;
    const from = pages.findIndex((p) => p.id === active.id);
    const to = pages.findIndex((p) => p.id === over.id);
    if (from < 0 || to < 0) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    actions.edit((d) => movePageById(d, activeId, overId), { select: null, goTo: positionAfterMove(state.page, from, to) });
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
        accessibility={{ announcements: announcements(pages), screenReaderInstructions: { draggable: INSTRUCTIONS } }}
      >
        <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy} disabled={readOnly}>
          <ol className="grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-4 lg:grid-cols-2" data-testid="pages-grid">
            {pages.map((p, i) => (
              <PageTile
                key={p.id}
                ctx={ctx}
                id={p.id}
                idx={i}
                count={pages.length}
                current={state.page === i}
                readOnly={readOnly}
                onOpen={() => open(i)}
                onMove={(to) => move(i, to)}
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
  id,
  idx,
  count,
  current,
  readOnly,
  onOpen,
  onMove,
  thumbs,
  captionLang,
}: {
  ctx: EditorContextValue;
  id: string;
  idx: number;
  count: number;
  current: boolean;
  readOnly: boolean;
  onOpen(): void;
  onMove(to: number): void;
  thumbs: EditorContextValue["photos"]["thumbs"];
  captionLang: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: readOnly });
  const n = idx + 1;

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
      className={cn("relative flex min-w-0 flex-col gap-1", isDragging && "z-10")}
      data-testid="pages-tile"
      data-page-id={id}
    >
      <div
        {...attributes}
        {...listeners}
        onKeyDown={onKeyDown}
        onClick={onOpen}
        role="button"
        tabIndex={0}
        aria-label={`Page ${n}${current ? ", current page" : ""}`}
        aria-current={current ? "page" : undefined}
        className={cn(
          "relative cursor-pointer touch-manipulation select-none rounded-sm outline-none [-webkit-touch-callout:none]",
          "ring-offset-2 focus-visible:ring-2 focus-visible:ring-primary",
          current ? "ring-2 ring-primary" : "ring-1 ring-black/10",
          isDragging && "scale-105 opacity-90 shadow-lg",
          !readOnly && "cursor-grab active:cursor-grabbing",
        )}
        data-testid="pages-thumb"
      >
        <div className="pointer-events-none">
          <BookPage doc={ctx.state.doc} page={idx} mode="view" photos={thumbs} captionLang={captionLang} />
        </div>
        <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1.5 text-xs font-medium text-white">
          {n}
        </span>
      </div>
      {readOnly ? null : (
        <div className="flex justify-between">
          <button
            type="button"
            onClick={() => onMove(idx - 1)}
            disabled={idx === 0}
            aria-label={`Move page ${n} earlier`}
            className="flex size-11 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"
            data-testid="pages-move-earlier"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onMove(idx + 1)}
            disabled={idx === count - 1}
            aria-label={`Move page ${n} later`}
            className="flex size-11 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"
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
  editsDoc: false,
  Panel: PagesSheet,
  panelTitle: "Pages",
};
