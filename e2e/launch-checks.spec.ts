/**
 * Milestone 9 T17 — launch HTTP checks that need a PRODUCTION server (`next start`), 375 px.
 *
 * SKIPPED unless E2E_LAUNCH=1 (the default config runs `next dev`, where these are covered by unit
 * tests). Point a config at a `next start` server that was started with a CRON_SECRET.
 *
 * SAFETY: this spec NEVER sends the right CRON_SECRET — a 200 cron call against the live project
 * would really delete eligible books. Only the 401/no-auth paths are exercised here; the 200 path
 * (counts JSON) is covered by tests/cron-route.test.ts with a mocked runCleanup.
 *
 * Checks: cron no auth / wrong bearer / wrong scheme → 401 (503 not_configured → skip);
 * /admin/ai-spend → 404 for anonymous; landing, /privacy, /terms render at 375 px with no
 * horizontal overflow; unsubscribe invalid token → 400 page.
 * With E2E_AUTH=1 as well (live DB): one throwaway user `e2e+m9chk-<random>@example.com`; a
 * valid unsubscribe token (signed here with BOOK_ACCESS_SECRET from .env.local, which the server
 * also reads) → GET shows the confirm page and does NOT change profiles.email_reminders; the
 * page's own POST button turns it off. afterAll deletes the user. Logs: statuses / booleans only.
 *
 * Example:
 *   E2E_LAUNCH=1 E2E_AUTH=1 npx playwright test -c <config: baseURL of next start, no webServer> e2e/launch-checks.spec.ts
 */
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.E2E_LAUNCH === "1";
const LIVE = ENABLED && process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_LAUNCH=1 and point the config at a `next start` server with CRON_SECRET set");

if (LIVE && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported below */
  }
}

const VIEWPORT = { width: 375, height: 812 };
const CRON = "/api/cron/cleanup";

async function noOverflow(p: Page) {
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(VIEWPORT.width);
}

/** Mirrors src/lib/email/unsubscribe-token.ts (u1.<payload>.<mac>, key = HMAC(secret, "unsub-v1")). */
function unsubToken(userId: string, secret: string): string {
  const key = createHmac("sha256", secret).update("unsub-v1").digest();
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + 86_400_000 })).toString("base64url");
  const mac = createHmac("sha256", key).update(`u1.${payload}`).digest().toString("base64url");
  return `u1.${payload}.${mac}`;
}

test.describe("cron + admin + public pages", () => {
  test.use({ viewport: VIEWPORT });

  test("cron: no auth / wrong secret / wrong scheme → 401, no-store, nothing but an error code", async ({ request }) => {
    const none = await request.get(CRON);
    test.skip(none.status() === 503, "server has no CRON_SECRET (503 not_configured) — restart it with one");
    expect(none.status()).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthorized" });
    expect(none.headers()["cache-control"]).toContain("no-store");
    for (const auth of [`Bearer ${randomBytes(24).toString("hex")}`, "Bearer ", "Basic Zm9vOmJhcg==", "bearer"]) {
      const r = await request.get(CRON, { headers: { authorization: auth } });
      expect(r.status(), auth.split(" ")[0]).toBe(401);
    }
    // Other methods are not routes (no POST handler).
    const post = await request.post(CRON);
    expect(post.status()).toBe(405);
    console.log("[cron] 401 paths ok; right secret deliberately NOT sent");
  });

  test("/admin/ai-spend → 404 for anonymous (no data, noindex)", async ({ page }) => {
    const res = await page.goto("/admin/ai-spend");
    expect(res?.status()).toBe(404);
    await expect(page.getByText(/AI spend/i)).toHaveCount(0);
  });

  test("landing at 375: hero + pricing, no horizontal overflow", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.getByText("AED 39").first()).toBeVisible();
    await noOverflow(page);
  });

  for (const p of ["/privacy", "/terms"]) {
    test(`${p} renders at 375 with no overflow and mentions AI processing`, async ({ page }) => {
      const res = await page.goto(p);
      expect(res?.status()).toBe(200);
      await expect(page.locator("h1").first()).toBeVisible();
      await expect(page.locator("main")).toContainText(/AI|Anthropic|Claude/);
      await noOverflow(page);
    });
  }

  test("unsubscribe: missing / garbage token → 400 page, noindex + no-store", async ({ request }) => {
    for (const q of ["", "?t=u1.abc.def", `?t=${"x".repeat(300)}`]) {
      const r = await request.get(`/api/email/unsubscribe${q}`);
      expect(r.status()).toBe(400);
      expect(r.headers()["cache-control"]).toContain("no-store");
      expect(r.headers()["x-robots-tag"] ?? "").toContain("noindex");
    }
  });
});

