import "server-only";
// Book queries for the signed-in user. Reads use the RLS-enforced server client;
// the explicit user_id filter is for the index, not for security. Every write
// of books.doc / page_count uses the admin client after an ownership check —
// those columns are server-only from migration 0900 on (D-036): writeDocIfEmpty,
// saveDocIfRev and the AI pipeline section at the bottom (see there).
import { getCurrentUser } from "@/lib/auth/current-user";
import { bookDesignOf, withBookDesign } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import { isAiReplaceableDoc, isReplaceableDoc } from "@/lib/book/replaceable";
import { BookFormatSchema, DesignStyleSchema, parseBookDoc } from "@/lib/book/schema";
import { stripPhotoFromDoc, type StripPhotoDims } from "@/lib/book/strip-photos";
import { listPhotoDims } from "@/lib/db/photos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json, Tables } from "@/lib/supabase/database.types";
import type { CaptionLang, Occasion, Tone } from "@/lib/book/options";
import type { BookFormat, DesignStyle } from "@/lib/book/types";
import { isUuid } from "@/lib/uuid";

export type BookListItem = Pick<
  Tables<"books">,
  | "id"
  | "title"
  | "updated_at"
  | "page_count"
  | "published_at"
  | "is_paid"
  | "ai_status"
  | "slug"
  | "expires_at"
  | "draft_warning_sent_at"
> & {
  /**
   * Live snapshot exists (published_doc is not null, read as `published_doc->version`). Unpublish
   * clears only published_doc (published_rev / slug / published_at survive), so this — not
   * published_rev or published_at — is what "published" means.
   */
  published: boolean;
  /** Upload-finished photos (upload_state = 'ready'); routes empty books to upload vs build. */
  photo_count: number;
  /** doc.meta.userEdited === true (read as a JSON path, the doc itself is not loaded). */
  user_edited: boolean;
};

export type MyBook = Pick<
  Tables<"books">,
  | "id"
  | "title"
  | "occasion"
  | "tone"
  | "caption_lang"
  | "is_paid"
  | "max_pages"
  | "page_count"
  | "doc"
  | "updated_at"
> & {
  /**
   * Optimistic-concurrency revision of `doc` (migration 0900, D-036). `null` only while
   * 0900 is not applied yet (column missing): the editor must treat that as "saving not
   * available" — saveDocIfRev would fail. Drop the null once 0900 is applied everywhere.
   */
  doc_rev: number | null;
  /**
   * books.format / books.design_style (migration 1900, D-063) — the authority for doc.format /
   * doc.style.designStyle (resolve with bookDesignOf). `null` only while 1900 is not applied yet.
   */
  format: string | null;
  design_style: string | null;
};

export type CreateBookInput = {
  title: string | null;
  occasion: Occasion;
  tone: Tone;
  captionLang: CaptionLang;
  /**
   * D-063: fixed at creation (books.format, migration 1900, insert-only for users). Omitted →
   * the column default 'A5_PORTRAIT'. The New book form sends it from A12 on.
   */
  format?: BookFormat;
  /** D-063: fixed at creation (books.design_style). Omitted → the column default 'classic'. */
  designStyle?: DesignStyle;
};

export class BooksQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "BooksQueryError";
    this.code = code;
  }
}

/**
 * Books owned by the current user, most recently edited first. [] if signed out.
 * Also returns what the dashboard card needs to pick its route (src/lib/dashboard/card-target.ts):
 * ai_status, the count of ready photos (embedded count, filtered) and doc.meta.userEdited.
 */
export async function listMyBooks(): Promise<BookListItem[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select(BOOK_LIST_COLUMNS)
    .eq("user_id", user.id)
    .eq("photos.upload_state", "ready")
    .order("updated_at", { ascending: false });
  if (error) throw new BooksQueryError("list books", error.code);
  return ((data ?? []) as unknown as BookListRow[]).map(toBookListItem);
}

const BOOK_LIST_COLUMNS =
  "id, title, updated_at, page_count, published_at, is_paid, ai_status, slug, expires_at, draft_warning_sent_at, user_edited:doc->meta->userEdited, live:published_doc->version, photos(count)";

