// M18 books screen: status / filter / search / sort / URL query / quick actions (pure), and the
// collection grid markup (static render: tabs, cards, quick-action placement, empty state).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

const lib = { ...(await import("@/lib/dashboard/library")), ...(await import("@/lib/dashboard/library-cards")) };
const { BookList } = await import("@/components/dashboard/BookList");
const { BookLibrary } = await import("@/components/dashboard/BookLibrary");
const { EmptyState } = await import("@/components/dashboard/EmptyState");
type BookListItem = import("@/lib/db/books").BookListItem;

const NOW = new Date("2026-11-14T08:00:00Z");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const base: BookListItem = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Our Travels",
  updated_at: "2026-11-13T10:00:00Z",
  page_count: 12,
  published_at: null,
  is_paid: false,
  ai_status: "done",
  slug: null,
  expires_at: null,
  draft_warning_sent_at: null,
  published: false,
  photo_count: 30,
  user_edited: false,
  format: "A5_PORTRAIT",
  designStyle: "classic",
  coverThumbUrl: null,
};
const book = (over: Partial<BookListItem>): BookListItem => ({ ...base, ...over });
const live = book({ id: "22222222-2222-4222-8222-222222222222", title: "Live one", published: true, published_at: "2026-11-01T00:00:00Z", expires_at: "2026-11-26T08:00:00Z" });
const paid = book({ id: "33333333-3333-4333-8333-333333333333", title: "Paid one", published: true, is_paid: true, published_at: "2026-11-01T00:00:00Z", expires_at: null });
const expired = book({ id: "44444444-4444-4444-8444-444444444444", title: "Old link", published: true, published_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-31T00:00:00Z" });
const empty = book({ id: "55555555-5555-4555-8555-555555555555", title: "", page_count: 0, photo_count: 0, ai_status: "idle" });

describe("library status + chip", () => {
  it("draft / live / expired from published + expiry; paid never expires", () => {
    expect(lib.libraryStatus(base, NOW)).toBe("draft");
    expect(lib.libraryStatus(live, NOW)).toBe("live");
    expect(lib.libraryStatus(expired, NOW)).toBe("expired");
    expect(lib.libraryStatus({ ...expired, is_paid: true }, NOW)).toBe("live");
  });

  it("chip labels", () => {
    expect(lib.libraryChip(base, NOW).label).toBe("Draft");
    expect(lib.libraryChip(live, NOW).label).toBe("Live · 12 days left");
    expect(lib.libraryChip({ ...live, expires_at: "2026-11-14T20:00:00Z" }, NOW).label).toBe("Live · 1 day left");
    expect(lib.libraryChip(paid, NOW).label).toBe("Live · Permanent");
    expect(lib.libraryChip({ ...live, expires_at: null }, NOW).label).toBe("Live");
    expect(lib.libraryChip(expired, NOW).label).toBe("Expired");
  });

  it("daysLeft rounds up and rejects bad dates", () => {
    expect(lib.daysLeft("2026-11-15T08:00:00Z", NOW)).toBe(1);
    expect(lib.daysLeft("2026-11-15T08:00:01Z", NOW)).toBe(2);
    expect(lib.daysLeft("nope", NOW)).toBeNull();
    expect(lib.daysLeft(null, NOW)).toBeNull();
  });
});

describe("filter / search / sort / counts", () => {
  const entries = [base, live, paid, expired].map((b) => ({
    id: b.id,
    title: b.title ?? "Your book",
    status: lib.libraryStatus(b, NOW),
    paid: b.is_paid,
    pages: b.page_count,
    updatedAt: b.updated_at,
  }));

  it("counts per tab and the header summary", () => {
    const c = lib.libraryCounts(entries);
    expect(c).toEqual({ all: 4, draft: 1, live: 2, paid: 1, expired: 1 });
    expect(lib.librarySummary(c)).toBe("4 books · 2 live · 1 draft · 1 expired");
    expect(lib.librarySummary({ all: 1, draft: 1, live: 0, paid: 0, expired: 0 })).toBe("1 book · 1 draft");
  });

  it("search is case/accent-insensitive and matches Arabic as typed", () => {
    expect(lib.matchesQuery("Café in Al Ain", "cafe")).toBe(true);
    expect(lib.matchesQuery("Our Travels", "  TRAV ")).toBe(true);
    expect(lib.matchesQuery("رحلتنا إلى العين", "العين")).toBe(true);
    expect(lib.matchesQuery("Our Travels", "beach")).toBe(false);
    expect(lib.matchesQuery("anything", "")).toBe(true);
  });

  it("sorts by title (collated), pages (desc) and updated (desc), ties keep server order", () => {
    const e = [
      { ...entries[0], title: "beta", pages: 4, updatedAt: "2026-11-01T00:00:00Z" },
      { ...entries[1], title: "Alpha", pages: 10, updatedAt: "2026-11-03T00:00:00Z" },
      { ...entries[2], title: "gamma", pages: 10, updatedAt: "2026-11-02T00:00:00Z" },
    ];
    expect(lib.sortEntries(e, "title").map((x) => x.title)).toEqual(["Alpha", "beta", "gamma"]);
    expect(lib.sortEntries(e, "pages").map((x) => x.title)).toEqual(["Alpha", "gamma", "beta"]);
    expect(lib.sortEntries(e, "updated").map((x) => x.title)).toEqual(["Alpha", "gamma", "beta"]);
  });

  it("URL query: parse with fallbacks, serialise only non-defaults", () => {
    expect(lib.parseLibraryQuery({ filter: "live", q: "trip", sort: "title" })).toEqual({ filter: "live", q: "trip", sort: "title" });
    expect(lib.parseLibraryQuery({ filter: "bogus", sort: ["pages", "title"] })).toEqual({ filter: "all", q: "", sort: "pages" });
    expect(lib.parseLibraryQuery(undefined)).toEqual(lib.DEFAULT_LIBRARY_QUERY);
    expect(lib.parseLibraryQuery({ q: "x".repeat(200) }).q).toHaveLength(80);
    expect(lib.libraryQueryString(lib.DEFAULT_LIBRARY_QUERY)).toBe("");
    expect(lib.libraryQueryString({ filter: "draft", q: " رحلة ", sort: "updated" })).toBe(`?filter=draft&q=${encodeURIComponent("رحلة")}`);
  });
});

describe("quick actions", () => {
  const kinds = (b: BookListItem, paymentsEnabled = true) => lib.quickActions(b, { paymentsEnabled }).map((a) => a.kind);

  it("built draft: Open, Share (= publish entry), Upgrade", () => {
    expect(kinds(base)).toEqual(["open", "publish", "upgrade"]);
    expect(lib.quickActions(base, { paymentsEnabled: true })[1]).toMatchObject({ href: `/books/${base.id}/publish`, label: "Share" });
    expect(lib.quickActions(base, { paymentsEnabled: true })[2].href).toBe(`/books/${base.id}/publish#upgrade`);
  });

  it("live free: Share link + Upgrade; payments off → no Upgrade", () => {
    expect(kinds(live)).toEqual(["open", "share", "upgrade"]);
    expect(kinds(live, false)).toEqual(["open", "share"]);
  });

  it("paid: PDF instead of Upgrade", () => {
    expect(kinds(paid)).toEqual(["open", "share", "pdf"]);
    expect(lib.quickActions(paid, { paymentsEnabled: true })[2].href).toBe(`/books/${paid.id}/publish#pdf`);
  });

  it("no album yet: only Open (into the wizard's photos / sorting step, M20 T9)", () => {
    expect(lib.quickActions(empty, { paymentsEnabled: true })).toEqual([
      { kind: "open", href: `/books/new?book=${empty.id}&step=5`, label: "Open" },
    ]);
    expect(kinds({ ...empty, photo_count: 4 })).toEqual(["open"]);
    expect(lib.quickActions({ ...empty, photo_count: 4 }, { paymentsEnabled: true })[0].href).toBe(`/books/new?book=${empty.id}&step=6`);
  });

  it("Open follows card-target (running AI → build)", () => {
    expect(lib.quickActions({ ...base, ai_status: "planning" }, { paymentsEnabled: true })[0].href).toBe(`/books/${base.id}/build`);
  });
});

describe("collection grid markup", () => {
  const html = renderToStaticMarkup(
    <BookList books={[base, live, paid, expired, empty]} now={NOW} deleteBook={async () => ({ ok: true })} paymentsEnabled />,
  );

  it("tabs are a keyboard tablist with counts; panel labelled by the selected tab", () => {
    expect(html).toMatch(/role="tablist" aria-label="Filter books"/);
    expect(html.match(/role="tab"/g)?.length).toBe(5);
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*data-testid="library-tab-all"/);
    expect(html.match(/tabindex="-1"[^>]*data-testid="library-tab-/g)?.length).toBe(4);
    expect(html).toMatch(/data-testid="library-count-all"><span class="sr-only">\(<\/span>5</);
    expect(html).toMatch(/data-testid="library-count-live"><span class="sr-only">\(<\/span>2</);
    expect(html).toMatch(/role="tabpanel"/);
    expect(html).toMatch(/<input type="search"[^>]*dir="auto"[^>]*data-testid="library-search"/);
    expect(html).toMatch(/<select[^>]*data-testid="library-sort"/);
  });

  it("one card link per book inside the grid list, one li per book", () => {
    expect(html.match(/data-testid="book-card"/g)?.length).toBe(5);
    expect(html).toMatch(/<ul class="grid grid-cols-\[repeat\(auto-fill/);
    const list = html.slice(html.indexOf('data-testid="book-list"'));
    expect(list.match(/<li /g)?.length).toBe(5);
  });

  it("quick actions: one set per card, hover-pane overlay vs touch row, Options labelled", () => {
    expect(html.match(/data-testid="book-actions"/g)?.length).toBe(5);
    expect(html).toContain("hover-pane:opacity-0");
    expect(html).toContain("group-focus-within/card:opacity-100");
    expect(html).toContain("group-has-[[data-popup-open]]/card:opacity-100");
    expect(html.match(/data-testid="book-menu"/g)?.length).toBe(5);
    expect(html).toMatch(/aria-label="Book options: Our Travels"[^>]*data-testid="book-menu"[^>]*>[\s\S]*?<span>Options<\/span>/);
    expect(html.match(/data-testid="book-upgrade"/g)?.length).toBe(3); // draft, live, expired (free + built)
    expect(html.match(/data-testid="book-pdf"/g)?.length).toBe(1);
    // A full touch row hides Open (the card itself opens the book); the empty book keeps it.
    expect(html.match(/touch-row:hidden"[^>]*data-testid="book-open"/g)?.length).toBe(4);
    // Labels carry the title for screen readers.
    expect(html).toContain('<span>Share<span class="sr-only">: Live one</span></span>');
  });

  it("status chips + meta", () => {
    expect(html).toContain("Live · 12 days left");
    expect(html).toContain("Live · Permanent");
    expect(html).toMatch(/data-testid="book-publish-chip">[\s\S]*?Expired<\/span>/);
    expect(html.match(/data-testid="book-paid-chip">Paid</g)?.length).toBe(1);
    expect(html).toContain("12 pages");
    expect(html).toContain("Portrait");
    expect(html).toContain("Classic");
    expect(html).toContain("Updated 13 Nov");
    expect(html.match(/data-cover="placeholder"/g)?.length).toBe(5);
    expect(html).toMatch(/data-format="A5_PORTRAIT" class="[^"]*w-\[60%\] aspect-\[148\/210\]/);
  });

  it("initial query from the URL filters the first render", () => {
    const items = [base, live].map((b) => ({ id: b.id, title: b.title!, status: lib.libraryStatus(b, NOW), paid: false, pages: 1, updatedAt: b.updated_at, card: <span>{b.title}</span> }));
    const only = renderToStaticMarkup(<BookLibrary items={items} initialQuery={{ filter: "live", q: "", sort: "updated" }} />);
    expect(only).toContain("Live one");
    expect(only).not.toContain(">Our Travels<");
    const none = renderToStaticMarkup(<BookLibrary items={items} initialQuery={{ filter: "all", q: "zzz", sort: "updated" }} />);
    expect(none).toContain('data-testid="library-no-match"');
    expect(none).toContain("No books match your search");
  });

  it("empty library: gold CTA link into the wizard, h2 keeps dir=auto", () => {
    const e = renderToStaticMarkup(<EmptyState />);
    expect(e).toMatch(/<a [^>]*bg-accent-strong[^"]*"[^>]*data-testid="create-first-book"/);
    expect(e).toContain("Make your first book");
    expect(e).toMatch(/<h2 dir="auto"[^>]*>No books yet<\/h2>/);
    expect(e).toMatch(/data-testid="create-first-book" href="\/books\/new"/);
    expect(e).not.toContain("empty-choose-style");
  });

  it("client island stays light: no next/link, cn or button recipes", () => {
    const island = src("src/components/dashboard/BookLibrary.tsx");
    expect(island.startsWith('"use client"')).toBe(true);
    expect(island).not.toMatch(/from "next\/link"|@\/lib\/utils|button-variants|@\/components\/ui\/button/);
    expect(src("src/components/dashboard/BookCover.tsx")).not.toMatch(/@\/lib\/utils/);
    // The island's helper module has no imports (publish rules / schema would add ~50 kB).
    expect(src("src/lib/dashboard/library.ts")).not.toMatch(/^import /m);
    expect(island).not.toContain("library-cards");
  });
});
