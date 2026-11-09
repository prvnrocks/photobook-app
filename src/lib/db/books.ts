import "server-only";
// Book queries for the signed-in user. Uses the RLS-enforced server client;
// the explicit user_id filter is for the index, not for security. The AI
// pipeline section at the bottom uses the admin client (see there).
import { getCurrentUser } from "@/lib/auth/current-user";
import { isAiReplaceableDoc, isReplaceableDoc } from "@/lib/book/replaceable";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json, Tables } from "@/lib/supabase/database.types";
import type { CaptionLang, Occasion, Tone } from "@/lib/book/options";
import { isUuid } from "@/lib/uuid";

export type BookListItem = Pick<
  Tables<"books">,
  "id" | "title" | "updated_at" | "page_count" | "published_at" | "is_paid"
>;

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
>;

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

/** Books owned by the current user, most recently edited first. [] if signed out. */
export async function listMyBooks(): Promise<BookListItem[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select("id, title, updated_at, page_count, published_at, is_paid")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) throw new BooksQueryError("list books", error.code);
  return data;
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

/**
 * One book of the current user, or null when the id is malformed, the book
 * doesn't exist, belongs to someone else (RLS: owner-only) or the user is
 * signed out.
 */
export async function getMyBook(id: string): Promise<MyBook | null> {
  if (!isUuid(id)) return null;
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select("id, title, occasion, tone, caption_lang, is_paid, max_pages, page_count, doc, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new BooksQueryError("load book", error.code);
  return data;
}

/**
 * Writes the fallback album only if the book's doc is still the empty object
 * (D-016). One UPDATE with two guards, so it never overwrites user or AI work:
 *   - `doc = '{}'` — PostgREST `doc=eq.{}`; Postgres casts the literal to jsonb,
 *     and jsonb equality is semantic, so only an empty object matches.
 *   - `updated_at = expectedUpdatedAt` — optimistic lock: the books_set_updated_at
 *     trigger bumps updated_at on every write, so if anything changed the row
 *     since the caller read it (and saw doc = {}), 0 rows match.
 * Returns true when exactly this call wrote the doc, false when a guard failed
 * (book changed meanwhile / not visible under RLS).
 */
export async function writeDocIfEmpty(
  bookId: string,
  doc: Json,
  pageCount: number,
  expectedUpdatedAt: string,
): Promise<boolean> {
  if (!isUuid(bookId)) return false;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .update({ doc, page_count: pageCount })
    .eq("id", bookId)
    .filter("doc", "eq", "{}")
    .eq("updated_at", expectedUpdatedAt)
    .select("id");

  if (error) throw new BooksQueryError("write book doc", error.code);
  return data.length === 1;
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
