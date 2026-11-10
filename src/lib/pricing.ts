// Upgrade price (CLAUDE.md: AED 39 one-time per book, VAT-inclusive, no Stripe Tax).
// Pure data — safe in client and server code. No secrets here.

import { APP_NAME } from "./brand";

export const UPGRADE = {
  /** Minor units (fils). */
  amount: 3900,
  /** Stripe currency code (lowercase). */
  currency: "aed",
  label: "AED 39",
  /** Generic product name shown on Checkout and receipts (never the book title). */
  productName: `${APP_NAME} book upgrade`,
} as const;
