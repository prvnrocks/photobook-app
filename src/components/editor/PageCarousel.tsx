"use client";

// Mobile-first page carousel: one big page at a time, swipe with native CSS scroll-snap (no deps).
// Item 0 = cover, item i + 1 = doc.pages[i]. Scroll position ⇄ state.page stay in sync:
// swiping updates the store; store changes (strip tap, prev/next, undo) scroll the carousel
// (instant for jumps > 1 so intermediate snap points don't feed back into the store).
// While such a programmatic scroll runs, scroll events are NOT fed back into the store: a smooth
// scroll passes through intermediate positions, and feeding those back dropped fast Next taps
// (T14 bug 2). Prev/next always step from the store's index (the target), never from the
// in-progress scroll position. A touch/wheel/key by the user hands control back to the scroll.
// Only items within WINDOW of the current one render a <BookPage>; the rest are empty boxes.
//
// Facing pages (M10a A9, ctx.spread — ≥ md): items are open spreads instead (src/lib/editor/
// spreads.ts: item 0 = cover alone, item k = pages 2(k-1) + 2(k-1)+1, same pairing as the
// flipbook). Swipe/arrows move by spread and land on its left page; tapping a page makes it the
// current page (what page tools act on). Phones keep one page + a read-only "View spread" sheet.

import { BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pageAspectStyle } from "@/lib/book/format-style";
import {
  editorSpreads,
  spreadAriaLabel,
  spreadAspectRatio,
  spreadCounterLabel,
  spreadOfPosition,
  spreadToPosition,
  stepSpread,
} from "@/lib/editor/spreads";
import { itemToPosition, positionToItem } from "@/lib/editor/store";
import { cn } from "@/lib/utils";
import { useEditor } from "./editor-context";
import { EditablePage } from "./EditablePage";
import { EditorSpreadView } from "./EditorSpread";
import { SpreadPreviewSheet } from "./SpreadPreviewSheet";

const WINDOW = 2;
/** Prev / next: 44 px round, visible focus ring (M11 tokens). */
const NAV_BTN =
  "flex size-11 items-center justify-center rounded-full text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:hover:bg-transparent";
/** Spread mode: spreads (two pages each) within this many of the current one render pages. */
const SPREAD_WINDOW = 1;

/** "Cover" for the cover, else "3 / 20" (1-based page of total pages). Exported for tests. */
export function pageCounterLabel(item: number, pageCount: number): string {
  return item <= 0 ? `Cover · ${pageCount} ${pageCount === 1 ? "page" : "pages"}` : `${item} / ${pageCount}`;
}

