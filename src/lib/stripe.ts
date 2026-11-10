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

/** Payments are on only when BOTH the secret key and the webhook secret are configured. */
export function isPaymentsEnabled(): boolean {
  return readEnv("STRIPE_SECRET_KEY") !== null && readEnv("STRIPE_WEBHOOK_SECRET") !== null;
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
