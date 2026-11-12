/**
 * Milestone 7 — payments end to end against the LIVE hosted Supabase project (opt-in), with
 * Stripe simulated by locally signed webhook events (scripts/stripe-signed-event.mjs).
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic (server: AI_MODE=replay, no ANTHROPIC_API_KEY).
 * There are no real Stripe keys: the server runs with a dummy STRIPE_SECRET_KEY and a random
 * STRIPE_WEBHOOK_SECRET, and this process must get the SAME STRIPE_WEBHOOK_SECRET in its env. The
 * webhook only verifies the signature; it never calls the Stripe API. The upgrade button DOES call
 * Stripe (sessions.create) and must fail with the dummy key — proving there is no fake success.
 *
 * Creates ONE throwaway user `e2e+m7-<random>@example.com` (admin generateLink, no email), one book
 * built in replay mode and published (book 1), and one admin-cloned published book (book 2, same
 * snapshot, new slug, no photos of its own). afterAll (always): orders rows of the user/books,
 * private.stripe_events rows this run created (via `supabase db query --linked`), storage objects
 * under `<uid>/`, then the user (books/photos cascade). Per-test timeouts (no --global-timeout).
 * Logs are counts/booleans/status codes only — never titles, ids, slugs, emails or secrets.
 *
 * Preconditions detected in beforeAll (tests skip with a clear message instead of failing):
 *   - migration 1000 (publish) applied;
 *   - migration 1200 (fulfill_book_checkout RPC): when missing, the fulfilment tests (c, d, f-flip,
 *     g-paid, h) skip and "c0" asserts the webhook answers 500 (Stripe would retry) and the book
 *     stays free;
 *   - the server has payments on (unsigned POST → 400, not 503) and its webhook secret matches ours
 *     (a signed ignored event → 200).
 *
 * Example:
 *   (production build in a scratch copy)
 *   STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_x AI_MODE=replay ANTHROPIC_API_KEY= next start -p 3640
 *   E2E_AUTH=1 STRIPE_WEBHOOK_SECRET=whsec_x npx playwright test -c <config: baseURL :3640, no webServer> e2e/payments.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildEvent, postEvent, signPayload } from "../scripts/stripe-signed-event.mjs";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live payments flow");

// Captured before .env.local is loaded (its STRIPE_* entries are empty).
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const BUCKET = "photos";
const VIEWPORT = { width: 375, height: 812 };
const DAY = 86_400_000;
const REPO = path.join(__dirname, "..");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
let slug = "";
let book2Id = "";
let slug2 = "";
let migration1000: boolean | null = null;
let migration1200: boolean | null = null;
let paymentsOn: boolean | null = null;
let secretMatches: boolean | null = null;
/** The paid event of test c (replayed in d; its payment intent is refunded in h). */
let paidEvent: ReturnType<typeof buildEvent> | null = null;
const eventIds: string[] = [];

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

function slugRandom(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => BASE58[b % BASE58.length]).join("");
}

async function signInHash(): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  return data.properties.hashed_token;
}

