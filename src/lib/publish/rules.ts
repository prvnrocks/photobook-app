// Publish rules (D-002, D-039). Pure + isomorphic; dates in, ISO strings / booleans out.
// - Free books: link expires 30 days after FIRST publish; republish/unpublish never extends it.
// - Paid books (books.is_paid, set only by the Stripe webhook): never expire.

import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";

export const FREE_LINK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type DateInput = Date | string | null | undefined;

/** Epoch ms, NaN for invalid input, null for null/undefined/"" . */
function toMs(d: DateInput): number | null {
  if (d === null || d === undefined || d === "") return null;
  const ms = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * `books.expires_at` to write on publish: null when paid; the existing value when already set
 * (never extended); otherwise now + 30 days. An unparsable existing value fails closed (epoch 0,
 * i.e. expired) instead of granting a fresh 30 days.
 */
export function nextExpiry(args: { isPaid: boolean; existingExpiresAt: DateInput; now: Date }): string | null {
  if (args.isPaid) return null;
  const existing = toMs(args.existingExpiresAt);
  if (existing !== null) return new Date(Number.isNaN(existing) ? 0 : existing).toISOString();
  return new Date(args.now.getTime() + FREE_LINK_DAYS * DAY_MS).toISOString();
}

/** Paid → never; no expiry → not expired; unparsable expiry → expired (fail closed). */
export function isExpired(args: { isPaid: boolean; expiresAt: DateInput; now: Date }): boolean {
  if (args.isPaid) return false;
  const ms = toMs(args.expiresAt);
  if (ms === null) return false;
  if (Number.isNaN(ms)) return true;
  return ms <= args.now.getTime();
}

export type PublishBlockReason = "invalid_doc" | "empty" | "page_limit" | "expired";
export type CanPublishResult = { ok: true; doc: BookDoc } | { ok: false; reason: PublishBlockReason };

/**
 * Whether the saved doc may be (re)published. Checked in this order: expired (free link past its
 * 30 days → "Upgrade to bring it back"), invalid_doc (fails parseBookDoc), empty (0 pages),
 * page_limit (> maxPages, which the caller takes from books.max_pages / limitsFor(isPaid)).
 * Semantic checks (photo ownership, layouts) stay with validateBookDoc in the route.
 */
export function canPublish(args: {
  doc: unknown;
  maxPages: number;
  isPaid: boolean;
  expiresAt: DateInput;
  now: Date;
}): CanPublishResult {
  if (isExpired({ isPaid: args.isPaid, expiresAt: args.expiresAt, now: args.now })) {
    return { ok: false, reason: "expired" };
  }
  const parsed = parseBookDoc(args.doc);
  if (!parsed.ok) return { ok: false, reason: "invalid_doc" };
  if (parsed.doc.pages.length < 1) return { ok: false, reason: "empty" };
  if (parsed.doc.pages.length > args.maxPages) return { ok: false, reason: "page_limit" };
  return { ok: true, doc: parsed.doc };
}
