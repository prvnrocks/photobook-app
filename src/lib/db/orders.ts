import "server-only";
// Stripe order RPC wrappers (M7, migration 1200). Called ONLY by the verified Stripe webhook.
// Both RPCs are SECURITY INVOKER and executable by service_role only, so they go through the
// secret-key admin client. Errors carry the operation + a Postgres code — never ids, amounts or
// metadata. Nothing here logs.

import { createAdminClient } from "@/lib/supabase/admin";

export type FulfillResult = "fulfilled" | "already_paid" | "book_missing" | "duplicate";
export type OrderEventResult = "updated" | "unchanged" | "order_missing" | "duplicate";
export type OrderEventStatus = "expired" | "failed" | "refunded" | "disputed";

const FULFILL_RESULTS: readonly FulfillResult[] = ["fulfilled", "already_paid", "book_missing", "duplicate"];
const EVENT_RESULTS: readonly OrderEventResult[] = ["updated", "unchanged", "order_missing", "duplicate"];

export class OrdersQueryError extends Error {
  readonly code: string;
  constructor(op: string, code: string | undefined) {
    const safe = (code ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
    super(`orders: ${op} failed (${safe})`);
    this.name = "OrdersQueryError";
    this.code = safe;
  }
}

export interface FulfillBookCheckoutArgs {
  eventId: string;
  eventType: string;
  sessionId: string;
  paymentIntentId: string | null;
  bookId: string;
  userId: string;
  amount: number;
  currency: string;
  livemode: boolean;
}

/** Marks the order paid and flips the book's entitlement (one transaction, deduped by event id). */
export async function fulfillBookCheckout(args: FulfillBookCheckoutArgs): Promise<FulfillResult> {
  const { data, error } = await createAdminClient().rpc("fulfill_book_checkout", {
    p_event_id: args.eventId,
    p_event_type: args.eventType,
    p_session_id: args.sessionId,
    p_payment_intent: args.paymentIntentId,
    p_book_id: args.bookId,
    p_user_id: args.userId,
    p_amount: args.amount,
    p_currency: args.currency,
    p_livemode: args.livemode,
  });
  if (error) throw new OrdersQueryError("fulfill", error.code);
  if (typeof data === "string" && (FULFILL_RESULTS as readonly string[]).includes(data)) {
    return data as FulfillResult;
  }
  throw new OrdersQueryError("fulfill", "bad_result");
}

export interface RecordStripeOrderEventArgs {
  eventId: string;
  eventType: string;
  sessionId: string | null;
  paymentIntentId: string | null;
  status: OrderEventStatus;
  livemode: boolean;
}

/** Records expired / failed / refunded / disputed on the order. Never touches books (no revoke). */
export async function recordStripeOrderEvent(args: RecordStripeOrderEventArgs): Promise<OrderEventResult> {
  const { data, error } = await createAdminClient().rpc("record_stripe_order_event", {
    p_event_id: args.eventId,
    p_event_type: args.eventType,
    p_session_id: args.sessionId,
    p_payment_intent: args.paymentIntentId,
    p_status: args.status,
    p_livemode: args.livemode,
  });
  if (error) throw new OrdersQueryError("record event", error.code);
  if (typeof data === "string" && (EVENT_RESULTS as readonly string[]).includes(data)) {
    return data as OrderEventResult;
  }
  throw new OrdersQueryError("record event", "bad_result");
}
