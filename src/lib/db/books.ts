import "server-only";
// Book queries for the signed-in user. Reads use the RLS-enforced server client;
// the explicit user_id filter is for the index, not for security. Every write
// of books.doc / page_count uses the admin client after an ownership check —
// those columns are server-only from migration 0900 on (D-036): writeDocIfEmpty,
// saveDocIfRev and the AI pipeline section at the bottom (see there).
import { getCurrentUser } from "@/lib/auth/current-user";
import { isAiReplaceableDoc, isReplaceableDoc } from "@/lib/book/replaceable";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json, Tables } from "@/lib/supabase/database.types";
import type { CaptionLang, Occasion, Tone } from "@/lib/book/options";
import { isUuid } from "@/lib/uuid";

export type BookListItem = Pick<
  Tables<"books">,
  "id" | "title" | "updated_at" | "page_count" | "published_at" | "is_paid" | "ai_status"
> & {
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
};

export type CreateBookInput = {
  title: string | null;
  occasion: Occasion;
  tone: Tone;
  captionLang: CaptionLang;
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
    .select(
      "id, title, updated_at, page_count, published_at, is_paid, ai_status, user_edited:doc->meta->userEdited, photos(count)",
    )
    .eq("user_id", user.id)
    .eq("photos.upload_state", "ready")
    .order("updated_at", { ascending: false });

  if (error) throw new BooksQueryError("list books", error.code);
  return (data ?? []).map((row) => toBookListItem(row as unknown as BookListRow));
}

type BookListRow = Omit<BookListItem, "photo_count" | "user_edited"> & {
  user_edited: unknown;
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
    photo_count: typeof count === "number" && Number.isFinite(count) ? count : 0,
    user_edited: row.user_edited === true,
  };
}

/**
 * Creates a book owned by the current user. Input must already be validated
 * (src/app/books/actions.ts). Only user-editable columns are sent; the
 * protected columns (is_paid, max_pages, expires_at, slug, published_at) are
 * left to their defaults and forced by the books guard trigger anyway (D-011).
 * Throws BooksQueryError("create book", "unauthenticated") when signed out.
 */
export async function createBook(input: CreateBookInput): Promise<{ id: string }> {
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
 * Deploy-order tolerance (0900): code ships before the migration, so when
 * `doc_rev` doesn't exist yet the query is retried without it and `doc_rev` is
 * null. Remove the fallback once 0900 is applied in every environment.
 */
export async function getMyBook(id: string): Promise<MyBook | null> {
  if (!isUuid(id)) return null;
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select(`${MY_BOOK_COLUMNS}, doc_rev`)
    .eq("id", id)
    .maybeSingle();

  if (!error) return data;
  if (!isMissingColumnError(error, "doc_rev")) {
    throw new BooksQueryError("load book", error.code);
  }

  const legacy = await supabase.from("books").select(MY_BOOK_COLUMNS).eq("id", id).maybeSingle();
  if (legacy.error) throw new BooksQueryError("load book", legacy.error.code);
  return legacy.data ? { ...legacy.data, doc_rev: null } : null;
}

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
>;

/** The book as the pipeline needs it, or null (malformed id / missing). Admin client. */
export async function getBookForRun(bookId: string): Promise<BookForRun | null> {
  if (!isUuid(bookId)) return null;
  const { data, error } = await createAdminClient()
    .from("books")
    .select("id, user_id, title, occasion, tone, caption_lang, is_paid, max_pages, doc, updated_at, ai_status")
    .eq("id", bookId)
    .maybeSingle();
  if (error) throw new BooksQueryError("load book for run", error.code);
  return data;
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
