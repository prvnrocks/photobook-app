// M9 T5 (D-057): unsubscribe token (tamper / expiry / strict parse) and /api/email/unsubscribe
// (GET never mutates, POST one-click mutates with a valid token, 400 otherwise, noindex,
// middleware exclusion).
import { createHmac } from "node:crypto";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ setEmailReminders: vi.fn() }));
vi.mock("@/lib/db/profiles", () => ({ setEmailReminders: mocks.setEmailReminders }));

const SECRET = "test_book_access_secret_0123456789_abcdef";
const USER = "4f1c2b3a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const NOW = Date.parse("2026-11-10T00:00:00Z");

const tokenMod = await import("@/lib/email/unsubscribe-token");
const { signUnsubscribeToken, verifyUnsubscribeToken, getUnsubscribeKey, UNSUBSCRIBE_TOKEN_MAX_AGE_MS } = tokenMod;
const route = await import("@/app/api/email/unsubscribe/route");
const { config: middlewareConfig } = await import("@/middleware");

const key = getUnsubscribeKey({ BOOK_ACCESS_SECRET: SECRET }) as Buffer;

beforeEach(() => {
  vi.stubEnv("BOOK_ACCESS_SECRET", SECRET);
  mocks.setEmailReminders.mockReset();
  mocks.setEmailReminders.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("unsubscribe token", () => {
  it("round-trips the user id", () => {
    const t = signUnsubscribeToken(USER, NOW, key) as string;
    expect(t).toMatch(/^u1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyUnsubscribeToken(t, NOW + 1000, key)).toBe(USER);
  });

  it("lowercases ids and refuses non-uuids", () => {
    const t = signUnsubscribeToken(USER.toUpperCase(), NOW, key) as string;
    expect(verifyUnsubscribeToken(t, NOW, key)).toBe(USER);
    expect(() => signUnsubscribeToken("nope", NOW, key)).toThrow(TypeError);
  });

  it("is null when the secret is missing or short", () => {
    expect(getUnsubscribeKey({})).toBeNull();
    expect(getUnsubscribeKey({ BOOK_ACCESS_SECRET: "short" })).toBeNull();
    expect(signUnsubscribeToken(USER, NOW, null)).toBeNull();
    expect(verifyUnsubscribeToken(signUnsubscribeToken(USER, NOW, key), NOW, null)).toBeNull();
  });

  it("expires after a year (and refuses tokens dated further out than issued)", () => {
    const t = signUnsubscribeToken(USER, NOW, key) as string;
    expect(verifyUnsubscribeToken(t, NOW + UNSUBSCRIBE_TOKEN_MAX_AGE_MS - 1, key)).toBe(USER);
    expect(verifyUnsubscribeToken(t, NOW + UNSUBSCRIBE_TOKEN_MAX_AGE_MS, key)).toBeNull();
    // Issued "2 years in the future" (forged era) → refused now.
    const far = signUnsubscribeToken(USER, NOW + 2 * UNSUBSCRIBE_TOKEN_MAX_AGE_MS, key) as string;
    expect(verifyUnsubscribeToken(far, NOW, key)).toBeNull();
  });

  it("rejects tampering: payload swap, mac flip, other key, raw-secret MAC, junk", () => {
    const t = signUnsubscribeToken(USER, NOW, key) as string;
    const [v, payload, mac] = t.split(".");
    const other = signUnsubscribeToken("11111111-2222-4333-8444-555555555555", NOW, key) as string;
    const otherPayload = other.split(".")[1];
    expect(verifyUnsubscribeToken(`${v}.${otherPayload}.${mac}`, NOW, key)).toBeNull();
    const flipped = mac.slice(0, -2) + (mac.at(-2) === "A" ? "B" : "A") + mac.at(-1);
    expect(verifyUnsubscribeToken(`${v}.${payload}.${flipped}`, NOW, key)).toBeNull();
    expect(verifyUnsubscribeToken(`v1.${payload}.${mac}`, NOW, key)).toBeNull();
    const otherKey = getUnsubscribeKey({ BOOK_ACCESS_SECRET: "another_secret_value_0123456789_xyz!" });
    expect(verifyUnsubscribeToken(t, NOW, otherKey)).toBeNull();
    // A MAC made with the raw BOOK_ACCESS_SECRET (access-cookie key) is not valid here.
    const rawMac = createHmac("sha256", SECRET).update(`u1.${payload}`).digest("base64url");
    expect(verifyUnsubscribeToken(`u1.${payload}.${rawMac}`, NOW, key)).toBeNull();
    for (const junk of [undefined, null, 42, "", "u1..", "u1.a.b.c", `${t}x`, "u1.%%%.###", "x".repeat(300)]) {
      expect(verifyUnsubscribeToken(junk, NOW, key)).toBeNull();
    }
  });

  it("strict payload shape: extra keys / wrong types are refused even with a valid MAC", () => {
    const sign = (obj: unknown) => {
      const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
      return `u1.${p}.${createHmac("sha256", key).update(`u1.${p}`).digest("base64url")}`;
    };
    const e = NOW + 1000;
    expect(verifyUnsubscribeToken(sign({ u: USER, e }), NOW, key)).toBe(USER);
    expect(verifyUnsubscribeToken(sign({ u: USER, e, admin: true }), NOW, key)).toBeNull();
    expect(verifyUnsubscribeToken(sign({ u: USER, e: String(e) }), NOW, key)).toBeNull();
    expect(verifyUnsubscribeToken(sign({ u: USER.toUpperCase(), e }), NOW, key)).toBeNull();
    expect(verifyUnsubscribeToken(sign([USER, e]), NOW, key)).toBeNull();
    expect(verifyUnsubscribeToken(sign({ u: USER, e: 1.5 }), NOW, key)).toBeNull();
  });
});

const URL_BASE = "http://localhost:3000/api/email/unsubscribe";
const liveToken = () => signUnsubscribeToken(USER, Date.now(), key) as string;
const oneClick = (t: string | null, body = "List-Unsubscribe=One-Click", contentType = "application/x-www-form-urlencoded") =>
  new Request(t === null ? URL_BASE : `${URL_BASE}?t=${encodeURIComponent(t)}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });

function expectPageHeaders(res: Response) {
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  expect(res.headers.get("x-robots-tag")).toContain("noindex");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("set-cookie")).toBeNull();
}

describe("GET /api/email/unsubscribe", () => {
  it("valid token → confirmation page with a POST form; never mutates", async () => {
    const t = liveToken();
    const res = await route.GET(new Request(`${URL_BASE}?t=${encodeURIComponent(t)}`));
    expect(res.status).toBe(200);
    expectPageHeaders(res);
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain(`action="/api/email/unsubscribe?t=${encodeURIComponent(t)}"`);
    expect(html).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(mocks.setEmailReminders).not.toHaveBeenCalled();
  });

  it.each([null, "", "u1.bad.token"])("invalid token %j → 400 page, no mutation", async (t) => {
    const res = await route.GET(new Request(t === null ? URL_BASE : `${URL_BASE}?t=${t}`));
    expect(res.status).toBe(400);
    expectPageHeaders(res);
    expect(await res.text()).toContain("This link doesn&#39;t work");
    expect(mocks.setEmailReminders).not.toHaveBeenCalled();
  });
});

describe("POST /api/email/unsubscribe", () => {
  it("one-click with a valid token → email_reminders off, 200", async () => {
    const res = await route.POST(oneClick(liveToken()));
    expect(res.status).toBe(200);
    expectPageHeaders(res);
    expect(await res.text()).toContain("You&#39;re unsubscribed");
    expect(mocks.setEmailReminders).toHaveBeenCalledTimes(1);
    expect(mocks.setEmailReminders).toHaveBeenCalledWith(USER, false);
  });

  it("accepts the RFC 8058 multipart body", async () => {
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    const encoded = new Request("http://x/", { method: "POST", body: form });
    const ct = encoded.headers.get("content-type") as string;
    const res = await route.POST(oneClick(liveToken(), await encoded.text(), ct));
    expect(res.status).toBe(200);
    expect(mocks.setEmailReminders).toHaveBeenCalledWith(USER, false);
  });

  it("a deleted account (helper returns false) still gets the done page", async () => {
    mocks.setEmailReminders.mockResolvedValue(false);
    expect((await route.POST(oneClick(liveToken()))).status).toBe(200);
  });

  it.each([null, "", "u1.bad.token"])("invalid token %j → 400, no mutation", async (t) => {
    const res = await route.POST(oneClick(t));
    expect(res.status).toBe(400);
    expect(mocks.setEmailReminders).not.toHaveBeenCalled();
  });

  it("expired token → 400", async () => {
    const old = signUnsubscribeToken(USER, Date.now() - UNSUBSCRIBE_TOKEN_MAX_AGE_MS - 1000, key) as string;
    expect((await route.POST(oneClick(old))).status).toBe(400);
    expect(mocks.setEmailReminders).not.toHaveBeenCalled();
  });

  it.each(["", "List-Unsubscribe=Yes", "foo=bar", "x".repeat(2000)])("bad body %j → 400, no mutation", async (body) => {
    const res = await route.POST(oneClick(liveToken(), body));
    expect(res.status).toBe(400);
    expect(mocks.setEmailReminders).not.toHaveBeenCalled();
  });

  it("db failure → 500 page, logs a code only (no user id / token)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.setEmailReminders.mockRejectedValue(Object.assign(new Error(`boom ${USER}`), { code: "XX000" }));
    const t = liveToken();
    const res = await route.POST(oneClick(t));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Something went wrong");
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).toContain("code=XX000");
    expect(logged).not.toContain(USER);
    expect(logged).not.toContain(t);
  });
});

describe("middleware", () => {
  it("skips the unsubscribe endpoint (no session work / cookies)", () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config: middlewareConfig, url });
    expect(matches("/api/email/unsubscribe?t=abc")).toBe(false);
    expect(matches("/api/stripe/webhook")).toBe(false);
    expect(matches("/settings")).toBe(true);
  });
});
