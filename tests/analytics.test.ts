import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CaptureResult } from "posthog-js/dist/module.slim.no-external";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAnalyticsForTests,
  initAnalytics,
  isAnalyticsActive,
  posthogConfig,
  sanitizeCapture,
  track,
  trackPageview,
} from "@/lib/analytics/client";
import { EVENT_SCHEMAS, MAX_COUNT, msBucket, sanitizeEventProperties } from "@/lib/analytics/events";
import {
  authFlash,
  FLASH_PARAM,
  flashEvent,
  NEW_USER_WINDOW_MS,
  stripFlash,
  withAnalyticsFlash,
} from "@/lib/analytics/flash";
import { sanitizePath, sanitizeUrl } from "@/lib/analytics/sanitize-path";
import { isTrackedPath } from "@/components/analytics/Analytics";

const UUID = "3f2b8c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6b";
const ORIGIN = "https://photobook.example";
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("sanitizePath", () => {
  it.each([
    ["/b/our-wedding-Ab3dEf9hJk", "/b/:slug"],
    ["/b/Ab3dEf9hJk/og", "/b/:slug/og"],
    ["/b/our-wedding-Ab3dEf9hJk?utm_source=wa#p3", "/b/:slug"],
    [`/books/${UUID}/edit`, "/books/:id/edit"],
    [`/books/${UUID.toUpperCase()}/publish?upgrade=cancelled`, "/books/:id/publish"],
    [`/print/${UUID}?token=abc.def`, "/print/:id"],
    ["/auth/confirm?token_hash=xyz&type=email", "/auth/confirm"],
    ["/dashboard", "/dashboard"],
    ["/", "/"],
    ["", "/"],
    ["dashboard", "/dashboard"],
    ["/unsubscribe/eyJhbGciOiJIUzI1NiJ9abc123defghij", "/unsubscribe/:token"],
    ["/x/someone%40mail.com", "/x/:email"],
    ["/books/new", "/books/new"],
    ["/settings", "/settings"],
  ])("%s → %s", (input, expected) => {
    expect(sanitizePath(input)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const p of ["/b/x-Ab3dEf9hJk", `/books/${UUID}/review`, "/a/b?c#d"]) {
      expect(sanitizePath(sanitizePath(p))).toBe(sanitizePath(p));
    }
  });

  it("only treats the first segment 'b' as the book route", () => {
    expect(sanitizePath("/blog/b")).toBe("/blog/b");
    expect(sanitizePath("/x/b/keep")).toBe("/x/b/keep");
  });
});

describe("sanitizeUrl", () => {
  it("keeps our origin with a sanitized path", () => {
    expect(sanitizeUrl(`${ORIGIN}/b/trip-Ab3dEf9hJk?x=1#y`, ORIGIN)).toBe(`${ORIGIN}/b/:slug`);
    expect(sanitizeUrl(`${ORIGIN}/books/${UUID}/edit`, ORIGIN)).toBe(`${ORIGIN}/books/:id/edit`);
  });

  it("cuts other sites to their origin", () => {
    expect(sanitizeUrl("https://l.facebook.com/l.php?u=https%3A%2F%2Fx", ORIGIN)).toBe("https://l.facebook.com/");
    expect(sanitizeUrl("https://user:pw@evil.example/secret/path", ORIGIN)).toBe("https://evil.example/");
  });

  it("drops non-http and junk", () => {
    expect(sanitizeUrl("javascript:alert(1)", ORIGIN)).toBeNull();
    expect(sanitizeUrl("not a url", ORIGIN)).toBeNull();
    expect(sanitizeUrl(42, ORIGIN)).toBeNull();
    expect(sanitizeUrl("", ORIGIN)).toBeNull();
  });
});