test.describe("unsubscribe against the live DB", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 too for the live unsubscribe check");
  let admin: SupabaseClient;
  let uid = "";

  test.beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `e2e+m9chk-${randomBytes(5).toString("hex")}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "?"})`);
    uid = data.user.id;
  });

  test.afterAll(async () => {
    if (!uid) return;
    const { error } = await admin.auth.admin.deleteUser(uid);
    console.log(`[cleanup] userDeleted=${!error}`);
  });

  test("GET (mail-scanner prefetch) never mutates; the page's POST button turns reminders off", async ({ page, request }) => {
    test.setTimeout(60_000);
    const secret = process.env.BOOK_ACCESS_SECRET?.trim() ?? "";
    test.skip(secret.length < 32, "BOOK_ACCESS_SECRET not available to the test process");
    const reminders = async () =>
      (await admin.from("profiles").select("email_reminders").eq("id", uid).maybeSingle()).data?.email_reminders ?? null;
    const before = await reminders();
    expect(before === null || before === true).toBe(true);

    const t = unsubToken(uid, secret);
    const url = `/api/email/unsubscribe?t=${encodeURIComponent(t)}`;
    for (let i = 0; i < 3; i++) expect((await request.get(url)).status()).toBe(200);
    expect((await request.head(url)).status()).toBeLessThan(500);
    expect(await reminders()).toBe(before);

    await page.setViewportSize(VIEWPORT);
    await page.goto(url);
    await noOverflow(page);
    expect(await reminders()).toBe(before);
    const button = page.locator("form button, form input[type=submit]").first();
    await expect(button).toBeVisible();
    await Promise.all([page.waitForLoadState("load"), button.click()]);
    await expect.poll(reminders, { timeout: 10_000 }).toBe(false);
    console.log(`[unsub] before=${before} afterGETs=unchanged afterPOST=false`);
  });

  test("review S3: opening a WARNED draft in the editor resets its idle clock and clears the warning; an unwarned one is untouched", async ({ page }) => {
    test.setTimeout(90_000);
    const ins = await admin
      .from("books")
      .insert([
        { user_id: uid, title: "Warned draft", occasion: "other", tone: "fun" },
        { user_id: uid, title: "Quiet draft", occasion: "other", tone: "fun" },
      ])
      .select("id, title");
    expect(ins.error).toBeNull();
    const warned = ins.data!.find((b) => b.title === "Warned draft")!.id as string;
    const quiet = ins.data!.find((b) => b.title === "Quiet draft")!.id as string;
    // updated_at can't be back-dated (the trigger sets now()), so assert a strict bump over the
    // seeded value instead. Warning-only updates keep updated_at (1600 trigger).
    const warn = await admin.from("books").update({ draft_warning_sent_at: new Date(Date.now() - 86_400_000).toISOString() }).eq("id", warned);
    expect(warn.error).toBeNull();
    const row = async (id: string) =>
      (await admin.from("books").select("updated_at, draft_warning_sent_at").eq("id", id).single()).data as {
        updated_at: string;
        draft_warning_sent_at: string | null;
      };
    const w0 = await row(warned);
    const q0 = await row(quiet);
    expect(w0.draft_warning_sent_at).not.toBeNull();
    await page.waitForTimeout(1_500);

    const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: (await admin.auth.admin.getUserById(uid)).data.user!.email! });
    await page.setViewportSize(VIEWPORT);
    await page.goto(`/auth/confirm?token_hash=${link.properties!.hashed_token}&type=magiclink&next=/dashboard`);
    await expect(page).toHaveURL(/\/dashboard$/);
    for (const id of [warned, quiet]) {
      const res = await page.goto(`/books/${id}/edit`);
      expect(res?.status()).toBeLessThan(400);
    }
    const w1 = await row(warned);
    const q1 = await row(quiet);
    console.log(
      `[touch] warned: bumped=${Date.parse(w1.updated_at) > Date.parse(w0.updated_at)} cleared=${w1.draft_warning_sent_at === null}; quiet: unchanged=${q1.updated_at === q0.updated_at}`,
    );
    expect(Date.parse(w1.updated_at)).toBeGreaterThan(Date.parse(w0.updated_at) + 1_000);
    expect(w1.draft_warning_sent_at).toBeNull();
    expect(q1.updated_at).toBe(q0.updated_at);
  });
});
