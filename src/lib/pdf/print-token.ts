import "server-only";

// Print-route token (D-048). Lets headless Chromium open /print/[bookId] for one export chunk.
// Format: <payloadB64url>.<sigB64url>
//   payload = {"v":1,"x":exportId,"b":bookId,"r":docRev,"f":from,"t":to,"e":exp}
//   sig     = HMAC-SHA256(key, payloadB64url), key = HMAC-SHA256(BOOK_ACCESS_SECRET, "print-token-v1")
// The derived key keeps print tokens and access cookies in separate MAC domains even though they
// share one secret. from/to are inclusive 0-based sheet indexes (sheet 0 = cover, see rules.ts);
// exp is epoch seconds. Tokens live PRINT_TOKEN_TTL_SECONDS; verify rejects anything issued
// further out than MAX_FUTURE_SECONDS.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getAccessSecret } from "@/lib/publish/access-cookie";
import { isValidSheetRange, PRINT_TOKEN_TTL_SECONDS } from "@/lib/pdf/rules";

export { PRINT_TOKEN_TTL_SECONDS };

/** verify rejects tokens whose exp is more than this far ahead of now (no long-lived tokens). */
export const PRINT_TOKEN_MAX_FUTURE_SECONDS = 600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 1024;
const PAYLOAD_KEYS = ["b", "e", "f", "r", "t", "v", "x"];

export interface PrintGrant {
  exportId: string;
  bookId: string;
  /** books.doc_rev snapshotted by the export row. */
  docRev: number;
  /** First sheet index, inclusive (0 = cover). */
  from: number;
  /** Last sheet index, inclusive; to - from < CHUNK_SHEETS. */
  to: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/** exp for a token issued at `nowSec` (epoch seconds). */
export function printTokenExpiry(nowSec: number): number {
  return Math.floor(nowSec) + PRINT_TOKEN_TTL_SECONDS;
}

function deriveKey(secret: Buffer): Buffer {
  return createHmac("sha256", secret).update("print-token-v1").digest();
}

function sign(secret: Buffer, payloadB64: string): Buffer {
  return createHmac("sha256", deriveKey(secret)).update(payloadB64).digest();
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Structural validity of a grant (time is checked separately). */
function isValidGrantShape(g: PrintGrant): boolean {
  return (
    isUuid(g.exportId) &&
    isUuid(g.bookId) &&
    isNonNegInt(g.docRev) &&
    isValidSheetRange(g.from, g.to) &&
    isNonNegInt(g.exp)
  );
}

/**
 * Signed token, or null when BOOK_ACCESS_SECRET is missing / shorter than 32 bytes (caller → 500).
 * Throws TypeError on an invalid grant (bad UUIDs, negative ints, bad sheet range) — a caller bug.
 */
export function signPrintToken(grant: PrintGrant, secret: Buffer | null = getAccessSecret()): string | null {
  if (!secret) return null;
  if (!isValidGrantShape(grant)) throw new TypeError("signPrintToken: invalid grant");
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      x: grant.exportId.toLowerCase(),
      b: grant.bookId.toLowerCase(),
      r: grant.docRev,
      f: grant.from,
      t: grant.to,
      e: grant.exp,
    }),
  ).toString("base64url");
  return `${payload}.${sign(secret, payload).toString("base64url")}`;
}

/**
 * The grant of an untampered, unexpired token issued for `bookId` (the route param), else null.
 * Constant-time MAC compare before parsing; strict payload (exact keys, UUIDs, ints, valid sheet
 * range); now < exp ≤ now + 10 min. Never throws; null when the secret is missing.
 */
export function verifyPrintToken(
  token: unknown,
  opts: { bookId: string; nowSec: number },
  secret: Buffer | null = getAccessSecret(),
): PrintGrant | null {
  try {
    if (!secret || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
    if (!opts || !isUuid(opts.bookId) || typeof opts.nowSec !== "number" || !Number.isFinite(opts.nowSec)) {
      return null;
    }
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    if (!B64URL_RE.test(payloadB64) || !B64URL_RE.test(sigB64)) return null;

    const expected = sign(secret, payloadB64);
    const given = Buffer.from(sigB64, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    // Reject non-canonical base64url (trailing bits) so one payload has exactly one signature string.
    if (given.toString("base64url") !== sigB64) return null;

    const payload: unknown = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const keys = Object.keys(payload).sort();
    if (keys.length !== PAYLOAD_KEYS.length || keys.some((k, i) => k !== PAYLOAD_KEYS[i])) return null;
    const p = payload as Record<string, unknown>;
    if (p.v !== 1) return null;

    const grant: PrintGrant = {
      exportId: p.x as string,
      bookId: p.b as string,
      docRev: p.r as number,
      from: p.f as number,
      to: p.t as number,
      exp: p.e as number,
    };
    if (!isValidGrantShape(grant)) return null;
    if (grant.bookId !== grant.bookId.toLowerCase() || grant.exportId !== grant.exportId.toLowerCase()) return null;
    if (grant.bookId !== opts.bookId.toLowerCase()) return null;

    const now = Math.floor(opts.nowSec);
    if (grant.exp <= now || grant.exp > now + PRINT_TOKEN_MAX_FUTURE_SECONDS) return null;
    return grant;
  } catch {
    return null;
  }
}
