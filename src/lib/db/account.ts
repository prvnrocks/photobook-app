import "server-only";
// Account-level queries for Settings (M9 T6 / T10, D-060):
//   - email reminders — read user-scoped (RLS); the write is setEmailReminders in db/profiles.ts;
//   - delete account — secret-key admin client, every query filtered by the AUTHENTICATED user's id
//     that the caller passes in (never an id from the request).
//
// Errors carry only the operation and a Postgres / Auth code — never ids, emails or titles.
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";
import type { BookRef } from "@/lib/db/cleanup";

export class AccountQueryError extends Error {
  readonly code: string;
  constructor(op: string, code: unknown) {
    const safe = (typeof code === "string" ? code : "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
    super(`account: ${op} failed (${safe})`);
    this.name = "AccountQueryError";
    this.code = safe;
  }
}

// ---------------------------------------------------------------------------
// Email reminders (profiles.email_reminders, migration 1600)

/** The signed-in user's reminder setting. Missing profile row → true (the column default). */
export async function getOwnEmailReminders(userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles").select("email_reminders").eq("id", userId).maybeSingle();
  if (error) throw new AccountQueryError("load email reminders", error.code);
  return data?.email_reminders !== false;
}

// Writing the setting: setEmailReminders in src/lib/db/profiles.ts (shared with the unsubscribe route).

// ---------------------------------------------------------------------------
// Delete account (admin)

/** Order statuses that block account deletion as "in review" (money moved; support must act). */
export const IN_REVIEW_ORDER_STATUSES = ["disputed", "needs_review"] as const;

async function hasOrderWithStatus(
  op: string,
  userId: string,
  bookIds: readonly string[],
  statuses: readonly string[],
): Promise<boolean> {
  if (!isUuid(userId)) throw new AccountQueryError(op, "invalid");
  const admin = createAdminClient();
  const ids = bookIds.filter(isUuid);
  const filter = ids.length > 0 ? `user_id.eq.${userId},book_id.in.(${ids.join(",")})` : `user_id.eq.${userId}`;
  const { count, error } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .in("status", [...statuses])
    .or(filter);
  if (error) throw new AccountQueryError(op, error.code);
  return (count ?? 0) > 0;
}

/**
 * True when the user has an order still in 'pending' (a Checkout Session may be paid any moment) —
 * by the order's user_id, or on any of the user's books.
 */
export async function hasPendingOrder(userId: string, bookIds: readonly string[]): Promise<boolean> {
  return hasOrderWithStatus("check pending orders", userId, bookIds, ["pending"]);
}

/** True when any of the user's orders (by user_id or on any of their books) is disputed / needs_review. */
export async function hasOrderInReview(userId: string, bookIds: readonly string[]): Promise<boolean> {
  return hasOrderWithStatus("check orders in review", userId, bookIds, IN_REVIEW_ORDER_STATUSES);
}

/** Ids of every book the user owns (paid ones included). */
export async function listUserBookIds(userId: string): Promise<string[]> {
  if (!isUuid(userId)) throw new AccountQueryError("list books", "invalid");
  const { data, error } = await createAdminClient().from("books").select("id").eq("user_id", userId);
  if (error) throw new AccountQueryError("list books", error.code);
  return (data ?? []).map((r) => r.id).filter(isUuid);
}

/**
 * Deletes EVERY book row of the user — paid and comped ones too (account deletion, D-060).
 * FK cascades remove photos / exports / unlock attempts / AI notes; orders and agent runs keep
 * their rows with book_id null (accounting), and the agent_steps trigger nulls step content.
 * Returns the deleted books' refs for the Storage clean-up.
 */
export async function deleteAllUserBooks(userId: string): Promise<BookRef[]> {
  if (!isUuid(userId)) throw new AccountQueryError("delete books", "invalid");
  const { data, error } = await createAdminClient().from("books").delete().eq("user_id", userId).select("id");
  if (error) throw new AccountQueryError("delete books", error.code);
  return (data ?? []).map((r) => r.id).filter(isUuid).map((bookId) => ({ userId, bookId }));
}

/** Deletes the auth user (cascades profiles, user_memory, remaining exports; orders keep user_id null). */
export async function deleteAuthUser(userId: string): Promise<void> {
  if (!isUuid(userId)) throw new AccountQueryError("delete user", "invalid");
  const { error } = await createAdminClient().auth.admin.deleteUser(userId);
  if (error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : String(error.status ?? "auth");
    throw new AccountQueryError("delete user", code);
  }
}
