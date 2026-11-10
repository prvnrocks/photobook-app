// Result of the /b/[slug] password unlock server action (D-040). Pure types + constants — safe to
// import from client components (a "use server" file may only export async functions).

export type UnlockErrorCode =
  /** Input was not a usable password string (missing / empty / absurdly long). */
  | "invalid_input"
  /** Slug is malformed. (A well-formed slug that matches no locked book answers wrong_password.) */
  | "not_found"
  /** BOOK_ACCESS_SECRET is not configured on the server. */
  | "unavailable"
  /** Too many attempts from this network or on this book — try again later. */
  | "rate_limited"
  | "wrong_password";

export type UnlockResult = { ok: true } | { ok: false; error: UnlockErrorCode };

/**
 * Rate limits passed to try_book_unlock: per ip bucket (any book) within the window; per book per
 * hour. Successful unlocks clear their own attempt (clear_unlock_attempt, migration 1100), so these
 * effectively count FAILED attempts only — a wedding group on one wifi / CGNAT who know the password
 * never trip them. (Before 1100 is applied, successes still count.)
 */
export const UNLOCK_IP_LIMIT = 10;
/** Failed attempts per book per hour, across all ips. */
export const UNLOCK_BOOK_LIMIT = 30;
export const UNLOCK_WINDOW_SECONDS = 900;
