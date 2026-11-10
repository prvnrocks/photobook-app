import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUnlockTarget: vi.fn(),
  recordUnlockAttempt: vi.fn(),
  cookieSet: vi.fn(),
  forwardedFor: "203.0.113.7, 10.0.0.1" as string | null,
  verifySpy: { calls: [] as unknown[][] },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.cookieSet }),
  headers: async () => ({ get: (n: string) => (n.toLowerCase() === "x-forwarded-for" ? mocks.forwardedFor : null) }),
}));
vi.mock("@/lib/db/public-books", () => ({
  getUnlockTarget: mocks.getUnlockTarget,
  recordUnlockAttempt: mocks.recordUnlockAttempt,
}));
vi.mock("@/lib/publish/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/publish/password")>();
  return {
    ...actual,
    verifyPassword: async (...args: Parameters<typeof actual.verifyPassword>) => {
      mocks.verifySpy.calls.push(args);
      return actual.verifyPassword(...args);
    },
  };
});

const { unlockBookAction } = await import("@/app/b/[slug]/actions");
const { hashPassword, passwordFingerprint } = await import("@/lib/publish/password");
const { accessCookieName, verifyAccess, ACCESS_MAX_AGE_SECONDS } = await import("@/lib/publish/access-cookie");
const { hashIp, clientIpFromForwardedFor } = await import("@/lib/publish/unlock");
const { UNLOCK_IP_LIMIT, UNLOCK_BOOK_LIMIT, UNLOCK_WINDOW_SECONDS } = await import("@/lib/publish/unlock-types");

const SECRET = "test-secret-test-secret-test-secret-0123";
const BOOK = "22222222-2222-4222-8222-222222222222";
const SLUG = "our-trip-AbCdEfGhJk";
let HASH = "";
let prevSecret: string | undefined;

function form(password?: string): FormData {
  const fd = new FormData();
  if (password !== undefined) fd.set("password", password);
  return fd;
}

beforeAll(async () => {
  prevSecret = process.env.BOOK_ACCESS_SECRET;
  HASH = await hashPassword("open sesame");
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.BOOK_ACCESS_SECRET;
  else process.env.BOOK_ACCESS_SECRET = prevSecret;
});

beforeEach(() => {
  process.env.BOOK_ACCESS_SECRET = SECRET;
  mocks.getUnlockTarget.mockReset().mockResolvedValue({ bookId: BOOK, passwordHash: HASH });
  mocks.recordUnlockAttempt.mockReset().mockResolvedValue(true);
  mocks.cookieSet.mockReset();
  mocks.forwardedFor = "203.0.113.7, 10.0.0.1";
  mocks.verifySpy.calls = [];
});

