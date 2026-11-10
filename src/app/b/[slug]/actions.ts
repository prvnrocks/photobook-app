"use server";
// Password unlock for /b/[slug] (D-040). Order: validate input → secret configured → resolve the
// book → rate limit (try_book_unlock records the attempt BEFORE verifying) → scrypt verify →
// clear that attempt (only failures count, migration 1100) → set the per-book access cookie.
// A well-formed slug without a live, unexpired, password-protected book answers wrong_password
// immediately (no scrypt — nothing to protect, and it can't be used to burn CPU). Responses are
// codes only; passwords and ips are never logged (the ip is only used as an HMAC input).

import { cookies, headers } from "next/headers";
import { z } from "zod";
import { clearUnlockAttempt, getUnlockTarget, recordUnlockAttempt } from "@/lib/db/public-books";
import { errorCodeOf } from "@/lib/http/json";
import { accessCookieName, accessCookieOptions, accessExpiry, getAccessSecret, signAccess } from "@/lib/publish/access-cookie";
import { passwordFingerprint, verifyPassword } from "@/lib/publish/password";
import { isValidSlug } from "@/lib/publish/slug";
import { clientIpFromForwardedFor, hashIp } from "@/lib/publish/unlock";
import {
  UNLOCK_BOOK_LIMIT,
  UNLOCK_IP_LIMIT,
  UNLOCK_WINDOW_SECONDS,
  type UnlockResult,
} from "@/lib/publish/unlock-types";

// 64 code points ≤ 256 UTF-16 units; anything longer can never match.
const PasswordSchema = z.string().min(1).max(256);

function readPassword(input: unknown): string | null {
  const raw = input instanceof FormData ? input.get("password") : input;
  const r = PasswordSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export async function unlockBookAction(slug: string, input: FormData | string): Promise<UnlockResult> {
  if (!isValidSlug(slug)) return { ok: false, error: "not_found" };
  const password = readPassword(input);
  if (password === null) return { ok: false, error: "invalid_input" };

  const secret = getAccessSecret();
  if (!secret) return { ok: false, error: "unavailable" };

  try {
    const target = await getUnlockTarget(slug);
    if (!target) return { ok: false, error: "wrong_password" };

    const ipHash = hashIp(clientIpFromForwardedFor((await headers()).get("x-forwarded-for")), secret);
    const allowed = await recordUnlockAttempt(target.bookId, ipHash, {
      ipLimit: UNLOCK_IP_LIMIT,
      bookLimit: UNLOCK_BOOK_LIMIT,
      windowSeconds: UNLOCK_WINDOW_SECONDS,
    });
    if (!allowed) return { ok: false, error: "rate_limited" };

    if (!(await verifyPassword(password, target.passwordHash))) return { ok: false, error: "wrong_password" };

    // Best effort: a failed clear only means this success keeps counting as an attempt.
    try {
      await clearUnlockAttempt(target.bookId, ipHash);
    } catch (err) {
      console.error(`[unlock] clear attempt failed (${errorCodeOf(err)})`);
    }

    const token = signAccess(
      { bookId: target.bookId, fingerprint: passwordFingerprint(target.passwordHash), exp: accessExpiry(Date.now()) },
      secret,
    );
    if (!token) return { ok: false, error: "unavailable" };
    (await cookies()).set(accessCookieName(slug), token, accessCookieOptions(slug));
    return { ok: true };
  } catch {
    // DB / storage failure: codes only, nothing about the input.
    return { ok: false, error: "unavailable" };
  }
}
