/**
 * M9 T14 — PostHog analytics privacy smoke (D-058).
 *
 * SKIPPED unless E2E_ANALYTICS=1, because the server must be started with a (fake) PostHog key
 * and a fake ingestion host that the test intercepts — nothing ever reaches PostHog:
 *
 *   (scratch copy) NEXT_PUBLIC_POSTHOG_KEY=phc_e2e_fake NEXT_PUBLIC_POSTHOG_HOST=https://ph.e2e.invalid \
 *     npx next dev -p 3521
 *   E2E_ANALYTICS=1 npx playwright test -c <config with baseURL :3521, no webServer> e2e/analytics.spec.ts
 *
 * Signed-out checks run on `next dev` (dev fixtures). With E2E_AUTH=1 as well, a live part
 * creates ONE throwaway user `e2e+t14-<random>@example.com` (admin createUser + generateLink, no
 * email), signs in through /auth/confirm, creates a book, and deletes the user in afterAll
 * (books cascade). Logs are counts only.
 *
 * Asserts: no ph_* / posthog cookies, nothing PostHog-ish in local/sessionStorage, only
 * allow-listed events, and no captured payload contains the book slug, a UUID, an email, a query
 * string or the ?_ev= flash; the flash is removed from the address bar.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.E2E_ANALYTICS === "1";
const LIVE = ENABLED && process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_ANALYTICS=1 (server with a fake NEXT_PUBLIC_POSTHOG_KEY/HOST) to run");

const PH_HOST = process.env.E2E_POSTHOG_HOST ?? "https://ph.e2e.invalid";
const VIEWPORT = { width: 375, height: 812 };
// posthog-js drops events from headless/bot user agents (UA, userAgentData brands
// "HeadlessChrome", navigator.webdriver) — present as a normal phone browser.
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const SLUG_RANDOM = "Ab3dEf9hJk";
const SLUG = `our-secret-trip-${SLUG_RANDOM}`;
const ALLOWED_EVENTS = new Set([
  "$pageview",
  "signed_up",
  "logged_in",
  "book_created",
  "upload_done",
  "ai_build_done",
  "published",
  "checkout_started",
  "pdf_downloaded",
  "viewer_opened",
]);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

type Captured = { event: string; properties: Record<string, unknown> };

function decodeBody(req: Request): unknown[] {
  const buf = req.postDataBuffer();
  if (!buf || buf.length === 0) return [];
  const url = new URL(req.url());
  let text: string;
  if (url.searchParams.get("compression") === "gzip-js" || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    text = gunzipSync(buf).toString("utf8");
  } else {
    text = buf.toString("utf8");
    if (text.startsWith("data=")) {
      text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString("utf8");
    }
  }
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { batch?: unknown[] }).batch)) {
    return (parsed as { batch: unknown[] }).batch;
  }
  return [parsed];
}

/** Intercepts the fake ingestion host; any request to real PostHog hosts is counted and aborted. */
async function interceptPosthog(page: Page) {
  const events: Captured[] = [];
  const raw: string[] = [];
  const realHostHits: string[] = [];
  await page.route(`${PH_HOST}/**`, async (route) => {
    const req = route.request();
    raw.push(req.url());
    try {
      for (const e of decodeBody(req)) {
        raw.push(JSON.stringify(e));
        const ev = e as Captured;
        if (ev && typeof ev.event === "string") events.push({ event: ev.event, properties: ev.properties ?? {} });
      }
    } catch {
      raw.push(`undecodable:${req.postDataBuffer()?.length ?? 0}`);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
  });
  await page.route(/posthog\.com/, async (route) => {
    realHostHits.push(new URL(route.request().url()).host);
    await route.abort();
  });
  return { events, raw, realHostHits };
}

async function looksHuman(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
  });
}

async function expectNoClientStorage(page: Page) {
  const cookies = await page.context().cookies();
  expect(cookies.filter((c) => /^ph_|posthog/i.test(c.name)).map((c) => c.name)).toEqual([]);
  const docCookie = await page.evaluate(() => document.cookie);
  expect(docCookie).not.toMatch(/(^|;\s*)ph_|posthog/i);
  const keys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
  expect(keys.filter((k) => /^ph_|posthog|__ph/i.test(k))).toEqual([]);
}

function expectCleanPayloads(raw: string[], extraSecrets: string[] = []) {
  const all = raw.join("\n");
  expect(all).not.toContain(SLUG_RANDOM);
  expect(all).not.toContain("utm_source");
  expect(all).not.toContain("_ev=");
  expect(all).not.toMatch(EMAIL_RE);
  for (const s of extraSecrets) if (s) expect(all).not.toContain(s);
  // posthog-js generates random UUIDv7s (event uuid, distinct/device/session/window/pageview ids) —
  // not user data. Our ids are v4 (gen_random_uuid); any non-v7 UUID left means a leak.
  const withoutSdkIds = all.replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<sdk-id>");
  expect(withoutSdkIds).not.toMatch(UUID_RE);
}

