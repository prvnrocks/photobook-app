import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { AppHeader } from "@/components/layout/AppHeader";
import { BuildDraftPreview } from "@/components/review/BuildDraftPreview";
import { BuildProgress } from "@/components/review/BuildProgress";
import { PhotoFan } from "@/components/review/PhotoFan";
import { WizardHeadline, WizardShell } from "@/components/wizard/WizardShell";
import { resolveAiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { getCurrentUser } from "@/lib/auth/current-user";
import { displayBookTitle } from "@/lib/book/display-title";
import { getActiveRunForBook } from "@/lib/db/agent-runs";
import { getMyBook } from "@/lib/db/books";
import { listReviewPhotos } from "@/lib/db/photos";
import { getMyProfile } from "@/lib/db/profiles";
import { draftDoc, loadFanUrls } from "@/lib/books/step-data";
import { isWizardBuild } from "@/lib/books/wizard-routes";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import { draftPreviewItems, draftPreviewPhotoIds, draftPreviewPhotos } from "@/lib/runs/draft-preview";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Making your book" };

// Progress screen for an AI build (D-022): resumes the book's active run, else starts one.
// `?trigger=rebuild` starts a rebuild instead of a build (used by "Try AI again").
// `?auto=1` (M13 T4): the upload screen started the automatic first build → ai_build_done { auto }.
// M13 T7 (D-070 (3)): the draft book (books.doc, the rule album) shows read-only while the run
// works; when it finishes the screen goes straight to the editor.
// M19 T7 (D-071): the first AI build wears the creation wizard chrome (step 6 "Sorting your
// photos": photo fan from the draft's signed thumbs + three-row checklist). Rebuilds, AI off and
// edited / AI-made albums keep the classic screen below.

export default async function BuildPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/books/${id}/build`)}`);

  const book = await getMyBook(id);
  if (!book) notFound();

  const [activeRead, profile] = await Promise.all([
    // A read error is not "no run": keep it apart so ?auto=1 never strands a queued run.
    getActiveRunForBook(book.id).then(
      (run) => ({ ok: true as const, run }),
      () => ({ ok: false as const, run: null }),
    ),
    getMyProfile().catch(() => null),
  ]);
  const active = activeRead.run;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;
  const trigger = query.trigger === "rebuild" ? "rebuild" : "build";
  const auto = query.auto === "1";
  // The automatic run already finished (fast replay / rule run, or a reload after it ended):
  // never start a manual build from an auto link — open the album instead. Only on a confirmed
  // "no active run": after a read error BuildProgress POSTs, and the server answers
  // 409 already_running + runId for a run that is still queued (or starts one when none is).
  if (auto && activeRead.ok && !active) redirect(`/books/${book.id}/edit`);

  const aiOn = resolveAiMode() !== "off";
  const progressProps = {
    bookId: book.id,
    activeRunId: active?.id ?? null,
    trigger,
    isPaid: book.is_paid,
    dailyCap: limitsFor(book.is_paid).maxLiveBuildsPerUserPerDay,
    auto,
    aiOn,
  } as const;

  if (isWizardBuild({ trigger, aiOn, doc: book.doc })) {
    // Fan: the draft's first photos (cover first), shared with the wizard's step 6 data.
    const urls = await loadFanUrls(book.id, draftDoc(book.doc));
    return (
      <WizardShell step={6} displayName={displayName}>
        <WizardHeadline>{wizardHeadline(6)}</WizardHeadline>
        <div className="mt-4 flex min-w-0 flex-col">
          <BuildProgress {...progressProps} variant="wizard" preview={<PhotoFan urls={urls} />} />
        </div>
      </WizardShell>
    );
  }

  // Draft preview: cover + first pages, 512 px thumbs signed for exactly those photos (only their
  // ids are loaded and signed). A read error only drops the preview (the checklist still shows).
  const doc = draftDoc(book.doc);
  let preview: ReactNode = null;
  if (doc) {
    const items = draftPreviewItems(doc);
    const wanted = draftPreviewPhotoIds(doc, items);
    const photos = await listReviewPhotos(book.id, wanted).catch(() => null);
    if (photos) {
      preview = (
        <BuildDraftPreview
          doc={doc}
          items={items}
          photos={draftPreviewPhotos(wanted, photos)}
          captionLang={book.caption_lang}
        />
      );
    }
  }
  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto flex w-full max-w-app min-w-0 flex-col gap-stack px-gutter py-6 sm:py-10">
        <PageHeader
          step="build"
          title="Making your book"
          description={
            <span dir="auto" className="break-words" data-testid="build-book-title">
              {displayBookTitle(book.title, book.doc)}
            </span>
          }
        />
        <BuildProgress {...progressProps} preview={preview} />
      </main>
    </>
  );
}
