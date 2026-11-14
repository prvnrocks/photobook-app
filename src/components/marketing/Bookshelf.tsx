"use client";
// Home hero bookshelf (M14): filter chips, a row of spines with the selected book pulled out to its
// cover, title + "View sample album", arrows. Motion is CSS transitions only: the track is anchored at
// 50 % and shifted by a calc() of CSS size variables (trackShift in src/lib/marketing/shelf.ts), so
// it is centred from the first server render at every width with no measuring. Swipe = pointer
// events writing a --drag variable (no re-render per move). Reduced motion: transitions off.
import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  filterShelf,
  selectionAfterFilter,
  SHELF_BOOKS,
  SHELF_DEFAULT_ID,
  SHELF_EDGES,
  SHELF_FILTERS,
  SPINE_NATURAL_H,
  spineRatio,
  stepSelection,
  trackShift,
  type ShelfFilter,
} from "@/lib/marketing/shelf";
import { cx } from "@/lib/cx";
import { ShelfCover, ShelfSpine } from "./ShelfCover";
import { ShelfPreview } from "./ShelfPreview";

const EASE_SLIDE = "ease-[cubic-bezier(0.22,1.12,0.36,1)]";
/** Spines within this many places of the default book load eagerly (the rest are off-screen). */
const EAGER_RADIUS = 5;
const DEFAULT_INDEX = SHELF_BOOKS.findIndex((b) => b.id === SHELF_DEFAULT_ID);