test.describe("analytics (signed out)", () => {
  test("cookieless, sanitized pageviews, flash event", async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, userAgent: USER_AGENT });
    await looksHuman(context);
    const page = await context.newPage();
    const cap = await interceptPosthog(page);

    // Full page loads: each one is a new in-memory PostHog instance, so wait for its pageview
    // (batched events still queued when a page unloads go out by beacon, best effort).
    const pageviews = () => cap.events.filter((e) => e.event === "$pageview").length;
    const visit = async (url: string) => {
      const before = pageviews();
      await page.goto(url);
      await expect.poll(pageviews, { timeout: 20_000 }).toBeGreaterThan(before);
    };

    await visit("/");
    // A book link with tracking params + fragment (404 for this made-up slug; still a pageview).
    await visit(`/b/${SLUG}?utm_source=whatsapp#p2`);
    // A protected route with an id → redirected to /login?next=/books/<uuid>/edit.
    const bookId = "3f2b8c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6b";
    await visit(`/books/${bookId}/edit`);
    await expect(page).toHaveURL(/\/login/);
    // Flash event from the server redirect contract; must be removed from the address bar.
    await visit("/?_ev=book_created");
    await expect.poll(() => cap.events.some((e) => e.event === "book_created"), { timeout: 20_000 }).toBe(true);
    await expect(page).not.toHaveURL(/_ev=/);
    // Unknown flash codes are ignored (and stay harmless).
    await visit("/?_ev=caption_written");
    await visit("/dev-viewer");

    await expectNoClientStorage(page);
    expect(cap.realHostHits).toEqual([]);
    for (const e of cap.events) expect(ALLOWED_EVENTS.has(e.event), e.event).toBe(true);
    expect(cap.events.some((e) => e.event === "caption_written")).toBe(false);

    const urls = cap.events.filter((e) => e.event === "$pageview").map((e) => String(e.properties.$current_url ?? ""));
    expect(urls.some((u) => u.endsWith("/b/:slug"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/login"))).toBe(true);
    for (const u of urls) expect(u).not.toMatch(/[?#]/);
    for (const e of cap.events) {
      expect(e.properties).not.toHaveProperty("title");
      expect(e.properties).not.toHaveProperty("$set");
      expect(e.properties).not.toHaveProperty("$raw_user_agent");
    }
    expectCleanPayloads(cap.raw, [bookId]);
    console.log(`[analytics] events=${cap.events.length} requests=${cap.raw.filter((r) => r.startsWith("http")).length}`);
    await context.close();
  });
});

// --- live: sign-up flash + book_created (E2E_AUTH=1) ----------------------------------------------

let admin: SupabaseClient | null = null;
let uid = "";

test.describe("analytics (live sign-up)", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 as well for the live sign-up part");

  test.beforeAll(() => {
    if (!process.env.SUPABASE_SECRET_KEY) {
      try {
        process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
      } catch {
        /* reported below */
      }
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("missing Supabase env");
    admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  });

  test.afterAll(async () => {
    if (!admin || !uid) return;
    const { error } = await admin.auth.admin.deleteUser(uid);
    const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
    console.log(`[cleanup] userDeleted=${!error} books=${books.count}`);
    expect(error).toBeNull();
  });

  test("signed_up + book_created, no email or ids captured", async ({ browser }) => {
    test.setTimeout(120_000);
    const email = `e2e+t14-${randomBytes(4).toString("hex")}@example.com`;
    const created = await admin!.auth.admin.createUser({ email, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`createUser failed (${created.error?.code ?? "no user"})`);
    uid = created.data.user.id;
    const link = await admin!.auth.admin.generateLink({ type: "magiclink", email });
    const hash = link.data.properties?.hashed_token;
    if (!hash) throw new Error("generateLink failed");

    const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, userAgent: USER_AGENT });
    await looksHuman(context);
    const page = await context.newPage();
    const cap = await interceptPosthog(page);

    await page.goto(`/auth/confirm?token_hash=${hash}&type=magiclink&next=/books/new`);
    await expect(page).toHaveURL(/\/books\/new/);
    await expect.poll(() => cap.events.find((e) => e.event === "signed_up")?.properties.method, { timeout: 20_000 }).toBe("email");
    await expect(page).not.toHaveURL(/_ev=/);

    await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
    await expect(page.getByTestId("occasion-travel")).toBeChecked();
    await page.getByTestId("create-book").click();
    await expect(page).toHaveURL(/\/books\/[0-9a-f-]{36}\/upload/, { timeout: 30_000 });
    const bookId = /\/books\/([0-9a-f-]{36})\//.exec(page.url())?.[1] ?? "";
    await expect.poll(() => cap.events.some((e) => e.event === "book_created"), { timeout: 20_000 }).toBe(true);
    await expect(page).not.toHaveURL(/_ev=/);
    await expect
      .poll(() => cap.events.some((e) => String(e.properties.$current_url ?? "").endsWith("/books/:id/upload")), { timeout: 20_000 })
      .toBe(true);

    await expectNoClientStorage(page);
    expect(cap.realHostHits).toEqual([]);
    for (const e of cap.events) expect(ALLOWED_EVENTS.has(e.event), e.event).toBe(true);
    expectCleanPayloads(cap.raw, [uid, bookId, email, hash]);
    console.log(`[analytics-live] events=${cap.events.length}`);
    await context.close();
  });
});
