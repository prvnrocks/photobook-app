import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { AppHeader } from "@/components/layout/AppHeader";
import { Uploader, type UploaderProps } from "@/components/upload/Uploader";
import { WIZARD_BACK_CLASS } from "@/components/wizard/WizardNav";
import { WizardHeadline, WizardShell } from "@/components/wizard/WizardShell";
import { resolveAiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { getCurrentUser } from "@/lib/auth/current-user";
import { displayBookTitle } from "@/lib/book/display-title";
import { OCCASION_LABELS, OCCASIONS, type Occasion } from "@/lib/book/options";
import { detailsLockReason } from "@/lib/book/setup";
import { docHasContent, uploadExisting } from "@/lib/books/step-data";
import { isWizardUpload, wizardBackHref } from "@/lib/books/wizard-routes";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import { getActiveRunForBook, hasAnyRunForBook } from "@/lib/db/agent-runs";
import { getMyBook } from "@/lib/db/books";
import { listUploadState } from "@/lib/db/photos";
import { getMyProfile } from "@/lib/db/profiles";
import type { FirstRunState } from "@/lib/upload/auto-build-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Add photos" };

function isOccasion(v: string | null): v is Occasion {
  return v !== null && (OCCASIONS as readonly string[]).includes(v);
}

export default async function UploadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/books/${id}/upload`)}`);

  const book = await getMyBook(id);
  if (!book) notFound();

  const [rows, profile, hasRun, active] = await Promise.all([
    listUploadState(book.id),
    getMyProfile().catch(() => null),
    // Unknown (read error) → treated as "no run": the server still decides (auto start → not_first).
    hasAnyRunForBook(book.id).catch(() => false),
    getActiveRunForBook(book.id).catch(() => null),
  ]);
  const { existing, readyCount, pendingCount } = uploadExisting(rows);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  const firstRun: FirstRunState = active ? "active" : hasRun ? "done" : "none";
  const wizard = isWizardUpload(firstRun, detailsLockReason({ hasRun, doc: book.doc }));
  const title = displayBookTitle(book.title, book.doc);

  const uploaderProps: UploaderProps = {
    bookId: book.id,
    userId: user.id,
    isPaid: book.is_paid,
    existing,
    maxUpload: limitsFor(book.is_paid).maxUploadPhotos,
    readyCount,
    pendingCount,
    hasDoc: docHasContent(book.doc),
    firstRun,
    dailyCap: limitsFor(book.is_paid).maxLiveBuildsPerUserPerDay,
    aiOn: resolveAiMode() !== "off",
  };

  if (wizard) {
    // Server-rendered Back (lesson: no next/link inside the client island).
    const back: ReactNode = (
      <Link href={wizardBackHref(book.id)} className={WIZARD_BACK_CLASS} data-testid="wizard-back">
        Back
      </Link>
    );
    return (
      <WizardShell step={5} displayName={displayName}>
        <WizardHeadline>{wizardHeadline(5)}</WizardHeadline>
        <p className="mt-2 text-center type-small text-muted-foreground">
          <span dir="auto" className="break-words" data-testid="upload-book-title">
            {title}
          </span>
        </p>
        <div className="mt-6 flex min-w-0 flex-col">
          <Uploader {...uploaderProps} variant="wizard" back={back} />
        </div>
      </WizardShell>
    );
  }

  return (
    <>
      <AppHeader displayName={displayName} />
      {/* pb-0 on phones: the sticky summary bar sits flush with the screen bottom. */}
      <main className="mx-auto w-full max-w-app px-gutter pt-4 pb-0 sm:pt-6 sm:pb-6">
        <PageHeader
          className="mb-stack"
          step="photos"
          eyebrow={isOccasion(book.occasion) && book.occasion !== "other" ? OCCASION_LABELS[book.occasion] : "Photobook"}
          eyebrowTestId="upload-occasion"
          title={title}
          titleTestId="upload-book-title"
          description={
            firstRun === "none"
              ? "Add your photos. We'll start your book as soon as they're in — change anything later."
              : "Add more photos to your book."
          }
        />
        <Uploader {...uploaderProps} />
      </main>
    </>
  );
}
