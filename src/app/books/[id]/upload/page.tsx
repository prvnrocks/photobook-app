import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/app/PageHeader";
import { AppHeader } from "@/components/layout/AppHeader";
import { Uploader } from "@/components/upload/Uploader";
import { limitsFor } from "@/lib/ai/limits";
import { getCurrentUser } from "@/lib/auth/current-user";
import { OCCASION_LABELS, OCCASIONS, type Occasion } from "@/lib/book/options";
import { getMyBook } from "@/lib/db/books";
import { listUploadState } from "@/lib/db/photos";
import { getMyProfile } from "@/lib/db/profiles";
import type { Json } from "@/lib/supabase/database.types";
import type { ExistingPhoto } from "@/lib/upload/queue";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Add photos" };

function isOccasion(v: string | null): v is Occasion {
  return v !== null && (OCCASIONS as readonly string[]).includes(v);
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

  const [rows, profile] = await Promise.all([
    listUploadState(book.id),
    getMyProfile().catch(() => null),
  ]);
  const existing: ExistingPhoto[] = rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint,
    upload_state: r.upload_state === "ready" ? "ready" : "pending",
  }));
  const readyCount = existing.filter((r) => r.upload_state === "ready").length;
  const pendingCount = existing.length - readyCount;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  return (
    <>
      <AppHeader displayName={displayName} />
      {/* pb-0 on phones: the sticky summary bar sits flush with the screen bottom. */}
      <main className="mx-auto w-full max-w-app px-gutter pt-4 pb-0 sm:pt-6 sm:pb-6">
        <PageHeader
          className="mb-stack"
          step="photos"
          eyebrow={isOccasion(book.occasion) ? OCCASION_LABELS[book.occasion] : "Photobook"}
          eyebrowTestId="upload-occasion"
          title={book.title || "Untitled book"}
          titleTestId="upload-book-title"
          description="Add the photos for your book. We'll arrange them into a draft album you can change."
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
        />
      </main>
    </>
  );
}
