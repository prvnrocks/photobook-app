// Stripe webhook (M7 T4). The ONLY place that sets books.is_paid (via fulfill_book_checkout).
//
// - Signature verified on the raw body (constructEvent); missing/bad signature or a tampered body → 400.
// - Payments not configured → 503 (Stripe retries later).
// - DB/RPC errors → 500 so Stripe retries; every RPC is deduped by event id ('duplicate' → 200).
// - Sessions that fail validation (amount / currency / kind / reference) are logged and acknowledged
//   (200) — retrying would never make them valid. They are NOT fulfilled.
// - Refunds (full only) / disputes are recorded on the order; is_paid is never revoked (decision).
// - Logs: event id, event type, session id, result / reason codes only. Never emails, metadata,
//   amounts, book or user ids.
// - Excluded from the middleware matcher (no cookie / getUser work here).

import type Stripe from "stripe";
import { revalidatePath } from "next/cache";
import { fulfillBookCheckout, recordStripeOrderEvent, type OrderEventStatus } from "@/lib/db/orders";
import { errorCodeOf, json } from "@/lib/http/json";
import {
  UPGRADE_METADATA_KIND,
  isPendingUpgradeSession,
  validatePaidSession,
} from "@/lib/payments/session";
import { getStripe, getWebhookSecret, isPaymentsEnabled } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TAG = "[stripe-webhook]";
let loggedDisabled = false;

/** Stripe ids / event types are [A-Za-z0-9_.]; strip anything else so logs can't be injected. */
function safeId(v: unknown): string {
  return typeof v === "string" ? v.replace(/[^A-Za-z0-9_.]/g, "").slice(0, 80) || "-" : "-";
}

function logLine(level: "info" | "warn" | "error", event: Stripe.Event, outcome: string, sessionId?: string) {
  const parts = [TAG, safeId(event.type), outcome, `evt=${safeId(event.id)}`];
  if (sessionId) parts.push(`cs=${safeId(sessionId)}`);
  console[level](parts.join(" "));
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (typeof v === "string") return v || null;
  return v?.id ?? null;
}

const ok = () => json({ received: true });

async function handleSessionPaid(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<Response> {
  if (session.metadata?.kind !== UPGRADE_METADATA_KIND) {
    logLine("info", event, "ignored:not_upgrade", session.id);
    return ok();
  }
  const r = validatePaidSession(session);
  if (!r.ok) {
    if (
      r.reason === "not_paid" &&
      event.type === "checkout.session.completed" &&
      isPendingUpgradeSession(session)
    ) {
      // Async payment method still pending; the order is already 'pending' from checkout.
      logLine("info", event, "pending", session.id);
      return ok();
    }
    logLine("warn", event, `invalid:${r.reason}`, session.id);
    return ok();
  }
  const result = await fulfillBookCheckout({
    eventId: event.id,
    eventType: event.type,
    sessionId: r.sessionId,
    paymentIntentId: r.paymentIntentId,
    bookId: r.bookId,
    userId: r.userId,
    amount: r.amount,
    currency: r.currency,
    livemode: r.livemode,
  });
  logLine(result === "book_missing" ? "warn" : "info", event, result, session.id);
  if (result === "fulfilled") {
    try {
      revalidatePath("/dashboard");
      revalidatePath(`/books/${r.bookId}/publish`);
      revalidatePath(`/books/${r.bookId}/edit`);
    } catch (err) {
      logLine("warn", event, `revalidate_failed:${errorCodeOf(err)}`, session.id);
    }
  }
  return ok();
}

async function handleSessionStatus(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  status: Extract<OrderEventStatus, "expired" | "failed">,
): Promise<Response> {
  if (session.metadata?.kind !== UPGRADE_METADATA_KIND) {
    logLine("info", event, "ignored:not_upgrade", session.id);
    return ok();
  }
  const result = await recordStripeOrderEvent({
    eventId: event.id,
    eventType: event.type,
    sessionId: session.id,
    paymentIntentId: idOf(session.payment_intent),
    status,
    livemode: event.livemode,
  });
  logLine(result === "order_missing" ? "warn" : "info", event, result, session.id);
  return ok();
}

async function handleByPaymentIntent(
  event: Stripe.Event,
  paymentIntentId: string | null,
  status: Extract<OrderEventStatus, "refunded" | "disputed">,
): Promise<Response> {
  if (!paymentIntentId) {
    logLine("warn", event, "ignored:no_payment_intent");
    return ok();
  }
  const result = await recordStripeOrderEvent({
    eventId: event.id,
    eventType: event.type,
    sessionId: null,
    paymentIntentId,
    status,
    livemode: event.livemode,
  });
  logLine(result === "order_missing" ? "warn" : "info", event, result);
  return ok();
}

async function dispatch(event: Stripe.Event): Promise<Response> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return handleSessionPaid(event, event.data.object);
    case "checkout.session.async_payment_failed":
      return handleSessionStatus(event, event.data.object, "failed");
    case "checkout.session.expired":
      return handleSessionStatus(event, event.data.object, "expired");
    case "charge.refunded": {
      const charge = event.data.object;
      if (!(charge.amount_refunded >= charge.amount)) {
        // Partial refund: logged only (decision) — the order stays as it is.
        logLine("warn", event, "partial_refund");
        return ok();
      }
      return handleByPaymentIntent(event, idOf(charge.payment_intent), "refunded");
    }
    case "charge.dispute.created":
      return handleByPaymentIntent(event, idOf(event.data.object.payment_intent), "disputed");
    default:
      return ok();
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isPaymentsEnabled()) {
    if (!loggedDisabled) {
      loggedDisabled = true;
      console.warn(`${TAG} payments not configured — returning 503`);
    }
    return json({ error: "payments_unavailable" }, 503);
  }
  const secret = getWebhookSecret();
  const signature = req.headers.get("stripe-signature");
  if (!secret || !signature) return json({ error: "bad_signature" }, 400);

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(raw, signature, secret);
  } catch {
    return json({ error: "bad_signature" }, 400);
  }

  try {
    return await dispatch(event);
  } catch (err) {
    logLine("error", event, `db_error:${errorCodeOf(err)}`);
    return json({ error: "server_error" }, 500);
  }
}
