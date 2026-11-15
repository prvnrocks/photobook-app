"use client";

// Keep / drop review grid (M3). Kept | Dropped tabs; tapping a tile toggles it optimistically
// through the `toggle` server action (user_override = true, so the AI never changes it again).
// Tiles the user toggled stay where they are until the tab changes, so nothing jumps under a tap.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { PhotoTile } from "@/components/review/PhotoTile";
import {
  REVIEW_EMPTY_TAB_COPY,
  REVIEW_MOVED_COPY,
  REVIEW_TAB_LABELS,
  applyUserChoice,
  countKept,
  headerCopy,
  isKept,
  tabOf,
  visiblePhotos,
  type ReviewTab,
  type ReviewTilePhoto,
} from "@/lib/review/ui";
import { cn } from "@/lib/utils";

export type ToggleResult = { ok: true } | { ok: false; error: string };

type ReviewGridProps = {
  photos: ReviewTilePhoto[];
  /** True when the AI picked these (books.ai_status done/partial) → "AI kept …". */
  aiUsed: boolean;
  /** Bound server action: (photoId, keep) → result. */
  toggle: (photoId: string, keep: boolean) => Promise<ToggleResult>;
  /** Called with the photos incl. optimistic choices whenever they change (must be stable). */
  onPhotosChange?: (photos: ReviewTilePhoto[]) => void;
  /** Bottom offset classes for the toast (keeps it above the review ActionBar). */
  toastClassName?: string;
  /**
   * Re-fetches fresh photos (new signed thumb URLs) instead of router.refresh — the /books/new
   * wizard (M20 T8, G1: no router.refresh there) re-loads its step-7 data. Default: router refresh.
   */
  refresh?: () => void;
  /** Wizard motion hooks (M20 T8): data-motion on the grid, per-tile index, keyed tab counts. */
  motion?: boolean;
  /** Called on each optimistic toggle (before the server answers), e.g. to animate the tile. */
  onToggle?: (photo: ReviewTilePhoto, keep: boolean) => void;
  /** After a saved toggle, a toast with Undo (M20 T8). Default off (classic review unchanged). */
  undo?: boolean;
  /** Replaces the "AI kept X of Y" heading text (the wizard shows its own counter). */
  title?: ReactNode;
  /** Classes for the photo list (default 3 columns, 4 from sm). */
  gridClassName?: string;
};

type GridToast = { text: string; undoId?: string };

type Choice = Pick<ReviewTilePhoto, "status" | "dropReason" | "userOverride">;

const TABS: ReviewTab[] = ["kept", "dropped"];
const TOAST_MS = 4000;
/** Signed thumb URLs expire after 10 min; re-sign (router.refresh) at most this often. */
const RESIGN_MIN_GAP_MS = 60_000;

