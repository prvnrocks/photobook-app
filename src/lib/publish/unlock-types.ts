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

/** Rate limits passed to try_book_unlock: per ip (any book) within the window; per book per hour. */
export const UNLOCK_IP_LIMIT = 10;
export const UNLOCK_BOOK_LIMIT = 100;
export const UNLOCK_WINDOW_SECONDS = 900;
