import "server-only";
// Bearer check for Vercel Cron requests. The secret is passed in by the route (the only place
// that reads CRON_SECRET). Both sides are hashed to equal-length digests before timingSafeEqual,
// so neither the content nor the length of the secret leaks through timing.
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time string equality. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** True when `authorization` is exactly `Bearer <secret>` (secret must be non-empty). */
export function isAuthorizedCron(authorization: string | null, secret: string): boolean {
  if (!secret) return false;
  return safeEqual(authorization ?? "", `Bearer ${secret}`);
}
