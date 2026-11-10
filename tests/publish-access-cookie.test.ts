import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ACCESS_MAX_AGE_SECONDS,
  accessCookieName,
  accessCookieOptions,
  accessExpiry,
  getAccessSecret,
  signAccess,
  verifyAccess,
} from "@/lib/publish/access-cookie";

const SECRET = Buffer.from("k".repeat(44), "utf8");
const OTHER = Buffer.from("z".repeat(44), "utf8");
const BOOK = "0b6f6a8e-2b1c-4f3a-9d1e-6c2a1b3c4d5e";
const BOOK2 = "1c7f6a8e-2b1c-4f3a-9d1e-6c2a1b3c4d5e";
const FP = "fpAAAAAAAAAAAAAAAAAAAA";
const NOW = Date.UTC(2026, 10, 10, 12);

function token(over: Partial<{ bookId: string; fingerprint: string; exp: number }> = {}, secret = SECRET) {
  const t = signAccess({ bookId: BOOK, fingerprint: FP, exp: accessExpiry(NOW), ...over }, secret);
  if (!t) throw new Error("no token");
  return t;
}

describe("getAccessSecret", () => {
  it("null when missing or shorter than 32 bytes", () => {
    expect(getAccessSecret({})).toBeNull();
    expect(getAccessSecret({ BOOK_ACCESS_SECRET: "" })).toBeNull();
    expect(getAccessSecret({ BOOK_ACCESS_SECRET: "x".repeat(31) })).toBeNull();
    expect(getAccessSecret({ BOOK_ACCESS_SECRET: "x".repeat(32) })?.length).toBe(32);
  });

  it("sign returns null / verify returns false without a secret", () => {
    expect(signAccess({ bookId: BOOK, fingerprint: FP, exp: NOW + 1000 }, null)).toBeNull();
    expect(verifyAccess(token(), BOOK, FP, NOW, null)).toBe(false);
  });
});

describe("signAccess / verifyAccess", () => {
  it("valid token verifies; format v1.payload.mac; fingerprint not readable", () => {
    const t = token();
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyAccess(t, BOOK, FP, NOW, SECRET)).toBe(true);
    expect(verifyAccess(t, BOOK.toUpperCase(), FP, NOW, SECRET)).toBe(true);
    expect(Buffer.from(t.split(".")[1], "base64url").toString()).not.toContain(FP);
  });

  it("expired", () => {
    const t = token();
    expect(verifyAccess(t, BOOK, FP, accessExpiry(NOW) - 1, SECRET)).toBe(true);
    expect(verifyAccess(t, BOOK, FP, accessExpiry(NOW), SECRET)).toBe(false);
    expect(verifyAccess(token({ exp: NOW - 1 }), BOOK, FP, NOW, SECRET)).toBe(false);
  });

  it("rejects an exp further out than ever issued", () => {
    expect(verifyAccess(token({ exp: NOW + 400 * 86_400_000 }), BOOK, FP, NOW, SECRET)).toBe(false);
  });

  it("wrong book", () => {
    expect(verifyAccess(token(), BOOK2, FP, NOW, SECRET)).toBe(false);
  });

  it("password change (new fingerprint) invalidates old cookies", () => {
    expect(verifyAccess(token(), BOOK, "fpBBBBBBBBBBBBBBBBBBBB", NOW, SECRET)).toBe(false);
    expect(verifyAccess(token(), BOOK, "", NOW, SECRET)).toBe(false);
  });

  it("other secret", () => {
    expect(verifyAccess(token({}, OTHER), BOOK, FP, NOW, SECRET)).toBe(false);
  });

  it("tampered payload / mac / format", () => {
    const t = token();
    const [v, payload, mac] = t.split(".");
    // Payload re-pointed at another book, original MAC.
    const forged = Buffer.from(JSON.stringify({ b: BOOK2, e: accessExpiry(NOW) })).toString("base64url");
    expect(verifyAccess(`${v}.${forged}.${mac}`, BOOK2, FP, NOW, SECRET)).toBe(false);
    // Extended expiry, original MAC.
    const later = Buffer.from(JSON.stringify({ b: BOOK, e: accessExpiry(NOW) + 1 })).toString("base64url");
    expect(verifyAccess(`${v}.${later}.${mac}`, BOOK, FP, NOW, SECRET)).toBe(false);
    // Flipped MAC bit.
    const m = Buffer.from(mac, "base64url");
    m[3] ^= 1;
    expect(verifyAccess(`${v}.${payload}.${m.toString("base64url")}`, BOOK, FP, NOW, SECRET)).toBe(false);
    for (const bad of [
      "",
      "v1",
      `v2.${payload}.${mac}`,
      `v1.${payload}`,
      `v1.${payload}.${mac}.x`,
      `v1.${payload}.${mac.slice(0, -2)}`,
      `v1.${payload}.`,
      `v1.${payload}.${mac}=`,
      "x".repeat(600),
      null,
      42,
    ]) {
      expect(verifyAccess(bad, BOOK, FP, NOW, SECRET)).toBe(false);
    }
  });

  it("validly signed but non-JSON / wrong-shape payload → false", async () => {
    const { createHmac } = await import("node:crypto");
    const sign = (payload: string) =>
      `v1.${payload}.${createHmac("sha256", SECRET).update(`v1.${payload}.${FP}`).digest("base64url")}`;
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    expect(verifyAccess(sign(b64(JSON.stringify({ b: BOOK, e: accessExpiry(NOW) }))), BOOK, FP, NOW, SECRET)).toBe(true);
    expect(verifyAccess(sign(b64("not json")), BOOK, FP, NOW, SECRET)).toBe(false);
    expect(verifyAccess(sign(b64(JSON.stringify({ b: BOOK, e: "9999999999999" }))), BOOK, FP, NOW, SECRET)).toBe(false);
    expect(verifyAccess(sign(b64(JSON.stringify([BOOK]))), BOOK, FP, NOW, SECRET)).toBe(false);
    expect(verifyAccess(sign(b64("null")), BOOK, FP, NOW, SECRET)).toBe(false);
  });

  it("refuses to sign an invalid grant", () => {
    expect(() => signAccess({ bookId: "nope", fingerprint: FP, exp: NOW }, SECRET)).toThrow();
    expect(() => signAccess({ bookId: BOOK, fingerprint: "", exp: NOW }, SECRET)).toThrow();
    expect(() => signAccess({ bookId: BOOK, fingerprint: FP, exp: 1.5 }, SECRET)).toThrow();
  });
});

describe("cookie name and options", () => {
  it("name is per slug and cookie-safe", () => {
    const a = accessCookieName("sara-omar-abcdefghij");
    expect(a).toMatch(/^pb_a_[0-9a-f]{16}$/);
    expect(accessCookieName("sara-omar-abcdefghij")).toBe(a);
    expect(accessCookieName("sara-omar-abcdefghik")).not.toBe(a);
  });

  it("options: httpOnly, Secure, Lax, scoped path, 30 days", () => {
    expect(accessCookieOptions("sara-omar-abcdefghij", "production")).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/b/sara-omar-abcdefghij",
      maxAge: 30 * 24 * 60 * 60,
    });
    expect(ACCESS_MAX_AGE_SECONDS).toBe(2_592_000);
    expect(accessCookieOptions("abcdefghij", "development").secure).toBe(false);
    expect(accessCookieOptions("abcdefghij", "test").secure).toBe(true);
  });
});
