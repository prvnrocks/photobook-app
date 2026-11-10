import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PRINT_TOKEN_MAX_FUTURE_SECONDS,
  PRINT_TOKEN_TTL_SECONDS,
  printTokenExpiry,
  signPrintToken,
  verifyPrintToken,
  type PrintGrant,
} from "@/lib/pdf/print-token";

const SECRET = Buffer.from("x".repeat(32), "utf8");
const OTHER = Buffer.from("y".repeat(32), "utf8");
const BOOK = "1111aaaa-2222-4333-8444-5555ffff5555";
const OTHER_BOOK = "99999999-2222-4333-8444-555555555555";
const EXPORT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = 1_800_000_000;

function grant(over: Partial<PrintGrant> = {}): PrintGrant {
  return { exportId: EXPORT, bookId: BOOK, docRev: 7, from: 0, to: 19, exp: printTokenExpiry(NOW), ...over };
}

function forge(payload: unknown, secret = SECRET): string {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = createHmac("sha256", secret).update("print-token-v1").digest();
  return `${p}.${createHmac("sha256", key).update(p).digest("base64url")}`;
}

const validPayload = { v: 1, x: EXPORT, b: BOOK, r: 7, f: 0, t: 19, e: NOW + 300 };

describe("print token", () => {
  it("roundtrips", () => {
    const token = signPrintToken(grant(), SECRET)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyPrintToken(token, { bookId: BOOK, nowSec: NOW }, SECRET)).toEqual(grant());
    expect(PRINT_TOKEN_TTL_SECONDS).toBe(300);
    expect(printTokenExpiry(NOW + 0.7)).toBe(NOW + 300);
  });

  it("accepts the route param in upper case and normalises ids", () => {
    const token = signPrintToken(grant({ bookId: BOOK.toUpperCase(), exportId: EXPORT.toUpperCase() }), SECRET)!;
    expect(verifyPrintToken(token, { bookId: BOOK.toUpperCase(), nowSec: NOW }, SECRET)).toEqual(grant());
  });

  it("forged payload with the right key verifies (sanity for forge helper)", () => {
    expect(verifyPrintToken(forge(validPayload), { bookId: BOOK, nowSec: NOW }, SECRET)).not.toBeNull();
  });

  it("rejects a tampered payload or signature", () => {
    const token = signPrintToken(grant(), SECRET)!;
    const [p, s] = token.split(".");
    const other = Buffer.from(JSON.stringify({ ...validPayload, t: 5 })).toString("base64url");
    expect(verifyPrintToken(`${other}.${s}`, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
    const flipped = s[0] === "A" ? `B${s.slice(1)}` : `A${s.slice(1)}`;
    expect(verifyPrintToken(`${p}.${flipped}`, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
    expect(verifyPrintToken(`${p}.${s.slice(0, -2)}`, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
    expect(verifyPrintToken(`${p}.${s}.x`, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret, or with the raw (underived) secret", () => {
    const token = signPrintToken(grant(), OTHER)!;
    expect(verifyPrintToken(token, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
    const p = Buffer.from(JSON.stringify(validPayload)).toString("base64url");
    const raw = createHmac("sha256", SECRET).update(p).digest("base64url");
    expect(verifyPrintToken(`${p}.${raw}`, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
  });

  it("rejects expired tokens (exp ≤ now)", () => {
    const token = signPrintToken(grant({ exp: NOW + 300 }), SECRET)!;
    expect(verifyPrintToken(token, { bookId: BOOK, nowSec: NOW + 299 }, SECRET)).not.toBeNull();
    expect(verifyPrintToken(token, { bookId: BOOK, nowSec: NOW + 300 }, SECRET)).toBeNull();
    expect(verifyPrintToken(token, { bookId: BOOK, nowSec: NOW + 10_000 }, SECRET)).toBeNull();
  });

  it("rejects exp further than 10 minutes out", () => {
    expect(PRINT_TOKEN_MAX_FUTURE_SECONDS).toBe(600);
    const ok = signPrintToken(grant({ exp: NOW + 600 }), SECRET)!;
    expect(verifyPrintToken(ok, { bookId: BOOK, nowSec: NOW }, SECRET)).not.toBeNull();
    const far = signPrintToken(grant({ exp: NOW + 601 }), SECRET)!;
    expect(verifyPrintToken(far, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
    const year = signPrintToken(grant({ exp: NOW + 365 * 86400 }), SECRET)!;
    expect(verifyPrintToken(year, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
  });

  it("rejects a token for another book, and a non-UUID route param", () => {
    const token = signPrintToken(grant(), SECRET)!;
    expect(verifyPrintToken(token, { bookId: OTHER_BOOK, nowSec: NOW }, SECRET)).toBeNull();
    expect(verifyPrintToken(token, { bookId: "not-a-uuid", nowSec: NOW }, SECRET)).toBeNull();
    expect(verifyPrintToken(token, { bookId: "", nowSec: NOW }, SECRET)).toBeNull();
  });

  it.each([
    ["from > to", { f: 5, t: 4 }],
    ["negative from", { f: -1, t: 3 }],
    ["21 sheets", { f: 0, t: 20 }],
    ["beyond last sheet", { f: 100, t: 101 }],
    ["float", { f: 0.5, t: 3 }],
    ["string range", { f: "0", t: 3 }],
    ["negative docRev", { r: -1 }],
    ["float docRev", { r: 1.5 }],
    ["bad exportId", { x: "nope" }],
    ["upper-case bookId in payload", { b: BOOK.toUpperCase() }],
    ["wrong version", { v: 2 }],
    ["string exp", { e: String(NOW + 300) }],
    ["extra key", { z: 1 }],
  ])("rejects a validly signed payload with %s", (_name, over) => {
    expect(verifyPrintToken(forge({ ...validPayload, ...over }), { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
  });

  it("rejects a payload with a missing key, or a non-object payload", () => {
    const missing: Record<string, unknown> = { ...validPayload };
    delete missing.r;
    for (const p of [missing, [1, 2], null, "str", 42]) {
      expect(verifyPrintToken(forge(p), { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
    }
  });

  it("accepts edge ranges: cover only, last chunk of a 100-page book", () => {
    for (const [f, t] of [[0, 0], [80, 99], [100, 100], [81, 100]]) {
      expect(verifyPrintToken(forge({ ...validPayload, f, t }), { bookId: BOOK, nowSec: NOW }, SECRET)).not.toBeNull();
    }
  });

  it("signPrintToken throws on invalid grants", () => {
    expect(() => signPrintToken(grant({ from: 3, to: 2 }), SECRET)).toThrow(TypeError);
    expect(() => signPrintToken(grant({ to: 20 }), SECRET)).toThrow(TypeError);
    expect(() => signPrintToken(grant({ bookId: "x" }), SECRET)).toThrow(TypeError);
    expect(() => signPrintToken(grant({ docRev: -1 }), SECRET)).toThrow(TypeError);
  });

  it("missing or short secret → null (sign and verify), via env too", async () => {
    expect(signPrintToken(grant(), null)).toBeNull();
    const token = signPrintToken(grant(), SECRET)!;
    expect(verifyPrintToken(token, { bookId: BOOK, nowSec: NOW }, null)).toBeNull();

    const { getAccessSecret } = await import("@/lib/publish/access-cookie");
    expect(getAccessSecret({ BOOK_ACCESS_SECRET: "short" })).toBeNull();
    expect(getAccessSecret({})).toBeNull();

    vi.stubEnv("BOOK_ACCESS_SECRET", "short");
    try {
      expect(signPrintToken(grant())).toBeNull();
      expect(verifyPrintToken(token, { bookId: BOOK, nowSec: NOW })).toBeNull();
      vi.stubEnv("BOOK_ACCESS_SECRET", "x".repeat(32));
      expect(verifyPrintToken(token, { bookId: BOOK, nowSec: NOW })).toEqual(grant());
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never throws on garbage", () => {
    const garbage: unknown[] = [
      undefined, null, 0, {}, [], "", ".", "..", "a.b", "a.b.c", "!!!.???", "a".repeat(5000),
      `${"a".repeat(600)}.${"b".repeat(600)}`, "e30.", ".e30", "e30.AAAA", "%%%.%%%", "\u0000.\u0000", "🎉.🎉",
    ];
    for (const g of garbage) {
      expect(verifyPrintToken(g, { bookId: BOOK, nowSec: NOW }, SECRET)).toBeNull();
    }
    const token = signPrintToken(grant(), SECRET)!;
    expect(verifyPrintToken(token, { bookId: BOOK, nowSec: Number.NaN }, SECRET)).toBeNull();
    expect(verifyPrintToken(token, undefined as unknown as { bookId: string; nowSec: number }, SECRET)).toBeNull();
    expect(verifyPrintToken(token, { bookId: 5 as unknown as string, nowSec: NOW }, SECRET)).toBeNull();
  });
});
