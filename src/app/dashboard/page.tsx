import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { deleteBookAction } from "@/app/books/actions";
import { Notice } from "@/components/app/Notice";
import { PageHeader } from "@/components/app/PageHeader";
import { AppHeader } from "@/components/layout/AppHeader";
import { BookList } from "@/components/dashboard/BookList";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { StartPicker } from "@/components/upload/StartPicker";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOwnEmailReminders } from "@/lib/db/account";
import { listMyBooks, type BookListItem } from "@/lib/db/books";
import { getMyProfile, type MyProfile } from "@/lib/db/profiles";

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

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fdashboard");

  const [profile, books, reminders] = await Promise.all([loadProfile(), loadBooks(), loadEmailReminders(user.id)]);
  // Drafts of owners who get no warning email are deleted without one (review S2) — the chips show it.
  const emailable = reminders === null ? null : reminders && Boolean(user.email);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;
  const count = books?.length ?? 0;

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto w-full max-w-wide px-gutter py-6 sm:py-8">
        <PageHeader
          className="mb-stack"
          eyebrow="Your library"
          title="My books"
          titleTestId="dashboard-heading"
          description={count > 0 ? `${count} ${count === 1 ? "book" : "books"}` : undefined}
          actionsInline
          actions={
            // Empty library: the EmptyState's call to action is the only "new book" button.
            // M13 T5: "New book" is the photo picker's label — picking photos starts the book.
            count > 0 || books === null ? <StartPicker variant="button" testId="new-book" /> : undefined
          }
        />
        {books === null ? (
          <Notice tone="error" data-testid="dashboard-error">
            We couldn&apos;t load your books. Please refresh.
          </Notice>
        ) : books.length === 0 ? (
          <div className="mx-auto max-w-app">
            <EmptyState />
          </div>
        ) : (
          <BookList books={books} deleteBook={deleteBookAction} emailable={emailable} />
        )}
      </main>
    </>
  );
}
