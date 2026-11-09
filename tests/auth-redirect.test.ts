import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeEmail, normalizeOtpCode } from "@/lib/auth/form-state";
import {
  DEFAULT_NEXT_PATH,
  getSiteUrl,
  MISSING_APP_URL_ERROR,
  isProtectedPath,
  safeNextPath,
} from "@/lib/auth/redirect";

describe("safeNextPath rejects open-redirect vectors", () => {
  it.each([
    ["//evil.com"],
    ["///evil.com"],
    ["/\\evil.com"],
    ["\\\\evil.com"],
    ["/x\\y"],
    ["%2F%2Fevil.com"],
    ["/%2F/evil.com"],
    ["/%2fevil.com"],
    ["/%5Cevil.com"],
    ["/%5cevil.com"],
    ["https://evil.com"],
    ["http:evil.com"],
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["data:text/html,hi"],
    [" /x"],
    ["/x y"],
    ["/x\ty"],
    ["/\n/evil.com"],
    ["/%0A/evil.com"],
    ["/%09/evil.com"],
    ["/%00"],
    ["/%E0%A4%A"], // malformed percent-encoding
    ["evil.com"],
    ["dashboard"],
    [""],
  ])("%j → default", (input) => {
    expect(safeNextPath(input)).toBe(DEFAULT_NEXT_PATH);
  });

  it.each([[null], [undefined]])("%j → default", (input) => {
    expect(safeNextPath(input)).toBe("/dashboard");
  });

  it("rejects absurdly long input", () => {
    expect(safeNextPath("/" + "a".repeat(5000))).toBe("/dashboard");
  });
});

describe("safeNextPath avoids auth loops", () => {
  it.each([
    ["/login"],
    ["/login?next=/dashboard"],
    ["/login/"],
    ["/LOGIN"],
    ["/auth/callback"],
    ["/auth/confirm?token_hash=x"],
    ["/auth"],
    ["/%6Cogin"], // encoded "l"
  ])("%j → default", (input) => {
    expect(safeNextPath(input)).toBe("/dashboard");
  });

  it("does not over-match lookalikes", () => {
    expect(safeNextPath("/loginhelp")).toBe("/loginhelp");
    expect(safeNextPath("/authors")).toBe("/authors");
  });
});

describe("safeNextPath keeps valid paths", () => {
  it.each([
    ["/dashboard"],
    ["/books/new?x=1"],
    ["/books/abc-123/edit#page-2"],
    ["/b/my-trip"],
    ["/"],
    ["/books?q=%D8%B9%D8%B1%D8%A8%D9%8A"], // encoded Arabic query
  ])("%j kept", (input) => {
    expect(safeNextPath(input)).toBe(input);
  });
});

describe("isProtectedPath", () => {
  it.each([
    ["/dashboard", true],
    ["/dashboard/", true],
    ["/dashboard/settings", true],
    ["/books", true],
    ["/books/new", true],
    ["/books/123/edit", true],
    ["/settings", true],
    ["/settings/", true],
    ["/settingsx", false],
    ["/booksfoo", false],
    ["/dashboardx", false],
    ["/", false],
    ["/login", false],
    ["/b/my-trip", false],
    ["/auth/callback", false],
    ["/api/books", false],
  ])("%s → %s", (path, expected) => {
    expect(isProtectedPath(path)).toBe(expected);
  });
});

describe("getSiteUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers NEXT_PUBLIC_APP_URL and trims trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://photobook.example//");
    expect(getSiteUrl("https://other.example")).toBe("https://photobook.example");
  });

  it("falls back to the request origin (trimmed) in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(getSiteUrl("https://preview.example/")).toBe("https://preview.example");
  });

  it("falls back to localhost in test", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(getSiteUrl()).toBe("http://localhost:3000");
    expect(getSiteUrl("  ")).toBe("http://localhost:3000");
  });

  it("throws in production when NEXT_PUBLIC_APP_URL is unset (never trusts headers)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "  ");
    expect(() => getSiteUrl("https://evil.example")).toThrow(MISSING_APP_URL_ERROR);
    expect(() => getSiteUrl()).toThrow(/NEXT_PUBLIC_APP_URL must be set in production/);
  });

  it("uses NEXT_PUBLIC_APP_URL in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://photobook.example/");
    expect(getSiteUrl("https://evil.example")).toBe("https://photobook.example");
  });
});

describe("form-state validators", () => {
  it("normalizes emails", () => {
    expect(normalizeEmail("  Sara@Example.AE ")).toBe("sara@example.ae");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a b@c.d")).toBeNull();
    expect(normalizeEmail(`${"a".repeat(250)}@x.ae`)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it("normalizes 6-digit codes", () => {
    expect(normalizeOtpCode("123456")).toBe("123456");
    expect(normalizeOtpCode(" 123 456 ")).toBe("123456");
    expect(normalizeOtpCode("12345")).toBeNull();
    expect(normalizeOtpCode("12345a")).toBeNull();
    expect(normalizeOtpCode(undefined)).toBeNull();
  });
});
