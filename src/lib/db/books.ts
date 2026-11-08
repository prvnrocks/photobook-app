import "server-only";
// Book queries for the signed-in user. Uses the RLS-enforced server client;
// the explicit user_id filter is for the index, not for security.
import { getCurrentUser } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

export type BookListItem = Pick<
  Tables<"books">,
  "id" | "title" | "updated_at" | "page_count" | "published_at" | "is_paid"
>;

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
