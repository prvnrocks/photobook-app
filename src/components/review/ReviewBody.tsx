"use client";

// Review screen body (M3 + D-028, M11 T12): grid, captions, secondary "Rebuild with AI" / Add photos,
// and one sticky ActionBar with the way forward — "Continue to editor" (confirmAlbumAction: Memory
// Keeper + redirect to the editor, D-032), plus "Update album" only while choices are pending. A user-edited album shows only "Continue in the editor" (D-037 #2). Tracks which keep / drop choices aren't in the album yet
// (unsyncedPhotoIds over the grid's optimistic state and the album's photo ids from the server).
import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { ActionBar } from "@/components/app/ActionBar";
import { Notice } from "@/components/app/Notice";
import { RebuildButton } from "@/components/review/RebuildButton";
import { ReviewGrid, type ToggleResult } from "@/components/review/ReviewGrid";
import { UpdateAlbumBar } from "@/components/review/UpdateAlbumBar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  CONTINUE_UNSYNCED_NOTE,
  EDITED_ALBUM_COPY,
  editorHref,
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
  /**
   * Album edited by the user (albumEditedByUser) → no Update album, no Rebuild with AI, and
   * "Continue in the editor" instead of Continue (D-037 #2).
   */
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

/** The main way forward from review (M11 T12). */
const CONTINUE_LABEL = "Continue to editor";

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
  const showBar = outOfSync && photos.length > 0 && !userEdited;

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

  const editedPanel = userEdited && !building;
  // Toasts sit above the sticky bar (taller while it carries the Update album row).
  const toastBottom = showBar
    ? "bottom-[calc(11rem+env(safe-area-inset-bottom))]"
    : "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]";

  return (
    <>
      {editedPanel ? (
        <Notice tone="info" title={EDITED_ALBUM_COPY.title} data-testid="review-edited">
          {EDITED_ALBUM_COPY.body}
        </Notice>
      ) : null}

      {photos.length === 0 ? (
        empty
      ) : (
        <ReviewGrid photos={photos} aiUsed={aiUsed} toggle={toggle} onPhotosChange={setCurrent} toastClassName={toastBottom} />
      )}

      {captions}

      {/* Secondary actions: re-plan with AI, add photos. Never the main way forward. */}
      <section className="flex min-w-0 flex-col gap-3 border-t border-border pt-stack" aria-label="More options">
        {rebuild && photos.length > 0 && !userEdited ? (
          <RebuildButton bookId={bookId} variant={rebuild.variant} rebuildsLeft={rebuild.rebuildsLeft} />
        ) : null}
        <Link
          href={`/books/${bookId}/upload`}
          className={cn(buttonVariants({ variant: "ghost", size: "touch" }), "w-full")}
          data-testid="review-add-photos"
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add more photos
        </Link>
      </section>

      {/* Primary: one way forward, sticky on phones. "Update album" joins it only while choices
          aren't in the album yet (D-028); an edited album only offers the editor (D-037 #2). */}
      <ActionBar label="Next step" className="sm:flex-col sm:items-stretch sm:*:w-full" data-testid="review-actions">
        {showBar ? (
          <UpdateAlbumBar
            count={unsynced.length}
            pending={pending || refreshing}
            error={error}
            onUpdate={onUpdate}
            note={
              <p id="review-continue-note" className="type-small text-muted-foreground" data-testid="review-continue-warning">
                {CONTINUE_UNSYNCED_NOTE}
              </p>
            }
          />
        ) : null}
        {editedPanel ? (
          <Link
            href={editorHref(bookId)}
            className={buttonVariants({ variant: "default", size: "cta" })}
            data-testid="review-open-editor"
          >
            {EDITED_ALBUM_COPY.button}
          </Link>
        ) : (
          <form action={confirm} className="flex flex-col">
            <ContinueButton outline={showBar} describedBy={showBar ? "review-continue-note" : undefined} />
          </form>
        )}
      </ActionBar>

      <div
        role="status"
        aria-live="polite"
        className={cn("pointer-events-none fixed inset-x-0 z-40 flex justify-center px-gutter sm:bottom-8", toastBottom)}
      >
        {toast ? (
          <p
            className="type-small pointer-events-auto max-w-sm rounded-xl bg-primary px-4 py-3 text-primary-foreground shadow-lift"
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
      size="cta"
      variant={outline ? "outline" : "default"}
      disabled={pending}
      aria-describedby={describedBy}
      data-testid="review-continue"
    >
      {pending ? "Saving…" : CONTINUE_LABEL}
      {pending ? null : <ArrowRight data-icon="inline-end" className="rtl:rotate-180" aria-hidden="true" />}
    </Button>
  );
}
