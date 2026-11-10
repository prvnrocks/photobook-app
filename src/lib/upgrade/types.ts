// Result types for the upgrade server actions (M7 T5, src/app/books/[id]/upgrade/actions.ts).
// Pure types/constants — safe in client components ("use server" files may only export async
// functions, and client code must not import src/lib/payments/*, see tests/boundaries.test.ts).
// Copy-neutral: the UI maps codes to its own strings.

export const START_UPGRADE_ERROR_CODES = [
  "unauthenticated",
  "not_found",
  "already_paid",
  /** Payments not configured on this deploy (no Stripe keys) → "Payments unavailable". */
  "unavailable",
  "failed",
] as const;

export type StartUpgradeErrorCode = (typeof START_UPGRADE_ERROR_CODES)[number];

/**
 * `url` is absolute: a Stripe Checkout URL, or — when the stored session already completed and the
 * payment is still being confirmed — this app's `/books/{id}/upgrade/success?session_id=…` page.
 * Navigate with `window.location.assign(url)`.
 */
export type StartUpgradeCheckoutResult = { url: string } | { error: StartUpgradeErrorCode };

export const ORDER_STATUSES = ["none", "pending", "paid", "failed", "expired", "refunded", "disputed"] as const;

/** Latest order for the book; 'none' when there is no order yet. */
export type UpgradeOrderStatus = (typeof ORDER_STATUSES)[number];

/** failed = DB read error (retry the poll). */
export type UpgradeStatusErrorCode = "unauthenticated" | "not_found" | "failed";

/**
 * isPaid is the live books.is_paid (only the Stripe webhook writes it). Poll until isPaid is true;
 * orderStatus 'failed' / 'expired' means the attempt ended without payment.
 */
export type UpgradeStatusResult =
  | { isPaid: boolean; orderStatus: UpgradeOrderStatus }
  | { error: UpgradeStatusErrorCode };
