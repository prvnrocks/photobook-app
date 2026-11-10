import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  hashPassword,
  passwordFingerprint,
  validatePasswordInput,
  verifyPassword,
} from "@/lib/publish/password";

describe("validatePasswordInput", () => {
  it.each([
    ["abcd", true],
    ["abc", false],
    ["a".repeat(64), true],
    ["a".repeat(65), false],
    ["كلمة", true], // 4 Arabic code points
    ["🎉🎉🎉🎉", true], // 4 code points, 8 UTF-16 units
    ["🎉".repeat(64), true],
    ["🎉".repeat(65), false],
  ])("%j → ok=%s", (pw, ok) => {
    expect(validatePasswordInput(pw).ok).toBe(ok);
  });

  it("rejects non-strings, control chars and lone surrogates", () => {
    expect(validatePasswordInput(1234)).toEqual({ ok: false, reason: "not_string" });
    expect(validatePasswordInput("ab\ncd")).toEqual({ ok: false, reason: "invalid_chars" });
    expect(validatePasswordInput("abc\ud83d")).toEqual({ ok: false, reason: "invalid_chars" });
    expect(validatePasswordInput("ab")).toEqual({ ok: false, reason: "too_short" });
  });

  it("returns the NFC form", () => {
    const r = validatePasswordInput("café");
    expect(r).toEqual({ ok: true, password: "café" });
  });
});

describe("hashPassword / verifyPassword", () => {
  it("hash format and round trip", async () => {
    const h = await hashPassword("open sesame");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
    expect(h).not.toContain("open sesame");
    expect(await verifyPassword("open sesame", h)).toBe(true);
    expect(await verifyPassword("open sesamE", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("salts: same password → different hashes, both verify", async () => {
    const [a, b] = await Promise.all([hashPassword("كلمة سر"), hashPassword("كلمة سر")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("كلمة سر", a)).toBe(true);
    expect(await verifyPassword("كلمة سر", b)).toBe(true);
  });

  it("NFC-normalises both sides", async () => {
    const h = await hashPassword("café");
    expect(await verifyPassword("café", h)).toBe(true);
  });

  it("returns false (never throws) for malformed stored values", async () => {
    const good = await hashPassword("abcd");
    const [, n, r, p, salt, hash] = good.split("$");
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "",
      "abcd",
      "bcrypt$2b$10$xxxx",
      `scrypt$${n}$${r}$${p}$${salt}`, // missing part
      `scrypt$${n}$${r}$${p}$${salt}$${hash}$extra`,
      `scrypt$3000$${r}$${p}$${salt}$${hash}`, // N not power of two
      `scrypt$${1 << 20}$${r}$${p}$${salt}$${hash}`, // N too large (DoS)
      `scrypt$${n}$64$${p}$${salt}$${hash}`, // r too large
      `scrypt$${n}$${r}$99$${salt}$${hash}`, // p too large
      `scrypt$${n}$${r}$${p}$${salt}$not*base64`,
      `scrypt$${n}$${r}$${p}$AA==$${hash}`, // salt too short
      `scrypt$${n}$${r}$${p}$${salt}$AAAA`, // hash too short
      `scrypt$-1$${r}$${p}$${salt}$${hash}`,
      "x".repeat(10_000),
    ];
    for (const s of bad) expect(await verifyPassword("abcd", s)).toBe(false);
    expect(await verifyPassword(1234 as unknown as string, good)).toBe(false);
    expect(await verifyPassword("a".repeat(2000), good)).toBe(false);
  });

  it("wrong hash with right length → false (compare path, not length shortcut)", async () => {
    const h = await hashPassword("abcd");
    const parts = h.split("$");
    const flipped = Buffer.from(parts[5], "base64");
    flipped[0] ^= 1;
    parts[5] = flipped.toString("base64");
    expect(await verifyPassword("abcd", parts.join("$"))).toBe(false);
  });

  it("compares with crypto.timingSafeEqual", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/publish/password.ts"), "utf8");
    expect(src).toMatch(/timingSafeEqual\(key, parsed\.hash\)/);
    expect(src).not.toMatch(/key\.equals|===\s*parsed\.hash(?!\.length)|toString\([^)]*\)\s*===/);
  });
});

describe("passwordFingerprint", () => {
  it("is short, stable, and changes when the password is re-set", async () => {
    const a = await hashPassword("abcd");
    const b = await hashPassword("abcd");
    expect(passwordFingerprint(a)).toBe(passwordFingerprint(a));
    expect(passwordFingerprint(a)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(passwordFingerprint(a)).not.toBe(passwordFingerprint(b));
    expect(a).not.toContain(passwordFingerprint(a));
  });
});
