// Publish screen copy + small decisions (M6 T8). Pure + isomorphic (client and server), tested in
// node. The server actions in src/app/books/[id]/publish/actions.ts return stable codes; every
// user-facing sentence for them lives here.

import { LIMITS } from "@/lib/ai/limits";

/** Mirrors PublishBlockReason in src/lib/publish/rules.ts. */
export type PublishBlock = "invalid_doc" | "empty" | "page_limit" | "expired";

/** Mirrors PublishErrorCode in the publish actions. */
export type PublishError = "signed_out" | "not_found" | PublishBlock | "conflict" | "failed";

/** Mirrors SetPasswordErrorCode in the publish actions. */
export type PasswordError =
  | "signed_out"
  | "not_found"
  | "invalid_password"
  | "too_short"
  | "too_long"
  | "invalid_chars"
  /** Server can't issue access cookies (BOOK_ACCESS_SECRET missing) — setting a password would lock viewers out. */
  | "unavailable"
  | "failed";

/** Same bounds as src/lib/publish/password.ts (server-only); the server re-validates. */
export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 64;

export const EXPIRED_COPY = "This free link has expired — Upgrade to bring it back";
export const CONFLICT_COPY = "Something changed — try again";
export const PASSWORD_UNAVAILABLE_COPY = "Passwords aren't available right now — try again later";

/** Why Publish / Publish changes is disabled (getPublishState().canPublishReason). */
export function blockReasonCopy(reason: PublishBlock, maxPages: number = LIMITS.free.maxPages): string {
  switch (reason) {
    case "empty":
      return "Your book has no pages yet. Add some pages in the editor first.";
    case "page_limit":
      return `This book has more than ${maxPages} pages. Remove some pages in the editor, or upgrade.`;
    case "invalid_doc":
      return "Something in this book needs fixing before it can be published. Open the editor and check your pages.";
    case "expired":
      return EXPIRED_COPY;
  }
}

export function publishErrorCopy(code: PublishError, maxPages?: number): string {
  switch (code) {
    case "signed_out":
      return "You're signed out. Sign in again to continue.";
    case "not_found":
      return "We couldn't find this book.";
    case "conflict":
      return CONFLICT_COPY;
    case "failed":
      return "Couldn't publish right now. Check your connection and try again.";
    default:
      return blockReasonCopy(code, maxPages);
  }
}

export function unpublishErrorCopy(code: "signed_out" | "not_found" | "failed"): string {
  if (code === "signed_out") return publishErrorCopy("signed_out");
  if (code === "not_found") return publishErrorCopy("not_found");
  return "Couldn't unpublish right now. Try again.";
}

export function passwordErrorCopy(code: PasswordError): string {
  switch (code) {
    case "too_short":
      return `Use at least ${PASSWORD_MIN} characters.`;
    case "too_long":
      return `Use at most ${PASSWORD_MAX} characters.`;
    case "invalid_chars":
    case "invalid_password":
      return "That password has characters we can't use. Try letters, numbers and symbols.";
    case "signed_out":
      return publishErrorCopy("signed_out");
    case "not_found":
      return publishErrorCopy("not_found");
    case "unavailable":
      return PASSWORD_UNAVAILABLE_COPY;
    case "failed":
      return "Couldn't save the password. Try again.";
  }
}

/** Instant client-side length check (code points, like the server). null = looks fine. */
export function passwordLengthError(pw: string): "too_short" | "too_long" | null {
  const n = Array.from(pw).length;
  if (n < PASSWORD_MIN) return "too_short";
  if (n > PASSWORD_MAX) return "too_long";
  return null;
}

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dubai" });
const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });

/** "12 Dec" (adds the year when it isn't the current UAE year). "" for invalid input. */
export function formatShortDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const year = (x: Date) => new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: "Asia/Dubai" }).format(x);
  return year(d) === year(now) ? shortDate.format(d) : longDate.format(d);
}

/** "Permanent link" (paid) · "Link expires 12 Dec" · "Link expired 12 Dec" · null (no expiry yet). */
export function expiryLabel(args: { isPaid: boolean; expiresAt: string | null; expired: boolean; now?: Date }): string | null {
  if (args.isPaid) return "Permanent link";
  if (!args.expiresAt) return null;
  const date = formatShortDate(args.expiresAt, args.now);
  if (!date) return null;
  return args.expired ? `Link expired ${date}` : `Link expires ${date}`;
}

/** "photobook.ae/b/our-trip-…" — URL without scheme for display; the full URL is what gets copied. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** Editor header chip (D-039): published and the saved doc moved past the snapshot. */
export function hasUnpublishedChanges(publishedRev: number | null, currentRev: number | null): boolean {
  return publishedRev !== null && currentRev !== null && currentRev > publishedRev;
}

/** Delay before the one automatic retry after a publish `conflict`. */
export const CONFLICT_RETRY_MS = 800;

/**
 * Runs `publish`; on `conflict` (doc saved between read and write) waits and retries once.
 * A second conflict is returned to the caller ("Something changed — try again").
 */
export async function publishWithRetry<R extends { ok: boolean; error?: string }>(
  publish: () => Promise<R>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<R> {
  const first = await publish();
  if (first.ok || first.error !== "conflict") return first;
  await wait(CONFLICT_RETRY_MS);
  return publish();
}