async function listAllUserObjects(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (prefix: string, depth: number) => {
    const res = await admin.storage.from(BUCKET).list(prefix, { limit: 1000 });
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
async function makeSynthetic(p: Page, n: number): Promise<FileSpec[]> {
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
    for (let i = 0; i < count; i++) out.push(await draw(i + 701));
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `pay-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

type BookRow = {
  doc: Record<string, unknown>;
  doc_rev: number;
  slug: string | null;
  expires_at: string | null;
  is_paid: boolean;
  max_pages: number;
  page_count: number;
};

async function bookRow(id = bookId): Promise<BookRow> {
  const { data, error } = await admin
    .from("books")
    .select("doc, doc_rev, slug, expires_at, is_paid, max_pages, page_count")
    .eq("id", id)
    .single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as BookRow;
}

type OrderRow = {
  status: string;
  amount: number;
  currency: string;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  livemode: boolean | null;
  user_id: string | null;
};

async function ordersFor(id: string): Promise<OrderRow[]> {
  const { data, error } = await admin
    .from("orders")
    .select(
      migration1200
        ? "status, amount, currency, stripe_session_id, stripe_payment_intent_id, paid_at, refunded_at, livemode, user_id"
        : "status, amount, currency, stripe_session_id, user_id", // 1200 adds the other columns
    )
    .eq("book_id", id);
  if (error) throw new Error(`orders select failed (${error.code})`);
  return (data ?? []) as unknown as OrderRow[];
}

async function putDoc(doc: unknown, baseRev: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ id, d, rev }) => {
      const res = await fetch(`/api/books/${id}/doc`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: d, baseRev: rev }),
        credentials: "same-origin",
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
    { id: bookId, d: doc, rev: baseRev },
  );
}

/**
 * Grows the doc to n pages with a VALID shape: each added page copies page 1's layout + caption
 * but keeps the layout's slot count with every photoId null (empty slots are allowed; `slots: []`
 * is invalid_doc because the slot count must equal the layout's photoCount, and reusing photos
 * would be duplicate_photo). New page ids are unique.
 */
function withPages(doc: Record<string, unknown>, n: number): Record<string, unknown> {
  type Slot = { photoId: string | null; crop: unknown };
  const big = structuredClone(doc) as { pages: { id: string; slots: Slot[] }[] };
  const first = big.pages[0];
  const emptySlots = () => first.slots.map((s) => ({ ...structuredClone(s), photoId: null }));
  while (big.pages.length < n) big.pages.push({ ...structuredClone(first), id: `p21x${big.pages.length}`, slots: emptySlots() });
  return big as unknown as Record<string, unknown>;
}

/** Signs + POSTs; remembers the event id for cleanup. */
async function send(ev: ReturnType<typeof buildEvent>, opts: { tamper?: boolean } = {}): Promise<number> {
  eventIds.push(ev.id);
  return postEvent({ baseURL, payload: ev.payload, secret: WEBHOOK_SECRET, tamper: opts.tamper === true });
}

async function anonContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true });
}

/** Anonymous visit of /b/<s>: what the viewer shows. */
async function anonView(browser: Browser, s: string) {
  const anon = await anonContext(browser);
  try {
    const v = await anon.newPage();
    const res = await v.goto(`/b/${s}`);
    const expired = await v.getByTestId("expired-book").count();
    if (expired === 0) await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    return {
      status: res?.status() ?? 0,
      expired: expired > 0,
      watermarks: await v.getByTestId("watermark").count(),
      footer: await v.getByTestId("made-with-footer").count(),
    };
  } finally {
    await anon.close();
  }
}

function needBook() {
  test.skip(migration1000 !== true, "migration 1000 (publish) is not applied to the live project");
}
function needWebhook() {
  needBook();
  test.skip(paymentsOn !== true, "server has payments off (webhook 503) — start it with STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET");
  test.skip(!WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET is not set in the test env (must equal the server's)");
  test.skip(secretMatches !== true, "the server's STRIPE_WEBHOOK_SECRET differs from the test env's");
}
function need1200() {
  needWebhook();
  test.skip(
    migration1200 !== true,
    "migration 20261112001200_payments is NOT applied to the live project (fulfill_book_checkout → PGRST202) — run `npx supabase db push`, then re-run",
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
  const p1000 = await admin.from("books").select("published_rev, published_doc").limit(1);
  migration1000 = !p1000.error;
  // All-null args: with 1200 the RPC raises 22023 before touching anything; without it → PGRST202.
  const probe = await admin.rpc("fulfill_book_checkout" as never, {
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
  migration1200 = probe.error?.code === "22023";

  const unsigned = await request.post("/api/stripe/webhook", { data: "{}", headers: { "content-type": "application/json" } });
  paymentsOn = unsigned.status() === 400;
  if (paymentsOn && WEBHOOK_SECRET) {
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
    secretMatches = r.status() === 200;
  }
  console.log(
    `[setup] migration1000=${migration1000} migration1200=${migration1200}${probe.error && !migration1200 ? ` probe=${probe.error.code}` : ""} webhookUnsigned=${unsigned.status()} secretInEnv=${!!WEBHOOK_SECRET} secretMatches=${secretMatches}`,
  );
  if (!migration1000) return;

  email = `e2e+m7-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;

  context = await browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (!uid) return;
  await context?.close().catch(() => {});

  // orders: user_id / book_id are ON DELETE SET NULL (history survives) → delete explicitly first.
  const bookIds = [bookId, book2Id].filter(Boolean);
  let ordersDeleted = 0;
  const byUser = await admin.from("orders").delete().eq("user_id", uid).select("id");
  ordersDeleted += byUser.data?.length ?? 0;
  if (bookIds.length) {
    const byBook = await admin.from("orders").delete().in("book_id", bookIds).select("id");
    ordersDeleted += byBook.data?.length ?? 0;
  }
  if (byUser.error) console.log(`[cleanup] orders delete error (${byUser.error.code})`);

  // private.stripe_events is not exposed to PostgREST → service SQL path via the linked CLI.
  let eventsLeft: number | string = 0;
  const ids = eventIds.filter((id) => /^evt_test_[0-9a-f]{24}$/.test(id));
  if (migration1200 && ids.length) {
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
  for (let round = 0; round < 3; round++) {
    const paths = await listAllUserObjects();
    if (paths.length === 0) break;
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await admin.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      if (error) console.log(`[cleanup] storage remove error (${error.message})`);
    }
    removed += paths.length;
  }
  const { error } = await admin.auth.admin.deleteUser(uid);
  const left = await listAllUserObjects();
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const orders = bookIds.length
    ? await admin.from("orders").select("id", { count: "exact", head: true }).in("book_id", bookIds)
    : { count: 0 };
  console.log(
    `[cleanup] objects removed=${removed} left=${left.length} books=${books.count} ordersDeleted=${ordersDeleted} ordersLeft=${orders.count} stripeEventsSent=${ids.length} stripeEventsLeft=${eventsLeft} userDeleted=${!error}`,
  );
  expect(error).toBeNull();
  expect(left.length).toBe(0);
  expect(books.count).toBe(0);
  expect(orders.count ?? 0).toBe(0);
});

test("a. build (replay) → publish a free book → viewer has watermark + footer, link expires in 30 days", async ({ browser }) => {
  needBook();
  test.setTimeout(600_000);
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await page.getByRole("radio", { name: /Modern/ }).check(); // D-068: travel now defaults to Geometric; this spec covers Modern.
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  bookId = new URL(page.url()).pathname.split("/")[2];
  await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 6));
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 420_000 });
  await page.getByTestId("review-continue").click();
  await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: 30_000 });
  // M13 T9: editor Share publishes and opens the share screen.
  const t0 = Date.now();
  await page.getByTestId("editor-done").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
  const row = await bookRow();
  slug = row.slug ?? "";
  expect(slug).not.toBe("");
  expect(row.is_paid).toBe(false);
  expect(row.max_pages).toBe(20);
  expect(Math.abs(Date.parse(row.expires_at ?? "") - (t0 + 30 * DAY))).toBeLessThan(10 * 60_000);

  const v = await anonView(browser, slug);
  console.log(`[a] viewer status=${v.status} watermarks=${v.watermarks} footer=${v.footer}`);
  expect(v.status).toBe(200);
  expect(v.expired).toBe(false);
  expect(v.watermarks).toBeGreaterThan(0);
  expect(v.footer).toBe(1);
});

