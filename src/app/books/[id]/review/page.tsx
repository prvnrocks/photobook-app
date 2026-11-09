import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { CaptionsPreview } from "@/components/review/CaptionsPreview";
import { ReviewBody } from "@/components/review/ReviewBody";
import { buttonVariants } from "@/components/ui/button";
import { resolveAiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { getCurrentUser } from "@/lib/auth/current-user";
import { docOrigin } from "@/lib/book/replaceable";
import { countLiveRebuilds, getActiveRunForBook } from "@/lib/db/agent-runs";
import { getBookForRun, getMyBook } from "@/lib/db/books";
import { listReviewPhotos } from "@/lib/db/photos";
import { getMyProfile } from "@/lib/db/profiles";
import { getLayout } from "@/lib/layouts";
import {
  aiPicked,
  albumEditedByUser,
  BANNER_COPY,
  captionsPreviewModel,
  captionsPreviewOf,
  docPhotoIds,
  partialCaptionsNote,
  rebuildsLeft,
  rebuildVariant,
  reviewBanner,
  type ReviewTilePhoto,
} from "@/lib/review/ui";
import { cn } from "@/lib/utils";
import { confirmAlbumAction, togglePhotoAction, updateAlbumAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Review your photos" };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/books/${id}/review`)}`);

  // Ownership under RLS first; the admin-client helpers below assume it was checked.
  const book = await getMyBook(id);
  if (!book) notFound();

  const aiMode = resolveAiMode();
  const [photos, forRun, activeRun, usedRebuilds, profile] = await Promise.all([
    listReviewPhotos(book.id),
    getBookForRun(book.id),
    getActiveRunForBook(book.id),
    aiMode === "live" ? countLiveRebuilds(book.id) : Promise.resolve(0),
    getMyProfile().catch(() => null),
  ]);
  const aiStatus = forRun?.ai_status ?? "idle";
  const aiAvailable = aiMode !== "off";
  // Captions preview: chapter titles/dates + caption text/source per page — no photo ids or URLs.
  const captionsPreview = captionsPreviewOf(book.doc, (layoutId) => !!getLayout(layoutId)?.caption);
  const missingCaptions = captionsPreviewModel(captionsPreview)?.missing ?? 0;
  const { generator } = docOrigin(book.doc);
  // Editor saves / user captions → review offers only "Continue in the editor" (D-037 #2).
  const userEdited = albumEditedByUser(book.doc);
  // Partial runs: the banner depends on whether the AI album was used and captions are missing.
  const banner = reviewBanner({ activeRun: !!activeRun, aiAvailable, aiStatus, generator, missingCaptions });
  const variant = rebuildVariant({ aiAvailable, aiStatus });
  // Only live runs are limited (D-021: counted from agent_runs).
  const left = aiMode === "live" ? rebuildsLeft(limitsFor(book.is_paid).maxRebuilds, usedRebuilds) : null;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  // Only what the grid needs — never AI descriptions (not loaded) or storage paths.
  const tiles: ReviewTilePhoto[] = photos.map((p) => ({
    id: p.id,
    status: p.status,
    dropReason: p.dropReason,
    userOverride: p.userOverride,
    dupGroup: p.dupGroup,
    width: p.width,
    height: p.height,
    thumbUrl: p.thumbUrl,
  }));
  const toggle = togglePhotoAction.bind(null, book.id);
  const updateAlbum = updateAlbumAction.bind(null, book.id);
  // D-028: the client compares choices with the album's photo ids (docOutOfSync in ui.ts is the
  // same rule as a boolean). Only ids go to the client, never the rest of the doc.
  const albumPhotoIds = docPhotoIds(book.doc);
  const confirm = confirmAlbumAction.bind(null, book.id);
  const captionsNote = banner ? partialCaptionsNote(banner, missingCaptions) : null;

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-6 px-4 py-6">
        <p dir="auto" className="truncate text-sm text-muted-foreground" data-testid="review-book-title">
          {book.title || "Untitled book"}
        </p>

        {banner ? (
          <div
            className={cn(
              "flex flex-col gap-2 rounded-xl border p-4 text-base",
              banner === "building" ? "border-primary/40 bg-primary/5" : "bg-muted/50",
            )}
            data-testid={`review-banner-${banner}`}
          >
            <p>{BANNER_COPY[banner]}</p>
            {captionsNote ? (
              <p className="text-sm text-muted-foreground" data-testid="review-banner-captions-note">
                {captionsNote}
              </p>
            ) : null}
            {banner === "building" ? (
              <Link
                href={`/books/${book.id}/build`}
                className={cn(buttonVariants({ variant: "default" }), "h-11 self-start px-4 text-base")}
                data-testid="review-go-build"
              >
                See progress
              </Link>
            ) : null}
          </div>
        ) : null}

        <ReviewBody
          bookId={book.id}
          photos={tiles}
          aiUsed={aiPicked(aiStatus)}
          toggle={toggle}
          updateAlbum={updateAlbum}
          albumPhotoIds={albumPhotoIds}
          userEdited={userEdited}
          building={!!activeRun}
          rebuild={activeRun ? null : { variant, rebuildsLeft: left }}
          confirm={confirm}
          captions={
            activeRun ? null : <CaptionsPreview preview={captionsPreview} captionLang={book.caption_lang} />
          }
          empty={
            <div className="flex flex-col gap-3 rounded-xl border border-dashed p-6 text-center" data-testid="review-no-photos">
              <h1 className="text-xl font-semibold">No photos yet</h1>
              <p className="text-base text-muted-foreground">Add some photos and we&apos;ll pick the best ones.</p>
              <Link
                href={`/books/${book.id}/upload`}
                className={cn(buttonVariants({ variant: "default" }), "h-11 self-center px-4 text-base")}
              >
                Add photos
              </Link>
            </div>
          }
        />
      </main>
    </>
  );
}
