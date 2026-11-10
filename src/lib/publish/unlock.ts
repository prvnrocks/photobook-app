import "server-only";

// Helpers for the password unlock action (D-040): client-ip extraction + keyed ip hash (the raw ip
// is never stored or logged) and a dummy password hash so a missing/unlockable book runs the same
// scrypt verification path as a wrong password.

import { createHmac, randomBytes } from "node:crypto";
import { hashPassword } from "@/lib/publish/password";

/** First hop of `x-forwarded-for` (Vercel puts the client ip first), else "unknown". */
export function clientIpFromForwardedFor(header: string | null | undefined): string {
  if (typeof header !== "string") return "unknown";
  const first = header.split(",")[0]?.trim() ?? "";
  // Bound + sanity-check; anything odd collapses to one shared bucket.
  if (!first || first.length > 64 || !/^[0-9A-Fa-f:.[\]]+$/.test(first)) return "unknown";
  return first.toLowerCase();
}

/** HMAC-SHA256(secret, "pb-unlock-ip\0" + ip) as 43 base64url chars (fits the 1..128 check). */
export function hashIp(ip: string, secret: Buffer): string {
  return createHmac("sha256", secret).update("pb-unlock-ip\0").update(ip).digest("base64url");
}

let dummyHash: Promise<string> | null = null;

/** A valid scrypt hash (same parameters as real ones) of a random secret nobody knows. */
export function getDummyPasswordHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = hashPassword(randomBytes(24).toString("base64url")).catch((e: unknown) => {
      dummyHash = null;
      throw e;
    });
  }
  return dummyHash;
}