test("b. publish screen: enabled 'Upgrade this book — AED 39'; dummy key → Stripe call fails → error, nothing paid; free book 21st page → 422", async () => {
  needBook();
  test.skip(!slug, "needs test a");
  await page.goto(`/books/${bookId}/publish`);
  const wrap = page.getByTestId("publish-upgrade-wrap");
  await expect(wrap).toBeVisible();
  const payments = await wrap.getAttribute("data-payments");
  console.log(`[b] data-payments=${payments}`);
  const btn = page.getByTestId("publish-upgrade");
  await expect(btn).toHaveText("Upgrade this book — AED 39");
  if (paymentsOn) {
    await expect(btn).toBeEnabled();
    await btn.click();
    const msg = page.getByTestId("publish-upgrade-message");
    await expect(msg).toHaveText("Couldn't start payment — try again", { timeout: 45_000 });
    await expect(msg).toHaveAttribute("data-code", "failed");
    await expect(btn).toBeEnabled();
    expect(new URL(page.url()).pathname).toBe(`/books/${bookId}/publish`);
  } else {
    await expect(btn).toBeDisabled();
    await expect(page.getByTestId("publish-upgrade-unavailable")).toHaveText("Payments unavailable");
  }
  const row = await bookRow();
  expect(row.is_paid).toBe(false);
  expect(await ordersFor(bookId)).toHaveLength(0); // no pending order without a Stripe session

  // The same builder at 20 pages saves on the free book, so the 21-page 422 below is the page
  // cap and not a malformed doc (test c saves the identical 21-page shape once paid).
  const twenty = await putDoc(withPages(row.doc, 20), row.doc_rev);
  console.log(`[b] 20-page save status=${twenty.status} code=${String(twenty.body.error ?? "-")}`);
  expect(twenty.status).toBe(200);
  const afterTwenty = await bookRow();
  expect(afterTwenty.page_count).toBe(20);
  const big = await putDoc(withPages(afterTwenty.doc, 21), afterTwenty.doc_rev);
  console.log(`[b] 21-page save status=${big.status} code=${String(big.body.error ?? "-")}`);
  expect(big.status).toBe(422);
  expect(big.body).toMatchObject({ error: "page_limit" });
  expect((await bookRow()).page_count).toBe(20);
});

