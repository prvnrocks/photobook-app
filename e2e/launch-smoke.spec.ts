/**
 * Milestone 9 T17 — launch smoke against the LIVE hosted Supabase project (opt-in), 375 px phone.
 * PLAN M9: "Playwright smoke: login → upload → AI build → edit caption → publish → view → pay (test mode)".
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic (server: AI_MODE=replay, no ANTHROPIC_API_KEY) and
 * never calls Stripe successfully: the server runs with a dummy STRIPE_SECRET_KEY and a random
 * STRIPE_WEBHOOK_SECRET; payment is simulated with a locally SIGNED checkout.session.completed
 * (scripts/stripe-signed-event.mjs) — the same path a real Stripe event takes (webhook → RPC).
 *
 * Flow (serial, one throwaway user `e2e+m9smoke-<random>@example.com`, admin generateLink sign-in):
 *   a. photos first (M13): /books/start → pick 6 synthetic JPEGs → upload screen (no second picker; setup
 *      card: Travel + Modern) → the first build starts by itself (replay) → editor: edit one caption
 *      (Saved ✓, persisted) → Share = publish ("Your book is live"; the caption is in the snapshot)
 *   b. anonymous phone visit of /b/<slug> at 375 px: watermark + "Made with" footer, no horizontal
 *      overflow, last page = free end card with the "Create yours" CTA
 *   c. owner taps "Upgrade this book — AED 39" (dummy key → error, nothing paid), then a signed
 *      checkout.session.completed (3900 aed) → 200 → book paid in the DB
 *   d. anonymous reload: no watermark / footer; end card = paid: "The end" + snapshot title +
 *      Replay / Share; Replay returns to the cover
 *   e. owner taps "Download PDF" (paid) on the publish screen → a PDF file is received
 *   f. dashboard shows "Paid" on the card                                  (needs migration 1600)
 *   g. dashboard ⋯ → Delete book: the paid book is refused ("has a payment"), a free draft seeded
 *      for the user is deleted and its card disappears                    (needs 1600 + 1700)
 * afterAll (always): orders, private.stripe_events (linked CLI), exports rows, storage objects under
 * `<uid>/` in the photos + exports buckets, then the user (books/photos cascade). Per-test timeouts
 * only (no --global-timeout, so afterAll runs). Logs: counts / booleans / statuses only.
 *
 * Preconditions detected in beforeAll — dependent tests skip with a clear message instead of failing:
 *   migration 1000 (publish), 1200 (fulfill_book_checkout), 1400 (exports), 1600 (cleanup columns:
 *   the dashboard query selects books.draft_warning_sent_at → errors without it), 1700
 *   (delete_book_guarded); server payments on + same webhook secret.
 *
 * Example:
 *   (scratch copy) NEXT_PUBLIC_APP_URL=http://localhost:3717 AI_MODE=replay ANTHROPIC_API_KEY= next build
 *   STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_x AI_MODE=replay ANTHROPIC_API_KEY= \
 *     NEXT_PUBLIC_APP_URL=http://localhost:3717 next start -p 3717
 *   E2E_AUTH=1 STRIPE_WEBHOOK_SECRET=whsec_x npx playwright test -c <config: baseURL :3717, no webServer> e2e/launch-smoke.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildEvent, postEvent, signPayload } from "../scripts/stripe-signed-event.mjs";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live launch smoke");

// Captured before .env.local is loaded (its STRIPE_* entries are empty).
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const BUCKETS = ["photos", "exports"] as const;
const VIEWPORT = { width: 375, height: 812 };
const REPO = path.join(__dirname, "..");
const CAPTION = "Launch smoke caption by the sea";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let admin: SupabaseClient;
let uid = "";
let email = "";
let context: BrowserContext;
let page: Page;
let baseURL = "";
let bookId = "";
let draftId = "";
let slug = "";
const ready = { m1000: false, m1200: false, m1400: false, m1600: false, m1700: false, payments: false, secret: false };
const eventIds: string[] = [];

async function signInHash(): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  return data.properties.hashed_token;
}

async function listAllUserObjects(bucket: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (prefix: string, depth: number) => {
    const res = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
    if (res.error) throw new Error(`storage list failed (${res.error.message})`);
    for (const e of res.data ?? []) {
      if (e.id || depth >= 3) out.push(`${prefix}/${e.name}`);
      else await walk(`${prefix}/${e.name}`, depth + 1);
    }
  };
  await walk(uid, 0);
  return out;
}

/** `n` distinct, sharp JPEGs (not duplicates, not blurry) drawn in the browser. */
async function makeSynthetic(p: Page, n: number) {
  const list = await p.evaluate(async (count) => {
    function rng(seed: number) {
      let s = seed >>> 0;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    }
    async function draw(seed: number): Promise<string> {
      const r = rng(seed * 7919 + 17);
      const c = document.createElement("canvas");
      c.width = 900;
      c.height = 1200;
      const g = c.getContext("2d")!;
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 9; x++) {
          g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
          g.fillRect(x * 100, y * 100, 100, 100);
        }
      }
      const img = g.getImageData(0, 0, 900, 1200);
      for (let i = 0; i < img.data.length; i += 4) {
        const d = Math.floor((r() - 0.5) * 60);
        img.data[i] += d;
        img.data[i + 1] += d;
        img.data[i + 2] += d;
      }
      g.putImageData(img, 0, 0);
      return new Promise((resolve) =>
        c.toBlob(
          (blob) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(",")[1]);
            fr.readAsDataURL(blob!);
          },
          "image/jpeg",
          0.92,
        ),
      );
    }
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(await draw(i + 901));
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `smoke-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

type BookRow = {
  doc: { pages?: { caption?: { text?: string } | null }[] };
  published_doc: { cover?: { title?: string }; pages?: { caption?: { text?: string } | null }[] } | null;
  slug: string | null;
  expires_at: string | null;
  is_paid: boolean;
  max_pages: number;
};

async function bookRow(id = bookId): Promise<BookRow> {
  const { data, error } = await admin
    .from("books")
    .select("doc, published_doc, slug, expires_at, is_paid, max_pages")
    .eq("id", id)
    .single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as BookRow;
}

function hasCaption(pages: { caption?: { text?: string } | null }[] | undefined): boolean {
  return (pages ?? []).some((p) => p.caption?.text === CAPTION);
}

async function noHorizontalOverflow(p: Page) {
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);
}

/** Flips forward until the counter reads "End" (≤ 80 taps). */
async function flipToEnd(v: Page) {
  const counter = v.getByTestId("page-counter");
  for (let i = 0; i < 80; i++) {
    if ((await counter.innerText()).trim() === "End") return;
    await v.getByTestId("next-page").click();
  }
  await expect(counter).toHaveText("End");
}

async function anonPage(browser: Browser): Promise<{ ctx: BrowserContext; v: Page }> {
  const ctx = await browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true });
  const v = await ctx.newPage();
  const res = await v.goto(`/b/${slug}`);
  expect(res?.status()).toBe(200);
  await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  return { ctx, v };
}

function needBook() {
  test.skip(!ready.m1000, "migration 1000 (publish) is not applied to the live project");
}
function needPaid() {
  needBook();
  test.skip(!ready.payments, "server has payments off (webhook 503) — start it with STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET");
  test.skip(!WEBHOOK_SECRET || !ready.secret, "STRIPE_WEBHOOK_SECRET missing in the test env or differs from the server's");
  test.skip(!ready.m1200, "migration 1200 (fulfill_book_checkout) is not applied to the live project");
}
function need1600() {
  test.skip(
    !ready.m1600,
    "migration 20261114001600_cleanup is NOT applied to the live project — the dashboard query selects books.draft_warning_sent_at (42703) — run `npx supabase db push`, then re-run",
  );
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async ({ browser, request }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  ready.m1000 = !(await admin.from("books").select("published_rev, published_doc").limit(1)).error;
  const fulfil = await admin.rpc("fulfill_book_checkout" as never, {
    p_event_id: null,
    p_event_type: null,
    p_session_id: null,
    p_payment_intent: null,
    p_book_id: null,
    p_user_id: null,
    p_amount: null,
    p_currency: null,
    p_livemode: null,
  } as never);
  ready.m1200 = fulfil.error?.code === "22023";
  ready.m1400 = !(await admin.from("exports").select("id").limit(1)).error;
  const cols = await admin.from("books").select("draft_warning_sent_at, expiry_warning_sent_at").limit(1);
  const prof = await admin.from("profiles").select("email_reminders").limit(1);
  ready.m1600 = !cols.error && !prof.error;
  const del = await admin.rpc("delete_book_guarded" as never, { p_book: randomUUID(), p_user: randomUUID() } as never);
  ready.m1700 = !del.error && del.data === "not_found";

  const unsigned = await request.post("/api/stripe/webhook", { data: "{}", headers: { "content-type": "application/json" } });
  ready.payments = unsigned.status() === 400;
  if (ready.payments && WEBHOOK_SECRET) {
    const payload = JSON.stringify({
      id: `evt_test_${randomBytes(12).toString("hex")}`,
      object: "event",
      api_version: "2026-10-28.endive",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "customer.created",
      data: { object: { id: "cus_test_probe", object: "customer" } },
    });
    const r = await request.post("/api/stripe/webhook", {
      data: payload,
      headers: { "content-type": "application/json", "stripe-signature": signPayload(payload, WEBHOOK_SECRET) },
    });
    ready.secret = r.status() === 200;
  }
  console.log(
    `[setup] ${Object.entries(ready)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}${del.error ? ` probe1700=${del.error.code}` : ""}${cols.error ? ` probe1600=${cols.error.code}` : ""}`,
  );
  if (!ready.m1000) return;

  email = `e2e+m9smoke-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;

  context = await browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  // M13 T5: landing CTA → login → /books/start (photos first).
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/start`);
  await expect(page).toHaveURL(/\/books\/start$/);
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  if (!uid) return;
  await context?.close().catch(() => {});
  const bookIds = [bookId, draftId].filter(Boolean);
  // This run's agent_runs (the user delete only nulls their ids) — collected first, deleted by id last.
  const runIds = ((await admin.from("agent_runs").select("id").eq("user_id", uid)).data ?? []).map((r) => (r as { id: string }).id);

  // orders: user_id / book_id are ON DELETE SET NULL → delete explicitly first.
  let ordersDeleted = 0;
  const byUser = await admin.from("orders").delete().eq("user_id", uid).select("id");
  ordersDeleted += byUser.data?.length ?? 0;
  if (bookIds.length) ordersDeleted += (await admin.from("orders").delete().in("book_id", bookIds).select("id")).data?.length ?? 0;

  let exportRows = 0;
  if (ready.m1400) exportRows = (await admin.from("exports").delete().eq("user_id", uid).select("id")).data?.length ?? 0;

  let eventsLeft: number | string = 0;
  const ids = eventIds.filter((id) => /^evt_test_[0-9a-f]{24}$/.test(id));
  if (ready.m1200 && ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    try {
      execFileSync("npx", ["supabase", "db", "query", "--linked", `delete from private.stripe_events where id in (${list})`], {
        cwd: REPO,
        stdio: "pipe",
        timeout: 60_000,
      });
      const out = execFileSync(
        "npx",
        ["supabase", "db", "query", "--linked", `select count(*)::int as n from private.stripe_events where id in (${list})`],
        { cwd: REPO, stdio: "pipe", timeout: 60_000 },
      ).toString();
      eventsLeft = Number(/"n"\s*:\s*(\d+)/.exec(out)?.[1] ?? "NaN");
    } catch {
      eventsLeft = `unknown (cli failed; ${ids.length} evt_test_ ids sent)`;
    }
  }

  let removed = 0;
  for (const bucket of BUCKETS) {
    for (let round = 0; round < 3; round++) {
      const paths = await listAllUserObjects(bucket);
      if (paths.length === 0) break;
      for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
      removed += paths.length;
    }
  }
  const { error } = await admin.auth.admin.deleteUser(uid);
  let runsDeleted = 0;
  for (let i = 0; i < runIds.length; i += 100) runsDeleted += (await admin.from("agent_runs").delete().in("id", runIds.slice(i, i + 100)).select("id")).data?.length ?? 0;
  const runsLeft = runIds.length ? (await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", runIds)).count ?? 0 : 0;
  console.log(`[cleanup] agent_runs found=${runIds.length} deleted=${runsDeleted} left=${runsLeft}`);
  let left = 0;
  for (const bucket of BUCKETS) left += (await listAllUserObjects(bucket)).length;
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const orders = bookIds.length
    ? await admin.from("orders").select("id", { count: "exact", head: true }).in("book_id", bookIds)
    : { count: 0 };
  console.log(
    `[cleanup] objects removed=${removed} left=${left} books=${books.count} ordersDeleted=${ordersDeleted} ordersLeft=${orders.count} exportRows=${exportRows} stripeEventsSent=${ids.length} stripeEventsLeft=${eventsLeft} userDeleted=${!error}`,
  );
  expect(error).toBeNull();
  expect(left).toBe(0);
  expect(books.count).toBe(0);
  expect(orders.count ?? 0).toBe(0);
});

test("a. login → choose photos → upload (setup card) → automatic AI build (replay) → edit a caption → Share (publishes)", async () => {
  needBook();
  test.setTimeout(600_000);
  // M13 T5: one "Choose photos" — picking creates the draft and carries the files to the upload screen.
  await expect(page.getByTestId("start-pick")).toBeVisible();
  await page.getByTestId("start-pick-input").setInputFiles(await makeSynthetic(page, 6));
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  bookId = new URL(page.url()).pathname.split("/")[2];
  // M13 T6: setup card while uploading; D-068: travel defaults to Geometric — this spec covers Modern.
  await page.locator("label", { has: page.getByTestId("setup-occasion-travel") }).click();
  await page.getByTestId("setup-change").click();
  await page.locator("label", { has: page.getByTestId("setup-style-modern") }).click();
  await expect(page.getByTestId("setup-status")).toHaveText("Saved", { timeout: 15_000 });
  await noHorizontalOverflow(page);
  // No Build tap: once uploads + finalize settle the first build starts by itself.
  await page.waitForURL(new RegExp(`/books/${bookId}/build\\?auto=1$`), { timeout: 240_000 });
  // M13 T7: the build screen shows the draft book (rule album) while AI works.
  await expect(page.getByTestId("build-draft")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("build-ai-note")).toBeVisible();
  // The draft's photos really load (signed 512 px thumbs), not just empty frames.
  const draftImgs = () =>
    page
      .locator('[data-testid="build-draft"] img')
      .evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0).length);
  await expect.poll(draftImgs, { timeout: 15_000 }).toBeGreaterThan(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath("m13-build-375.png"), fullPage: true });
  const setup = (await admin.from("books").select("occasion, tone, design_style").eq("id", bookId).single()).data;
  expect(setup).toEqual({ occasion: "travel", tone: "fun", design_style: "modern" });
  // M13 T7: the build hands over to the editor (review is reached from the "AI kept X of Y" chip).
  await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: 420_000 });
  await noHorizontalOverflow(page);
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await expect(page.getByTestId("ai-summary-chip")).toBeVisible();
  await expect(page.getByTestId("ai-summary-link")).toHaveAttribute("href", `/books/${bookId}/review`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.screenshot({ path: test.info().outputPath("m13-editor-chip-375.png") });

  // Editor: walk the carousel to the first page with a caption target and type a new caption.
  const cur = page.locator('[data-testid="carousel-item"][aria-hidden="false"]');
  let steps = 0;
  for (; steps < 25; steps++) {
    if ((await cur.getByTestId("caption-target").count()) > 0) break;
    await page.getByTestId("carousel-next").click();
    await page.waitForTimeout(400);
  }
  console.log(`[a] caption target after ${steps} carousel steps`);
  const target = cur.getByTestId("caption-target");
  await expect(target).toHaveCount(1);
  await target.click();
  const input = page.getByTestId("caption-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("dir", "auto");
  await input.fill(CAPTION);
  await expect(cur.getByTestId("page-caption")).toHaveText(CAPTION);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  await noHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  expect(hasCaption((await bookRow()).doc.pages)).toBe(true);

  // M13 T9: Share = publish → share screen; WhatsApp is the next tap.
  await expect(page.getByTestId("editor-share-note")).toHaveText("Free · 30 days");
  await page.getByTestId("editor-done").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
  await expect(page.getByTestId("share-whatsapp")).toBeVisible();
  await noHorizontalOverflow(page);
  const row = await bookRow();
  slug = row.slug ?? "";
  expect(slug).not.toBe("");
  expect(row.is_paid).toBe(false);
  expect(row.expires_at).not.toBeNull();
  expect(hasCaption(row.published_doc?.pages)).toBe(true);
});

test("b. anonymous phone view at 375 px: watermark + footer, free end card CTA", async ({ browser }) => {
  needBook();
  test.skip(!slug, "needs test a");
  const { ctx, v } = await anonPage(browser);
  try {
    const watermarks = await v.getByTestId("watermark").count();
    const footer = await v.getByTestId("made-with-footer").count();
    console.log(`[b] watermarks=${watermarks} footer=${footer}`);
    expect(watermarks).toBeGreaterThan(0);
    expect(footer).toBe(1);
    await noHorizontalOverflow(v);
    await flipToEnd(v);
    const card = v.locator('[data-testid="end-card"][data-paid="false"]');
    await expect(card.getByTestId("end-card-cta").last()).toBeVisible();
    await expect(v.getByTestId("end-card-heading")).toHaveCount(0);
    await noHorizontalOverflow(v);
    await v.screenshot({ path: test.info().outputPath("smoke-free-end-375.png") });
  } finally {
    await ctx.close();
  }
});

test("c. owner Upgrade: button fails safely with the dummy key; signed checkout.session.completed → paid", async () => {
  needPaid();
  test.skip(!slug, "needs test a");
  await page.goto(`/books/${bookId}/publish`);
  const btn = page.getByTestId("publish-upgrade");
  await expect(btn).toHaveText("Upgrade this book — AED 39");
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(page.getByTestId("publish-upgrade-message")).toHaveText("Couldn't start payment — try again", { timeout: 45_000 });
  expect((await bookRow()).is_paid).toBe(false);

  const ev = buildEvent({ type: "completed", bookId, userId: uid, amount: 3900, currency: "aed" });
  eventIds.push(ev.id);
  expect(await postEvent({ baseURL, payload: ev.payload, secret: WEBHOOK_SECRET })).toBe(200);
  const row = await bookRow();
  expect(row.is_paid).toBe(true);
  expect(row.expires_at).toBeNull();
  expect(row.max_pages).toBe(100);
  const orders = await admin.from("orders").select("status, amount, currency").eq("book_id", bookId);
  expect(orders.data).toEqual([{ status: "paid", amount: 3900, currency: "aed" }]);
});

test("d. anonymous reload: no watermark, paid end card with The end + title + Replay/Share", async ({ browser }) => {
  needPaid();
  test.skip(!slug, "needs test a");
  const title = (await bookRow()).published_doc?.cover?.title?.trim() ?? "";
  const { ctx, v } = await anonPage(browser);
  try {
    expect(await v.getByTestId("watermark").count()).toBe(0);
    expect(await v.getByTestId("made-with-footer").count()).toBe(0);
    await flipToEnd(v);
    const card = v.locator('[data-testid="end-card"][data-paid="true"]').last();
    await expect(card.getByTestId("end-card-heading")).toHaveText("The end");
    await expect(card.getByTestId("end-card-heading")).toBeVisible();
    if (title) await expect(card.getByTestId("end-card-title")).toHaveText(title);
    await expect(card.getByTestId("end-card-title")).toHaveAttribute("dir", "auto");
    for (const id of ["end-card-replay", "end-card-share"]) {
      await expect(card.getByTestId(id)).toBeVisible();
      expect((await card.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(v.getByTestId("end-card-cta")).toHaveCount(0);
    await noHorizontalOverflow(v);
    await v.screenshot({ path: test.info().outputPath("smoke-paid-end-375.png") });
    await card.getByTestId("end-card-replay").click();
    await expect(v.getByTestId("page-counter")).toHaveText("Cover");
  } finally {
    await ctx.close();
  }
});

test("e. Download PDF (paid) on the publish screen → file received", async () => {
  needPaid();
  test.skip(!ready.m1400, "migration 1400 (exports) is not applied to the live project");
  test.setTimeout(300_000);
  await page.goto(`/books/${bookId}/publish`);
  await expect(page.getByTestId("publish-pdf")).toBeVisible({ timeout: 30_000 });
  const btn = page.getByTestId("pdf-download");
  await expect(btn).toBeEnabled();
  const t0 = Date.now();
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await btn.click();
  const d = await download;
  const file = test.info().outputPath("smoke.pdf");
  await d.saveAs(file);
  const bytes = readFileSync(file);
  console.log(`[e] click→download ${((Date.now() - t0) / 1000).toFixed(1)} s bytes=${bytes.length} pdfName=${/\.pdf$/i.test(d.suggestedFilename())}`);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(10_000);
  expect(d.suggestedFilename()).toMatch(/\.pdf$/i);
  await expect(page.getByTestId("pdf-status-text")).toHaveText("Your PDF is ready", { timeout: 15_000 });
});

test("f. dashboard shows Paid on the book card", async () => {
  needPaid();
  need1600();
  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-heading")).toBeVisible();
  const card = page.getByTestId("book-list").locator("li").filter({ has: page.locator(`a[data-testid="book-card"][href*="${bookId}"]`) });
  await expect(card.getByText("Paid", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("g. dashboard ⋯ → Delete book: paid book refused; a free draft is deleted and its card disappears", async () => {
  needPaid();
  need1600();
  test.skip(!ready.m1700, "migration 20261114001700_payments_hardening is NOT applied (delete_book_guarded → PGRST202)");
  const ins = await admin.from("books").insert({ user_id: uid, title: "Smoke draft", occasion: "other", tone: "fun" }).select("id").single();
  expect(ins.error).toBeNull();
  draftId = (ins.data as { id: string }).id;
  await page.goto("/dashboard");
  await expect(page.getByTestId("book-card")).toHaveCount(2);

  const paidCard = page.locator("li").filter({ has: page.locator(`a[data-testid="book-card"][href*="${bookId}"]`) });
  await paidCard.getByTestId("book-menu").click();
  await page.getByTestId("book-menu-delete").click();
  const dialog = page.getByTestId("delete-book-dialog");
  await dialog.getByTestId("delete-book-confirm").click();
  await expect(dialog.getByTestId("delete-book-error")).toHaveText("This book has a payment — contact support to delete it.", { timeout: 20_000 });
  await dialog.getByTestId("delete-book-cancel").click();
  await expect(dialog).toBeHidden();
  expect((await bookRow()).is_paid).toBe(true);

  const draftCard = page.locator("li").filter({ has: page.locator(`a[data-testid="book-card"][href*="${draftId}"]`) });
  await draftCard.getByTestId("book-menu").click();
  await page.getByTestId("book-menu-delete").click();
  await expect(dialog.getByTestId("delete-book-title")).toHaveText("Smoke draft");
  await dialog.getByTestId("delete-book-confirm").click();
  await expect(page.getByTestId("book-card")).toHaveCount(1, { timeout: 20_000 });
  await expect(draftCard).toHaveCount(0);
  const gone = await admin.from("books").select("id").eq("id", draftId).maybeSingle();
  expect(gone.data).toBeNull();
});