export function ReviewGrid({
  photos,
  aiUsed,
  toggle,
  onPhotosChange,
  toastClassName = "bottom-4",
  refresh: refreshOverride,
  motion = false,
  onToggle,
  undo = false,
  title,
  gridClassName = "grid grid-cols-3 gap-2 sm:grid-cols-4",
}: ReviewGridProps) {
  // Re-sign refresh: a bare router.refresh() can stay pending forever under the review loading.tsx,
  // so the new thumb URLs would never arrive (src/lib/app/refresh-nudge.ts).
  const [, routerRefresh] = useRefreshTransition();
  const refresh = refreshOverride ?? routerRefresh;
  const [overrides, setOverrides] = useState<Map<string, Choice>>(() => new Map());
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<ReviewTab>("kept");
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<GridToast | null>(null);
  const lastResign = useRef(0);
  const tabRefs = useRef<Record<ReviewTab, HTMLButtonElement | null>>({ kept: null, dropped: null });

  // Server props (refreshed after each toggle via revalidatePath) + optimistic choices on top.
  const merged = useMemo(
    () =>
      photos.map((p) => {
        const o = overrides.get(p.id);
        return o ? { ...p, ...o } : p;
      }),
    [photos, overrides],
  );
  const kept = countKept(merged);
  const dropped = merged.length - kept;
  const shown = visiblePhotos(merged, tab, pinned);
  const indexOf = new Map(photos.map((p, i) => [p.id, i + 1]));

  useEffect(() => {
    onPhotosChange?.(merged);
  }, [merged, onPhotosChange]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const onTileTap = useCallback(
    async (photo: ReviewTilePhoto, fromUndo = false) => {
      if (pending.has(photo.id)) return;
      const keep = !isKept(photo);
      const before = overrides.get(photo.id);
      const next = applyUserChoice(photo, keep);
      onToggle?.(photo, keep);

      setOverrides((m) => new Map(m).set(photo.id, { status: next.status, dropReason: next.dropReason, userOverride: true }));
      setPinned((s) => new Set(s).add(photo.id));
      setPending((s) => new Set(s).add(photo.id));

      let result: ToggleResult;
      try {
        result = await toggle(photo.id, keep);
      } catch {
        result = { ok: false, error: "We couldn't save that. Please try again." };
      }

      setPending((s) => {
        const n = new Set(s);
        n.delete(photo.id);
        return n;
      });
      if (!result.ok) {
        setOverrides((m) => {
          const n = new Map(m);
          if (before) n.set(photo.id, before);
          else n.delete(photo.id);
          return n;
        });
        setToast({ text: result.error });
      } else if (undo) {
        setToast(fromUndo ? null : { text: REVIEW_MOVED_COPY[keep ? "kept" : "dropped"], undoId: photo.id });
      }
    },
    [overrides, pending, toggle, onToggle, undo],
  );

  const onUndo = () => {
    const id = toast?.undoId;
    const photo = id ? merged.find((p) => p.id === id) : undefined;
    setToast(null);
    if (photo) void onTileTap(photo, true);
  };

  const onThumbError = useCallback(() => {
    const now = Date.now();
    if (now - lastResign.current < RESIGN_MIN_GAP_MS) return;
    lastResign.current = now;
    refresh();
  }, [refresh]);

  const selectTab = (t: ReviewTab) => {
    setTab(t);
    setPinned(new Set());
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = TABS.indexOf(tab);
    const next =
      e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-labelledby="review-heading"
      data-testid="review-grid"
      data-motion={motion ? "" : undefined}
    >
      <div>
        <h2 id="review-heading" className="type-h2 text-foreground" data-testid="review-header" aria-live="polite">
          {title ?? headerCopy({ aiUsed, kept, total: merged.length })}
        </h2>
        <p className="type-small mt-1 text-muted-foreground">
          Tap a photo to keep it or take it out. Your choices are never changed by AI.
        </p>
      </div>

      <div role="tablist" aria-label="Photos" className="grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1">
        {TABS.map((t) => {
          const selected = tab === t;
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`review-tab-${t}`}
              aria-selected={selected}
              aria-controls="review-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(t)}
              onKeyDown={onTabKey}
              data-testid={`review-tab-${t}`}
              className={cn(
                "min-h-11 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary",
                selected ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {REVIEW_TAB_LABELS[t]}{" "}
              <span
                key={motion ? `${t}-${t === "kept" ? kept : dropped}` : t}
                className={cn("tabular-nums", motion && "rv-count")}
                data-testid={`review-count-${t}`}
              >
                ({t === "kept" ? kept : dropped})
              </span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="review-panel" aria-labelledby={`review-tab-${tab}`} data-testid="review-panel">
        {shown.length === 0 ? (
          <p className="type-small rounded-xl border border-dashed border-input/60 bg-card p-6 text-center text-muted-foreground" data-testid="review-empty-tab">
            {REVIEW_EMPTY_TAB_COPY[tab]}
          </p>
        ) : (
          <ul className={gridClassName}>
            {shown.map((p, i) => (
              <li
                key={p.id}
                className="min-w-0"
                style={motion ? ({ "--rv-i": Math.min(i, 24) } as CSSProperties) : undefined}
                data-toggled={motion && pinned.has(p.id) ? "" : undefined}
              >
                <PhotoTile
                  photo={p}
                  index={indexOf.get(p.id) ?? 0}
                  busy={pending.has(p.id)}
                  moved={tabOf(p) !== tab}
                  onTap={onTileTap}
                  onThumbError={onThumbError}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none fixed inset-x-0 z-40 flex justify-center px-gutter sm:bottom-8",
          toastClassName,
        )}
      >
        {toast?.undoId ? (
          <p
            className="type-small pointer-events-auto flex max-w-sm items-center gap-3 rounded-xl bg-primary py-1.5 ps-4 pe-1.5 text-primary-foreground shadow-lift"
            data-testid="review-undo-toast"
          >
            <span className="min-w-0 flex-1">{toast.text}</span>
            <button
              type="button"
              onClick={onUndo}
              className="min-h-11 min-w-11 shrink-0 rounded-lg px-3 font-semibold underline underline-offset-4 outline-none hover:bg-primary-foreground/10 focus-visible:ring-2 focus-visible:ring-primary-foreground"
              data-testid="review-undo"
            >
              Undo
            </button>
          </p>
        ) : toast ? (
          <p
            className="type-small pointer-events-auto max-w-sm rounded-xl bg-primary px-4 py-3 text-primary-foreground shadow-lift"
            data-testid="review-toast"
          >
            {toast.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