type BookListRow = Omit<BookListItem, "photo_count" | "user_edited" | "published"> & {
  user_edited: unknown;
  /** published_doc->version: null/absent when there is no live snapshot. */
  live: unknown;
  photos: { count: number }[] | null;
};

function toBookListItem(row: BookListRow): BookListItem {
  const count = Array.isArray(row.photos) ? row.photos[0]?.count : undefined;
  return {
    id: row.id,
    title: row.title,
    updated_at: row.updated_at,
    page_count: row.page_count,
    published_at: row.published_at,
    is_paid: row.is_paid,
    ai_status: row.ai_status,
    slug: row.slug,
    expires_at: row.expires_at,
    draft_warning_sent_at: row.draft_warning_sent_at ?? null,
    published: row.live !== null && row.live !== undefined,
    photo_count: typeof count === "number" && Number.isFinite(count) ? count : 0,
    user_edited: row.user_edited === true,
  };
}

/**
 * Creates a book owned by the current user. Input must already be validated
 * (src/app/books/actions.ts); format / designStyle are re-checked against the enums
 * (BooksQueryError "invalid_format" / "invalid_design_style"). Only user-editable columns are sent; the
 * protected columns (is_paid, max_pages, expires_at, slug, published_at) are
 * left to their defaults and forced by the books guard trigger anyway (D-011).
 * Throws BooksQueryError("create book", "unauthenticated") when signed out.
 */
export async function createBook(input: CreateBookInput): Promise<{ id: string }> {
  // Runtime check too: the enums are also DB check constraints, but a typed error beats a 23514.
  if (input.format !== undefined && !BookFormatSchema.safeParse(input.format).success) {
    throw new BooksQueryError("create book", "invalid_format");
  }
  if (input.designStyle !== undefined && !DesignStyleSchema.safeParse(input.designStyle).success) {
    throw new BooksQueryError("create book", "invalid_design_style");
  }

  const user = await getCurrentUser();
  if (!user) throw new BooksQueryError("create book", "unauthenticated");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .insert({
      user_id: user.id,
      title: input.title,
      occasion: input.occasion,
      tone: input.tone,
      caption_lang: input.captionLang,
      // Only sent when chosen, so callers that omit them work with or without 1900 applied
      // (rollback-safe); the column defaults are the same portrait / classic.
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.designStyle !== undefined ? { design_style: input.designStyle } : {}),
    })
    .select("id")
    .single();

  if (error) throw new BooksQueryError("create book", error.code);
  return { id: data.id };
}

const MY_BOOK_COLUMNS = "id, title, occasion, tone, caption_lang, is_paid, max_pages, page_count, doc, updated_at";

/**
 * Postgres undefined_column (42703) / PostgREST schema-cache miss (PGRST204) for `column` — the
 * message must name the column, so an unrelated missing column (or an error without a message)
 * is never mistaken for the pre-0900 deploy window.
 */
function isMissingColumnError(error: { code?: string; message?: string }, column: string): boolean {
  if (error.code !== "42703" && error.code !== "PGRST204") return false;
  return typeof error.message === "string" && error.message.includes(column);
}

/**
 * One book of the current user, or null when the id is malformed, the book
 * doesn't exist, belongs to someone else (RLS: owner-only) or the user is
 * signed out.
 *
 * Deploy-order tolerance (0900 / 1900): when `doc_rev`, `format` or `design_style` doesn't exist
 * yet, the query is retried with the base columns only and those fields are null — doc_rev null
 * makes the editor save answer "saving unavailable" (safe: without the 1900 columns the server
 * has no format/style authority). LAUNCH.md applies 1900 before this code; remove the fallback
 * once both migrations are applied everywhere.
 */
export async function getMyBook(id: string): Promise<MyBook | null> {
  if (!isUuid(id)) return null;
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select(`${MY_BOOK_COLUMNS}, doc_rev, format, design_style`)
    .eq("id", id)
    .maybeSingle();

  if (!error) return data;
  if (!OPTIONAL_COLUMNS.some((c) => isMissingColumnError(error, c))) {
    throw new BooksQueryError("load book", error.code);
  }

  const legacy = await supabase.from("books").select(MY_BOOK_COLUMNS).eq("id", id).maybeSingle();
  if (legacy.error) throw new BooksQueryError("load book", legacy.error.code);
  return legacy.data ? { ...legacy.data, doc_rev: null, format: null, design_style: null } : null;
}

