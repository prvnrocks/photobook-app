import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { UpgradeStatusPoller } from "@/components/upgrade/UpgradeStatusPoller";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getPublishRow } from "@/lib/db/publish";
import { isUuid } from "@/lib/uuid";
import { getUpgradeStatus } from "../actions";

// Stripe Checkout return page (M7 T7). The `session_id` query param Stripe appends is ignored on
// purpose: only the webhook sets books.is_paid, and this page shows success only once the live
// is_paid (read here or via getUpgradeStatus polling) is true.

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Upgrade", robots: { index: false, follow: false } };

export default async function UpgradeSuccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const loginNext = `/login?next=${encodeURIComponent(`/books/${rawId}/upgrade/success`)}`;
  const user = await getCurrentUser();
  if (!user) redirect(loginNext);
  if (!isUuid(rawId)) notFound();
  const id = rawId.toLowerCase();

  // Owner-scoped (id AND user_id): someone else's / unknown book → null → 404.
  let row: Awaited<ReturnType<typeof getPublishRow>>;
  try {
    row = await getPublishRow(id, user.id.toLowerCase());
  } catch {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-10" data-testid="upgrade-load-error">
        <h1 className="text-2xl font-semibold">We couldn&apos;t load this page</h1>
        <p className="text-base text-muted-foreground">Please check your connection and try again.</p>
        <Link href={`/books/${id}/upgrade/success`} className="min-h-11 font-medium underline underline-offset-4">
          Try again
        </Link>
      </main>
    );
  }
  if (!row) notFound();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-3">
      <header className="flex items-center gap-1">
        <Link
          href={`/books/${id}/publish`}
          className="-ml-2 flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium hover:bg-muted"
          data-testid="upgrade-back"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </Link>
      </header>
      <UpgradeStatusPoller
        bookId={id}
        initialPaid={row.is_paid === true}
        liveSlug={row.live && row.slug ? row.slug : null}
        check={getUpgradeStatus.bind(null, id)}
      />
    </main>
  );
}
