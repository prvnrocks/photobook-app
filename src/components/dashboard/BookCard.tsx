// One book in the "My books" collection grid (M18), rendered on the server. The book is shown as a
// real hard cover on an ivory stage; below it the title (dir="auto"), a meta line and the update date.
//
// - The whole card opens the book: the title link (data-testid="book-card", href from card-target)
//   is stretched over the card with ::after. Quick actions sit above it (z-index), so there are no
//   nested anchors.
// - Quick actions (Open / Share / Upgrade or PDF / Options): on a mouse/trackpad ≥ 640 px they slide
//   up over the lower part of the cover on hover or keyboard focus (and stay while the Options menu is
//   open); on touch and phones they are an always-visible row at the foot of the card. One set of
//   elements, two CSS placements (hover-pane / touch-row variants in globals.css), so testids are unique.
// - Status chips sit on the cover stage's top corners; the deletion notice (M9) under the meta line.
// No cn() / buttonVariants: plain class strings (lesson 2026-11-14).

import { BookOpen, Crown, FileDown, Send, Share2, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { BookCardMenu, type DeleteBookFn } from "@/components/dashboard/BookCardMenu";
import { BookCover } from "@/components/dashboard/BookCover";
import { LIBRARY_STAGE } from "@/components/dashboard/library-classes";
import { DESIGN_STYLE_LABELS, FORMAT_SHORT_LABELS } from "@/lib/design/defaults";
import type { DeletionChip } from "@/lib/dashboard/deletion-chip";
import type { LibraryChip, QuickAction, QuickActionKind } from "@/lib/dashboard/library-cards";
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

// Status tokens (globals.css), never raw palette colours. Chips sit on the light cover stage.
const CHIP = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium shadow-card";
const CHIP_TONE: Record<LibraryChip["status"], string> = {
  draft: "border-border bg-card text-muted-foreground",
  live: "border-success-border bg-success-soft text-success",
  expired: "border-warning-border bg-warning-soft text-warning",
};
const DOT_TONE: Record<LibraryChip["status"], string> = {
  draft: "bg-input",
  live: "bg-success",
  expired: "bg-warning",
};
// Paid: gold on deep emerald (5.16:1), the brand's "foil" mark.
const PAID_CHIP = `${CHIP} border-primary bg-primary text-accent-strong`;

const ICON: Record<QuickActionKind, LucideIcon> = {
  open: BookOpen,
  share: Share2,
  publish: Send,
  upgrade: Crown,
  pdf: FileDown,
};

const TESTID: Record<QuickActionKind, string> = {
  open: "book-open",
  share: "book-share",
  // A draft's "Share" is the publish entry (D-070), not a live link — its own testid.
  publish: "book-publish",
  upgrade: "book-upgrade",
  pdf: "book-pdf",
};

/** One quick action: icon over a short label, ≥ 44 px, inset focus ring (colour added per action). */
const ACTION =
  "relative flex min-h-11 min-w-11 flex-1 basis-0 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[0.6875rem] leading-none font-medium outline-none transition-colors hover:bg-secondary focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-secondary hover-pane:min-h-14 hover-pane:gap-1 hover-pane:text-xs";
// Upgrade in antique gold (6.4:1 on white) — a gold accent, not a second gold button.
const ACTION_TONE: Record<QuickActionKind, string> = {
  open: "text-primary",
  share: "text-primary",
  publish: "text-primary",
  upgrade: "text-accent-text",
  pdf: "text-primary",
};

// Touch: a row at the foot of the card. Hover pane: a frosted bar over the lower cover, hidden until
// the card is hovered or holds focus (or its Options menu is open).
const ACTIONS_BAR = [
  "relative z-[2] col-start-1 row-start-3 flex divide-x divide-border overflow-hidden border-t border-border rtl:divide-x-reverse",
  "hover-pane:row-start-1 hover-pane:mx-2.5 hover-pane:mb-2.5 hover-pane:self-end hover-pane:rounded-xl hover-pane:border hover-pane:border-white/70 hover-pane:bg-card/95 hover-pane:shadow-lift hover-pane:backdrop-blur-sm",
  // Still clickable while transparent: the pointer is then over the card, which reveals it anyway.
  "hover-pane:translate-y-3 hover-pane:opacity-0",
  "group-hover/card:translate-y-0 group-hover/card:opacity-100",
  "group-focus-within/card:translate-y-0 group-focus-within/card:opacity-100",
  "group-has-[[data-popup-open]]/card:translate-y-0 group-has-[[data-popup-open]]/card:opacity-100",
  "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out",
].join(" ");

export function BookCard({
  book,
  title,
  href,
  chip,
  deletion,
  actions,
  deleteBook,
}: {
  book: BookListItem;
  /** displayTitle ?? displayBookTitle(title). */
  title: string;
  /** card-target href (the book's current step). */
  href: string;
  chip: LibraryChip;
  deletion: DeletionChip | null;
  actions: QuickAction[];
  deleteBook?: DeleteBookFn;
}) {
  const pages = `${book.page_count} ${book.page_count === 1 ? "page" : "pages"}`;
  const meta = [pages, FORMAT_SHORT_LABELS[book.format], DESIGN_STYLE_LABELS[book.designStyle]].filter(Boolean);
  const updated = formatUpdated(book.updated_at);
  // Touch row fits three: Open hides there when Share + Upgrade/PDF + Options are all present
  // (tapping the card opens the book anyway).
  const hideOpenOnTouch = actions.length + (deleteBook ? 1 : 0) > 3;

  return (
    <article
      className="group/card relative grid h-full grid-cols-1 grid-rows-[auto_1fr_auto] overflow-hidden rounded-2xl bg-card shadow-card ring-1 ring-border transition-[box-shadow,translate] duration-300 ease-out hover:shadow-lift hover:ring-accent-strong/50 focus-within:shadow-lift focus-within:ring-accent-strong/50 motion-safe:hover:-translate-y-1 motion-safe:focus-within:-translate-y-1"
      data-status={chip.status}
      data-paid={book.is_paid ? "true" : undefined}
    >
      {/* Cover stage */}
      <div className={`relative col-start-1 row-start-1 flex aspect-[4/5] items-center justify-center overflow-hidden ${LIBRARY_STAGE}`}>
        <BookCover
          url={book.coverThumbUrl}
          format={book.format}
          designStyle={book.designStyle}
          size="shelf"
          className="-mt-[6%] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out motion-safe:group-hover/card:-translate-y-1.5 motion-safe:group-hover/card:scale-[1.03]"
        />
        <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-1 sm:inset-x-2.5 sm:top-2.5 sm:gap-1.5">
          <span className={`${CHIP} ${CHIP_TONE[chip.status]}`} data-testid="book-publish-chip">
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT_TONE[chip.status]}`} />
            {chip.label}
          </span>
          {book.is_paid ? (
            <span className={PAID_CHIP} data-testid="book-paid-chip">
              Paid
            </span>
          ) : null}
        </div>
      </div>

      {/* Title + meta. The title link covers the whole card (::after) — the card's one "open" target. */}
      <div className="col-start-1 row-start-2 flex min-w-0 flex-col gap-1.5 px-3 pt-3 pb-3.5 sm:px-4 sm:pt-3.5 sm:pb-4">
        <h2 className="min-w-0">
          <Link
            href={href}
            className="-mt-2.5 -mb-3 block min-h-11 rounded-sm py-2.5 font-display text-base leading-snug font-semibold break-words text-heading outline-none sm:text-[1.0625rem] after:absolute after:inset-0 after:z-[1] after:rounded-2xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            data-testid="book-card"
          >
            {/* dir="auto" on an inline span: Arabic shapes RTL, the card keeps one alignment (lesson 2026-11-13).
                The link box itself is ≥ 44 px tall (padding offset by negative margins) even though its
                ::after already covers the card — target audits measure the element. */}
            <span className="line-clamp-2">
              <span dir="auto">{title}</span>
            </span>
          </Link>
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {meta.map((part, i) => (
            <span key={part}>
              {i > 0 ? <span aria-hidden="true"> · </span> : null}
              <span className="whitespace-nowrap">{part}</span>
            </span>
          ))}
        </p>
        {updated ? <p className="text-xs text-muted-foreground">{updated}</p> : null}
        {deletion ? (
          <p
            className="mt-0.5 inline-flex w-fit items-center rounded-full border border-warning-border bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning"
            data-testid="book-delete-chip"
          >
            {deletion.label}
          </p>
        ) : null}
      </div>

      {/* Quick actions */}
      <div className={ACTIONS_BAR} role="group" aria-label={`Quick actions: ${title}`} data-testid="book-actions">
        {actions.map((a) => {
          const Icon = ICON[a.kind];
          return (
            <Link
              key={a.kind}
              href={a.href}
              className={`${ACTION} ${ACTION_TONE[a.kind]}${a.kind === "open" && hideOpenOnTouch ? " touch-row:hidden" : ""}`}
              data-testid={TESTID[a.kind]}
            >
              <Icon className="size-[1.125rem]" aria-hidden="true" />
              <span>
                {a.label}
                <span className="sr-only">: {title}</span>
              </span>
            </Link>
          );
        })}
        {deleteBook ? (
          <BookCardMenu bookId={book.id} title={title} deleteBook={deleteBook} triggerClassName={`${ACTION} text-muted-foreground`} label="Options" />
        ) : null}
      </div>
    </article>
  );
}