export function Bookshelf({ previewCta }: { previewCta: ReactNode }) {
  const [filter, setFilter] = useState<ShelfFilter>("all");
  const [selectedId, setSelectedId] = useState(SHELF_DEFAULT_ID);
  const [open, setOpen] = useState(false);
  const visible = useMemo(() => filterShelf(SHELF_BOOKS, filter), [filter]);
  const selected = visible.find((b) => b.id === selectedId) ?? visible[0];
  const index = visible.findIndex((b) => b.id === selected.id);

  const trackRef = useRef<HTMLUListElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const coverRefs = useRef(new Map<string, HTMLSpanElement>());
  const focusAfterMove = useRef(false);
  const drag = useRef<{ id: number; x0: number; dx: number } | null>(null);
  const suppressClick = useRef(false);
  const hintId = useId();
  const titleId = useId();

  const select = useCallback((id: string, focus = false) => {
    focusAfterMove.current = focus;
    setSelectedId(id);
  }, []);

  useEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    buttons.current.get(selected.id)?.focus({ preventScroll: true });
  }, [selected.id]);

  function changeFilter(next: ShelfFilter) {
    setFilter(next);
    const id = selectionAfterFilter(filterShelf(SHELF_BOOKS, next), selectedId);
    if (id) setSelectedId(id);
  }

  function step(delta: number, focus = false) {
    select(stepSelection(visible, selected.id, delta), focus);
  }

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    const moves: Record<string, () => string> = {
      ArrowLeft: () => stepSelection(visible, selected.id, -1),
      ArrowRight: () => stepSelection(visible, selected.id, 1),
      Home: () => visible[0].id,
      End: () => visible[visible.length - 1].id,
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    select(move(), true);
  }

  function onBookClick(id: string) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (id === selected.id) setOpen(true);
    else select(id);
  }

  // Swipe (touch / pen). Mouse users click spines or use the arrows.
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    drag.current = { id: e.pointerId, x0: e.clientX, dx: 0 };
    suppressClick.current = false;
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const track = trackRef.current;
    if (!d || d.id !== e.pointerId || !track) return;
    d.dx = e.clientX - d.x0;
    if (Math.abs(d.dx) > 8) {
      track.dataset.dragging = "";
      suppressClick.current = true;
    }
    track.style.setProperty("--drag", `${d.dx}px`);
  }
  function endDrag(e: PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const d = drag.current;
    const track = trackRef.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (track) {
      delete track.dataset.dragging;
      track.style.setProperty("--drag", "0px");
    }
    if (cancelled || Math.abs(d.dx) < 24) return;
    const spinePx = (track?.querySelector<HTMLElement>("[data-spine-face]")?.offsetHeight ?? 200) * 0.25;
    const steps = Math.round(-d.dx / spinePx) || (d.dx < 0 ? 1 : -1);
    step(steps);
  }

  const shift = trackShift(visible, selected.id);
  const trackStyle = {
    transform: `translateX(calc(-1 * (var(--spine-h) * ${shift.ratio} + ${shift.gaps} * var(--gap) + var(--slot-w) / 2) + var(--drag, 0px)))`,
  } as CSSProperties;
  const visibleIds = new Set(visible.map((b) => b.id));

  return (
    <div
      data-testid="bookshelf"
      className="flex w-full min-w-0 flex-col items-center [--cover-h:calc(var(--spine-h)*1.1)] [--cover-w:calc(var(--cover-h)*0.864)] [--gap:max(2px,calc(var(--spine-h)*0.011))] [--room:calc(var(--spine-h)*0.022)] [--slot-w:calc(var(--cover-w)+2*var(--room))] [--spine-h:clamp(180px,min(calc(17vw+116px),calc(56svh-150px)),380px)]"
    >
      <div className="w-full max-w-full overflow-x-auto px-gutter [scrollbar-width:none] sm:w-auto [&::-webkit-scrollbar]:hidden">
        <div
          role="group"
          aria-label="Filter sample books"
          className="mx-auto flex w-max items-center rounded-full border border-[#dccbb7] bg-white/40 p-1"
        >
          {SHELF_FILTERS.map((f, i) => (
            <span key={f.id} className="flex items-center">
              {i > 0 && filter !== f.id && filter !== SHELF_FILTERS[i - 1].id ? (
                <span aria-hidden="true" className="h-4 w-px bg-[#dccbb7]" />
              ) : (
                <span aria-hidden="true" className="w-px" />
              )}
              <button
                type="button"
                aria-pressed={filter === f.id}
                data-testid={`shelf-filter-${f.id}`}
                onClick={() => changeFilter(f.id)}
                className={cx(
                  "h-11 min-w-11 rounded-full px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:h-10 sm:px-6 motion-reduce:transition-none",
                  filter === f.id ? "bg-accent-strong text-white shadow-card" : "text-foreground hover:bg-secondary/70",
                )}
              >
                {f.label}
              </button>
            </span>
          ))}
        </div>
      </div>

      <section aria-roledescription="carousel" aria-label="Sample books" className="relative mt-1 w-full">
        <span id={hintId} className="sr-only">
          Selected. Press Enter to preview this book. Use the arrow keys to browse.
        </span>
        <div
          className="relative w-full touch-pan-y overflow-clip pt-3 pb-5"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
        >
          {/* floor shadow under the row */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-5 h-6 bg-[radial-gradient(ellipse_at_center,rgb(38_34_30/0.16),transparent_70%)]"
          />
          <ul
            ref={trackRef}
            aria-label="Books"
            onKeyDown={onKeyDown}
            style={trackStyle}
            className={cx(
              "relative left-1/2 flex h-[var(--cover-h)] w-max items-end transition-transform duration-[750ms] data-dragging:transition-none motion-reduce:transition-none",
              EASE_SLIDE,
            )}
          >
            <li
              aria-hidden="true"
              className="h-[var(--spine-h)] shrink-0"
              style={{ width: `calc(var(--spine-h) * ${SHELF_EDGES.left.w / SPINE_NATURAL_H})`, marginInlineEnd: "var(--gap)" }}
            >
              <EdgeImg edge={SHELF_EDGES.left} />
            </li>
            {SHELF_BOOKS.map((book, i) => {
              const shown = visibleIds.has(book.id);
              const isSel = shown && book.id === selected.id;
              const ratio = spineRatio(book);
              return (
                <li
                  key={book.id}
                  aria-hidden={shown ? undefined : true}
                  inert={!shown}
                  data-testid={`shelf-book-${book.id}`}
                  data-selected={isSel ? "" : undefined}
                  className={cx(
                    "relative h-full shrink-0 transition-[width,margin,opacity] duration-[650ms] motion-reduce:transition-none",
                    EASE_SLIDE,
                    shown ? "opacity-100" : "pointer-events-none opacity-0",
                  )}
                  style={{
                    width: !shown ? 0 : isSel ? "var(--slot-w)" : `calc(var(--spine-h) * ${ratio})`,
                    marginInlineEnd: shown ? "var(--gap)" : 0,
                  }}
                >
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) buttons.current.set(book.id, el);
                      else buttons.current.delete(book.id);
                    }}
                    tabIndex={isSel ? 0 : -1}
                    aria-label={book.title}
                    aria-current={isSel ? "true" : undefined}
                    aria-haspopup={isSel ? "dialog" : undefined}
                    aria-describedby={isSel ? hintId : undefined}
                    onClick={() => onBookClick(book.id)}
                    className="group absolute inset-0 cursor-pointer rounded-md outline-none [perspective:1400px] hover:[--lift:-12px] focus-visible:[--lift:-12px] data-[sel]:hover:[--lift:0px]"
                    data-sel={isSel ? "" : undefined}
                  >
                    <span
                      data-spine-face
                      className={cx(
                        "absolute bottom-0 left-1/2 block h-[var(--spine-h)] drop-shadow-[0_10px_8px_rgb(38_34_30/0.22)] transition-[transform,opacity] duration-500 group-focus-visible:outline-2 group-focus-visible:outline-offset-4 group-focus-visible:outline-ring motion-reduce:transition-none",
                        EASE_SLIDE,
                        isSel ? "opacity-0" : "opacity-100 delay-100",
                      )}
                      style={{
                        width: `calc(var(--spine-h) * ${ratio})`,
                        transform: isSel
                          ? "translateX(-50%) translateY(-6%) rotateY(-80deg)"
                          : "translateX(-50%) translateY(var(--lift, 0px))",
                      }}
                    >
                      <ShelfSpine book={book} eager={Math.abs(i - DEFAULT_INDEX) <= EAGER_RADIUS} />
                    </span>
                    <span
                      ref={(el) => {
                        if (el) coverRefs.current.set(book.id, el);
                        else coverRefs.current.delete(book.id);
                      }}
                      aria-hidden="true"
                      className={cx(
                        "pointer-events-none absolute bottom-0 left-1/2 block h-[var(--cover-h)] w-[var(--cover-w)] origin-bottom transition-[transform,opacity] duration-[650ms] group-focus-visible:outline-2 group-focus-visible:outline-offset-4 group-focus-visible:outline-ring motion-reduce:transition-none",
                        EASE_SLIDE,
                        isSel ? "opacity-100 delay-150" : "opacity-0",
                        book.cover ? "" : "drop-shadow-[0_14px_14px_rgb(38_34_30/0.28)]",
                      )}
                      style={{
                        transform: isSel
                          ? `translateX(-50%) translateY(2%) rotate(${book.cover ? 0 : -1.5}deg)`
                          : "translateX(-50%) translateY(10%) rotateY(78deg) scale(0.6)",
                      }}
                    >
                      <ShelfCover book={book} priority={book.id === SHELF_DEFAULT_ID} />
                    </span>
                  </button>
                </li>
              );
            })}
            <li
              aria-hidden="true"
              className="h-[var(--spine-h)] shrink-0"
              style={{ width: `calc(var(--spine-h) * ${SHELF_EDGES.right.w / SPINE_NATURAL_H})` }}
            >
              <EdgeImg edge={SHELF_EDGES.right} />
            </li>
          </ul>
        </div>

        <div className="mx-auto grid w-full max-w-[96rem] grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-start gap-2 px-gutter sm:px-6 lg:px-12">
          <ArrowButton dir="prev" disabled={index <= 0} onClick={() => step(-1)} />
          <div className="flex min-w-0 flex-col items-center text-center">
            <p
              id={titleId}
              data-testid="shelf-title"
              className="font-display text-2xl font-medium break-words text-foreground sm:text-[2rem] sm:leading-tight"
            >
              <span dir="auto">{selected.title}</span>
            </p>
            <button
              type="button"
              data-testid="shelf-view-sample"
              aria-haspopup="dialog"
              aria-describedby={titleId}
              onClick={() => setOpen(true)}
              className="inline-flex min-h-11 items-center rounded-md px-2 text-[0.95rem] text-accent-strong underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              View sample album
            </button>
          </div>
          <ArrowButton dir="next" disabled={index >= visible.length - 1} onClick={() => step(1)} />
        </div>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {`${selected.title}, ${index + 1} of ${visible.length}`}
        </p>
      </section>

      <ShelfPreview
        book={selected}
        cta={previewCta}
        open={open}
        originEl={() => coverRefs.current.get(selected.id) ?? null}
        onClose={() => {
          setOpen(false);
          buttons.current.get(selected.id)?.focus({ preventScroll: true });
        }}
      />
    </div>
  );
}

function EdgeImg({ edge }: { edge: { src: string; w: number; h: number } }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- decorative 40 px PNG with fixed size
    <img src={edge.src} width={edge.w} height={edge.h} alt="" draggable={false} className="block h-full w-full opacity-90 select-none" />
  );
}

function ArrowButton({ dir, disabled, onClick }: { dir: "prev" | "next"; disabled: boolean; onClick: () => void }) {
  const Icon = dir === "prev" ? ArrowLeft : ArrowRight;
  return (
    <button
      type="button"
      aria-label={dir === "prev" ? "Previous book" : "Next book"}
      data-testid={`shelf-${dir}`}
      disabled={disabled}
      onClick={onClick}
      className="flex size-11 items-center justify-center rounded-full text-foreground transition outline-none hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 motion-reduce:transition-none"
    >
      <Icon aria-hidden="true" className="size-6 stroke-[1.5]" />
    </button>
  );
}
