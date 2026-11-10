import "server-only";
// Upgrade checkout queries (M7 T5). Admin client: orders are written only by the service role
// (owner may SELECT under RLS), and books.is_paid is a server-only column. Every book query is
// scoped by id AND user_id; the caller MUST have resolved userId from the session.
// Errors carry codes only (UpgradeQueryError) — never titles, emails or other user text.

import { createAdminClient } from "@/lib/supabase/admin";
import { ORDER_STATUSES, type UpgradeOrderStatus } from "@/lib/upgrade/types";
import { isUuid } from "@/lib/uuid";

export class UpgradeQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "UpgradeQueryError";
    this.code = code;
  }
}

export type UpgradeTarget = { isPaid: boolean; slug: string | null; title: string | null };

/** The owner's book (live is_paid), or null for malformed ids / missing / someone else's. */
export async function getUpgradeTarget(bookId: string, userId: string): Promise<UpgradeTarget | null> {
  if (!isUuid(bookId) || !isUuid(userId)) return null;
  const { data, error } = await createAdminClient()
    .from("books")
    .select("id, is_paid, slug, title")
    .eq("id", bookId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new UpgradeQueryError("load upgrade target", error.code);
  if (!data) return null;
  return { isPaid: data.is_paid === true, slug: data.slug ?? null, title: data.title ?? null };
}

export type PendingOrder = { id: string; sessionId: string | null; userId: string | null };

/** The book's single 'pending' order (orders_one_pending_per_book), or null. */
export async function findPendingOrder(bookId: string): Promise<PendingOrder | null> {
  if (!isUuid(bookId)) return null;
  const { data, error } = await createAdminClient()
    .from("orders")
    .select("id, stripe_session_id, user_id")
    .eq("book_id", bookId)
    .eq("status", "pending")
    .maybeSingle();
  if (error) throw new UpgradeQueryError("load pending order", error.code);
  if (!data) return null;
  return { id: data.id, sessionId: data.stripe_session_id, userId: data.user_id };
}

export type InsertPendingOrderInput = {
  bookId: string;
  userId: string;
  sessionId: string;
  amount: number;
  currency: string;
  livemode: boolean;
};

export type InsertPendingOrderResult = { ok: true; id: string } | { ok: false; reason: "pending_exists" };

/**
 * Inserts the 'pending' digital order for a freshly created Checkout Session.
 * 23505 → pending_exists: orders_one_pending_per_book (another request won the race) or
 * orders_stripe_session_id_key (an idempotent replay returned a session already stored) —
 * the caller re-reads the pending order either way.
 */
export async function insertPendingOrder(input: InsertPendingOrderInput): Promise<InsertPendingOrderResult> {
  if (!isUuid(input.bookId) || !isUuid(input.userId)) throw new UpgradeQueryError("insert pending order", "invalid_id");
  const { data, error } = await createAdminClient()
    .from("orders")
    .insert({
      book_id: input.bookId,
      user_id: input.userId,
      type: "digital",
      status: "pending",
      stripe_session_id: input.sessionId,
      amount: input.amount,
      currency: input.currency.toLowerCase(),
      livemode: input.livemode,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "pending_exists" };
    throw new UpgradeQueryError("insert pending order", error.code);
  }
  return { ok: true, id: data.id };
}

/**
 * pending → expired, only while still pending (a webhook may have moved it to paid meanwhile).
 * Returns whether a row changed.
 */
export async function markOrderExpired(orderId: string): Promise<boolean> {
  if (!isUuid(orderId)) return false;
  const { data, error } = await createAdminClient()
    .from("orders")
    .update({ status: "expired" })
    .eq("id", orderId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new UpgradeQueryError("expire order", error.code);
  return data.length === 1;
}

/** Status of the newest order for the owner's book, 'none' if there is none. */
export async function getLatestOrderStatus(bookId: string, userId: string): Promise<UpgradeOrderStatus> {
  if (!isUuid(bookId) || !isUuid(userId)) return "none";
  const { data, error } = await createAdminClient()
    .from("orders")
    .select("status")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new UpgradeQueryError("load order status", error.code);
  const status = data?.status;
  return (ORDER_STATUSES as readonly string[]).includes(status ?? "") && status !== "none"
    ? (status as UpgradeOrderStatus)
    : "none";
}