describe("event guard", () => {
  it("drops strings outside the enum and unknown keys", () => {
    expect(sanitizeEventProperties("signed_up", { method: "email" })).toEqual({ method: "email" });
    expect(sanitizeEventProperties("signed_up", { method: "someone@mail.com" })).toEqual({});
    expect(sanitizeEventProperties("signed_up", { method: "email", email: "a@b.co", title: "Our wedding" })).toEqual({
      method: "email",
    });
    expect(sanitizeEventProperties("ai_build_done", { mode: "ai", outcome: "ok", ms_bucket: "73412ms" })).toEqual({
      mode: "ai",
      outcome: "ok",
    });
  });

  it("only admits counts and booleans where declared", () => {
    expect(
      sanitizeEventProperties("published", { is_paid: "true", has_password: false, pages: "20", first: true }),
    ).toEqual({ has_password: false, first: true });
    expect(sanitizeEventProperties("upload_done", { photos: 12.7, failed: -1, skipped: Number.NaN })).toEqual({
      photos: 12,
    });
    expect(sanitizeEventProperties("viewer_opened", { pages: 10 ** 9, is_paid: true, is_owner: false })).toEqual({
      pages: MAX_COUNT,
      is_paid: true,
      is_owner: false,
    });
    expect(sanitizeEventProperties("viewer_opened", { pages: { slug: "x" } })).toEqual({});
  });

  it("ai_build_done admits an optional auto bool (M13 T4)", () => {
    expect(sanitizeEventProperties("ai_build_done", { mode: "ai", outcome: "ok", ms_bucket: "<30s", auto: true })).toEqual({
      mode: "ai",
      outcome: "ok",
      ms_bucket: "<30s",
      auto: true,
    });
    expect(sanitizeEventProperties("ai_build_done", { mode: "rules", outcome: "ok", ms_bucket: "<30s", auto: "yes" })).toEqual({
      mode: "rules",
      outcome: "ok",
      ms_bucket: "<30s",
    });
  });

  it("rejects unknown events", () => {
    expect(sanitizeEventProperties("caption_written", { text: "hi" })).toBeNull();
    expect(sanitizeEventProperties("$autocapture", {})).toBeNull();
    expect(sanitizeEventProperties("__proto__", {})).toBeNull();
    expect(sanitizeEventProperties(undefined, {})).toBeNull();
  });

  it("every schema property is a count, bool or a short enum of plain words", () => {
    for (const schema of Object.values(EVENT_SCHEMAS)) {
      for (const kind of Object.values(schema) as unknown[]) {
        if (kind === "count" || kind === "bool") continue;
        expect(Array.isArray(kind)).toBe(true);
        for (const v of kind as string[]) expect(v).toMatch(/^[\w<+\-.]{1,12}$/);
      }
    }
  });

  it("msBucket", () => {
    expect(msBucket(0)).toBe("<30s");
    expect(msBucket(-5)).toBe("<30s");
    expect(msBucket(Number.NaN)).toBe("<30s");
    expect(msBucket(45_000)).toBe("30-60s");
    expect(msBucket(90_000)).toBe("1-2m");
    expect(msBucket(4 * 60_000)).toBe("2-5m");
    expect(msBucket(7 * 60_000)).toBe("5-10m");
    expect(msBucket(3_600_000)).toBe("10m+");
  });
});

