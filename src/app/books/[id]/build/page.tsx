import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { BuildProgress } from "@/components/review/BuildProgress";
import { limitsFor } from "@/lib/ai/limits";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getActiveRunForBook } from "@/lib/db/agent-runs";
import { getMyBook } from "@/lib/db/books";
import { getMyProfile } from "@/lib/db/profiles";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Building your album" };

// Progress screen for an AI build (D-022): resumes the book's active run, else starts one.
// `?trigger=rebuild` starts a rebuild instead of a build (used by "Try AI again").
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

  const [active, profile] = await Promise.all([
    // On a read error the POST answers 409 already_running + runId, so starting is still safe.
    getActiveRunForBook(book.id).catch(() => null),
    getMyProfile().catch(() => null),
  ]);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;
  const trigger = query.trigger === "rebuild" ? "rebuild" : "build";

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto w-full max-w-md px-4 py-6">
        <h1 className="text-2xl font-semibold">Building your album</h1>
        <p
          dir="auto"
          className="mt-1 text-base text-muted-foreground break-words"
          data-testid="build-book-title"
        >
          {book.title || "Untitled book"}
        </p>
        <div className="mt-6">
          <BuildProgress
            bookId={book.id}
            activeRunId={active?.id ?? null}
            trigger={trigger}
            isPaid={book.is_paid}
            dailyCap={limitsFor(book.is_paid).maxLiveBuildsPerUserPerDay}
          />
        </div>
      </main>
    </>
  );
}
