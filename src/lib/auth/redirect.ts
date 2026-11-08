// Pure helpers for auth redirects. No next/supabase imports so they are
// unit-testable and safe in middleware, route handlers and server actions.

export const DEFAULT_NEXT_PATH = "/dashboard";

// Control chars (C0 + DEL + C1) and any whitespace.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\s]/;

function isSafeRelativePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  if (UNSAFE_CHARS.test(path)) return false;
  return true;
}

// Paths that would cause a redirect loop after login.
function isAuthPath(path: string): boolean {
  return /^\/(login|auth)(?:[/?#]|$)/i.test(path);
}

/**
 * Returns `next` only if it is a same-origin relative path ("/foo?x=1").
 * Rejects protocol-relative URLs, backslash tricks, schemes, control chars,
 * whitespace, percent-encoded variants (decoded once), and /login or /auth/*.
 * Anything else falls back to "/dashboard".
 */
export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) {
    return DEFAULT_NEXT_PATH;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return DEFAULT_NEXT_PATH;
  }

  for (const candidate of [next, decoded]) {
    if (!isSafeRelativePath(candidate)) return DEFAULT_NEXT_PATH;
    if (isAuthPath(candidate)) return DEFAULT_NEXT_PATH;
  }

  // Belt and braces: resolving against a dummy origin must stay on it.
  try {
    const base = "http://placeholder.invalid";
    if (new URL(next, base).origin !== base) return DEFAULT_NEXT_PATH;
  } catch {
    return DEFAULT_NEXT_PATH;
  }

  return next;
}

/** True for /dashboard, /books and their subpaths (not "/booksfoo"). */
export function isProtectedPath(pathname: string): boolean {
  return /^\/(dashboard|books)(?:\/|$)/.test(pathname);
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export const MISSING_APP_URL_ERROR =
  "NEXT_PUBLIC_APP_URL must be set in production (e.g. https://your-domain.ae). " +
  "Refusing to build auth redirect links from request headers.";

/**
 * Public base URL for links in emails / OAuth redirects.
 * NEXT_PUBLIC_APP_URL wins. In production it is REQUIRED (throws otherwise):
 * request headers (Origin / Host) are attacker-influenced, so they are only
 * used as a fallback in dev/test, then localhost.
 */
export function getSiteUrl(requestOrigin?: string): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromEnv) return trimTrailingSlashes(fromEnv);
  if (process.env.NODE_ENV === "production") {
    throw new Error(MISSING_APP_URL_ERROR);
  }
  const origin = requestOrigin?.trim();
  if (origin) return trimTrailingSlashes(origin);
  return "http://localhost:3000";
}