test("c0. (only without migration 1200) valid paid event → 500 so Stripe retries; book stays free", async () => {
  needWebhook();
  test.skip(migration1200 !== false, "migration 1200 is applied — covered by c");
  test.skip(!slug, "needs test a");
  const ev = buildEvent({ type: "completed", bookId, userId: uid, amount: 3900, currency: "aed" });
  expect(await send(ev)).toBe(500);
  const row = await bookRow();
  expect(row.is_paid).toBe(false);
  expect(row.expires_at).not.toBeNull();
  expect(await ordersFor(bookId)).toHaveLength(0);
});

test("c. signed checkout.session.completed (3900 aed) → 200; live link loses watermark + footer; DB entitlement; dashboard Paid; 21st page saves", async ({ browser }) => {
  need1200();
  test.skip(!slug, "needs test a");
  paidEvent = buildEvent({ type: "completed", bookId, userId: uid, amount: 3900, currency: "aed" });
  expect(await send(paidEvent)).toBe(200);

  const row = await bookRow();
  expect(row.is_paid).toBe(true);
  expect(row.expires_at).toBeNull();
  expect(row.max_pages).toBe(100);
  const orders = await ordersFor(bookId);
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({
    status: "paid",
    amount: 3900,
    currency: "aed",
    stripe_session_id: paidEvent.sessionId,
    stripe_payment_intent_id: paidEvent.paymentIntentId,
    livemode: false,
    user_id: uid,
  });
  expect(orders[0].paid_at).not.toBeNull();

  const v = await anonView(browser, slug);
  console.log(`[c] viewer status=${v.status} watermarks=${v.watermarks} footer=${v.footer}`);
  expect(v.status).toBe(200);
  expect(v.watermarks).toBe(0);
  expect(v.footer).toBe(0);

  await page.goto("/dashboard");
  const card = page
    .getByTestId("book-list")
    .locator("li")
    .filter({ has: page.locator(`a[data-testid="book-card"][href*="${bookId}"]`) });
  await expect(card.getByText("Paid", { exact: true })).toBeVisible();

  await page.goto(`/books/${bookId}/publish`);
  await expect(page.getByTestId("publish-upgrade")).toHaveCount(0);
  await expect(page.getByTestId("publish-expiry")).toHaveText("Permanent link");

  const big = await putDoc(withPages(row.doc, 21), row.doc_rev);
  console.log(`[c] 21-page save status=${big.status} code=${String(big.body.error ?? "-")}`);
  expect(big.status).toBe(200);
  expect((await bookRow()).page_count).toBe(21);
});

