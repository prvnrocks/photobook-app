// "My books" collection grid (M18): filter tabs, search, sort and the URL query. Pure and
// import-free on purpose: the <BookLibrary> client island imports this module, so it must not pull
// in publish rules / the book schema (that cost ~50 kB). Card status + quick actions live in
// ./library-cards.ts (server side). Tested in tests/dashboard-library.test.tsx.
//
// Statuses (computed in library-cards.ts from BookListItem, no new query):
//   draft   — no live snapshot (never published, or unpublished)
//   live    — live snapshot, link not expired (paid books never expire)
//   expired — live snapshot of a free book past its 30 days
//   paid    — is_paid (orthogonal: a paid book is also draft or live)

export type LibraryStatus = "draft" | "live" | "expired";

export const LIBRARY_FILTERS = ["all", "draft", "live", "paid", "expired"] as const;
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

export const LIBRARY_FILTER_LABELS: Record<LibraryFilter, string> = {
  all: "All",
  draft: "Drafts",
  live: "Live",
  paid: "Paid",
  expired: "Expired",
};

export const LIBRARY_SORTS = ["updated", "title", "pages"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export const LIBRARY_SORT_LABELS: Record<LibrarySort, string> = {
  updated: "Recently updated",
  title: "Title",
  pages: "Pages",
};

/** The small record the client island filters and sorts (one per card, same order as rendered). */
export interface LibraryEntry {
  id: string;
  title: string;
  status: LibraryStatus;
  paid: boolean;
  pages: number;
  updatedAt: string;
}

export function matchesFilter(e: Pick<LibraryEntry, "status" | "paid">, filter: LibraryFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "paid":
      return e.paid;
    default:
      return e.status === filter;
  }
}

/** Case- and accent-insensitive title match; Arabic is compared as typed (NFKC, no case). */
export function normaliseQuery(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesQuery(title: string, query: string): boolean {
  const q = normaliseQuery(query);
  return q === "" || normaliseQuery(title).includes(q);
}

const time = (iso: string) => {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
};

const collator = new Intl.Collator(["en", "ar"], { sensitivity: "base", numeric: true });

/** Stable sort (ties keep the server order, i.e. most recently updated first). */
export function sortEntries<T extends LibraryEntry>(entries: readonly T[], sort: LibrarySort): T[] {
  const indexed = entries.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    let d = 0;
    if (sort === "title") d = collator.compare(a.e.title, b.e.title);
    else if (sort === "pages") d = b.e.pages - a.e.pages;
    else d = time(b.e.updatedAt) - time(a.e.updatedAt);
    return d || a.i - b.i;
  });
  return indexed.map((x) => x.e);
}

export type LibraryCounts = Record<LibraryFilter, number>;

export function libraryCounts(entries: readonly Pick<LibraryEntry, "status" | "paid">[]): LibraryCounts {
  const out: LibraryCounts = { all: 0, draft: 0, live: 0, paid: 0, expired: 0 };
  for (const e of entries) {
    for (const f of LIBRARY_FILTERS) if (matchesFilter(e, f)) out[f] += 1;
  }
  return out;
}

/** "4 books · 1 live · 2 drafts · 1 expired" (zero parts dropped). */
export function librarySummary(c: LibraryCounts): string {
  const parts = [`${c.all} ${c.all === 1 ? "book" : "books"}`];
  if (c.live) parts.push(`${c.live} live`);
  if (c.draft) parts.push(`${c.draft} ${c.draft === 1 ? "draft" : "drafts"}`);
  if (c.expired) parts.push(`${c.expired} expired`);
  return parts.join(" · ");
}

export interface LibraryQuery {
  filter: LibraryFilter;
  q: string;
  sort: LibrarySort;
}

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = { filter: "all", q: "", sort: "updated" };

const MAX_QUERY = 80;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** ?filter=&q=&sort= → a valid query (unknown values fall back to the defaults). */
export function parseLibraryQuery(params: Record<string, string | string[] | undefined> | undefined): LibraryQuery {
  const filter = first(params?.filter);
  const sort = first(params?.sort);
  const q = first(params?.q);
  return {
    filter: (LIBRARY_FILTERS as readonly string[]).includes(filter ?? "") ? (filter as LibraryFilter) : "all",
    sort: (LIBRARY_SORTS as readonly string[]).includes(sort ?? "") ? (sort as LibrarySort) : "updated",
    q: typeof q === "string" ? q.slice(0, MAX_QUERY) : "",
  };
}

/** The query string for the address bar ("" for the defaults, so a clean URL stays clean). */
export function libraryQueryString(query: LibraryQuery): string {
  const p = new URLSearchParams();
  if (query.filter !== "all") p.set("filter", query.filter);
  const q = query.q.trim();
  if (q) p.set("q", q);
  if (query.sort !== "updated") p.set("sort", query.sort);
  const s = p.toString();
  return s ? `?${s}` : "";
}
