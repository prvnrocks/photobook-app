import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { deleteBookAction } from "@/app/books/actions";
import { AppHeader } from "@/components/layout/AppHeader";
import { BookList } from "@/components/dashboard/BookList";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listMyBooks, type BookListItem } from "@/lib/db/books";
import { getMyProfile, type MyProfile } from "@/lib/db/profiles";
import { cn } from "@/lib/utils";

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

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fdashboard");

  const [profile, books] = await Promise.all([loadProfile(), loadBooks()]);
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  return (
    <>
      <AppHeader displayName={displayName} />
      <main className="mx-auto w-full max-w-md px-4 py-6">
        <div className="mb-6 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold" data-testid="dashboard-heading">
            My books
          </h1>
          <Link
            href="/books/new"
            className={cn(buttonVariants(), "h-11 shrink-0 px-4")}
            data-testid="new-book"
          >
            New book
          </Link>
        </div>
        {books === null ? (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
            data-testid="dashboard-error"
          >
            We couldn&apos;t load your books. Please refresh.
          </p>
        ) : books.length === 0 ? (
          <EmptyState />
        ) : (
          <BookList books={books} deleteBook={deleteBookAction} />
        )}
      </main>
    </>
  );
}
