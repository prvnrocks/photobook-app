// The signed-in user's books as tappable cards linking to the editor.
import Link from "next/link";
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

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

export function BookList({ books }: { books: BookListItem[] }) {
  return (
    <ul className="flex flex-col gap-3" data-testid="book-list">
      {books.map((book) => (
        <li key={book.id}>
          <Link
            href={`/books/${book.id}/edit`}
            className="block min-h-11 rounded-xl border p-4 transition-colors hover:bg-muted/50"
            data-testid="book-card"
          >
            <p dir="auto" className="truncate font-medium">
              {book.title || "Untitled book"}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Chip>{book.published_at ? "Published" : "Draft"}</Chip>
              {book.is_paid ? <Chip>Paid</Chip> : null}
              <span>
                {book.page_count} {book.page_count === 1 ? "page" : "pages"}
              </span>
              <span>{formatUpdated(book.updated_at)}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
