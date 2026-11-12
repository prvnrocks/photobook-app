"use client";

// Phones (< md, M10a A9): read-only preview of the open book. Shows the spread containing the
// current page (cover alone, then pages [0,1], [2,3], … — the flipbook's pairing, see
// src/lib/editor/spreads.ts), swipe or arrows between spreads, tap a page to jump to it in the
// editor (closes the sheet). Pages render through the shared <BookPage> in "view" mode.
// Modal (N6): Tab / Shift+Tab cycle inside the sheet; on close focus returns to whatever opened
// it (the carousel's "Spread" button).

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { BookPage } from "@/components/book/BookPage";
import { pageAspectStyle } from "@/lib/book/format-style";
import { editorSpreads, spreadAspectRatio, spreadCounterLabel, spreadOfPosition, type EditorSpread } from "@/lib/editor/spreads";
import type { RenderPhotos } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import { trapFocusIndex } from "@/lib/editor/roving";
import type { EditorPosition } from "@/lib/editor/store";
import { useEditor } from "./editor-context";
import { BOOK_SHADOW, FOLD_GRADIENT } from "./EditorSpread";

/** Spreads within this many of the shown one render their pages. */
const WINDOW = 1;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Tabbable elements inside `root`, skipping inert (off-screen) spreads. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert]") && !el.closest('[aria-hidden="true"]'),
  );
}

export function SpreadPreviewSheet({ onClose, returnFocus }: { onClose: () => void; returnFocus?: RefObject<HTMLElement | null> }) {
  const { state, actions, photos, book } = useEditor();
  const { doc } = state;
  const spreads = editorSpreads(doc);
  const pageCount = doc.pages.length;
  const [shown, setShown] = useState(() => spreadOfPosition(state.page));
  const scroller = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const initial = useRef(shown);

  // Return focus on close: to `returnFocus` (iOS Safari doesn't focus a tapped button), else to
  // whatever had focus when the sheet opened.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    const target = returnFocus;
    return () => {
      const el = target?.current ?? opener;
      if (el?.isConnected) el.focus({ preventScroll: true });
    };
  }, [opener, returnFocus]);

  // Open on the current page's spread (before paint, no animation).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: initial.current * el.clientWidth, behavior: "instant" });
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el.clientWidth > 0) setShown(Math.round(el.scrollLeft / el.clientWidth));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Escape closes; arrows move between spreads (and don't reach the editor's own arrow keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const list = tabbables(root);
        const to = trapFocusIndex(list.indexOf(document.activeElement as HTMLElement), list.length, e.shiftKey);
        e.preventDefault();
        list[to]?.focus();
        return;
      }
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  function go(delta: number) {
    const el = scroller.current;
    if (!el) return;
    const target = Math.min(Math.max(shown + delta, 0), spreads.length - 1);
    setShown(target);
    el.scrollTo({ left: target * el.clientWidth, behavior: "smooth" });
  }

  const jump = (page: EditorPosition) => {
    actions.goTo(page);
    onClose();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close two-page preview"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-30 bg-black/40"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Two-page preview"
        className="fixed inset-x-0 bottom-0 z-40 flex max-h-[85dvh] flex-col rounded-t-2xl border-t bg-background pb-[env(safe-area-inset-bottom)] shadow-xl"
        data-testid="spread-preview"
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-4">
          <h2 className="flex-1 truncate py-3 text-base font-semibold">Open book</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 flex size-11 items-center justify-center"
            data-testid="spread-preview-close"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <p className="shrink-0 px-4 pt-2 text-center text-xs text-muted-foreground">Tap a page to edit it.</p>
        <div
          ref={scroller}
          className="flex min-h-0 snap-x snap-mandatory overflow-x-auto overscroll-x-contain bg-stone-100 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-testid="spread-preview-scroller"
        >
          {spreads.map((sp, i) => (
            <div
              key={i}
              className="flex w-full shrink-0 snap-center snap-always items-center justify-center px-4 py-5"
              aria-hidden={i !== shown}
              inert={i !== shown ? true : undefined}
              data-testid="spread-preview-item"
              data-spread={i}
            >
              <PreviewSpread
                spread={sp}
                near={Math.abs(i - shown) <= WINDOW}
                onPick={jump}
                doc={doc}
                photos={photos.web}
                captionLang={book.captionLang}
              />
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center justify-center gap-2 py-1">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={shown <= 0}
            aria-label="Previous pages"
            className="flex size-11 items-center justify-center rounded-full disabled:opacity-30"
            data-testid="spread-preview-prev"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <span className="min-w-24 text-center text-sm tabular-nums text-muted-foreground" aria-live="polite" data-testid="spread-preview-counter">
            {spreadCounterLabel(shown, pageCount)}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={shown >= spreads.length - 1}
            aria-label="Next pages"
            className="flex size-11 items-center justify-center rounded-full disabled:opacity-30"
            data-testid="spread-preview-next"
          >
            <ChevronRight className="size-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );
}

function PreviewSpread({
  spread,
  near,
  onPick,
  doc,
  photos,
  captionLang,
}: {
  spread: EditorSpread;
  near: boolean;
  onPick: (p: EditorPosition) => void;
  doc: BookDoc;
  photos: RenderPhotos;
  captionLang: string;
}) {
  const cells: { pos: EditorPosition | null; key: string }[] =
    spread.kind === "cover"
      ? [{ pos: "cover", key: "cover" }]
      : [
          { pos: spread.left, key: "l" },
          { pos: spread.right, key: "r" },
        ];
  return (
    <div
      className={spread.kind === "cover" ? "grid w-1/2 grid-cols-1" : "relative grid w-full grid-cols-2"}
      style={spread.kind === "cover" ? undefined : { boxShadow: BOOK_SHADOW, aspectRatio: spreadAspectRatio(doc.format) }}
    >
      {cells.map(({ pos, key }) =>
        pos === null ? (
          <div key={key} aria-hidden="true" className="bg-neutral-50" />
        ) : (
          <button
            key={key}
            type="button"
            onClick={() => onPick(pos)}
            aria-label={pos === "cover" ? "Edit the cover" : `Edit page ${pos + 1}`}
            className="block w-full outline-none focus-visible:ring-4 focus-visible:ring-primary/60"
            data-testid="spread-preview-page"
            data-page-idx={String(pos)}
          >
            {near ? (
              <BookPage doc={doc} page={pos} mode="view" photos={photos} captionLang={captionLang} />
            ) : (
              <div className="aspect-[148/210] w-full bg-neutral-100" style={pageAspectStyle(doc.format)} />
            )}
          </button>
        ),
      )}
      {spread.kind === "cover" ? null : (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 w-[8%] -translate-x-1/2"
          style={{ backgroundImage: FOLD_GRADIENT }}
        />
      )}
    </div>
  );
}
