import "server-only";
// One-click unsubscribe token for reminder emails (D-057). Token format:
//   u1.<payloadB64url>.<macB64url>
// payload = {"u": userId, "e": expiry epoch ms}; mac = HMAC-SHA256(key, "u1.<payload>")
// key = HMAC-SHA256(BOOK_ACCESS_SECRET, "unsub-v1") — a derived key, so an unsubscribe token can
// never be confused with (or forged from) a book access cookie, which uses the raw secret.
//
// The token only allows turning reminder emails OFF for one user; it carries no other capability.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAccessSecret } from "@/lib/publish/access-cookie";

/** Tokens in emails stay valid for a year. */
export const UNSUBSCRIBE_TOKEN_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 256;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Derived signing key, or null when BOOK_ACCESS_SECRET is missing / too short. */
export function getUnsubscribeKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const secret = getAccessSecret(env);
  if (!secret) return null;
  return createHmac("sha256", secret).update("unsub-v1").digest();
}

function mac(key: Buffer, payloadB64: string): Buffer {
  return createHmac("sha256", key).update(`u1.${payloadB64}`).digest();
}

/** Signed token for `userId`, valid until now + 1 year; null when the secret is not configured. */
export function signUnsubscribeToken(
  userId: string,
  now: number,
  key: Buffer | null = getUnsubscribeKey(),
): string | null {
  if (!key) return null;
  const u = typeof userId === "string" ? userId.toLowerCase() : "";
  if (!UUID_RE.test(u) || !Number.isSafeInteger(now)) throw new TypeError("signUnsubscribeToken: invalid input");
  const payload = Buffer.from(JSON.stringify({ u, e: now + UNSUBSCRIBE_TOKEN_MAX_AGE_MS })).toString("base64url");
  return `u1.${payload}.${mac(key, payload).toString("base64url")}`;
}

/**
 * The user id of an untampered, unexpired token, else null. Constant-time MAC check before the
 * payload is parsed; strict shape (exactly {u, e}). Never throws.
 */
export function verifyUnsubscribeToken(
  token: unknown,
  now: number,
  key: Buffer | null = getUnsubscribeKey(),
): string | null {
  if (!key || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "u1") return null;
  const [, payloadB64, macB64] = parts;
  if (!B64URL_RE.test(payloadB64) || !B64URL_RE.test(macB64)) return null;
  const expected = mac(key, payloadB64);
  const given = Buffer.from(macB64, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  // Canonical encoding only (no alternative base64url spellings of the same MAC).
  if (given.toString("base64url") !== macB64) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes("u") || !keys.includes("e")) return null;
  const { u, e } = payload as { u: unknown; e: unknown };
  if (typeof u !== "string" || !UUID_RE.test(u)) return null;
  if (typeof e !== "number" || !Number.isSafeInteger(e)) return null;
  // Expired, or further out than we ever issue.
  if (e <= now || e > now + UNSUBSCRIBE_TOKEN_MAX_AGE_MS + 60_000) return null;
  return u;
}