test("d. replaying the same event → 200, nothing changes (one order row)", async () => {
  need1200();
  test.skip(!paidEvent, "needs test c");
  const before = await ordersFor(bookId);
  expect(await send(paidEvent!)).toBe(200);
  const after = await ordersFor(bookId);
  expect(after).toHaveLength(1);
  expect(after[0]).toEqual(before[0]);
  const row = await bookRow();
  expect(row.is_paid).toBe(true);
  expect(row.expires_at).toBeNull();
});

test("e. tampered signature → 400; wrong amount (3800) for a second free, expired book → 200 but it stays free; success page shows 'Confirming payment…'", async ({ browser }) => {
  needWebhook();
  test.skip(!slug, "needs test a");
  // Book 2: admin clone of book 1's published snapshot (free, expired), new slug, no photos.
  const { data: src, error: srcErr } = await admin.from("books").select("*").eq("id", bookId).single();
  expect(srcErr).toBeNull();
  const clone = { ...(src as Record<string, unknown>) };
  for (const k of ["id", "created_at", "updated_at", "password_hash"]) delete clone[k];
  slug2 = `m7-${slugRandom()}`;
  Object.assign(clone, {
    slug: slug2,
    is_paid: false,
    max_pages: 20,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    published_at: new Date(Date.now() - 31 * DAY).toISOString(),
  });
  const ins = await admin.from("books").insert(clone).select("id").single();
  if (ins.error) console.log(`[e] clone insert error=${ins.error.code}`);
  expect(ins.error).toBeNull();
  book2Id = (ins.data as { id: string }).id;
  const before = await anonView(browser, slug2);
  console.log(`[e] book2 before: status=${before.status} expired=${before.expired}`);
  expect(before.expired).toBe(true);

  // Tampered body (signature over the original) → 400, nothing recorded.
  const tampered = buildEvent({ type: "completed", bookId: book2Id, userId: uid, amount: 3900 });
  expect(await send(tampered, { tamper: true })).toBe(400);
  // Signature with the wrong secret → 400.
  const wrongSecret = buildEvent({ type: "completed", bookId: book2Id, userId: uid, amount: 3900 });
  eventIds.push(wrongSecret.id);
  expect(await postEvent({ baseURL, payload: wrongSecret.payload, secret: `whsec_${randomBytes(16).toString("hex")}` })).toBe(400);

  // Wrong amount → acknowledged (200, retrying never makes it valid) but not fulfilled.
  const cheap = buildEvent({ type: "completed", bookId: book2Id, userId: uid, amount: 3800, currency: "aed" });
  expect(await send(cheap)).toBe(200);
  // Wrong currency → same.
  const usd = buildEvent({ type: "completed", bookId: book2Id, userId: uid, amount: 3900, currency: "usd" });
  expect(await send(usd)).toBe(200);

  const row = await bookRow(book2Id);
  expect(row.is_paid).toBe(false);
  expect(row.max_pages).toBe(20);
  expect(row.expires_at).not.toBeNull();
  // Tolerant of review fix S1 (migration 1300, paid_but_invalid → order 'needs_review'): book 2
  // is an admin clone with no pending order, so there is normally nothing to move (0 orders);
  // if an order row exists it may only be needs_review — never paid/pending.
  const orders2 = await ordersFor(book2Id);
  console.log(`[e] book2 orders=${orders2.length} statuses=${orders2.map((o) => o.status).join(",") || "-"}`);
  for (const o of orders2) expect(o.status).toBe("needs_review");
  expect((await anonView(browser, slug2)).expired).toBe(true);

  // g (free branch): the success page never claims success for an unpaid book. Without an order
  // it polls ("Confirming payment…"); with a needs_review order (1300) it may show the support
  // screen instead.
  await page.goto(`/books/${book2Id}/upgrade/success?session_id=${tampered.sessionId}`);
  const polling = page.getByTestId("upgrade-polling");
  const support = page.getByTestId("upgrade-support");
  await expect(polling.or(support)).toBeVisible({ timeout: 30_000 });
  const phase = (await support.count()) > 0 ? "support" : ((await polling.getAttribute("data-phase")) ?? "polling");
  console.log(`[e] return page=${phase}`);
  if (phase !== "support") {
    await expect(page.getByRole("heading", { name: "Confirming payment…" })).toBeVisible();
  }
  await page.waitForTimeout(5_000); // ≥ 2 polls
  await expect(page.getByTestId("upgrade-paid")).toHaveCount(0);
  expect((await bookRow(book2Id)).is_paid).toBe(false);
});