describe("unlockBookAction", () => {
  it("right password → sets the access cookie with path/flags and returns ok", async () => {
    const before = Date.now();
    expect(await unlockBookAction(SLUG, form("open sesame"))).toEqual({ ok: true });
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
    const [name, token, opts] = mocks.cookieSet.mock.calls[0];
    expect(name).toBe(accessCookieName(SLUG));
    expect(opts).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: `/b/${SLUG}`, maxAge: ACCESS_MAX_AGE_SECONDS });
    expect(verifyAccess(token, BOOK, passwordFingerprint(HASH), before, Buffer.from(SECRET))).toBe(true);
  });

  it("accepts a plain string password too", async () => {
    expect(await unlockBookAction(SLUG, "open sesame")).toEqual({ ok: true });
  });

  it("records the attempt BEFORE verifying, with a keyed ip hash and the agreed limits", async () => {
    const order: string[] = [];
    mocks.recordUnlockAttempt.mockImplementation(async () => (order.push("record"), true));
    const len = mocks.verifySpy.calls.length;
    await unlockBookAction(SLUG, form("wrong one"));
    expect(order).toEqual(["record"]);
    expect(mocks.verifySpy.calls.length).toBe(len + 1);
    const [bookId, ipHash, limits] = mocks.recordUnlockAttempt.mock.calls[0];
    expect(bookId).toBe(BOOK);
    expect(ipHash).toBe(hashIp("203.0.113.7", Buffer.from(SECRET)));
    expect(ipHash).not.toContain("203.0.113.7");
    expect(limits).toEqual({ ipLimit: UNLOCK_IP_LIMIT, bookLimit: UNLOCK_BOOK_LIMIT, windowSeconds: UNLOCK_WINDOW_SECONDS });
    expect([UNLOCK_IP_LIMIT, UNLOCK_BOOK_LIMIT, UNLOCK_WINDOW_SECONDS]).toEqual([10, 100, 900]);
  });

  it("missing x-forwarded-for → 'unknown' bucket", async () => {
    mocks.forwardedFor = null;
    await unlockBookAction(SLUG, form("open sesame"));
    expect(mocks.recordUnlockAttempt.mock.calls[0][1]).toBe(hashIp("unknown", Buffer.from(SECRET)));
  });

  it("rate limited → rate_limited, no verify, no cookie", async () => {
    mocks.recordUnlockAttempt.mockResolvedValue(false);
    expect(await unlockBookAction(SLUG, form("open sesame"))).toEqual({ ok: false, error: "rate_limited" });
    expect(mocks.verifySpy.calls).toHaveLength(0);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("wrong password → wrong_password, no cookie", async () => {
    expect(await unlockBookAction(SLUG, form("open sesame!"))).toEqual({ ok: false, error: "wrong_password" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("no locked book for a well-formed slug → same wrong_password, still runs scrypt on a dummy hash", async () => {
    mocks.getUnlockTarget.mockResolvedValue(null);
    expect(await unlockBookAction(SLUG, form("open sesame"))).toEqual({ ok: false, error: "wrong_password" });
    expect(mocks.verifySpy.calls).toHaveLength(1);
    expect(String(mocks.verifySpy.calls[0][1])).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(mocks.recordUnlockAttempt).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("missing / short secret → unavailable without DB calls", async () => {
    delete process.env.BOOK_ACCESS_SECRET;
    expect(await unlockBookAction(SLUG, form("open sesame"))).toEqual({ ok: false, error: "unavailable" });
    process.env.BOOK_ACCESS_SECRET = "short";
    expect(await unlockBookAction(SLUG, form("open sesame"))).toEqual({ ok: false, error: "unavailable" });
    expect(mocks.getUnlockTarget).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("invalid slug → not_found without DB calls", async () => {
    for (const s of ["", "nope", "../../x-AbCdEfGhJk", "Our-trip-AbCdEfGhJk"]) {
      expect(await unlockBookAction(s, form("open sesame"))).toEqual({ ok: false, error: "not_found" });
    }
    expect(mocks.getUnlockTarget).not.toHaveBeenCalled();
    expect(mocks.recordUnlockAttempt).not.toHaveBeenCalled();
  });

  it("invalid input → invalid_input without DB calls", async () => {
    expect(await unlockBookAction(SLUG, form())).toEqual({ ok: false, error: "invalid_input" });
    expect(await unlockBookAction(SLUG, form(""))).toEqual({ ok: false, error: "invalid_input" });
    expect(await unlockBookAction(SLUG, form("x".repeat(257)))).toEqual({ ok: false, error: "invalid_input" });
    expect(await unlockBookAction(SLUG, 42 as unknown as string)).toEqual({ ok: false, error: "invalid_input" });
    expect(mocks.getUnlockTarget).not.toHaveBeenCalled();
  });

  it("DB failure → unavailable, and nothing about the input is logged", async () => {
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    mocks.getUnlockTarget.mockRejectedValue(new Error("Failed to load published book (57014)"));
    expect(await unlockBookAction(SLUG, form("open sesame"))).toEqual({ ok: false, error: "unavailable" });
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain("open sesame");
      expect(JSON.stringify(s.mock.calls)).not.toContain("203.0.113.7");
      s.mockRestore();
    }
  });
});

describe("clientIpFromForwardedFor", () => {
  it("takes the first hop and rejects junk", () => {
    expect(clientIpFromForwardedFor("198.51.100.1, 10.0.0.1")).toBe("198.51.100.1");
    expect(clientIpFromForwardedFor(" 2001:DB8::1 ")).toBe("2001:db8::1");
    expect(clientIpFromForwardedFor(null)).toBe("unknown");
    expect(clientIpFromForwardedFor("")).toBe("unknown");
    expect(clientIpFromForwardedFor("<script>")).toBe("unknown");
  });
});
