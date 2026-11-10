import "server-only";

// Optional book password (D-040): 4–64 code points, scrypt-hashed. Stored format:
//   scrypt$N$r$p$saltB64$hashB64
// The plaintext is never stored or logged. Input is NFC-normalised so the same password typed on
// different keyboards (e.g. Arabic with/without precomposed forms) verifies.

import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { codePointLength, hasLoneSurrogate } from "@/lib/text/clip";

export const PASSWORD_MIN_CODE_POINTS = 4;
export const PASSWORD_MAX_CODE_POINTS = 64;

const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
/** scrypt needs 128·N·r bytes (32 MiB here) — Node's default maxmem is exactly 32 MiB, so raise it. */
const MAX_MEM = 128 * (1 << 16) * 16 + 16 * 1024 * 1024;

/** Upper bounds accepted when parsing a stored hash (refuse DoS-sized parameters). */
const MAX_N = 1 << 16;
const MAX_R = 16;
const MAX_P = 4;

function scryptAsync(pw: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export type PasswordInputResult =
  | { ok: true; password: string }
  | { ok: false; reason: "not_string" | "too_short" | "too_long" | "invalid_chars" };

/** Validate a user-chosen password (code points, like the UI counter). Returns the NFC form. */
export function validatePasswordInput(pw: unknown): PasswordInputResult {
  if (typeof pw !== "string") return { ok: false, reason: "not_string" };
  if (hasLoneSurrogate(pw)) return { ok: false, reason: "invalid_chars" };
  if (/[\u0000-\u001f\u007f]/.test(pw)) return { ok: false, reason: "invalid_chars" };
  const nfc = pw.normalize("NFC");
  const n = codePointLength(nfc);
  if (n < PASSWORD_MIN_CODE_POINTS) return { ok: false, reason: "too_short" };
  if (n > PASSWORD_MAX_CODE_POINTS) return { ok: false, reason: "too_long" };
  return { ok: true, password: nfc };
}

/** Hash a password (call validatePasswordInput first). ~50–100 ms of CPU, async (libuv pool). */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(pw.normalize("NFC"), salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function parseStored(stored: unknown): ParsedHash | null {
  if (typeof stored !== "string" || stored.length > 512) return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, nS, rS, pS, saltS, hashS] = parts;
  if (![nS, rS, pS].every((x) => /^[1-9][0-9]{0,6}$/.test(x))) return null;
  const n = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  if (n < 2 || n > MAX_N || (n & (n - 1)) !== 0 || r > MAX_R || p > MAX_P) return null;
  if (!B64.test(saltS) || !B64.test(hashS)) return null;
  const salt = Buffer.from(saltS, "base64");
  const hash = Buffer.from(hashS, "base64");
  if (salt.length < 8 || hash.length < 16 || hash.length > 64) return null;
  return { n, r, p, salt, hash };
}

/**
 * Constant-time check of `pw` against a stored hash. Returns false (never throws) for a malformed
 * stored value, a non-string / absurdly long input, or a scrypt error.
 */
export async function verifyPassword(pw: unknown, stored: unknown): Promise<boolean> {
  if (typeof pw !== "string" || pw.length > 1024) return false;
  const parsed = parseStored(stored);
  if (!parsed) return false;
  try {
    const key = await scryptAsync(pw.normalize("NFC"), parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * Short, non-reversible fingerprint of the stored hash, bound into the access cookie's MAC.
 * Every hashPassword call uses a fresh salt, so changing (or re-setting) the password changes the
 * fingerprint and invalidates all existing access cookies.
 */
export function passwordFingerprint(stored: string): string {
  return createHash("sha256").update("pb-access-fp\0").update(stored).digest("base64url").slice(0, 22);
}
