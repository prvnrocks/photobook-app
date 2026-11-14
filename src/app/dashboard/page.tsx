import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { deleteBookAction } from "@/app/books/actions";
import { Notice } from "@/components/app/Notice";
import { AppHeader } from "@/components/layout/AppHeader";
import { BookList } from "@/components/dashboard/BookList";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { LibraryHeader } from "@/components/dashboard/LibraryHeader";
import { LIBRARY_CONTAINER } from "@/components/dashboard/library-classes";
import { buttonVariants } from "@/components/ui/button-variants";
import { getCurrentUser } from "@/lib/auth/current-user";
import { libraryCounts, librarySummary, parseLibraryQuery } from "@/lib/dashboard/library";
import { libraryChip } from "@/lib/dashboard/library-cards";
import { getOwnEmailReminders } from "@/lib/db/account";
import { listMyBooks, type BookListItem } from "@/lib/db/books";
import { getMyProfile, type MyProfile } from "@/lib/db/profiles";
import { isPaymentsEnabled } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "My books" };

async function loadBooks(): Promise<BookListItem[] | null> {
  try {
    return await listMyBooks();
  } catch {
    return null;
  }
}

async function loadProfile(): Promise<MyProfile | null> {
  try {
    return await getMyProfile();
  } catch {
    return null;
  }
}

/** null when the setting couldn't be loaded (the chips then use the no-email rule — never a later date). */
async function loadEmailReminders(userId: string): Promise<boolean | null> {
  try {
    return await getOwnEmailReminders(userId);
  } catch {
    return null;
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fdashboard");

  const [profile, books, reminders, params] = await Promise.all([
    loadProfile(),
    loadBooks(),
    loadEmailReminders(user.id),
    searchParams,
  ]);
  // Drafts of owners who get no warning email are deleted without one (review S2) — the chips show it.
  const emailable = reminders === null ? null : reminders && Boolean(user.email);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;
  const count = books?.length ?? 0;
  // One clock for every chip on the page (server render and hydration agree on "N days left").
  const now = new Date();
  const summary =
    books && count > 0
      ? librarySummary(libraryCounts(books.map((b) => ({ status: libraryChip(b, now).status, paid: b.is_paid }))))
      : books
        ? "Your photobooks will live here"
        : undefined;

  return (
    <>
      <AppHeader displayName={displayName} width="library" />
      <main className="pb-16">
        <LibraryHeader
          summary={summary}
          action={
            // Empty library: the EmptyState's call to action is the only "new book" button (and the one
            // gold CTA). M19 (D-071): "New book" opens the creation wizard.
            count > 0 || books === null ? (
              <Link href="/books/new" className={buttonVariants({ variant: "accent", size: "touch" })} data-testid="new-book">
                <Plus aria-hidden="true" data-icon="inline-start" />
                New book
              </Link>
            ) : undefined
          }
        />
        <div className={`${LIBRARY_CONTAINER} pt-6 sm:pt-8`}>
          {books === null ? (
            <Notice tone="error" data-testid="dashboard-error">
              We couldn&apos;t load your books. Please refresh.
            </Notice>
          ) : books.length === 0 ? (
            <EmptyState />
          ) : (
            <BookList
              books={books}
              now={now}
              deleteBook={deleteBookAction}
              emailable={emailable}
              paymentsEnabled={isPaymentsEnabled()}
              initialQuery={parseLibraryQuery(params)}
            />
          )}
        </div>
      </main>
    </>
  );
}
