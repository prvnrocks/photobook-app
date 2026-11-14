"use client";

// "My books" toolbar + collection grid (M18). Client island: filter tabs (role=tablist, arrow keys),
// title search and sort, all client-side over small records (src/lib/dashboard/library.ts). The cards
// themselves are rendered on the server and passed in as nodes, so this module imports no next/link,
// cn() or button recipes (lesson 2026-11-14). The state is mirrored to ?filter=&q=&sort= with
// history.replaceState (no server round trip); the page passes the initial query from the URL.

import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LIBRARY_GRID } from "@/components/dashboard/library-classes";
import {
  LIBRARY_FILTER_LABELS,
  LIBRARY_FILTERS,
  LIBRARY_SORT_LABELS,
  LIBRARY_SORTS,
  libraryCounts,
  libraryQueryString,
  matchesFilter,
  matchesQuery,
  sortEntries,
  type LibraryEntry,
  type LibraryFilter,
  type LibraryQuery,
  type LibrarySort,
} from "@/lib/dashboard/library";

export type LibraryItem = LibraryEntry & { card: ReactNode };

const EMPTY_COPY: Record<LibraryFilter, string> = {
  all: "No books yet",
  draft: "No drafts",
  live: "No live books",
  paid: "No paid books",
  expired: "No expired links",
};

const FIELD =
  "h-11 rounded-xl border border-border bg-card text-sm text-foreground shadow-card outline-none transition-colors hover:border-input/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

export function BookLibrary({ items, initialQuery }: { items: LibraryItem[]; initialQuery: LibraryQuery }) {
  const [filter, setFilter] = useState<LibraryFilter>(initialQuery.filter);
  const [q, setQ] = useState(initialQuery.q);
  const [sort, setSort] = useState<LibrarySort>(initialQuery.sort);
  const tabRefs = useRef<Partial<Record<LibraryFilter, HTMLButtonElement | null>>>({});
  const firstRender = useRef(true);
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const tabId = (f: LibraryFilter) => `${baseId}-tab-${f}`;

  const counts = useMemo(() => libraryCounts(items), [items]);
  const visible = useMemo(
    () => sortEntries(items.filter((i) => matchesFilter(i, filter) && matchesQuery(i.title, q)), sort),
    [items, filter, q, sort],
  );

  // Mirror the view into the address bar (shareable, survives reload); skip the first render so a
  // clean /dashboard stays clean.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const url = `${window.location.pathname}${libraryQueryString({ filter, q, sort })}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
  }, [filter, q, sort]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = LIBRARY_FILTERS.indexOf(filter);
    const last = LIBRARY_FILTERS.length - 1;
    const next =
      e.key === "ArrowRight" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    const f = LIBRARY_FILTERS[next];
    setFilter(f);
    tabRefs.current[f]?.focus();
  };

  const filtered = filter !== "all" || q.trim() !== "";
  const reset = () => {
    setFilter("all");
    setQ("");
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 sm:gap-7">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between" data-testid="library-toolbar">
        {/* Filter tabs: scroll sideways on narrow phones rather than wrap. "relative" makes the scroller the
            containing block of the counts' sr-only (absolute) text — otherwise it widens the page. */}
        <div className="relative -mx-gutter min-w-0 overflow-x-auto px-gutter [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
          <div
            role="tablist"
            aria-label="Filter books"
            className="inline-flex min-w-max gap-1 rounded-2xl border border-border bg-card p-1 shadow-card"
          >
            {LIBRARY_FILTERS.map((f) => {
              const selected = f === filter;
              return (
                <button
                  key={f}
                  ref={(el) => {
                    tabRefs.current[f] = el;
                  }}
                  type="button"
                  role="tab"
                  id={tabId(f)}
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setFilter(f)}
                  onKeyDown={onTabKey}
                  className={`inline-flex h-11 items-center gap-2 rounded-xl px-3.5 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card ${
                    selected ? "bg-primary text-primary-foreground shadow-card" : "text-muted-foreground hover:bg-secondary hover:text-primary"
                  }`}
                  data-testid={`library-tab-${f}`}
                >
                  {LIBRARY_FILTER_LABELS[f]}
                  <span
                    className={`min-w-5 rounded-full px-1.5 py-px text-center text-xs tabular-nums ${
                      selected ? "bg-primary-foreground/15 text-primary-foreground" : "bg-muted text-muted-foreground"
                    }`}
                    data-testid={`library-count-${f}`}
                  >
                    <span className="sr-only">(</span>
                    {counts[f]}
                    <span className="sr-only">)</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex gap-2 sm:gap-3">
          <label className="relative min-w-0 flex-1 lg:w-72 lg:flex-none">
            <span className="sr-only">Search your books by title</span>
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search titles"
              maxLength={80}
              dir="auto"
              enterKeyHint="search"
              autoComplete="off"
              className={`${FIELD} w-full ps-9 pe-10 placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden`}
              data-testid="library-search"
            />
            {q ? (
              <button
                type="button"
                onClick={() => setQ("")}
                className="absolute end-0 top-0 flex size-11 items-center justify-center rounded-xl text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                aria-label="Clear search"
                data-testid="library-search-clear"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </label>
          <label className="relative shrink-0">
            <span className="sr-only">Sort books</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as LibrarySort)}
              className={`${FIELD} cursor-pointer appearance-none ps-3 pe-9 font-medium`}
              data-testid="library-sort"
            >
              {LIBRARY_SORTS.map((s) => (
                <option key={s} value={s}>
                  {LIBRARY_SORT_LABELS[s]}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          </label>
        </div>
      </div>

      <p className="sr-only" aria-live="polite" data-testid="library-result">
        {filtered ? `Showing ${visible.length} of ${items.length} ${items.length === 1 ? "book" : "books"}` : ""}
      </p>

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(filter)} tabIndex={-1} className="outline-none">
        {visible.length > 0 ? (
          <ul className={LIBRARY_GRID} data-testid="book-list">
            {visible.map((item) => (
              <li key={item.id} className="min-w-0">
                {item.card}
              </li>
            ))}
          </ul>
        ) : (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-card/60 px-6 py-14 text-center"
            data-testid="library-no-match"
          >
            <p className="font-display text-xl font-semibold text-heading">
              {q.trim() ? "No books match your search" : EMPTY_COPY[filter]}
            </p>
            <p className="type-small max-w-sm text-muted-foreground">
              {q.trim() ? "Try another word from the title, or show all books." : "Books in this group will show up here."}
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-1 inline-flex h-11 items-center rounded-xl border border-border bg-card px-4 text-sm font-medium text-primary shadow-card outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              data-testid="library-reset"
            >
              Show all books
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
