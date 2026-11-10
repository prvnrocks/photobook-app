// Upgrade button UI logic (M7 T6). Pure — safe in client components and unit tests.
// Maps startUpgradeCheckout() results to copy and side effects; the component only renders.

import { UPGRADE } from "@/lib/pricing";
import type { StartUpgradeCheckoutResult, StartUpgradeErrorCode } from "./types";

/** Default button label: "Upgrade this book — AED 39". */
export const UPGRADE_BUTTON_LABEL = `Upgrade this book — ${UPGRADE.label}`;

/** Shown under the disabled button when Stripe isn't configured on this deploy. */
export const PAYMENTS_UNAVAILABLE_HINT = "Payments unavailable";

/** Banner after Stripe Checkout's cancel URL (?upgrade=cancelled). */
export const UPGRADE_CANCELLED_COPY = "Payment cancelled — you haven't been charged.";

/** Query param + value Stripe's cancel_url appends (src/lib/payments/session.ts). */
export const UPGRADE_CANCELLED_PARAM = "upgrade";
export const UPGRADE_CANCELLED_VALUE = "cancelled";

export function upgradeErrorCopy(code: StartUpgradeErrorCode): string {
  switch (code) {
    case "already_paid":
      return "This book is already upgraded";
    case "unavailable":
      return "Payments aren't available right now";
    case "unauthenticated":
      return "Please sign in again";
    case "needs_review":
      return "Something went wrong with an earlier payment for this book. We'll sort it out — contact support and mention this book.";
    default:
      return "Couldn't start payment — try again";
  }
}

export type UpgradeOutcome =
  | { kind: "navigating"; url: string }
  | { kind: "error"; code: StartUpgradeErrorCode; text: string };

/**
 * Runs the checkout action and applies its side effects:
 *  - {url}           → navigate(url) (the caller keeps its busy state until the page unloads)
 *  - already_paid    → refresh() so the server re-renders the page as paid
 *  - any error / throw → an inline message
 */
export async function runUpgradeCheckout(deps: {
  start: () => Promise<StartUpgradeCheckoutResult>;
  navigate: (url: string) => void;
  refresh: () => void;
}): Promise<UpgradeOutcome> {
  let r: StartUpgradeCheckoutResult;
  try {
    r = await deps.start();
  } catch {
    r = { error: "failed" };
  }
  if ("url" in r && typeof r.url === "string" && r.url.length > 0) {
    deps.navigate(r.url);
    return { kind: "navigating", url: r.url };
  }
  const code: StartUpgradeErrorCode = "error" in r ? r.error : "failed";
  if (code === "already_paid") deps.refresh();
  return { kind: "error", code, text: upgradeErrorCopy(code) };
}

/** Current path + query without ?upgrade=cancelled (other params kept). */
export function stripUpgradeCancelled(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(UPGRADE_CANCELLED_PARAM);
  const q = params.toString();
  return q ? `${pathname}?${q}` : pathname;
}
