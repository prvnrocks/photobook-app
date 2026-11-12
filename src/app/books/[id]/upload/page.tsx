import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/app/PageHeader";
import { AppHeader } from "@/components/layout/AppHeader";
import { Uploader } from "@/components/upload/Uploader";
import { limitsFor } from "@/lib/ai/limits";
import { getCurrentUser } from "@/lib/auth/current-user";
import { bookDesignOf } from "@/lib/book/book-design";
import { displayBookTitle } from "@/lib/book/display-title";
import {
  CAPTION_LANGS,
  DEFAULT_TONE,
  OCCASION_LABELS,
  OCCASIONS,
  TONES,
  type CaptionLang,
  type Occasion,
  type Tone,
} from "@/lib/book/options";
import { designLockReason, detailsLockReason, type BookSetup } from "@/lib/book/setup";
import { getActiveRunForBook } from "@/lib/db/agent-runs";
import { bookHasAnyRun, getMyBook } from "@/lib/db/books";
import { listUploadState } from "@/lib/db/photos";
import { getMyProfile } from "@/lib/db/profiles";
import type { Json } from "@/lib/supabase/database.types";
import type { FirstRunState } from "@/lib/upload/auto-build-client";
import type { ExistingPhoto } from "@/lib/upload/queue";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Add photos" };

function isOccasion(v: string | null): v is Occasion {
  return v !== null && (OCCASIONS as readonly string[]).includes(v);
}

function pick<T extends string>(v: string | null, values: readonly T[], fallback: T): T {
  return (values as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
}

function docHasContent(doc: Json | null): boolean {
  return doc !== null && typeof doc === "object" && !Array.isArray(doc) && Object.keys(doc).length > 0;
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
    bookHasAnyRun(book.id).catch(() => false),
    getActiveRunForBook(book.id).catch(() => null),
  ]);
  const existing: ExistingPhoto[] = rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint,
    upload_state: r.upload_state === "ready" ? "ready" : "pending",
  }));
  const readyCount = existing.filter((r) => r.upload_state === "ready").length;
  const pendingCount = existing.length - readyCount;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  // M13 T6 setup card (D-070): the stored setup + which parts can still change.
  const occasion = pick<Occasion>(book.occasion, OCCASIONS, "other");
  const design = bookDesignOf(book);
  const setup: BookSetup = {
    occasion,
    tone: pick<Tone>(book.tone, TONES, DEFAULT_TONE[occasion]),
    captionLang: pick<CaptionLang>(book.caption_lang, CAPTION_LANGS, "en"),
    title: book.title,
    format: design.format,
    designStyle: design.designStyle,
  };
  const locks = {
    details: detailsLockReason({ hasRun }),
    design: designLockReason({ hasRun, doc: book.doc }),
  };
  const firstRun: FirstRunState = active ? "active" : hasRun ? "done" : "none";

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
          title={displayBookTitle(book.title, book.doc)}
          titleTestId="upload-book-title"
          description={
            firstRun === "none"
              ? "Add your photos. We'll start your book as soon as they're in — change anything later."
              : "Add more photos to your book."
          }
        />
        <Uploader
          bookId={book.id}
          userId={user.id}
          isPaid={book.is_paid}
          existing={existing}
          maxUpload={limitsFor(book.is_paid).maxUploadPhotos}
          readyCount={readyCount}
          pendingCount={pendingCount}
          hasDoc={docHasContent(book.doc)}
          setup={setup}
          locks={locks}
          firstRun={firstRun}
          dailyCap={limitsFor(book.is_paid).maxLiveBuildsPerUserPerDay}
        />
      </main>
    </>
  );
}
