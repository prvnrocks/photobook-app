"use client";

// Keep / drop review grid (M3). Kept | Dropped tabs; tapping a tile toggles it optimistically
// through the `toggle` server action (user_override = true, so the AI never changes it again).
// Tiles the user toggled stay where they are until the tab changes, so nothing jumps under a tap.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { PhotoTile } from "@/components/review/PhotoTile";
import {
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
};

type Choice = Pick<ReviewTilePhoto, "status" | "dropReason" | "userOverride">;

const TABS: ReviewTab[] = ["kept", "dropped"];
const TOAST_MS = 4000;
/** Signed thumb URLs expire after 10 min; re-sign (router.refresh) at most this often. */
const RESIGN_MIN_GAP_MS = 60_000;

export function ReviewGrid({ photos, aiUsed, toggle, onPhotosChange, toastClassName = "bottom-4" }: ReviewGridProps) {
  // Re-sign refresh: a bare router.refresh() can stay pending forever under the review loading.tsx,
  // so the new thumb URLs would never arrive (src/lib/app/refresh-nudge.ts).
  const [, refresh] = useRefreshTransition();
  const [overrides, setOverrides] = useState<Map<string, Choice>>(() => new Map());
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<ReviewTab>("kept");
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);
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
    async (photo: ReviewTilePhoto) => {
      if (pending.has(photo.id)) return;
      const keep = !isKept(photo);
      const before = overrides.get(photo.id);
      const next = applyUserChoice(photo, keep);

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
        setToast(result.error);
      }
    },
    [overrides, pending, toggle],
  );

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
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby="review-heading" data-testid="review-grid">
      <div>
        <h2 id="review-heading" className="type-h2 text-foreground" data-testid="review-header" aria-live="polite">
          {headerCopy({ aiUsed, kept, total: merged.length })}
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
              {t === "kept" ? "Kept" : "Dropped"}{" "}
              <span className="tabular-nums" data-testid={`review-count-${t}`}>
                ({t === "kept" ? kept : dropped})
              </span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="review-panel" aria-labelledby={`review-tab-${tab}`} data-testid="review-panel">
        {shown.length === 0 ? (
          <p className="type-small rounded-xl border border-dashed border-input/60 bg-card p-6 text-center text-muted-foreground" data-testid="review-empty-tab">
            {tab === "kept" ? "No photos kept yet. Open Dropped to add some back." : "Nothing dropped — every photo is in your album."}
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {shown.map((p) => (
              <li key={p.id} className="min-w-0">
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
        {toast ? (
          <p
            className="type-small pointer-events-auto max-w-sm rounded-xl bg-primary px-4 py-3 text-primary-foreground shadow-lift"
            data-testid="review-toast"
          >
            {toast}
          </p>
        ) : null}
      </div>
    </section>
  );
}
