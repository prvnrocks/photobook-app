"use client";

// Review screen body (M3 + D-028): grid, sticky "Update album" bar, secondary AI rebuild and the
// Continue form (confirmAlbumAction: Memory Keeper + redirect, D-032) / Add photos link. Tracks which keep / drop choices aren't in the album yet
// (unsyncedPhotoIds over the grid's optimistic state and the album's photo ids from the server).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { RebuildButton } from "@/components/review/RebuildButton";
import { ReviewGrid, type ToggleResult } from "@/components/review/ReviewGrid";
import { UpdateAlbumBar } from "@/components/review/UpdateAlbumBar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  CONTINUE_UNSYNCED_NOTE,
  unsyncedPhotoIds,
  updateAlbumOutcome,
  type RebuildVariant,
  type ReviewTilePhoto,
  type UpdateAlbumOutcome,
  type UpdateAlbumResult,
} from "@/lib/review/ui";
import { cn } from "@/lib/utils";

type ReviewBodyProps = {
  bookId: string;
  photos: ReviewTilePhoto[];
  aiUsed: boolean;
  /** Bound server action: (photoId, keep) → result. */
  toggle: (photoId: string, keep: boolean) => Promise<ToggleResult>;
  /** Bound server action: re-lays out the album from the current choices (D-028). */
  updateAlbum: () => Promise<UpdateAlbumResult>;
  /** Photo ids used by the album (pages + cover); empty = no album yet. */
  albumPhotoIds: string[];
  /** Album edited by the user → Update album never runs on it. */
  userEdited: boolean;
  /** A build is running → no Update album, no rebuild. */
  building: boolean;
  rebuild: { variant: RebuildVariant; rebuildsLeft: number | null } | null;
  /** Bound server action for "Continue": learns preferences, then redirects (never returns). */
  confirm: () => Promise<void>;
  /** Read-only captions preview, shown above Continue (null = nothing to show). */
  captions?: ReactNode;
  /** Shown instead of the grid when the book has no photos. */
  empty: ReactNode;
};

const TOAST_MS = 4000;

export function ReviewBody({
  bookId,
  photos,
  aiUsed,
  toggle,
  updateAlbum,
  albumPhotoIds,
  userEdited,
  building,
  rebuild,
  confirm,
  captions,
  empty,
}: ReviewBodyProps) {
  const router = useRouter();
  const [current, setCurrent] = useState<ReviewTilePhoto[]>(photos);
  /** id → status at the last successful update: still-unsynced ids the relayout couldn't place. */
  const [settled, setSettled] = useState<Map<string, string>>(() => new Map());
  const [pending, setPending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<Extract<UpdateAlbumOutcome, { kind: "error" }> | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const albumIds = useMemo(() => new Set(albumPhotoIds), [albumPhotoIds]);
  const unsynced = useMemo(() => {
    const status = new Map(current.map((p) => [p.id, p.status]));
    return unsyncedPhotoIds(current, albumIds, {
      hasAlbum: albumIds.size > 0,
      userEdited,
      building,
    }).filter((id) => settled.get(id) !== status.get(id));
  }, [current, albumIds, userEdited, building, settled]);
  const outOfSync = unsynced.length > 0;
  const showBar = outOfSync && photos.length > 0;

  // An error belongs to the changes it was about; drop it once nothing is out of sync.
  useEffect(() => {
    if (!outOfSync) setError(null);
  }, [outOfSync]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const onUpdate = useCallback(async () => {
    if (pending || refreshing) return;
    // Snapshot now: a photo toggled while the update runs keeps showing as unsynced.
    const statusAtClick = new Map(current.map((p) => [p.id, p.status]));
    const ids = unsynced;
    setPending(true);
    setError(null);
    let result: UpdateAlbumResult | null = null;
    try {
      result = await updateAlbum();
    } catch {
      result = null;
    }
    const outcome = updateAlbumOutcome(bookId, result);
    setPending(false);
    if (outcome.kind === "updated") {
      setSettled((m) => {
        const n = new Map(m);
        for (const id of ids) n.set(id, statusAtClick.get(id) ?? "");
        return n;
      });
      setToast(outcome.toast);
      startRefresh(() => router.refresh());
    } else {
      setError(outcome);
    }
  }, [pending, refreshing, current, unsynced, updateAlbum, bookId, router]);

  return (
    <>
      {photos.length === 0 ? (
        empty
      ) : (
        <ReviewGrid photos={photos} aiUsed={aiUsed} toggle={toggle} onPhotosChange={setCurrent} raiseToast={showBar} />
      )}

      {captions}

      <div className="flex flex-col gap-3 border-t pt-4">
        {rebuild && photos.length > 0 ? <RebuildButton bookId={bookId} variant={rebuild.variant} rebuildsLeft={rebuild.rebuildsLeft} /> : null}
        {showBar ? (
          <p
            id="review-continue-note"
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50"
            data-testid="review-continue-warning"
          >
            {CONTINUE_UNSYNCED_NOTE}
          </p>
        ) : null}
        <form action={confirm} className="flex flex-col">
          <ContinueButton outline={showBar} describedBy={showBar ? "review-continue-note" : undefined} />
        </form>
        <Link
          href={`/books/${bookId}/upload`}
          className={cn(buttonVariants({ variant: "ghost" }), "h-11 w-full text-base")}
          data-testid="review-add-photos"
        >
          Add more photos
        </Link>
      </div>

      {showBar ? (
        <>
          {/* Room so the sticky bar never covers the last links. */}
          <div aria-hidden className="h-[calc(6rem+env(safe-area-inset-bottom))] shrink-0" />
          <UpdateAlbumBar count={unsynced.length} pending={pending || refreshing} error={error} onUpdate={onUpdate} />
        </>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
      >
        {toast ? (
          <p
            className="pointer-events-auto max-w-sm rounded-lg bg-foreground px-4 py-3 text-base text-background shadow-lg"
            data-testid="update-album-toast"
          >
            {toast}
          </p>
        ) : null}
      </div>
    </>
  );
}

function ContinueButton({ outline, describedBy }: { outline: boolean; describedBy: string | undefined }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={outline ? "outline" : "default"}
      className="h-12 w-full text-base"
      disabled={pending}
      aria-describedby={describedBy}
      data-testid="review-continue"
    >
      {pending ? "Saving…" : "Continue"}
    </Button>
  );
}
