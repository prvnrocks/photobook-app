import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { AppHeader } from "@/components/layout/AppHeader";
import { BuildDraftPreview } from "@/components/review/BuildDraftPreview";
import { BuildProgress } from "@/components/review/BuildProgress";
import { resolveAiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { getCurrentUser } from "@/lib/auth/current-user";
import { displayBookTitle } from "@/lib/book/display-title";
import { detailsLockReason } from "@/lib/book/setup";
import { getActiveRunForBook, hasAnyRunForBook } from "@/lib/db/agent-runs";
import { getMyBook } from "@/lib/db/books";
import { listReviewPhotos } from "@/lib/db/photos";
import { getMyProfile } from "@/lib/db/profiles";
import { draftDoc } from "@/lib/books/step-data";
import { albumConfirmedOf, buildEntryRedirect } from "@/lib/books/wizard-routes";
import { albumEditedByUser } from "@/lib/review/ui";
import { draftPreviewItems, draftPreviewPhotoIds, draftPreviewPhotos } from "@/lib/runs/draft-preview";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Making your book" };

// Progress screen for an AI build (D-022): resumes the book's active run, else starts one.
// `?trigger=rebuild` starts a rebuild instead of a build (used by "Try AI again").
// `?auto=1` (M13 T4): the upload screen started the automatic first build → ai_build_done { auto }.
// M13 T7 (D-070 (3)): the draft book (books.doc, the rule album) shows read-only while the run
// works; when it finishes the screen goes straight to the editor.
// M20 T9 (D-072): the first AI build of a fresh book runs inside the wizard — this page redirects it
// to /books/new?book=<id>&step=6 (&auto=1 kept), and a finished ?auto=1 run to step 7 (Review) when
// the wizard gate says so (else the editor, as before). Rebuilds (?trigger=rebuild, "Try AI again"),
// a running rebuild and edited / AI-made albums keep the classic screen below — the wizard's gate
// sends only a running rebuild here ("classic"), so the two never loop (buildEntryRedirect).
// M20b: AI off is no longer classic — a fresh book's first (rule) build also runs in the wizard.

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

  const trigger = query.trigger === "rebuild" ? "rebuild" : "build";
  const auto = query.auto === "1";
  const aiOn = resolveAiMode() !== "off";
  const [activeRead, runExists, profile] = await Promise.all([
    // A read error is not "no run": keep it apart so ?auto=1 never strands a queued run.
    getActiveRunForBook(book.id).then(
      (run) => ({ ok: true as const, run }),
      () => ({ ok: false as const, run: null }),
    ),
    // Only the wizard gate needs it (a rebuild never enters the wizard). null = read error.
    trigger === "build" ? hasAnyRunForBook(book.id).catch(() => null) : Promise.resolve(null),
    getMyProfile().catch(() => null),
  ]);
  const active = activeRead.run;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  // The automatic run already finished (fast replay / rule run, or a reload after it ended): never
  // start a manual build from an auto link — wizard Review or the editor. Only on a confirmed "no
  // active run": after a read error BuildProgress POSTs, and the server answers 409
  // already_running + runId for a run that is still queued (or starts one when none is).
  const entry = buildEntryRedirect({
    bookId: book.id,
    trigger,
    auto,
    aiOn,
    doc: book.doc,
    detailsLock: detailsLockReason({ hasRun: runExists === true || active !== null, doc: book.doc }),
    userEdited: albumEditedByUser(book.doc),
    activeReadOk: activeRead.ok,
    active: active ? { trigger: active.trigger === "rebuild" ? "rebuild" : "build" } : null,
    runExists,
    albumConfirmed: albumConfirmedOf(book.album_confirmed_at),
  });
  if (entry.kind === "editor") redirect(`/books/${book.id}/edit`);
  if (entry.kind === "wizard") redirect(entry.href);

  const progressProps = {
    bookId: book.id,
    activeRunId: active?.id ?? null,
    trigger,
    isPaid: book.is_paid,
    dailyCap: limitsFor(book.is_paid).maxLiveBuildsPerUserPerDay,
    auto,
    aiOn,
  } as const;

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
