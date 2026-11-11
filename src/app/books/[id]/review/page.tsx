import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmptyState } from "@/components/app/EmptyState";
import { Notice, type NoticeTone } from "@/components/app/Notice";
import { PageHeader } from "@/components/app/PageHeader";
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
import { touchWarnedDraft } from "@/lib/db/draft-activity";
import { listReviewPhotos } from "@/lib/db/photos";
import { getMyProfile } from "@/lib/db/profiles";
import { hasCaptionArea } from "@/lib/layouts";
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
  type ReviewBanner,
  type ReviewTilePhoto,
} from "@/lib/review/ui";
import { confirmAlbumAction, togglePhotoAction, updateAlbumAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Review your photos" };

/** Simple-rules fallbacks are worth a look (warn); the rest is information. */
const BANNER_TONE: Record<Exclude<ReviewBanner, null>, NoticeTone> = {
  building: "info",
  ai_off: "info",
  partial: "warn",
  captions_missing: "info",
  failed: "warn",
};

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/books/${id}/review`)}`);

  // Ownership under RLS first; the admin-client helpers below assume it was checked.
  const book = await getMyBook(id);
  if (!book) notFound();
  // Owner opened a warned draft: counts as activity (review S3). Never throws.
  await touchWarnedDraft(book.id, user.id);

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
  const captionsPreview = captionsPreviewOf(book.doc, hasCaptionArea);
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
      <main className="mx-auto flex w-full max-w-app min-w-0 flex-col gap-stack px-gutter pt-6 sm:pb-10">
        <PageHeader
          step="review"
          title="Review your photos"
          description={
            <span className="block truncate" data-testid="review-book-title">
              {book.title || "Untitled book"}
            </span>
          }
        />

        {banner ? (
          <Notice
            tone={BANNER_TONE[banner]}
            data-testid={`review-banner-${banner}`}
            title={BANNER_COPY[banner]}
            action={
              banner === "building" ? (
                <Link
                  href={`/books/${book.id}/build`}
                  className={buttonVariants({ variant: "default", size: "touch" })}
                  data-testid="review-go-build"
                >
                  See progress
                </Link>
              ) : null
            }
          >
            {captionsNote ? <span data-testid="review-banner-captions-note">{captionsNote}</span> : null}
          </Notice>
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
            <EmptyState
              data-testid="review-no-photos"
              title="No photos yet"
              description="Add some photos and we'll pick the best ones."
              action={
                <Link href={`/books/${book.id}/upload`} className={buttonVariants({ variant: "default", size: "cta" })}>
                  Add photos
                </Link>
              }
            />
          }
        />
      </main>
    </>
  );
}