/** Columns of not-yet-applied migrations that readers tolerate (0900 doc_rev, 1900 format/style). */
const OPTIONAL_COLUMNS = ["doc_rev", "format", "design_style"] as const;

/**
 * Writes the fallback album only if the book's doc is still the empty object
 * (D-016). One UPDATE with three guards, so it never overwrites user or AI work:
 *   - `user_id = <current user>` — ownership (the caller already loaded the book
 *     with getMyBook under RLS; this keeps the admin write scoped to the owner);
 *   - `doc = '{}'` — PostgREST `doc=eq.{}`; Postgres casts the literal to jsonb,
 *     and jsonb equality is semantic, so only an empty object matches.
 *   - `updated_at = expectedUpdatedAt` — optimistic lock: the books_set_updated_at
 *     trigger bumps updated_at on every write, so if anything changed the row
 *     since the caller read it (and saw doc = {}), 0 rows match.
 * Admin client: books.doc / page_count are server-only from migration 0900 on
 * (D-036) — a user-scoped update would silently keep the old doc. Works the
 * same before 0900 (no new columns are referenced).
 * Returns true when exactly this call wrote the doc, false when a guard failed
 * (book changed meanwhile / not the caller's / signed out).
 */
export async function writeDocIfEmpty(
  bookId: string,
  doc: Json,
  pageCount: number,
  expectedUpdatedAt: string,
): Promise<boolean> {
  if (!isUuid(bookId)) return false;
  const user = await getCurrentUser();
  if (!user) return false;
  const { data, error } = await createAdminClient()
    .from("books")
    .update({ doc, page_count: pageCount })
    .eq("id", bookId)
    .eq("user_id", user.id)
    .filter("doc", "eq", "{}")
    .eq("updated_at", expectedUpdatedAt)
    .select("id");

  if (error) throw new BooksQueryError("write book doc", error.code);
  return data.length === 1;
}

export type SaveDocResult =
  | { ok: true; rev: number; savedAt: string }
  | { ok: false; reason: "conflict" | "not_found" };

/**
 * Editor save (D-036): writes doc + page_count (+ optional title, D-037 (7))
 * only when the stored revision is still `baseRev` — one UPDATE … WHERE id AND
 * user_id AND doc_rev = baseRev RETURNING doc_rev, updated_at. The
 * books_set_doc_rev trigger bumps doc_rev when doc changes (an identical doc
 * keeps the rev). 0 rows → a follow-up existence check (same id + owner)
 * tells `conflict` (someone saved first; no merge, client reloads) from
 * `not_found` (deleted / not the owner's).
 *
 * Admin client: doc is server-only. The caller (PUT /api/books/[id]/doc) MUST
 * have verified the session user = ownerId and validated the whole doc
 * (shape, photo ownership, max_pages from DB, fonts) and title (≤ 120 code
 * points, clipText) before calling. Requires migration 0900 (doc_rev);
 * before it, Postgres rejects the filter → BooksQueryError.
 */
export async function saveDocIfRev(
  bookId: string,
  ownerId: string,
  doc: Json,
  pageCount: number,
  baseRev: number,
  extra: { title?: string | null } = {},
): Promise<SaveDocResult> {
  if (!isUuid(bookId) || !isUuid(ownerId)) return { ok: false, reason: "not_found" };
  if (!Number.isSafeInteger(baseRev) || baseRev < 0) return { ok: false, reason: "conflict" };
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) throw new BooksQueryError("save book doc", "invalid_page_count");
  const admin = createAdminClient();

  const patch: { doc: Json; page_count: number; title?: string | null } = { doc, page_count: pageCount };
  if (extra.title !== undefined) patch.title = extra.title;

  const { data, error } = await admin
    .from("books")
    .update(patch)
    .eq("id", bookId)
    .eq("user_id", ownerId)
    .eq("doc_rev", baseRev)
    .select("doc_rev, updated_at");
  if (error) throw new BooksQueryError("save book doc", error.code);
  if (data.length === 1) return { ok: true, rev: data[0].doc_rev, savedAt: data[0].updated_at };

  const { data: existing, error: readError } = await admin
    .from("books")
    .select("id")
    .eq("id", bookId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (readError) throw new BooksQueryError("save book doc", readError.code);
  return { ok: false, reason: existing ? "conflict" : "not_found" };
}