test("f + g. expired free book → signed paid event → link works again; the open success page flips to 'Your book is upgraded'", async ({ browser }) => {
  need1200();
  test.skip(!book2Id, "needs test e");
  await page.goto(`/books/${book2Id}/upgrade/success`);
  await expect(page.getByTestId("upgrade-polling")).toBeVisible({ timeout: 30_000 });

  const ev = buildEvent({ type: "completed", bookId: book2Id, userId: uid, amount: 3900, currency: "aed" });
  expect(await send(ev)).toBe(200);
  await expect(page.getByTestId("upgrade-paid")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Your book is upgraded" })).toBeVisible();

  const row = await bookRow(book2Id);
  expect(row.is_paid).toBe(true);
  expect(row.expires_at).toBeNull();
  expect(row.max_pages).toBe(100);
  const v = await anonView(browser, slug2);
  console.log(`[f] book2 after: status=${v.status} expired=${v.expired} watermarks=${v.watermarks} footer=${v.footer}`);
  expect(v.status).toBe(200);
  expect(v.expired).toBe(false);
  expect(v.watermarks).toBe(0);
  expect(v.footer).toBe(0);

  // g (paid branch, fresh load): book 1 is paid → immediately "Your book is upgraded".
  await page.goto(`/books/${bookId}/upgrade/success`);
  await expect(page.getByTestId("upgrade-paid")).toBeVisible({ timeout: 15_000 });
});

test("h. full refund (charge.refunded) → order refunded, book stays paid; partial refund → no change", async ({ browser }) => {
  need1200();
  test.skip(!paidEvent, "needs test c");
  const partial = buildEvent({ type: "partial_refund", paymentIntentId: paidEvent!.paymentIntentId });
  expect(await send(partial)).toBe(200);
  expect((await ordersFor(bookId))[0].status).toBe("paid");

  const refund = buildEvent({ type: "refunded", paymentIntentId: paidEvent!.paymentIntentId });
  expect(await send(refund)).toBe(200);
  const orders = await ordersFor(bookId);
  expect(orders).toHaveLength(1);
  expect(orders[0].status).toBe("refunded");
  expect(orders[0].refunded_at).not.toBeNull();
  const row = await bookRow();
  expect(row.is_paid).toBe(true);
  expect(row.expires_at).toBeNull();
  expect(row.max_pages).toBe(100);

  // A late replay of the paid event never moves a refunded order back to paid.
  const replayAfter = buildEvent({
    type: "async_succeeded",
    bookId,
    userId: uid,
    sessionId: paidEvent!.sessionId,
    paymentIntentId: paidEvent!.paymentIntentId,
  });
  expect(await send(replayAfter)).toBe(200);
  expect((await ordersFor(bookId))[0].status).toBe("refunded");

  const v = await anonView(browser, slug);
  expect(v.watermarks).toBe(0);
  expect(v.footer).toBe(0);
});
