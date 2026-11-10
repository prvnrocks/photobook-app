// The signed-in user's books as tappable cards (D-017). Each card opens the step the book is at
// (upload / build / review / edit) — rules in src/lib/dashboard/card-target.ts (M5 Task 12).
// Published books show their link state and a Share link to /books/[id]/publish (M6 T8).
import { Share2 } from "lucide-react";
import Link from "next/link";
import { bookCardHref } from "@/lib/dashboard/card-target";
import { bookPublishChip, bookShareHref, type PublishChip } from "@/lib/dashboard/publish-chip";
import type { BookListItem } from "@/lib/db/books";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Dubai",
});

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `Updated ${dateFormat.format(d)}`;
}

const CHIP_TONE: Record<PublishChip["tone"] | "neutral", string> = {
  neutral: "bg-muted text-muted-foreground",
  draft: "bg-muted text-muted-foreground",
  live: "bg-emerald-50 text-emerald-800",
  expired: "bg-amber-50 text-amber-900",
};

function Chip({ children, tone = "neutral", testId }: { children: React.ReactNode; tone?: keyof typeof CHIP_TONE; testId?: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_TONE[tone]}`} data-testid={testId}>
      {children}
    </span>
  );
}

export function BookList({ books, now }: { books: BookListItem[]; now?: Date }) {
  return (
    <ul className="flex flex-col gap-3" data-testid="book-list">
      {books.map((book) => {
        const chip = bookPublishChip(book, now);
        const share = bookShareHref(book);
        return (
          <li key={book.id} className="flex items-stretch rounded-xl border transition-colors hover:bg-muted/50">
            <Link href={bookCardHref(book)} className="block min-h-11 min-w-0 flex-1 p-4" data-testid="book-card">
              <p dir="auto" className="truncate font-medium">
                {book.title || "Untitled book"}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Chip tone={chip.tone} testId="book-publish-chip">
                  {chip.label}
                </Chip>
                {book.is_paid ? <Chip>Paid</Chip> : null}
                <span>
                  {book.page_count} {book.page_count === 1 ? "page" : "pages"}
                </span>
                <span>{formatUpdated(book.updated_at)}</span>
              </div>
            </Link>
            {share ? (
              <Link
                href={share}
                className="flex min-h-11 shrink-0 flex-col items-center justify-center gap-1 border-l px-4 text-xs font-medium text-primary"
                data-testid="book-share"
              >
                <Share2 className="size-4" aria-hidden="true" />
                Share
              </Link>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
