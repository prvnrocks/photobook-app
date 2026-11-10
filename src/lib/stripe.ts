import "server-only";

// Stripe server client (M7): Checkout for the AED 39 per-book upgrade + webhook signature
// verification. Only the verified webhook ever sets books.is_paid (CLAUDE.md).
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are read only here.

import Stripe from "stripe";

/** Pinned API version — the one the installed SDK (stripe@23.1.0) types are generated for. */
export const STRIPE_API_VERSION = "2026-10-28.endive" as const;

function readEnv(name: "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET"): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

export type StripeKeyMode = "live" | "test";

/**
 * Mode implied by the configured secret key: `sk_live_…` / `rk_live_…` → "live", anything else
 * (sk_test_ / rk_test_ / unset) → "test". Webhook events whose `livemode` differs are ignored.
 */
export function stripeKeyMode(): StripeKeyMode {
  const key = readEnv("STRIPE_SECRET_KEY") ?? "";
  return key.startsWith("sk_live_") || key.startsWith("rk_live_") ? "live" : "test";
}

/**
 * Payments are on only when BOTH the secret key and the webhook secret are configured — and, on
 * Vercel Production (VERCEL_ENV=production), only with a live key unless STRIPE_ALLOW_TEST_IN_PROD=1
 * (so a test key in Production can't hand out paid books for test cards).
 */
export function isPaymentsEnabled(): boolean {
  if (readEnv("STRIPE_SECRET_KEY") === null || readEnv("STRIPE_WEBHOOK_SECRET") === null) return false;
  if (
    process.env.VERCEL_ENV === "production" &&
    stripeKeyMode() !== "live" &&
    process.env.STRIPE_ALLOW_TEST_IN_PROD?.trim() !== "1"
  ) {
    return false;
  }
  return true;
}

/** Webhook signing secret (whsec_…), or null when unset. */
export function getWebhookSecret(): string | null {
  return readEnv("STRIPE_WEBHOOK_SECRET");
}

let client: Stripe | null = null;

/**
 * Lazy singleton. Throws when payments are not configured — callers should check
 * isPaymentsEnabled() first and show "Payments unavailable".
 */
export function getStripe(): Stripe {
  if (client) return client;
  const key = readEnv("STRIPE_SECRET_KEY");
  if (!key || !isPaymentsEnabled()) throw new Error("Stripe is not configured");
  client = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    typescript: true,
    appInfo: { name: "photobook-app" },
  });
  return client;
}
