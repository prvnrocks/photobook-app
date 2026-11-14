// The signed-in user's books as a collection grid (D-017; M18 redesign). Server component: renders
// one <BookCard> per book (cover, title, status, quick actions) and hands them, with a small record
// per book, to the <BookLibrary> client island (filter tabs, search, sort).
// Card rules kept from earlier milestones:
// - each card opens the step the book is at (src/lib/dashboard/card-target.ts, M5 T12);
// - published books get Share → /books/[id]/publish (M6 T8); built drafts get Share as the publish
//   entry (D-070); free books Upgrade (payments on), paid books PDF;
// - deletion chips (src/lib/dashboard/deletion-chip.ts) and the "Options" menu with "Delete book"
//   (only when the page passes the deleteBook server action, M9 T10);
// - real cover thumbnails in the book's page shape with a styled placeholder (M11 T8, D-067).
import { BookCard } from "@/components/dashboard/BookCard";
import type { DeleteBookFn } from "@/components/dashboard/BookCardMenu";
import { BookLibrary, type LibraryItem } from "@/components/dashboard/BookLibrary";
import { displayBookTitle } from "@/lib/book/display-title";
import { bookCardHref } from "@/lib/dashboard/card-target";
import { bookDeletionChip } from "@/lib/dashboard/deletion-chip";
import { DEFAULT_LIBRARY_QUERY, type LibraryQuery } from "@/lib/dashboard/library";
import { libraryChip, quickActions } from "@/lib/dashboard/library-cards";
import type { BookListItem } from "@/lib/db/books";

export function BookList({
  books,
  now,
  deleteBook,
  emailable = true,
  paymentsEnabled = false,
  initialQuery = DEFAULT_LIBRARY_QUERY,
}: {
  books: BookListItem[];
  now?: Date;
  deleteBook?: DeleteBookFn;
  /** Viewer gets warning emails (reminders on + has an email); null = unknown. See deletion-chip.ts. */
  emailable?: boolean | null;
  /** Show "Upgrade" on free books (Stripe configured on this deploy). */
  paymentsEnabled?: boolean;
  /** From ?filter=&q=&sort= (parseLibraryQuery). */
  initialQuery?: LibraryQuery;
}) {
  const at = now ?? new Date();
  const items: LibraryItem[] = books.map((book) => {
    const title = book.displayTitle ?? displayBookTitle(book.title);
    const chip = libraryChip(book, at);
    return {
      id: book.id,
      title,
      status: chip.status,
      paid: book.is_paid,
      pages: book.page_count,
      updatedAt: book.updated_at,
      card: (
        <BookCard
          book={book}
          title={title}
          href={bookCardHref(book)}
          chip={chip}
          deletion={bookDeletionChip(book, at, { emailable })}
          actions={quickActions(book, { paymentsEnabled })}
          deleteBook={deleteBook}
        />
      ),
    };
  });
  return <BookLibrary items={items} initialQuery={initialQuery} />;
}
