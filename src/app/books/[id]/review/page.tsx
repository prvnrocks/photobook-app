import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmptyState } from "@/components/app/EmptyState";
import { Notice, type NoticeTone } from "@/components/app/Notice";
import { PageHeader } from "@/components/app/PageHeader";
import { AppHeader } from "@/components/layout/AppHeader";
import { CaptionsPreview } from "@/components/review/CaptionsPreview";
import { ReviewBody } from "@/components/review/ReviewBody";
import { buttonVariants } from "@/components/ui/button-variants";
import { resolveAiMode } from "@/lib/ai/client";
import { getCurrentUser } from "@/lib/auth/current-user";
import { displayBookTitle } from "@/lib/book/display-title";
import { loadReviewState } from "@/lib/books/step-data";
import { getMyBook } from "@/lib/db/books";
import { touchWarnedDraft } from "@/lib/db/draft-activity";
import { getMyProfile } from "@/lib/db/profiles";
import { BANNER_COPY, type ReviewBanner } from "@/lib/review/ui";
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

  // Photos, ai_status, active run, rebuild count and everything derived from them — shared with
  // the wizard's step 7 (src/lib/books/step-data.ts). Tiles carry only what the grid needs — never
  // AI descriptions (not loaded) or storage paths; the album goes to the client as photo ids only
  // (D-028), the captions as a text-only preview.
  const [review, profile] = await Promise.all([
    loadReviewState(book, resolveAiMode()),
    getMyProfile().catch(() => null),
  ]);
  const {
    tiles,
    activeRun,
    aiUsed,
    userEdited,
    albumPhotoIds,
    captionsPreview,
    banner,
    captionsNote,
    variant,
    rebuildsLeft: left,
  } = review;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  const toggle = togglePhotoAction.bind(null, book.id);
  const updateAlbum = updateAlbumAction.bind(null, book.id);
  const confirm = confirmAlbumAction.bind(null, book.id);

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto flex w-full max-w-app min-w-0 flex-col gap-stack px-gutter pt-6 sm:pb-10">
        <PageHeader
          step="review"
          title="Review your photos"
          description={
            <span dir="auto" className="block truncate" data-testid="review-book-title">
              {displayBookTitle(book.title, book.doc)}
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
          aiUsed={aiUsed}
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
