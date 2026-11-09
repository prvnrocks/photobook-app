"use client";

// Mobile-first page carousel: one big page at a time, swipe with native CSS scroll-snap (no deps).
// Item 0 = cover, item i + 1 = doc.pages[i]. Scroll position ⇄ state.page stay in sync:
// swiping updates the store; store changes (strip tap, prev/next, undo) scroll the carousel
// (instant for jumps > 1 so intermediate snap points don't feed back into the store).
// Only items within WINDOW of the current one render a <BookPage>; the rest are empty boxes.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { itemToPosition, positionToItem } from "@/lib/editor/store";
import { cn } from "@/lib/utils";
import { useEditor } from "./editor-context";
import { EditablePage } from "./EditablePage";

const WINDOW = 2;

/** "Cover" for the cover, else "3 / 20" (1-based page of total pages). Exported for tests. */
export function pageCounterLabel(item: number, pageCount: number): string {
  return item <= 0 ? `Cover · ${pageCount} ${pageCount === 1 ? "page" : "pages"}` : `${item} / ${pageCount}`;
}

export function PageCarousel() {
  const { state, actions } = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  const current = positionToItem(state.page);
  const count = state.doc.pages.length + 1;
  const currentRef = useRef(current);
  const firstRun = useRef(true);

  // store → scroll
  useEffect(() => {
    currentRef.current = current;
    const el = ref.current;
    if (!el || el.clientWidth === 0) return;
    const shown = Math.round(el.scrollLeft / el.clientWidth);
    if (shown !== current) {
      const jump = Math.abs(shown - current) > 1 || firstRun.current;
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
        if (shown !== currentRef.current) {
          currentRef.current = shown;
          actions.goTo(itemToPosition(shown));
        }
      });
    };
    // Keep the current page in view when the width changes (rotation, desktop resize).
    const ro = new ResizeObserver(() => {
      el.scrollTo({ left: currentRef.current * el.clientWidth, behavior: "instant" });
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [actions]);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-roledescription="carousel" aria-label="Book pages">
      <div
        ref={ref}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="page-carousel"
      >
        {Array.from({ length: count }, (_, item) => {
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
              {/* Height-bound A5 box: as tall as the space allows, never wider than the screen. */}
              <div className="flex aspect-[148/210] h-full max-w-full items-center">
                {near ? <EditablePage page={position} priority={item === current} /> : <div className="aspect-[148/210] w-full bg-neutral-100" />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2 pb-1">
        <button
          type="button"
          onClick={actions.prev}
          disabled={current === 0}
          aria-label="Previous page"
          className="flex size-11 items-center justify-center rounded-full text-foreground disabled:opacity-30"
          data-testid="carousel-prev"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </button>
        <span className="min-w-24 text-center text-sm tabular-nums text-muted-foreground" aria-live="polite" data-testid="page-counter">
          {pageCounterLabel(current, count - 1)}
        </span>
        <button
          type="button"
          onClick={actions.next}
          disabled={current >= count - 1}
          aria-label="Next page"
          className={cn("flex size-11 items-center justify-center rounded-full text-foreground disabled:opacity-30")}
          data-testid="carousel-next"
        >
          <ChevronRight className="size-5" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
