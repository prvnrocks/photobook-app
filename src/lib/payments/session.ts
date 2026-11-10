// Pure Checkout Session helpers (M7 T2): build the create params for the per-book upgrade and
// validate a Session (from the webhook event or a retrieve) before fulfilment.
// No Stripe client here (type-only import) — safe to unit-test and to import from server code.
// Never put the book title or other user text in metadata; the product name is generic.

import type Stripe from "stripe";
import { UPGRADE } from "@/lib/pricing";
import { isValidSlug } from "@/lib/publish/slug";

export const UPGRADE_METADATA_KIND = "book_upgrade" as const;
/**
 * Checkout Session lifetime. Stripe requires expires_at >= 30 min after ITS creation time; nowSec is
 * taken before the request, so exactly 30 min can be rejected under clock skew/latency — use 31.
 */
export const CHECKOUT_SESSION_TTL_SEC = 31 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Allow-listed, same-origin, relative return path for the Checkout cancel URL:
 * `/books/{bookId}/publish`, `/books/{bookId}/edit`, or `/b/{slug}` (owner's expired-book page).
 * Anything else (absolute URLs, `//host`, backslashes, other books, query/hash, encoded tricks)
 * falls back to `/books/{bookId}/publish`.
 */
export function safeReturnPath(returnTo: unknown, bookId: string): string {
  const fallback = `/books/${bookId}/publish`;
  if (typeof returnTo !== "string" || returnTo.length === 0 || returnTo.length > 200) return fallback;
  // Exact-match only: no scheme, no protocol-relative, no backslash, no query/hash, no encoding.
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || /[\\?#%\s]/.test(returnTo)) return fallback;
  if (returnTo === `/books/${bookId}/publish` || returnTo === `/books/${bookId}/edit`) return returnTo;
  const m = /^\/b\/([^/]+)$/.exec(returnTo);
  if (m && isValidSlug(m[1])) return returnTo;
  return fallback;
}

/** `https://host[:port]` with no path, or throws. Use the server's configured app URL. */
function normalizeOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("buildCheckoutParams: invalid origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("buildCheckoutParams: invalid origin");
  return url.origin;
}

export interface BuildCheckoutInput {
  bookId: string;
  userId: string;
  /** Prefilled on Checkout (customer_email); omitted when empty. */
  email?: string | null;
  /** Accepted for API symmetry but NOT sent to Stripe (user text stays out of Stripe). */
  bookTitle?: string | null;
  /** Trusted app origin (NEXT_PUBLIC_APP_URL), never a request header. */
  origin: string;
  /** Where the user started; filtered through safeReturnPath. */
  returnTo?: string | null;
  /** Current unix time in seconds (injected for tests). */
  nowSec: number;
}

export function buildCheckoutParams(input: BuildCheckoutInput): Stripe.Checkout.SessionCreateParams {
  const { bookId, userId, email, nowSec } = input;
  if (!isUuid(bookId) || !isUuid(userId)) throw new Error("buildCheckoutParams: invalid ids");
  if (!Number.isInteger(nowSec) || nowSec <= 0) throw new Error("buildCheckoutParams: invalid nowSec");
  const origin = normalizeOrigin(input.origin);
  const metadata = { kind: UPGRADE_METADATA_KIND, book_id: bookId, user_id: userId };
  const cancelPath = safeReturnPath(input.returnTo, bookId);
  const trimmedEmail = typeof email === "string" ? email.trim() : "";

  return {
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: UPGRADE.currency,
          unit_amount: UPGRADE.amount,
          product_data: { name: UPGRADE.productName },
        },
      },
    ],
    ...(trimmedEmail ? { customer_email: trimmedEmail } : {}),
    client_reference_id: bookId,
    metadata,
    payment_intent_data: { metadata },
    expires_at: nowSec + CHECKOUT_SESSION_TTL_SEC,
    success_url: `${origin}/books/${bookId}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${cancelPath}?upgrade=cancelled`,
  };
}

/** The Session fields the validator reads (a full Stripe.Checkout.Session satisfies this). */
export type CheckoutSessionLike = Pick<
  Stripe.Checkout.Session,
  | "id"
  | "mode"
  | "payment_status"
  | "currency"
  | "amount_total"
  | "metadata"
  | "client_reference_id"
  | "payment_intent"
  | "livemode"
>;

export type SessionRejectReason =
  | "not_payment_mode"
  | "not_paid"
  | "wrong_currency"
  | "wrong_amount"
  | "wrong_kind"
  | "invalid_book_id"
  | "invalid_user_id"
  | "reference_mismatch";

export interface UpgradeSessionInfo {
  bookId: string;
  userId: string;
  sessionId: string;
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  livemode: boolean;
  paymentStatus: Stripe.Checkout.Session.PaymentStatus;
}

export type ValidateResult =
  | ({ ok: true } & UpgradeSessionInfo)
  | { ok: false; reason: SessionRejectReason };

/**
 * Checks that a Session is OUR book upgrade, ignoring payment_status: payment mode, AED,
 * amount_total === 3900, metadata.kind, UUID book/user ids, client_reference_id === book_id.
 * Use it to recognise pending (payment_status 'unpaid', async methods) sessions.
 *
 * amount_total (not amount_subtotal) is checked: it is what was actually charged. With no tax,
 * discounts or shipping configured both are 3900; if a discount ever slips in, amount_total drops
 * and fulfilment is refused rather than granting a paid book for less.
 */
export function validateUpgradeSession(session: CheckoutSessionLike): ValidateResult {
  if (session.mode !== "payment") return { ok: false, reason: "not_payment_mode" };
  if ((session.currency ?? "").toLowerCase() !== UPGRADE.currency) return { ok: false, reason: "wrong_currency" };
  if (session.amount_total !== UPGRADE.amount) return { ok: false, reason: "wrong_amount" };
  const md = session.metadata ?? {};
  if (md.kind !== UPGRADE_METADATA_KIND) return { ok: false, reason: "wrong_kind" };
  if (!isUuid(md.book_id)) return { ok: false, reason: "invalid_book_id" };
  if (!isUuid(md.user_id)) return { ok: false, reason: "invalid_user_id" };
  if (session.client_reference_id !== md.book_id) return { ok: false, reason: "reference_mismatch" };
  const pi = session.payment_intent;
  return {
    ok: true,
    bookId: md.book_id.toLowerCase(),
    userId: md.user_id.toLowerCase(),
    sessionId: session.id,
    paymentIntentId: typeof pi === "string" ? pi : (pi?.id ?? null),
    amount: session.amount_total,
    currency: UPGRADE.currency,
    livemode: session.livemode,
    paymentStatus: session.payment_status,
  };
}

/** validateUpgradeSession + payment_status === 'paid'. The only gate before fulfilment. */
export function validatePaidSession(session: CheckoutSessionLike): ValidateResult {
  const r = validateUpgradeSession(session);
  if (!r.ok) return r;
  if (r.paymentStatus !== "paid") return { ok: false, reason: "not_paid" };
  return r;
}

/** True for a valid upgrade session still awaiting an async payment (payment_status 'unpaid'). */
export function isPendingUpgradeSession(session: CheckoutSessionLike): boolean {
  const r = validateUpgradeSession(session);
  return r.ok && r.paymentStatus === "unpaid";
}
