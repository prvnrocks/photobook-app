// URL/path sanitising for analytics (M9 T14, D-058). Pure + isomorphic.
//
// Book slugs are capabilities (anyone with /b/<slug> can open the book), ids are internal and
// query strings carry tokens (?token_hash, print tokens, Stripe session ids). Analytics only ever
// sees route shapes:
//   /b/<slug>[/...]          → /b/:slug[/...]
//   UUID segments            → :id          (/books/<uuid>/edit → /books/:id/edit)
//   email-like segments      → :email
//   long token-like segments → :token       (≥ 20 chars with a digit, or ≥ 32 chars)
//   query string + fragment  → removed
// Absolute URLs keep their origin; other sites' URLs (referrers) are cut to the origin only,
// since their paths can hold anything.

import { isUuid } from "@/lib/uuid";

const TOKEN_MIN_WITH_DIGIT = 20;
const TOKEN_MIN_ANY = 32;

function sanitizeSegment(seg: string, index: number, segments: readonly string[]): string {
  if (seg === "") return seg;
  if (index === 1 && segments[0] === "b") return ":slug";
  if (isUuid(`${seg}`)) return ":id";
  let decoded = seg;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    // keep the raw segment
  }
  if (decoded.includes("@")) return ":email";
  if (decoded.length >= TOKEN_MIN_ANY || (decoded.length >= TOKEN_MIN_WITH_DIGIT && /\d/.test(decoded))) {
    return ":token";
  }
  return seg;
}

/** Sanitise a path (query string and fragment removed). Always starts with "/". */
export function sanitizePath(path: string): string {
  const raw = String(path ?? "");
  const cut = raw.search(/[?#]/);
  const bare = cut === -1 ? raw : raw.slice(0, cut);
  const withSlash = bare.startsWith("/") ? bare : `/${bare}`;
  const segments = withSlash.slice(1).split("/");
  return `/${segments.map((s, i) => sanitizeSegment(s, i, segments)).join("/")}`;
}

/**
 * Sanitise an absolute URL. `ownOrigin` given and the URL is on another origin → origin only.
 * Non-http(s) or unparsable input → null (drop the property).
 */
export function sanitizeUrl(url: unknown, ownOrigin?: string): string | null {
  if (typeof url !== "string" || url === "") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (ownOrigin !== undefined && u.origin !== ownOrigin) return `${u.origin}/`;
  return `${u.origin}${sanitizePath(u.pathname)}`;
}
