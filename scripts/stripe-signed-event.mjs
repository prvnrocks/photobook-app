#!/usr/bin/env node
// Signed Stripe webhook events for local / e2e testing (M7 T8) — no Stripe account or network needed.
//
// Builds a Stripe event JSON shaped like the real thing for the per-book upgrade, signs it with
// STRIPE_WEBHOOK_SECRET (stripe.webhooks.generateTestHeaderString — the same scheme Stripe uses), and
// POSTs it to <url>/api/stripe/webhook. Prints the HTTP status only (ids with --verbose).
//
// The server under test must run with the SAME STRIPE_WEBHOOK_SECRET (and any non-empty
// STRIPE_SECRET_KEY, e.g. sk_test_dummy — the webhook path never calls the Stripe API).
// If STRIPE_WEBHOOK_SECRET is not in the environment, .env.local is loaded (when present).
//
// Usage:
//   STRIPE_WEBHOOK_SECRET=whsec_... node scripts/stripe-signed-event.mjs \
//     --book <uuid> --user <uuid> [--type completed] [--amount 3900] [--currency aed] \
//     [--session cs_test_x] [--pi pi_test_x] [--event evt_test_x] [--payment-status paid] \
//     [--url http://localhost:3000] [--tamper] [--verbose]
//
// --type: completed | async_succeeded | async_failed | expired | refunded | partial_refund | disputed
//   completed / async_*: checkout.session.* for book/user/amount/currency (metadata kind book_upgrade)
//   expired:             checkout.session.expired (payment_status unpaid) for --session
//   refunded:            charge.refunded, amount_refunded = amount (full) for --pi
//   partial_refund:      charge.refunded, amount_refunded = amount - 100
//   disputed:            charge.dispute.created for --pi
// --tamper: signs the payload, then changes the body (expect 400).
// Re-send the SAME --event id to test idempotency.
//
// Also importable (e2e/payments.spec.ts): buildEvent, signPayload, postEvent.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import Stripe from "stripe";

export const EVENT_TYPES = {
  completed: "checkout.session.completed",
  async_succeeded: "checkout.session.async_payment_succeeded",
  async_failed: "checkout.session.async_payment_failed",
  expired: "checkout.session.expired",
  refunded: "charge.refunded",
  partial_refund: "charge.refunded",
  disputed: "charge.dispute.created",
};

const API_VERSION = "2026-10-28.endive";

export function randomId(prefix) {
  return `${prefix}_test_${randomBytes(12).toString("hex")}`;
}

/**
 * @param {{ type?: keyof typeof EVENT_TYPES, bookId?: string, userId?: string, amount?: number,
 *   currency?: string, sessionId?: string, paymentIntentId?: string, eventId?: string,
 *   paymentStatus?: string, livemode?: boolean }} o
 * @returns {{ id: string, type: string, sessionId: string, paymentIntentId: string, payload: string }}
 */
export function buildEvent(o = {}) {
  const kind = o.type ?? "completed";
  const type = EVENT_TYPES[kind];
  if (!type) throw new Error(`unknown --type ${kind}`);
  const amount = o.amount ?? 3900;
  const currency = (o.currency ?? "aed").toLowerCase();
  const sessionId = o.sessionId ?? randomId("cs");
  const paymentIntentId = o.paymentIntentId ?? randomId("pi");
  const id = o.eventId ?? randomId("evt");
  const livemode = o.livemode ?? false;
  const created = Math.floor(Date.now() / 1000);

  let object;
  if (kind === "completed" || kind === "async_succeeded" || kind === "async_failed" || kind === "expired") {
    if (kind !== "expired" && (!o.bookId || !o.userId)) throw new Error("--book and --user are required");
    const paymentStatus =
      o.paymentStatus ?? (kind === "completed" || kind === "async_succeeded" ? "paid" : "unpaid");
    object = {
      id: sessionId,
      object: "checkout.session",
      mode: "payment",
      status: kind === "expired" ? "expired" : "complete",
      payment_status: paymentStatus,
      currency,
      amount_total: amount,
      amount_subtotal: amount,
      client_reference_id: o.bookId ?? null,
      metadata: { kind: "book_upgrade", book_id: o.bookId ?? "", user_id: o.userId ?? "" },
      payment_intent: kind === "expired" ? null : paymentIntentId,
      customer_email: null,
      livemode,
      created,
      expires_at: created + 31 * 60,
    };
  } else if (kind === "refunded" || kind === "partial_refund") {
    object = {
      id: randomId("ch"),
      object: "charge",
      amount,
      amount_refunded: kind === "refunded" ? amount : Math.max(0, amount - 100),
      currency,
      refunded: kind === "refunded",
      payment_intent: paymentIntentId,
      livemode,
      created,
    };
  } else {
    object = {
      id: randomId("dp"),
      object: "dispute",
      amount,
      currency,
      charge: randomId("ch"),
      payment_intent: paymentIntentId,
      reason: "general",
      status: "needs_response",
      livemode,
      created,
    };
  }

  const payload = JSON.stringify({
    id,
    object: "event",
    api_version: API_VERSION,
    created,
    livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  });
  return { id, type, sessionId, paymentIntentId, payload };
}

let signer = null;
/**
 * Stripe-Signature header for payload (t=…,v1=…). No network: the key is never used.
 * @param {string} payload
 * @param {string | undefined} secret
 * @returns {string}
 */
export function signPayload(payload, secret) {
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  signer ??= new Stripe("sk_test_signing_only_not_used");
  return signer.webhooks.generateTestHeaderString({ payload, secret });
}

/**
 * POSTs a payload to <baseURL>/api/stripe/webhook with a valid signature (or a tampered body).
 * @param {{ baseURL: string, payload: string, secret?: string, tamper?: boolean, signature?: string }} o
 * @returns {Promise<number>} HTTP status
 */
export async function postEvent({ baseURL, payload, secret, tamper = false, signature }) {
  const header = signature ?? signPayload(payload, secret);
  const body = tamper ? payload.replace('"amount_total":', '"amount_total": ') + " " : payload;
  const res = await fetch(new URL("/api/stripe/webhook", baseURL), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", "stripe-signature": header },
    body,
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "tamper" || key === "verbose" || key === "livemode") {
      out[key] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${a}`);
    out[key] = v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    const envFile = path.join(process.cwd(), ".env.local");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set (env or .env.local)");
  const amount = args.amount === undefined ? undefined : Number(args.amount);
  if (amount !== undefined && !Number.isInteger(amount)) throw new Error("--amount must be an integer (minor units)");
  const ev = buildEvent({
    type: args.type ?? "completed",
    bookId: args.book,
    userId: args.user,
    amount,
    currency: args.currency,
    sessionId: args.session,
    paymentIntentId: args.pi,
    eventId: args.event,
    paymentStatus: args["payment-status"],
    livemode: args.livemode === true,
  });
  const status = await postEvent({
    baseURL: args.url ?? "http://localhost:3000",
    payload: ev.payload,
    secret,
    tamper: args.tamper === true,
  });
  console.log(args.verbose ? `${status} ${ev.type} evt=${ev.id} cs=${ev.sessionId} pi=${ev.paymentIntentId}` : String(status));
  if (status >= 500) process.exitCode = 1;
}

// No import.meta: Playwright transpiles this file to CommonJS when the e2e spec imports it.
if (process.argv[1] && path.basename(process.argv[1]) === "stripe-signed-event.mjs") {
  main().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  });
}
