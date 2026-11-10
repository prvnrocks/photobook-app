"use server";

// Upgrade actions (M7 T5): start (or reuse) the AED 39 Stripe Checkout for one book, and read
// the upgrade status for the success page. These NEVER fulfil — only the verified Stripe webhook
// sets books.is_paid (CLAUDE.md). Logs carry error codes only: never emails, titles or ids.
// Result types live in src/lib/upgrade/types.ts ("use server" files export only async functions).

import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getSiteUrl } from "@/lib/auth/redirect";
import {
  findPendingOrder,
  getLatestOrderStatus,
  getUpgradeTarget,
  insertPendingOrder,
  markOrderExpired,
} from "@/lib/db/upgrade";
import { errorCodeOf } from "@/lib/http/json";
import { buildCheckoutParams, validateUpgradeSession } from "@/lib/payments/session";
import { UPGRADE } from "@/lib/pricing";
import { getStripe, isPaymentsEnabled } from "@/lib/stripe";
import type { StartUpgradeCheckoutResult, UpgradeStatusResult } from "@/lib/upgrade/types";
import { isUuid } from "@/lib/uuid";

/** A stored open session is reused only if it stays open for at least this long. */
const REUSE_MIN_REMAINING_SEC = 5 * 60;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Safe log code for Stripe / DB errors (code, else the Stripe error type). */
function logCode(err: unknown): string {
  const code = errorCodeOf(err);
  if (code !== "unknown") return code;
  if (err && typeof err === "object" && "type" in err && typeof err.type === "string") {
    return err.type.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
  }
  return "unknown";
}

function isMissingResource(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    err.code === "resource_missing"
  );
}

/** Best effort: a failure only means the session will expire on its own (≤ 31 min). */
async function expireQuietly(stripe: Stripe, sessionId: string): Promise<void> {
  try {
    await stripe.checkout.sessions.expire(sessionId);
  } catch (err) {
    console.warn(`[upgrade] expire session failed (${logCode(err)})`);
  }
}

function successUrl(origin: string, bookId: string, sessionId: string): string {
  return `${origin}/books/${bookId}/upgrade/success?session_id=${encodeURIComponent(sessionId)}`;
}

/**
 * Reuse the book's pending order if its Checkout Session is still usable:
 *  - open, ours, and > 5 min left           → its Checkout URL
 *  - complete (payment may still be processing) → our success page
 *  - anything else (expired, near expiry, gone, not ours) → expire it at Stripe when still open
 *    (best effort), mark the order expired, return null so the caller creates a new one.
 */
async function tryReuse(
  stripe: Stripe,
  bookId: string,
  userId: string,
  origin: string,
): Promise<{ url: string } | null> {
  const pending = await findPendingOrder(bookId);
  if (!pending) return null;
  if (!pending.sessionId) {
    await markOrderExpired(pending.id);
    return null;
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(pending.sessionId);
  } catch (err) {
    if (!isMissingResource(err)) throw err;
    await markOrderExpired(pending.id);
    return null;
  }

  const v = validateUpgradeSession(session);
  const ours = v.ok && v.bookId === bookId && v.userId === userId;

  if (ours && session.status === "complete") return { url: successUrl(origin, bookId, session.id) };
  if (ours && session.status === "open" && session.url && session.expires_at > nowSec() + REUSE_MIN_REMAINING_SEC) {
    return { url: session.url };
  }
  if (session.status === "open") await expireQuietly(stripe, session.id);
  await markOrderExpired(pending.id);
  return null;
}

/**
 * Idempotency key for sessions.create: same book + user + minute bucket + identical params →
 * Stripe returns the SAME session (stops double-click duplicates). Params are hashed so the key
 * carries no email; different params (e.g. another returnTo) get a different key instead of a
 * Stripe idempotency error.
 */
function idempotencyKey(bookId: string, userId: string, bucket: number, params: Stripe.Checkout.SessionCreateParams): string {
  const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 24);
  return `upgrade:${bookId}:${userId}:${bucket}:${digest}`;
}

/**
 * Starts the upgrade Checkout for one of the signed-in user's books and returns the URL to
 * navigate to. Reuses the book's open session when possible (one pending order per book).
 * Errors: unauthenticated | not_found (bad id / not the owner's) | already_paid | unavailable
 * (Stripe not configured) | failed.
 */
export async function startUpgradeCheckout(bookId: string, returnTo?: string): Promise<StartUpgradeCheckoutResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "unauthenticated" };
  if (!isUuid(bookId)) return { error: "not_found" };
  const id = bookId.toLowerCase();
  const userId = user.id.toLowerCase();

  try {
    const target = await getUpgradeTarget(id, userId);
    if (!target) return { error: "not_found" };
    if (target.isPaid) return { error: "already_paid" };
    if (!isPaymentsEnabled()) return { error: "unavailable" };

    const origin = getSiteUrl(); // NEXT_PUBLIC_APP_URL (never request headers); throws in prod if unset
    const stripe = getStripe();

    const reused = await tryReuse(stripe, id, userId, origin);
    if (reused) return reused;

    // Round up to the end of the current minute: identical params (incl. expires_at) for every
    // click in this minute, and expires_at stays 31–32 min ahead (Stripe needs ≥ 30, ≤ 24 h).
    const bucket = Math.ceil(nowSec() / 60) * 60;
    const params = buildCheckoutParams({
      bookId: id,
      userId,
      email: user.email ?? null,
      origin,
      returnTo: typeof returnTo === "string" ? returnTo : null,
      nowSec: bucket,
    });
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: idempotencyKey(id, userId, bucket, params),
    });
    if (!session.url) {
      console.error("[upgrade] created session has no url");
      return { error: "failed" };
    }

    const inserted = await insertPendingOrder({
      bookId: id,
      userId,
      sessionId: session.id,
      amount: session.amount_total ?? UPGRADE.amount,
      currency: session.currency ?? UPGRADE.currency,
      livemode: session.livemode,
    });
    if (inserted.ok) return { url: session.url };

    // pending_exists: an idempotent replay of a click already stored (same session) → use it;
    // otherwise a parallel request won → drop ours and reuse theirs (once).
    const winner = await findPendingOrder(id);
    if (winner?.sessionId === session.id) return { url: session.url };
    await expireQuietly(stripe, session.id);
    const again = await tryReuse(stripe, id, userId, origin);
    if (again) return again;
    console.error("[upgrade] pending order race unresolved");
    return { error: "failed" };
  } catch (err) {
    console.error(`[upgrade] checkout failed (${logCode(err)})`);
    return { error: "failed" };
  }
}

/**
 * Owner-only upgrade status for the success page / polling: live books.is_paid plus the newest
 * order's status. Read-only — it never fulfils (the webhook is the only writer).
 */
export async function getUpgradeStatus(bookId: string): Promise<UpgradeStatusResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "unauthenticated" };
  if (!isUuid(bookId)) return { error: "not_found" };
  const id = bookId.toLowerCase();
  const userId = user.id.toLowerCase();
  try {
    const target = await getUpgradeTarget(id, userId);
    if (!target) return { error: "not_found" };
    const orderStatus = await getLatestOrderStatus(id, userId);
    return { isPaid: target.isPaid, orderStatus };
  } catch (err) {
    console.error(`[upgrade-status] failed (${logCode(err)})`);
    return { error: "failed" };
  }
}
