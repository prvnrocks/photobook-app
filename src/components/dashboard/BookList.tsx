// The signed-in user's books as tappable cards (D-017). Each card opens the step the book is at
// (upload / build / edit) — rules in src/lib/dashboard/card-target.ts (M5 Task 12).
// Published books show their link state and a Share link to /books/[id]/publish (M6 T8).
// M9 T10: deletion chips (src/lib/dashboard/deletion-chip.ts) and a "⋯" menu with "Delete book"
// (rendered only when the page passes the deleteBook server action).
// M11 T8 (D-067): the card shows the real cover thumbnail in the book's page shape (placeholder when
// there is none or it fails to load), status chips use the app status tokens, and Share / ⋯ are a
// 44 px action column outside the card link (no nested anchors).
import { Share2 } from "lucide-react";
import Link from "next/link";
import { BookCardMenu, type DeleteBookFn } from "@/components/dashboard/BookCardMenu";
import { BookCover } from "@/components/dashboard/BookCover";
import { bookCardHref } from "@/lib/dashboard/card-target";
import { bookDeletionChip } from "@/lib/dashboard/deletion-chip";
import { bookPublishChip, bookShareHref, type PublishChip } from "@/lib/dashboard/publish-chip";
import type { BookListItem } from "@/lib/db/books";
import { cn } from "@/lib/utils";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Dubai",
});

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `Updated ${dateFormat.format(d)}`;
}

// Status tokens (globals.css): the same soft fills + borders as <Notice>, never raw palette colours.
const CHIP_TONE: Record<PublishChip["tone"] | "neutral" | "paid", string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  draft: "border-border bg-muted text-muted-foreground",
  live: "border-success-border bg-success-soft text-success",
  expired: "border-warning-border bg-warning-soft text-warning",
  paid: "border-info-border bg-info-soft text-info",
};

function Chip({ children, tone = "neutral", testId }: { children: React.ReactNode; tone?: keyof typeof CHIP_TONE; testId?: string }) {
  return (
    <span
      className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", CHIP_TONE[tone])}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

export function BookList({
  books,
  now,
  deleteBook,
  emailable = true,
}: {
  books: BookListItem[];
  now?: Date;
  deleteBook?: DeleteBookFn;
  /** Viewer gets warning emails (reminders on + has an email); null = unknown. See deletion-chip.ts. */
  emailable?: boolean | null;
}) {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4" data-testid="book-list">
      {books.map((book) => {
        const chip = bookPublishChip(book, now);
        const share = bookShareHref(book);
        const deletion = bookDeletionChip(book, now, { emailable });
        const hasActions = Boolean(share || deleteBook);
        return (
          <li
            key={book.id}
            className="flex min-w-0 items-stretch overflow-hidden rounded-2xl border border-border bg-card shadow-card transition-shadow hover:shadow-lift"
          >
            <Link
              href={bookCardHref(book)}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-4 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              data-testid="book-card"
            >
              <BookCover url={book.coverThumbUrl} format={book.format} designStyle={book.designStyle} />
              <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
                <p dir="auto" className="type-h2 line-clamp-2 break-words text-foreground">
                  {book.title || "Untitled book"}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={chip.tone} testId="book-publish-chip">
                    {chip.label}
                  </Chip>
                  {book.is_paid ? <Chip tone="paid">Paid</Chip> : null}
                  {deletion ? (
                    <Chip tone="expired" testId="book-delete-chip">
                      {deletion.label}
                    </Chip>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  <span className="whitespace-nowrap">
                    {book.page_count} {book.page_count === 1 ? "page" : "pages"}
                  </span>
                  <span aria-hidden="true"> · </span>
                  <span className="whitespace-nowrap">{formatUpdated(book.updated_at)}</span>
                </p>
              </div>
            </Link>
            {hasActions ? (
              <div className="flex w-14 shrink-0 flex-col divide-y divide-border border-s border-border">
                {share ? (
                  <Link
                    href={share}
                    className="flex min-h-11 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-primary outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    data-testid="book-share"
                  >
                    <Share2 className="size-4" aria-hidden="true" />
                    Share
                  </Link>
                ) : null}
                {deleteBook ? <BookCardMenu bookId={book.id} title={book.title} deleteBook={deleteBook} /> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
