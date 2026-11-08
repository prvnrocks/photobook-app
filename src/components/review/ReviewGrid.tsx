"use client";

// Keep / drop review grid (M3). Kept | Dropped tabs; tapping a tile toggles it optimistically
// through the `toggle` server action (user_override = true, so the AI never changes it again).
// Tiles the user toggled stay where they are until the tab changes, so nothing jumps under a tap.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
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
};

type Choice = Pick<ReviewTilePhoto, "status" | "dropReason" | "userOverride">;

const TABS: ReviewTab[] = ["kept", "dropped"];
const TOAST_MS = 4000;
/** Signed thumb URLs expire after 10 min; re-sign (router.refresh) at most this often. */
const RESIGN_MIN_GAP_MS = 60_000;

export function ReviewGrid({ photos, aiUsed, toggle }: ReviewGridProps) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Map<string, Choice>>(() => new Map());
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<ReviewTab>("kept");
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);
  const lastResign = useRef(0);
  const tabRefs = useRef<Record<ReviewTab, HTMLButtonElement | null>>({ kept: null, dropped: null });

  // Server props (refreshed after each toggle via revalidatePath) + optimistic choices on top.
  const merged = photos.map((p) => {
    const o = overrides.get(p.id);
    return o ? { ...p, ...o } : p;
  });
  const kept = countKept(merged);
  const dropped = merged.length - kept;
  const shown = visiblePhotos(merged, tab, pinned);
  const indexOf = new Map(photos.map((p, i) => [p.id, i + 1]));

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
    router.refresh();
  }, [router]);

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
        <h1 id="review-heading" className="text-2xl font-semibold" data-testid="review-header" aria-live="polite">
          {headerCopy({ aiUsed, kept, total: merged.length })}
        </h1>
        <p className="mt-1 text-base text-muted-foreground">
          Tap a photo to keep it or take it out. Your choices are never changed by AI.
        </p>
      </div>

      <div role="tablist" aria-label="Photos" className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
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
                "min-h-11 rounded-lg px-3 text-base font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                selected ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
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
          <p className="rounded-xl border border-dashed p-6 text-center text-base text-muted-foreground" data-testid="review-empty-tab">
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
        className="pointer-events-none fixed inset-x-0 bottom-4 z-20 flex justify-center px-4"
      >
        {toast ? (
          <p
            className="pointer-events-auto max-w-sm rounded-lg bg-foreground px-4 py-3 text-base text-background shadow-lg"
            data-testid="review-toast"
          >
            {toast}
          </p>
        ) : null}
      </div>
    </section>
  );
}