describe("analytics flash", () => {
  it("is a no-op when analytics is off", () => {
    expect(withAnalyticsFlash("/dashboard", "book_created", false)).toBe("/dashboard");
  });

  it("appends the code, keeping existing query and hash", () => {
    expect(withAnalyticsFlash("/dashboard", "logged_in.email", true)).toBe(`/dashboard?${FLASH_PARAM}=logged_in.email`);
    expect(withAnalyticsFlash("/books/new?x=1#top", "signed_up.google", true)).toBe(
      `/books/new?x=1&${FLASH_PARAM}=signed_up.google#top`,
    );
  });

  it("maps only listed codes to events and strips the param", () => {
    expect(flashEvent(`?${FLASH_PARAM}=book_created`)).toEqual({ name: "book_created", props: {} });
    expect(flashEvent(`?${FLASH_PARAM}=signed_up.google`)).toEqual({ name: "signed_up", props: { method: "google" } });
    expect(flashEvent(`?${FLASH_PARAM}=toString`)).toBeNull();
    expect(flashEvent(`?${FLASH_PARAM}=evil`)).toBeNull();
    expect(flashEvent("?a=1")).toBeNull();
    expect(stripFlash(`?a=1&${FLASH_PARAM}=book_created`)).toBe("?a=1");
    expect(stripFlash(`?${FLASH_PARAM}=book_created`)).toBe("");
  });

  it("authFlash: confirmed just now = new account", () => {
    const now = Date.parse("2026-11-10T10:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(authFlash({ email_confirmed_at: iso(now - 5_000), created_at: iso(now - 600_000) }, "email", now)).toBe(
      "signed_up.email",
    );
    expect(authFlash({ email_confirmed_at: iso(now - 86_400_000) }, "email", now)).toBe("logged_in.email");
    expect(authFlash({ created_at: iso(now - 1_000) }, "google", now)).toBe("signed_up.google");
    expect(authFlash({ email_confirmed_at: iso(now - NEW_USER_WINDOW_MS - 1) }, "google", now)).toBe("logged_in.google");
    expect(authFlash(null, "email", now)).toBe("logged_in.email");
    expect(authFlash({ email_confirmed_at: "garbage" }, "email", now)).toBe("logged_in.email");
  });
});

function capture(event: string, properties: Record<string, unknown>): CaptureResult {
  return { uuid: "0190f0e0-0000-7000-8000-000000000000", event, properties } as CaptureResult;
}

describe("sanitizeCapture (before_send)", () => {
  it("drops events not on the allow-list", () => {
    expect(sanitizeCapture(capture("$autocapture", {}), ORIGIN)).toBeNull();
    expect(sanitizeCapture(capture("$pageleave", {}), ORIGIN)).toBeNull();
    expect(sanitizeCapture(capture("$identify", {}), ORIGIN)).toBeNull();
    expect(sanitizeCapture(null, ORIGIN)).toBeNull();
  });

  it("rewrites URLs and keeps only allow-listed SDK properties", () => {
    const out = sanitizeCapture(
      capture("$pageview", {
        token: "phc_test",
        distinct_id: "abc",
        $current_url: `${ORIGIN}/b/our-wedding-Ab3dEf9hJk?ref=wa`,
        $pathname: "/b/our-wedding-Ab3dEf9hJk",
        $referrer: `https://mail.example/inbox/someone@mail.com?id=${UUID}`,
        $prev_pageview_pathname: `/books/${UUID}/edit`,
        $host: "photobook.example",
        $browser: "Chrome",
        $ip: "1.2.3.4",
        $raw_user_agent: "Mozilla/5.0",
        title: "Our wedding — Photobook",
        email: "someone@mail.com",
        $set: { email: "someone@mail.com" },
        $elements: [{ text: "caption" }],
      }),
      ORIGIN,
    );
    expect(out).not.toBeNull();
    const props = out!.properties;
    expect(props).toEqual({
      token: "phc_test",
      distinct_id: "abc",
      $current_url: `${ORIGIN}/b/:slug`,
      $pathname: "/b/:slug",
      $referrer: "https://mail.example/",
      $prev_pageview_pathname: "/books/:id/edit",
      $host: "photobook.example",
      $browser: "Chrome",
    });
    expect(out).not.toHaveProperty("$set");
    const json = JSON.stringify(out);
    expect(json).not.toMatch(EMAIL_RE);
    expect(JSON.stringify(props)).not.toMatch(UUID_RE);
    expect(json).not.toContain(UUID);
    expect(json).not.toContain("Ab3dEf9hJk");
  });

  it("re-validates our own event properties", () => {
    const out = sanitizeCapture(
      capture("published", { is_paid: true, has_password: "yes", pages: 20, first: false, slug: "x-Ab3dEf9hJk" }),
      ORIGIN,
    );
    expect(out!.properties).toEqual({ is_paid: true, pages: 20, first: false });
  });
});