export function PageCarousel() {
  const { state, actions, spread = false } = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  const pageCount = state.doc.pages.length;
  const spreads = useMemo(() => (spread ? editorSpreads(state.doc) : null), [spread, state.doc]);
  const current = spread ? spreadOfPosition(state.page) : positionToItem(state.page);
  const count = spreads ? spreads.length : pageCount + 1;
  const [preview, setPreview] = useState(false);
  const spreadButton = useRef<HTMLButtonElement>(null);
  const pageCountRef = useRef(pageCount);
  useEffect(() => {
    pageCountRef.current = pageCount;
  }, [pageCount]);
  /** Inline aspect-ratio for non-A5-portrait formats (undefined → the aspect-[148/210] class). */
  const aspectStyle = pageAspectStyle(state.doc.format);
  const currentRef = useRef(current);
  /** Item a programmatic scroll is heading to (null = the user is in control). */
  const scrollTarget = useRef<number | null>(null);
  const targetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStoreItem = useRef(current);
  const firstRun = useRef(true);
  // Items are keyed by page id, so when pages are added/removed/reordered (Task 11) the browser
  // re-snaps to the element that was snapped before — not the store's position. For a moment
  // after the page order changes, scroll events snap back to `current` instead of moving it.
  const pinUntil = useRef(0);
  const pageOrder = useMemo(() => state.doc.pages.map((p) => p.id).join("\n"), [state.doc.pages]);
  useLayoutEffect(() => {
    currentRef.current = current;
    pinUntil.current = performance.now() + 250;
    // current is read at the moment the order changes; deps are the order only on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageOrder]);

  // store → scroll
  useEffect(() => {
    currentRef.current = current;
    const from = lastStoreItem.current;
    lastStoreItem.current = current;
    const el = ref.current;
    if (!el || el.clientWidth === 0) return;
    const shown = Math.round(el.scrollLeft / el.clientWidth);
    if (shown !== current || scrollTarget.current !== null) {
      // A step of one store index scrolls smoothly even if a previous smooth scroll is still
      // running (rapid Next taps); real jumps (strip tap, undo elsewhere) are instant.
      const jump = Math.abs(from - current) > 1 || firstRun.current;
      scrollTarget.current = current;
      if (targetTimer.current) clearTimeout(targetTimer.current);
      // Fallback in case the scroll never reports arriving (interrupted, no scroll event).
      targetTimer.current = setTimeout(() => {
        scrollTarget.current = null;
      }, 1000);
      el.scrollTo({ left: current * el.clientWidth, behavior: jump ? "instant" : "smooth" });
    }
    firstRun.current = false;
  }, [current]);

  // scroll → store (rAF-throttled)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el.clientWidth === 0) return;
        const shown = Math.round(el.scrollLeft / el.clientWidth);
        if (scrollTarget.current !== null) {
          // Our own scroll: ignore the positions it passes through; done once it arrives.
          if (Math.abs(el.scrollLeft - scrollTarget.current * el.clientWidth) < 2) scrollTarget.current = null;
          return;
        }
        if (shown !== currentRef.current && performance.now() < pinUntil.current) {
          el.scrollTo({ left: currentRef.current * el.clientWidth, behavior: "instant" });
          return;
        }
        if (shown !== currentRef.current) {
          currentRef.current = shown;
          // Spread mode: a spread is entered on its left page.
          actions.goTo(spread ? spreadToPosition(shown, pageCountRef.current) : itemToPosition(shown));
        }
      });
    };
    // Keep the current page in view when the width changes (rotation, desktop resize).
    const ro = new ResizeObserver(() => {
      el.scrollTo({ left: currentRef.current * el.clientWidth, behavior: "instant" });
    });
    // The user takes over (swipe, trackpad, keyboard scrolling): stop ignoring scroll events.
    const release = () => {
      scrollTarget.current = null;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("pointerdown", release, { passive: true });
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("keydown", release);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("pointerdown", release);
      el.removeEventListener("wheel", release);
      el.removeEventListener("keydown", release);
      ro.disconnect();
      if (targetTimer.current) clearTimeout(targetTimer.current);
    };
    // The carousel remounts when the mode changes (EditorShell key), so `spread` is fixed here.
  }, [actions, spread]);

  const prev = () => (spread ? actions.goTo(stepSpread(state.page, -1, pageCount)) : actions.prev());
  const next = () => (spread ? actions.goTo(stepSpread(state.page, 1, pageCount)) : actions.next());
  const label = spread ? spreadCounterLabel(current, pageCount) : pageCounterLabel(current, count - 1);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-roledescription="carousel" aria-label="Book pages">
      <div
        ref={ref}
        className={cn(
          "flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          // A desk under the open book.
          spread && "bg-muted",
        )}
        data-testid="page-carousel"
        data-mode={spread ? "spread" : "single"}
      >
        {spreads
          ? spreads.map((sp, item) => (
              <div
                key={item}
                className="flex h-full w-full shrink-0 snap-center snap-always items-center justify-center px-6 py-4"
                aria-roledescription="slide"
                aria-label={spreadAriaLabel(item, pageCount)}
                aria-hidden={item !== current}
                inert={item !== current ? true : undefined}
                data-testid="carousel-item"
                data-spread={item}
              >
                <EditorSpreadView spread={sp} near={Math.abs(item - current) <= SPREAD_WINDOW} isCurrent={item === current} />
              </div>
            ))
          : Array.from({ length: count }, (_, item) => {
          const near = Math.abs(item - current) <= WINDOW;
          const position = itemToPosition(item);
          return (
            <div
              key={item === 0 ? "cover" : state.doc.pages[item - 1].id}
              className="flex h-full w-full shrink-0 snap-center snap-always items-center justify-center px-4 py-3"
              aria-roledescription="slide"
              aria-label={item === 0 ? "Cover" : `Page ${item} of ${count - 1}`}
              aria-hidden={item !== current}
              inert={item !== current ? true : undefined}
              data-testid="carousel-item"
            >
              {/* Height-bound page box (doc.format): as tall as the space allows, never wider than the screen. */}
              <div className="flex aspect-[148/210] h-full max-w-full items-center" style={aspectStyle}>
                {near ? (
                  <EditablePage page={position} priority={item === current} />
                ) : (
                  <div className="aspect-[148/210] w-full bg-muted" style={aspectStyle} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="relative flex shrink-0 items-center justify-center gap-2 pb-1">
        <button
          type="button"
          onClick={prev}
          disabled={current === 0}
          aria-label={spread ? "Previous pages" : "Previous page"}
          className={NAV_BTN}
          data-testid="carousel-prev"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </button>
        <span className="min-w-24 text-center text-sm tabular-nums text-muted-foreground" aria-live="polite" data-testid="page-counter">
          {label}
        </span>
        <button
          type="button"
          onClick={next}
          disabled={current >= count - 1}
          aria-label={spread ? "Next pages" : "Next page"}
          className={NAV_BTN}
          data-testid="carousel-next"
        >
          <ChevronRight className="size-5" aria-hidden="true" />
        </button>
        {spread ? null : (
          <button
            ref={spreadButton}
            type="button"
            onClick={() => setPreview(true)}
            disabled={pageCount === 0}
            aria-label="View spread"
            className="absolute right-1 flex h-11 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
            data-testid="view-spread"
          >
            <BookOpen className="size-4" aria-hidden="true" />
            {/* < 360 px the label would sit on the Next button: icon only (aria-label stays). */}
            <span className="max-[359px]:sr-only">Spread</span>
          </button>
        )}
      </div>
      {preview && !spread ? <SpreadPreviewSheet onClose={() => setPreview(false)} returnFocus={spreadButton} /> : null}
    </section>
  );
}

/**
 * md+ stand-in for the spread carousel while the screen width isn't known yet (server render +
 * hydration, N7): same box as the real thing — desk, the current spread (or the cover alone) at
 * its aspect ratio, counter row — so switching to the live carousel doesn't move anything.
 * EditorShell shows it with `hidden md:flex`; phones never see it.
 */
export function SpreadCarouselPlaceholder({ className }: { className?: string }) {
  const { state } = useEditor();
  const pageCount = state.doc.pages.length;
  const current = spreadOfPosition(state.page);
  const aspect = current === 0 ? pageAspectStyle(state.doc.format) : { aspectRatio: spreadAspectRatio(state.doc.format) };
  return (
    <div className={cn("min-h-0 flex-1 flex-col", className)} aria-hidden="true" data-testid="spread-placeholder">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted px-6 py-4">
        <div className={cn("h-full max-w-full bg-card", current === 0 && "aspect-[148/210]")} style={aspect} />
      </div>
      <div className="flex h-11 shrink-0 items-center justify-center pb-1 text-sm tabular-nums text-muted-foreground">
        {spreadCounterLabel(current, pageCount)}
      </div>
    </div>
  );
}