export type StripPhotoResult = "updated" | "unchanged" | "conflict" | "not_found";

/**
 * After a photo was deleted (M10a review S3): removes every reference to it from books.doc —
 * cover photoId → null, photo backgrounds using it removed (book default → white colour, page
 * override → removed), and the pages that held it reflow (M10b A19, D-028 rule 1: refit to a
 * smaller layout of the book's format + style, empty pages/spreads removed unless they carry a
 * user caption, repairSpreads; fallback = slot photoId → null; stripPhotoFromDoc). Read-modify-write guarded by doc_rev exactly like
 * the editor save (saveDocIfRev), retried once on a conflict; meta, title and page_count stay as
 * they are (a cleanup is not a user edit). The doc_rev bump makes an editor that is open in
 * another tab get 409 on its next save ("Changed in another tab – Reload"), so it reloads the
 * cleaned doc instead of re-sending the deleted id (which would 422 foreign_photo).
 *
 * `{}`, unparsable docs and docs that don't reference the photo → "unchanged" (no write). Before
 * migration 0900 (doc_rev null) nothing is written ("unchanged"): there is no safe guard.
 * Reads under RLS (getMyBook = ownership), writes with the admin client + owner filter.
 * Call only AFTER the photo row is gone, so no save can put the id back in between.
 */
export async function stripPhotoFromBookDoc(bookId: string, photoId: string): Promise<StripPhotoResult> {
  if (!isUuid(bookId) || !isUuid(photoId)) return "not_found";
  const user = await getCurrentUser();
  if (!user) return "not_found";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const book = await getMyBook(bookId);
    if (!book) return "not_found";
    if (book.doc_rev === null) return "unchanged";
    const parsed = parseBookDoc(book.doc);
    if (!parsed.ok) return "unchanged";
    // D-063: the doc carries the book's columns BEFORE the reflow, so refits use the book's
    // format + style (no-op once they agree).
    const stamped = withBookDesign(parsed.doc, bookDesignOf(book));
    // Reflow (M10b A19) needs the remaining photos' sizes — only when a page held the photo.
    // Best effort: without sizes every photo counts as square (still a valid reflow).
    const onPages = stamped.pages.some((p) => p.slots.some((s) => s.photoId === photoId));
    let dims: StripPhotoDims[] = [];
    if (onPages) {
      try {
        dims = await listPhotoDims(book.id);
      } catch {
        dims = [];
      }
    }
    const stripped = stripPhotoFromDoc(stamped, photoId, dims);
    if (!stripped.changed) return "unchanged";
    const doc = stripped.doc;
    const saved = await saveDocIfRev(
      book.id,
      user.id,
      serializeDoc(doc) as unknown as Json,
      doc.pages.length,
      book.doc_rev,
    );
    if (saved.ok) return "updated";
    if (saved.reason === "not_found") return "not_found";
    // conflict: the doc changed since we read it → reload and retry once
  }
  return "conflict";
}

// ---------------------------------------------------------------------------
// AI pipeline (M3, D-018 / D-021). Admin client: books.ai_status is server-only
// (protect_book_columns) and the orchestrator may run a tick without relying
// on RLS. Callers MUST have checked ownership first (getMyBook under RLS).

export type BookAiStatus =
  | "idle"
  | "analyzing"
  | "planning"
  | "captioning"
  | "done"
  | "partial"
  | "failed";

export type BookForRun = Pick<
  Tables<"books">,
  | "id"
  | "user_id"
  | "title"
  | "occasion"
  | "tone"
  | "caption_lang"
  | "is_paid"
  | "max_pages"
  | "doc"
  | "updated_at"
  | "ai_status"
> & {
  /** books.format / books.design_style (1900, D-063); null only before 1900 (see getBookForRun). */
  format: string | null;
  design_style: string | null;
};

const BOOK_FOR_RUN_COLUMNS = "id, user_id, title, occasion, tone, caption_lang, is_paid, max_pages, doc, updated_at, ai_status";

