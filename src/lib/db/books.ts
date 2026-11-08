import "server-only";
// Book queries for the signed-in user. Uses the RLS-enforced server client;
// the explicit user_id filter is for the index, not for security.
import { getCurrentUser } from "@/lib/auth/current-user";
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