describe("posthogConfig", () => {
  it("is cookieless, quiet and profile-free", () => {
    const c = posthogConfig("https://eu.i.posthog.com", ORIGIN);
    expect(c).toMatchObject({
      api_host: "https://eu.i.posthog.com",
      persistence: "memory",
      disable_persistence: true,
      person_profiles: "never",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      mask_all_text: true,
      internal_or_test_user_hostname: null,
    });
    expect(c.property_denylist).toEqual(expect.arrayContaining(["$ip", "title"]));
    expect(typeof c.before_send).toBe("function");
  });
});

describe("analytics client", () => {
  type FakePh = { init: ReturnType<typeof vi.fn>; capture: ReturnType<typeof vi.fn> };
  let fake: FakePh;
  const load = vi.fn(async () => ({ default: fake as never }));

  beforeEach(() => {
    __resetAnalyticsForTests();
    fake = { init: vi.fn(), capture: vi.fn() };
    load.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetAnalyticsForTests();
  });

  it("is a no-op without NEXT_PUBLIC_POSTHOG_KEY (nothing loaded, nothing captured)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    vi.stubGlobal("window", { location: { origin: ORIGIN } });
    expect(isAnalyticsActive()).toBe(false);
    track("book_created", {});
    trackPageview();
    await expect(initAnalytics(load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(fake.capture).not.toHaveBeenCalled();
  });

  it("is a no-op on the server even with a key", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    expect(isAnalyticsActive()).toBe(false);
    await expect(initAnalytics(load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("with a key: inits once on the EU host and flushes queued, sanitized events", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "");
    vi.stubGlobal("window", { location: { origin: ORIGIN } });
    const loading = initAnalytics(load);
    // Queued while loading; the untyped extra prop must be stripped by the runtime guard.
    track("upload_done", { photos: 3, failed: 1, skipped: 0, ...({ filename: "IMG_1.jpg" } as object) } as never);
    expect(fake.capture).not.toHaveBeenCalled();
    await loading;
    await initAnalytics(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fake.init).toHaveBeenCalledTimes(1);
    const [key, config] = fake.init.mock.calls[0];
    expect(key).toBe("phc_test");
    expect(config.api_host).toBe("https://eu.i.posthog.com");
    expect(fake.capture).toHaveBeenCalledWith("upload_done", { photos: 3, failed: 1, skipped: 0 }, undefined);

    track("checkout_started", {}, { beacon: true });
    expect(fake.capture).toHaveBeenLastCalledWith("checkout_started", {}, { send_instantly: true, transport: "sendBeacon" });
  });
});

describe("<Analytics> route filter", () => {
  it("never runs on the headless print route", () => {
    expect(isTrackedPath(`/print/${UUID}`)).toBe(false);
    expect(isTrackedPath(null)).toBe(false);
    expect(isTrackedPath("/b/x-Ab3dEf9hJk")).toBe(true);
    expect(isTrackedPath("/")).toBe(true);
  });
});

describe("analytics boundaries", () => {
  const SRC = join(process.cwd(), "src");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });

  it("only src/lib/analytics imports posthog-js", () => {
    const offenders = walk(SRC)
      .filter((f) => /from\s+["']posthog-js|import\(\s*["']posthog-js/.test(readFileSync(f, "utf8")))
      .map((f) => relative(process.cwd(), f))
      .filter((f) => !f.startsWith("src/lib/analytics/"));
    expect(offenders).toEqual([]);
  });

  it("nobody calls posthog identify / people APIs", () => {
    const offenders = walk(SRC)
      .filter((f) => /\.(identify|alias|setPersonProperties|group)\(/.test(readFileSync(f, "utf8")) && /posthog/i.test(readFileSync(f, "utf8")))
      .map((f) => relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});
