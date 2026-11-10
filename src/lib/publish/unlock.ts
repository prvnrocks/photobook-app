import "server-only";

// Helpers for the password unlock action (D-040): client-ip extraction + keyed ip hash (the raw ip
// is never stored or logged).
//
// XFF assumption (M6 review N8): we run on Vercel, whose edge OVERWRITES `x-forwarded-for` with the
// real client ip as the first (left-most) entry, so a client cannot spoof the first hop. This is
// NOT true behind other proxies/CDNs (which append to a client-supplied header) — if the app ever
// moves off Vercel or gets another proxy in front, switch to the platform's trusted header (or the
// right-most untrusted hop) before relying on the per-ip limit. The per-book limit does not depend
// on the ip at all.

import { createHmac } from "node:crypto";

/**
 * Rate-limit bucket for the first hop of `x-forwarded-for` (Vercel puts the client ip first; see the
 * header comment). IPv4 is returned unchanged (lower-cased). IPv6 is bucketed to its /64 —
 * one subscriber/LAN usually owns a whole /64, so rotating the interface id must not buy fresh
 * attempts — rendered as "<h1>:<h2>:<h3>:<h4>::/64". IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as
 * that IPv4. Anything malformed collapses to one shared "unknown" bucket.
 */
export function clientIpFromForwardedFor(header: string | null | undefined): string {
  if (typeof header !== "string") return "unknown";
  const first = header.split(",")[0]?.trim() ?? "";
  // Bound + sanity-check; anything odd collapses to one shared bucket.
  if (!first || first.length > 64 || !/^[0-9A-Fa-f:.[\]]+$/.test(first)) return "unknown";
  const ip = first.toLowerCase();
  if (!ip.includes(":")) return ip; // IPv4 (unchanged)
  return ipv6Bucket(ip) ?? "unknown";
}

function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** "/64" bucket of an IPv6 literal (optionally [bracketed]); IPv4-mapped → dotted IPv4; null if invalid. */
function ipv6Bucket(input: string): string | null {
  let s = input;
  if (s.startsWith("[") || s.endsWith("]")) {
    if (!(s.startsWith("[") && s.endsWith("]"))) return null;
    s = s.slice(1, -1);
  }
  if (s.includes("[") || s.includes("]")) return null;

  // Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) → two hextets.
  let v4: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    v4 = parseIpv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): string[] | null => {
    if (part === "") return [];
    const g = part.split(":");
    return g.every((x) => /^[0-9a-f]{1,4}$/.test(x)) ? g : null;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest].map((x) => parseInt(x, 16));
  } else {
    if (head.length !== 8) return null;
    groups = head.map((x) => parseInt(x, 16));
  }

  // IPv4-mapped (::ffff:a.b.c.d) → the IPv4 bucket.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6], groups[7]];
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** HMAC-SHA256(secret, "pb-unlock-ip\0" + ip) as 43 base64url chars (fits the 1..128 check). */
export function hashIp(ip: string, secret: Buffer): string {
  return createHmac("sha256", secret).update("pb-unlock-ip\0").update(ip).digest("base64url");
}