/**
 * The book as the pipeline needs it, or null (malformed id / missing). Admin client.
 * format / design_style are null only before migration 1900 (retried without them; writers then
 * fall back to the doc's own design via bookDesignOf).
 */
export async function getBookForRun(bookId: string): Promise<BookForRun | null> {
  if (!isUuid(bookId)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("books")
    .select(`${BOOK_FOR_RUN_COLUMNS}, format, design_style`)
    .eq("id", bookId)
    .maybeSingle();
  if (!error) return data;
  if (!isMissingColumnError(error, "format") && !isMissingColumnError(error, "design_style")) {
    throw new BooksQueryError("load book for run", error.code);
  }
  const legacy = await admin.from("books").select(BOOK_FOR_RUN_COLUMNS).eq("id", bookId).maybeSingle();
  if (legacy.error) throw new BooksQueryError("load book for run", legacy.error.code);
  return legacy.data ? { ...legacy.data, format: null, design_style: null } : null;
}

/** Sets books.ai_status (server-only column, D-021). Admin client. */
export async function setBookAiStatus(bookId: string, status: BookAiStatus): Promise<void> {
  if (!isUuid(bookId)) throw new BooksQueryError("set ai status", "invalid_id");
  const { error } = await createAdminClient().from("books").update({ ai_status: status }).eq("id", bookId);
  if (error) throw new BooksQueryError("set ai status", error.code);
}

export type WriteDocResult =
  | { ok: true }
  | { ok: false; reason: "user_edited" | "conflict" | "not_found" };

/**
 * Which "may this doc be replaced?" rule applies (D-031):
 * - "ai" (default, safe side): AI runs — isAiReplaceableDoc (not user-edited AND no user captions).
 * - "relayout": the free "Update album" (D-028) — isReplaceableDoc; it keeps user captions itself.
 */
export type WriteDocGuard = "ai" | "relayout";

/**
 * Writes an AI / rebuilt / re-laid-out album only when the current doc may be replaced
 * (D-018, D-031): `{}` or a draft with meta.userEdited !== true, and — for guard "ai" — no
 * caption with source "user".
 *   1. read doc + updated_at (admin);
 *   2. not replaceable (per guard) → user_edited; updated_at ≠ expected → conflict;
 *   3. UPDATE … WHERE id AND updated_at = expected (optimistic lock — the
 *      books_set_updated_at trigger bumps it on every write), 0 rows → conflict.
 * So an edit landing between the read and the write is never clobbered.
 */
export async function writeDocIfReplaceable(
  bookId: string,
  doc: Json,
  pageCount: number,
  expected: { updatedAt: string },
  options: { guard?: WriteDocGuard } = {},
): Promise<WriteDocResult> {
  const replaceable = options.guard === "relayout" ? isReplaceableDoc : isAiReplaceableDoc;
  if (!isUuid(bookId)) return { ok: false, reason: "not_found" };
  const admin = createAdminClient();

  const { data: current, error: readError } = await admin
    .from("books")
    .select("doc, updated_at")
    .eq("id", bookId)
    .maybeSingle();
  if (readError) throw new BooksQueryError("load book doc", readError.code);
  if (!current) return { ok: false, reason: "not_found" };
  if (!replaceable(current.doc)) return { ok: false, reason: "user_edited" };
  if (current.updated_at !== expected.updatedAt) return { ok: false, reason: "conflict" };

  const { data, error } = await admin
    .from("books")
    .update({ doc, page_count: pageCount })
    .eq("id", bookId)
    .eq("updated_at", expected.updatedAt)
    .select("id");
  if (error) throw new BooksQueryError("write book doc", error.code);
  return data.length === 1 ? { ok: true } : { ok: false, reason: "conflict" };
}

/**
 * Display title of one of the current user's books (books.title, else the doc's cover title —
 * read as a JSON path, the doc itself is not loaded). null when untitled / not visible.
 */
export async function getMyBookTitle(id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select("title, cover_title:doc->cover->>title")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new BooksQueryError("load book title", error.code);
  if (!data) return null;
  const row = data as unknown as { title: string | null; cover_title: unknown };
  const title = row.title?.trim() || (typeof row.cover_title === "string" ? row.cover_title.trim() : "");
  return title || null;
}
