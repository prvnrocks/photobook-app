import "server-only";

// Access cookie for password-protected books (D-040). Token format:
//   v1.<payloadB64url>.<macB64url>
// payload = {"b": bookId, "e": expiry epoch ms}; mac = HMAC-SHA256(secret, "v1.<payload>.<fp>")
// where fp = passwordFingerprint(stored hash). The fingerprint is bound into the MAC but not
// readable from the cookie; changing the password changes fp, so every old cookie fails.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ACCESS_MAX_AGE_MS = ACCESS_MAX_AGE_SECONDS * 1000;
const MIN_SECRET_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** BOOK_ACCESS_SECRET as bytes, or null when missing / shorter than 32 bytes (callers → 500). */
export function getAccessSecret(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.BOOK_ACCESS_SECRET?.trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "utf8");
  return buf.length >= MIN_SECRET_BYTES ? buf : null;
}

export interface AccessGrant {
  bookId: string;
  /** passwordFingerprint(books.password_hash) at the time of unlock. */
  fingerprint: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

/** Expiry for a cookie issued at `now` (epoch ms). */
export function accessExpiry(now: number): number {
  return now + ACCESS_MAX_AGE_MS;
}

function mac(secret: Buffer, payloadB64: string, fingerprint: string): Buffer {
  return createHmac("sha256", secret).update(`v1.${payloadB64}.${fingerprint}`).digest();
}

/** Signed token, or null when BOOK_ACCESS_SECRET is not configured. */
export function signAccess(grant: AccessGrant, secret: Buffer | null = getAccessSecret()): string | null {
  if (!secret) return null;
  if (!UUID_RE.test(grant.bookId) || !grant.fingerprint || !Number.isSafeInteger(grant.exp)) {
    throw new TypeError("signAccess: invalid grant");
  }
  const payload = Buffer.from(JSON.stringify({ b: grant.bookId.toLowerCase(), e: grant.exp })).toString("base64url");
  return `v1.${payload}.${mac(secret, payload, grant.fingerprint).toString("base64url")}`;
}

/**
 * True only for an untampered, unexpired token issued for this book and this password
 * (fingerprint). Never throws; false when the secret is missing.
 */
export function verifyAccess(
  token: unknown,
  bookId: string,
  fingerprint: string,
  now: number,
  secret: Buffer | null = getAccessSecret(),
): boolean {
  if (!secret || typeof token !== "string" || token.length > 512 || !fingerprint) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const [, payloadB64, macB64] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(macB64)) return false;
  const expected = mac(secret, payloadB64, fingerprint);
  const given = Buffer.from(macB64, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object") return false;
  const { b, e } = payload as { b?: unknown; e?: unknown };
  if (typeof b !== "string" || typeof e !== "number" || !Number.isSafeInteger(e)) return false;
  if (b !== bookId.toLowerCase()) return false;
  // Expired, or further out than we ever issue (defence in depth against a leaked secret era).
  return e > now && e <= now + ACCESS_MAX_AGE_MS + 60_000;
}

/** Per-book cookie name: `pb_a_` + 16 hex of sha256(slug). Slugs are validated before use. */
export function accessCookieName(slug: string): string {
  return `pb_a_${createHash("sha256").update(slug).digest("hex").slice(0, 16)}`;
}

export interface AccessCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

/**
 * Cookie options for `cookies().set(accessCookieName(slug), token, accessCookieOptions(slug))`.
 * Scoped to `/b/<slug>` so one book's cookie is never sent to another. `secure` is off only in
 * `next dev` (Safari rejects Secure cookies on http://localhost).
 */
export function accessCookieOptions(slug: string, nodeEnv: string | undefined = process.env.NODE_ENV): AccessCookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv !== "development",
    sameSite: "lax",
    path: `/b/${slug}`,
    maxAge: ACCESS_MAX_AGE_SECONDS,
  };
}
