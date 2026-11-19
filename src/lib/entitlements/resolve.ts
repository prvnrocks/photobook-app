// Entitlement resolution (Task 9) — pure. What a book may do, from server-side facts only:
//
//   books.is_paid        set ONLY by the Stripe webhook (fulfill_book_checkout) or comp_book
//   orders.status        'paid' (Stripe) | 'comped' (admin comp) — tells the source of is_paid
//   book_entitlements    an active authorized grant (support / tester / promotion; migration 2900)
//
// tier "full"    → full storybook generation (all chapters, up to the book's page limit)
// tier "preview" → a 4–6 page storybook preview only
// canExportPdf   → ONLY a paid / comped book (is_paid). A grant never unlocks the PDF, the
//                  watermark-free viewer or the permanent link.
//
// The client never supplies any of these facts.

import { LIMITS, limitsFor } from "@/lib/ai/limits";
import { readPreviewConfig, type PreviewConfig } from "./preview";

export type EntitlementTier = "preview" | "full";
export type EntitlementSource = "stripe" | "comp" | "grant" | "none";

export type BookEntitlement = {
  bookId: string;
  tier: EntitlementTier;
  source: EntitlementSource;
  /** books.is_paid (paid or comped). */
  isPaid: boolean;
  /** PDF export (and every other paid-only output) — is_paid only, never a grant. */
  canExportPdf: boolean;
  limits: {
    /** books.max_pages (20 free / 100 paid; the DB trigger enforces it). A grant: the paid limit (Task 10). */
    maxPages: number;
    /** Interior pages of a storybook preview (meaningful when tier = preview). */
    previewPages: number;
    /** Live preview generations per book. */
    maxPreviewRuns: number;
    /** USD ceiling of one album run (D-035), by paid status. */
    maxRunCostUsd: number;
  };
};

export type EntitlementFacts = {
  bookId: string;
  isPaid: boolean;
  maxPages: number | null;
  /** Newest order status of the book that made it paid ('paid' | 'comped' | other / null). */
  orderStatus: string | null;
  hasActiveGrant: boolean;
};

export function resolveEntitlement(f: EntitlementFacts, preview: PreviewConfig = readPreviewConfig()): BookEntitlement {
  const isPaid = f.isPaid === true;
  const source: EntitlementSource = isPaid ? (f.orderStatus === "comped" ? "comp" : "stripe") : f.hasActiveGrant ? "grant" : "none";
  const limits = limitsFor(isPaid);
  const stored = typeof f.maxPages === "number" && Number.isFinite(f.maxPages) && f.maxPages > 0 ? Math.floor(f.maxPages) : limits.maxPages;
  // Task 10: a full grant composes the whole storybook, so it gets the paid page limit (books.max_pages
  // is raised to match by grantBookEntitlement / ensureGrantPageLimit). PDF / watermark / permanent
  // link stay is_paid-only (D-093).
  const maxPages = source === "grant" ? Math.max(stored, LIMITS.paid.maxPages) : stored;
  return {
    bookId: f.bookId,
    tier: source === "none" ? "preview" : "full",
    source,
    isPaid,
    canExportPdf: isPaid,
    limits: { maxPages, previewPages: preview.pages, maxPreviewRuns: preview.maxRuns, maxRunCostUsd: limits.maxRunCostUsd },
  };
}
