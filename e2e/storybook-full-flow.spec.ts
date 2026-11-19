/**
 * AI Balanced Storybook (Tasks 1–10) — the complete signed-in flow, end to end, at 375 px, against the
 * LIVE hosted Supabase project (opt-in).
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic: the server must run with AI_MODE=replay and an
 * empty ANTHROPIC_API_KEY. Never moves money: the server runs with a dummy STRIPE_SECRET_KEY and a
 * random STRIPE_WEBHOOK_SECRET that this process gets too; "paid" comes from a locally SIGNED
 * checkout.session.completed (scripts/stripe-signed-event.mjs) — the same webhook → RPC path Stripe uses.
 * The PDF steps need a production build (`next start`) whose NEXT_PUBLIC_APP_URL is its own origin,
 * with PDF_CHROME_PATH and BOOK_ACCESS_SECRET (as e2e/pdf.spec.ts).
 *
 * Serial steps (one throwaway user `e2e+story-<random>@example.com`, admin generateLink sign-in):
 *   01 sign in → /books/new
 *   02 wizard: Title, Occasion (book created) → Photos (privacy note) → upload 12 photos
 *   03 Story: one question answered, one skipped, a tone → Design: "Recommended" badges, keep them
 *   04 Continue starts the storybook run → step 6 "Your memories are becoming a story." with the four
 *      real stages advancing → done opens the editor (no step 7)
 *   05 unpaid: 5-page preview (doc + banner "This is a 5-page preview.")
 *   06 paid via the signed webhook → banner "Complete my book" → the continuation job → more pages
 *   07 Story actions: Rewrite story (AI text, one Undo), Change photo, Regenerate page (+ Undo),
 *      View chapters (jump)
 *   08 a user's own page text survives "Regenerate story" (editor + DB)
 *   09 publish → anonymous /b/<slug> viewer
 *   10 revoke ("Turn off and make a new link") → old slug 404s; publish again → new slug works
 *   11 PDF export (download) + print package (cover + interior PDFs)
 *   12 delete: the paid book is refused on the dashboard; a second (draft) book with photos is
 *      deleted (row + storage gone); Settings → Delete account removes the paid storybook, its
 *      photos, PDF and print files and every storybook row
 * afterAll (always): orders, private.stripe_events (linked CLI), exports, storage under `<uid>/` in
 * both buckets, the user (books / photos / storybooks cascade), agent_runs + usage ledger rows of
 * the user; asserts nothing is left. Logs: counts / booleans / statuses only.
 * Screenshots: docs/design/e2e-*.png (STORY_SHOT_DIR to override).
 *
 * Example:
 *   (scratch copy) NEXT_PUBLIC_APP_URL=http://localhost:3717 AI_MODE=replay ANTHROPIC_API_KEY= next build
 *   STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_x AI_MODE=replay ANTHROPIC_API_KEY= \
 *     NEXT_PUBLIC_APP_URL=http://localhost:3717 next start -p 3717
 *   E2E_AUTH=1 STRIPE_WEBHOOK_SECRET=whsec_x npx playwright test -c <config: baseURL :3717, no webServer> \
 *     e2e/storybook-full-flow.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { answerStory, chooseDesign, continueFromPhotos, createBookViaWizard, expectWizardStep, wizardStepUrl } from "./helpers/create-book";
import { buildEvent, postEvent } from "../scripts/stripe-signed-event.mjs";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live storybook full flow");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
  // the test env's webhook secret (shared with the server) wins over .env.local
  if (secret) process.env.STRIPE_WEBHOOK_SECRET = secret;
}

const REPO = path.join(__dirname, "..");
const VIEWPORT = { width: 375, height: 812 };
const BUCKETS = ["photos", "exports"] as const;
const N_PHOTOS = 12;
const PREVIEW_PAGES = 5;
const STORY_HEADLINE = "Your memories are becoming a story.";
const TYPED_ANSWER = "Our first family trip together";
const USER_TEXT = "These are our own words about the evening by the sea.";
const SHOTS = process.env.STORY_SHOT_DIR ?? path.join(REPO, "docs", "design");
const STAGES = ["discovering", "organizing", "writing", "designing"] as const;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let admin: SupabaseClient;
let baseURL = "";
let uid = "";
let email = "";
let context: BrowserContext;
let page: Page;
let bookId = "";
let draftId = "";
let slug = "";
let accountDeleted = false;
const eventIds: string[] = [];
/** Rows that outlive the user by design (agent runs, orders keep their rows with ids nulled): captured by id. */
const runIds = new Set<string>();
const orderIds = new Set<string>();
const consoleErrors: string[] = [];
const done: Record<string, boolean> = {};

type DocText = { panel: number; text: string; source?: string };
type DocPage = { layout?: string; texts?: DocText[]; slots?: { photoId?: string | null }[] };
type Doc = { pages?: DocPage[]; meta?: Record<string, unknown> };

/** Remember this user's agent runs and orders (by id) while their user / book ids still point here. */
async function captureOwnedRows() {
  if (!uid) return;
  for (const r of (await admin.from("agent_runs").select("id").eq("user_id", uid)).data ?? []) runIds.add((r as { id: string }).id);
  for (const r of (await admin.from("orders").select("id").eq("user_id", uid)).data ?? []) orderIds.add((r as { id: string }).id);
  for (const b of [bookId, draftId].filter(Boolean)) {
    for (const r of (await admin.from("agent_runs").select("id").eq("book_id", b)).data ?? []) runIds.add((r as { id: string }).id);
    for (const r of (await admin.from("orders").select("id").eq("book_id", b)).data ?? []) orderIds.add((r as { id: string }).id);
  }
}

async function bookRow(id = bookId) {
  const { data, error } = await admin.from("books").select("doc, published_doc, slug, is_paid, max_pages, doc_rev").eq("id", id).single();
  if (error) throw new Error(`book read failed (${error.code})`);
  return data as { doc: Doc; published_doc: Doc | null; slug: string | null; is_paid: boolean; max_pages: number; doc_rev: number };
}

function allTexts(doc: Doc | null | undefined): string[] {
  return (doc?.pages ?? []).flatMap((p) => (p.texts ?? []).map((t) => t.text));
}

async function shot(p: Page, name: string, fullPage = false) {
  mkdirSync(SHOTS, { recursive: true });
  await p.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((e) => e.remove())).catch(() => {});
  await p.screenshot({ path: path.join(SHOTS, `e2e-${name}.png`), fullPage });
}

async function noHorizontalOverflow(p: Page) {
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(VIEWPORT.width);
}

async function signInHash(): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  return data.properties.hashed_token;
}

async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, depth: number) => {
    const res = await admin.storage.from(bucket).list(p, { limit: 1000 });
    if (res.error) throw new Error(`storage list failed (${res.error.message})`);
    for (const e of res.data ?? []) {
      if (e.id || depth >= 3) out.push(`${p}/${e.name}`);
      else await walk(`${p}/${e.name}`, depth + 1);
    }
  };
  await walk(prefix, 0);
  return out;
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(column, value);
  if (error) throw new Error(`count ${table} failed (${error.code})`);
  return count ?? 0;
}

/** `n` distinct, sharp JPEGs (not duplicates, not blurry) drawn in the browser. */
async function makeSynthetic(p: Page, n: number, seed0 = 401) {
  const list = await p.evaluate(
    async ({ count, seed0 }) => {
      function rng(seed: number) {
        let s = seed >>> 0;
        return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      }
      async function draw(seed: number): Promise<string> {
        const r = rng(seed * 7919 + 17);
        const c = document.createElement("canvas");
        const landscape = seed % 3 === 0;
        c.width = landscape ? 1200 : 900;
        c.height = landscape ? 900 : 1200;
        const g = c.getContext("2d")!;
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 12; x++) {
            g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
            g.fillRect(x * 100, y * 100, 100, 100);
          }
        }
        const img = g.getImageData(0, 0, c.width, c.height);
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
      for (let i = 0; i < count; i++) out.push(await draw(i + seed0));
      return out;
    },
    { count: n, seed0 },
  );
  return list.map((b64, i) => ({ name: `story-${seed0 + i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

/** The carousel item shown now. */
const current = (p: Page) => p.locator('[data-testid="carousel-item"][aria-hidden="false"]');

/** Walk the editor carousel from where it is until `has` is on the shown page (max `max` steps). */
async function walkTo(p: Page, testId: string, max = 30): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if ((await current(p).getByTestId(testId).count()) > 0) return true;
    const next = p.getByTestId("carousel-next");
    if (!(await next.isEnabled().catch(() => false))) return false;
    await next.click();
    await p.waitForTimeout(350);
  }
  return false;
}

async function backToCover(p: Page) {
  for (let i = 0; i < 60; i++) {
    const prev = p.getByTestId("carousel-prev");
    if (!(await prev.isEnabled().catch(() => false))) return;
    await prev.click();
    await p.waitForTimeout(120);
  }
}

async function waitSaved(p: Page) {
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", /saved|idle/, { timeout: 30_000 });
}

/** The Story tool: a row button with nothing / a text selected, behind "More" with a photo selected. */
async function openStoryTool(p: Page) {
  const row = p.getByTestId("editor-toolbar").getByTestId("editor-tool-story");
  if (!(await row.isVisible().catch(() => false))) {
    await p.getByTestId("editor-more").click({ timeout: 10_000 });
    await expect(p.getByTestId("editor-more-sheet")).toBeVisible();
  }
  await p.getByTestId("editor-tool-story").filter({ visible: true }).first().click({ timeout: 10_000 });
  await expect(p.getByTestId("story-actions")).toBeVisible({ timeout: 15_000 });
}

async function closeSheet(p: Page) {
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
}

function need(...steps: string[]) {
  for (const s of steps) test.skip(!done[s], `needs step ${s}, which did not pass`);
}

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  email = `e2e+story-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;
  context = await (browser as Browser).newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true, acceptDownloads: true });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.name}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text().slice(0, 160)}`);
  });
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  console.log(`[console] errors=${consoleErrors.length}${consoleErrors.length ? `\n  ${[...new Set(consoleErrors)].slice(0, 12).join("\n  ")}` : ""}`);
  if (!uid) return;
  await context?.close().catch(() => {});
  const bookIds = [bookId, draftId].filter(Boolean);
  await captureOwnedRows();
  const ledgerIds = ((await admin.from("ai_usage_ledger").select("id").eq("user_id", uid)).data ?? []).map((r) => (r as { id: string }).id);
  let ordersDeleted = (await admin.from("orders").delete().eq("user_id", uid).select("id")).data?.length ?? 0;
  if (bookIds.length) ordersDeleted += (await admin.from("orders").delete().in("book_id", bookIds).select("id")).data?.length ?? 0;
  if (orderIds.size) ordersDeleted += (await admin.from("orders").delete().in("id", [...orderIds]).select("id")).data?.length ?? 0;
  const exportRows = (await admin.from("exports").delete().eq("user_id", uid).select("id")).data?.length ?? 0;

  let eventsLeft: number | string = 0;
  const ids = eventIds.filter((id) => /^evt_test_[0-9a-f]{24}$/.test(id));
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    try {
      execFileSync("npx", ["supabase", "db", "query", "--linked", `delete from private.stripe_events where id in (${list})`], { cwd: REPO, stdio: "pipe", timeout: 60_000 });
      const out = execFileSync("npx", ["supabase", "db", "query", "--linked", `select count(*)::int as n from private.stripe_events where id in (${list})`], { cwd: REPO, stdio: "pipe", timeout: 60_000 }).toString();
      eventsLeft = Number(/"n"\s*:\s*(\d+)/.exec(out)?.[1] ?? "NaN");
    } catch {
      eventsLeft = `unknown (cli failed; ${ids.length} evt_test_ ids sent)`;
    }
  }
  let removed = 0;
  for (const bucket of BUCKETS) {
    for (let round = 0; round < 3; round++) {
      const paths = await listAll(bucket, uid);
      if (paths.length === 0) break;
      for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
      removed += paths.length;
    }
  }
  let userError: string | null = null;
  if (!accountDeleted) {
    const { error } = await admin.auth.admin.deleteUser(uid);
    userError = error ? (error.code ?? "error") : null;
  }
  const userLeft = (await admin.auth.admin.getUserById(uid)).data.user ? 1 : 0;
  const runList = [...runIds];
  let runsDeleted = 0;
  for (let i = 0; i < runList.length; i += 100) runsDeleted += (await admin.from("agent_runs").delete().in("id", runList.slice(i, i + 100)).select("id")).data?.length ?? 0;
  let ledgerDeleted = 0;
  for (let i = 0; i < ledgerIds.length; i += 100) ledgerDeleted += (await admin.from("ai_usage_ledger").delete().in("id", ledgerIds.slice(i, i + 100)).select("id")).data?.length ?? 0;
  let left = 0;
  for (const bucket of BUCKETS) left += (await listAll(bucket, uid)).length;
  const books = (await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid)).count ?? 0;
  const storybooks = (await admin.from("storybooks").select("book_id", { count: "exact", head: true }).eq("user_id", uid)).count ?? 0;
  const runsLeft = runList.length ? ((await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", runList)).count ?? 0) : 0;
  const orders = orderIds.size ? ((await admin.from("orders").select("id", { count: "exact", head: true }).in("id", [...orderIds])).count ?? 0) : 0;
  console.log(
    `[cleanup] objects removed=${removed} left=${left} books=${books} storybooks=${storybooks} ordersDeleted=${ordersDeleted} ordersLeft=${orders} exportRows=${exportRows} stripeEventsSent=${ids.length} stripeEventsLeft=${eventsLeft} runs found=${runList.length} deleted=${runsDeleted} left=${runsLeft} ledger found=${ledgerIds.length} deleted=${ledgerDeleted} accountDeletedInApp=${accountDeleted} userLeft=${userLeft}`,
  );
  expect(userError).toBeNull();
  expect(userLeft).toBe(0);
  expect(left).toBe(0);
  expect(books).toBe(0);
  expect(storybooks).toBe(0);
  expect(orders).toBe(0);
  expect(runsLeft).toBe(0);
});

test("01 sign in → the new book wizard", async () => {
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new(\?step=1)?$/, { timeout: 30_000 });
  await expectWizardStep(page, 1, 30_000);
  done["01"] = true;
});

test("02 wizard: title + occasion create the book; Photos shows the privacy note; 12 photos upload", async () => {
  need("01");
  test.setTimeout(360_000);
  bookId = await createBookViaWizard(page, { title: "Our trip to the coast", occasion: "travel", goto: false });
  await expect(page.getByTestId("upload-privacy-note")).toBeVisible();
  await expect(page.getByTestId("upload-privacy-note")).toContainText(/private/i);
  await shot(page, "01-photos-privacy-375");
  await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, N_PHOTOS));
  await expect(page.getByTestId("upload-wizard-continue")).toBeVisible({ timeout: 300_000 });
  await noHorizontalOverflow(page);
  const photos = await countRows("photos", "book_id", bookId);
  console.log(`[02] photos=${photos}`);
  expect(photos).toBe(N_PHOTOS);
  done["02"] = true;
});

test("03 Story: one answer typed, one skipped, a tone → Design shows Recommended badges", async () => {
  need("02");
  await continueFromPhotos(page);
  await expect(page.getByTestId("wizard-headline")).toHaveText("Every memory has a story.");
  const questions = page.locator('[data-testid^="story-question-"]');
  expect(await questions.count()).toBeGreaterThanOrEqual(2);
  await shot(page, "02-story-375", true);
  await answerStory(page, { story: { answers: [TYPED_ANSWER, null], tone: "joyful" } });
  await expect(page.getByTestId("design-shape").getByTestId("choice-badge")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("design-style").getByTestId("choice-badge")).toHaveCount(1);
  await expect(page.getByTestId("design-style").getByTestId("choice-badge")).toHaveText("Recommended");
  await noHorizontalOverflow(page);
  await shot(page, "03-design-375", true);
  const ctx = (await admin.from("storybooks").select("context").eq("book_id", bookId).single()).data as { context: { answers?: { text?: string }[]; skipped?: boolean; storyTone?: string } } | null;
  const answers = (ctx?.context?.answers ?? []).map((a) => a.text);
  console.log(`[03] stored answers=${answers.length} skipped=${ctx?.context?.skipped}`);
  expect(answers).toEqual([TYPED_ANSWER]);
  expect(ctx?.context?.skipped).toBe(false);
  expect(ctx?.context?.storyTone).toBe("joyful");
  done["03"] = true;
});

test("04 Continue starts the storybook run: step 6 with real stages → the editor", async () => {
  need("03");
  test.setTimeout(480_000);
  await chooseDesign(page, { format: "recommended" });
  await page.waitForURL(wizardStepUrl(bookId, "6"), { timeout: 60_000 });
  await expect(page.getByTestId("wizard-step-story-generation")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(STORY_HEADLINE);
  await expect(page.getByTestId("story-stages").locator("li")).toHaveCount(4);
  const seen = new Map<string, Set<string>>();
  const details = new Set<string>();
  let shotTaken = false;
  const editUrl = new RegExp(`/books/${bookId}/edit`);
  const t0 = Date.now();
  while (!editUrl.test(page.url()) && Date.now() - t0 < 420_000) {
    const snap = await page
      .evaluate(() =>
        [...document.querySelectorAll('[data-testid^="story-stage-"][data-status]')].map((e) => ({
          id: e.getAttribute("data-testid")!.replace("story-stage-", ""),
          status: e.getAttribute("data-status")!,
          detail: document.querySelector(`[data-testid="${e.getAttribute("data-testid")}-detail"]`)?.textContent ?? "",
        })),
      )
      .catch(() => []);
    for (const s of snap) {
      if (!seen.has(s.id)) seen.set(s.id, new Set());
      seen.get(s.id)!.add(s.status);
      if (s.detail) details.add(`${s.id}: ${s.detail}`);
    }
    const stopped = await page.getByTestId("story-stopped").isVisible().catch(() => false);
    if (stopped) {
      const reason = await page.getByTestId("story-stopped-reason").textContent().catch(() => "");
      await shot(page, "04-step6-stopped-375", true);
      throw new Error(`storybook run stopped: ${reason}`);
    }
    if (!shotTaken && snap.some((s) => s.status === "running" && s.id !== "discovering")) {
      shotTaken = true;
      expect(await page.locator("body").innerText()).not.toContain("%");
      await noHorizontalOverflow(page);
      await shot(page, "04-step6-running-375", true);
    }
    await page.waitForTimeout(150);
  }
  console.log(`[04] run ${Math.round((Date.now() - t0) / 1000)} s; statuses ${[...seen].map(([k, v]) => `${k}=${[...v].join("/")}`).join(" ")}`);
  console.log(`[04] details: ${[...details].join(" | ")}`);
  await page.waitForURL(editUrl, { timeout: 60_000 });
  expect(new URL(page.url()).searchParams.get("step")).toBeNull();
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
  // real stages: every stage was seen, at least one while running, and they ended done
  for (const s of STAGES) expect(seen.has(s), `stage ${s} was shown`).toBe(true);
  expect([...seen.values()].some((v) => v.has("running"))).toBe(true);
  expect([...details].some((d) => /^discovering: \d+ photos?$/.test(d))).toBe(true);
  const run = (await admin.from("agent_runs").select("state, mode, trigger").eq("book_id", bookId).order("started_at", { ascending: false }).limit(1).single()).data as { state: string; mode: string; trigger: string };
  console.log(`[04] run state=${run.state} mode=${run.mode} trigger=${run.trigger}`);
  expect(run).toMatchObject({ state: "done", mode: "replay", trigger: "storybook" });
  done["04"] = true;
});

test("05 unpaid: a 5-page preview + the unlock banner", async () => {
  need("04");
  const banner = page.getByTestId("story-preview-banner");
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toHaveAttribute("data-state", "locked");
  await expect(banner).toContainText(`This is a ${PREVIEW_PAGES}-page preview.`);
  await expect(page.getByTestId("story-unlock-button")).toContainText("Unlock the full book — AED 39");
  const row = await bookRow();
  console.log(`[05] pages=${row.doc.pages?.length} texts=${allTexts(row.doc).length} is_paid=${row.is_paid}`);
  expect(row.is_paid).toBe(false);
  expect(row.doc.pages?.length).toBe(PREVIEW_PAGES);
  expect(allTexts(row.doc).length).toBeGreaterThan(0);
  await noHorizontalOverflow(page);
  await page.waitForLoadState("networkidle").catch(() => {});
  await shot(page, "05-editor-preview-banner-375");
  done["05"] = true;
});

test("06 paid (signed test webhook) → Complete my book continues the story", async ({ request }) => {
  need("05");
  test.setTimeout(480_000);
  const secret = env("STRIPE_WEBHOOK_SECRET");
  const ev = buildEvent({ type: "completed", bookId, userId: uid, amount: 3900, currency: "aed" });
  eventIds.push(ev.id);
  const status = await postEvent({ baseURL, payload: ev.payload, secret });
  console.log(`[06] webhook status=${status}`);
  expect(status).toBe(200);
  await expect.poll(async () => (await bookRow()).is_paid, { timeout: 15_000 }).toBe(true);
  void request;

  await page.reload();
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
  const banner = page.getByTestId("story-preview-banner");
  await expect(banner).toHaveAttribute("data-state", "complete", { timeout: 30_000 });
  await expect(page.getByTestId("story-complete-button")).toHaveText(/Complete my book/);
  await shot(page, "06-editor-complete-banner-375");
  await page.getByTestId("story-complete-button").click();
  const dialog = page.getByTestId("story-regen-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText(STORY_HEADLINE);
  await expect(page.getByTestId("story-regen-dialog").getByTestId("story-stages")).toBeVisible({ timeout: 30_000 });
  await shot(page, "07-complete-running-375");
  await expect(dialog).toHaveCount(0, { timeout: 420_000 });
  await expect(page.getByTestId("editor-toast")).toContainText("Story regenerated", { timeout: 15_000 });
  await expect(banner).toHaveCount(0, { timeout: 30_000 }).catch(async () => {
    // the banner follows the server's newest job; a reload shows the settled state
    await page.reload();
    await expect(page.getByTestId("story-preview-banner")).toHaveCount(0, { timeout: 30_000 });
  });
  await waitSaved(page);
  const row = await bookRow();
  console.log(`[06] pages after complete=${row.doc.pages?.length} max_pages=${row.max_pages}`);
  expect(row.doc.pages?.length ?? 0).toBeGreaterThan(PREVIEW_PAGES);
  expect(row.max_pages).toBe(100);
  done["06"] = true;
});

test("07 Story actions: rewrite story (+ Undo), change photo, regenerate page (+ Undo), view chapters", async () => {
  need("06");
  test.setTimeout(300_000);
  await backToCover(page);
  // Rewrite story on an AI text → applied as one edit, one Undo puts it back
  expect(await walkTo(page, "page-text-target"), "a page with story text").toBe(true);
  const target = current(page).getByTestId("page-text-target").first();
  await target.click();
  await expect(page.getByTestId("page-text-input")).toBeVisible({ timeout: 10_000 });
  const before = await page.getByTestId("page-text-input").inputValue();
  await openStoryTool(page);
  await shot(page, "08-story-actions-375");
  await expect(page.getByTestId("story-action-rewrite")).toBeEnabled();
  await page.getByTestId("story-action-rewrite").click();
  await expect(page.getByTestId("story-rewrite-current")).toHaveText(before);
  await page.getByTestId("story-rewrite-shorter").click();
  const msg = page.getByTestId("story-action-message");
  await expect(page.getByTestId("editor-toast").or(msg).or(page.getByTestId("story-proposal"))).toBeVisible({ timeout: 60_000 });
  if (await msg.isVisible()) throw new Error(`rewrite failed: ${await msg.textContent()}`);
  await expect(page.getByTestId("editor-toast")).toContainText("Text rewritten");
  const afterRewrite = allTexts((await (async () => (await waitSaved(page), bookRow()))()).doc);
  expect(afterRewrite).not.toContain(before);
  await page.getByTestId("editor-toast").getByRole("button", { name: "Undo" }).click();
  await waitSaved(page);
  await expect.poll(async () => allTexts((await bookRow()).doc).includes(before), { timeout: 20_000 }).toBe(true);
  await closeSheet(page);

  // Change photo: a slot on an inside page → Change photo (behind More) → the picker → another photo
  await backToCover(page);
  await page.getByTestId("carousel-next").click();
  await page.waitForTimeout(350);
  expect(await walkTo(page, "slot-target"), "a page with a photo").toBe(true);
  const pageIdxBefore = await current(page).getAttribute("data-index").catch(() => null);
  await current(page).getByTestId("slot-target").first().click();
  await openStoryTool(page);
  await expect(page.getByTestId("story-action-photo")).toBeEnabled();
  const docBeforePhoto = (await bookRow()).doc;
  await page.getByTestId("story-action-photo").click();
  await expect(page.getByTestId("photo-picker")).toBeVisible({ timeout: 10_000 });
  const pick = page.getByTestId("picker-photo").and(page.locator(":enabled")); // the current photo is disabled
  expect(await pick.count()).toBeGreaterThan(0);
  await pick.first().click();
  await waitSaved(page);
  await expect
    .poll(async () => JSON.stringify((await bookRow()).doc.pages?.map((p) => p.slots?.map((s) => s.photoId))) !== JSON.stringify(docBeforePhoto.pages?.map((p) => p.slots?.map((s) => s.photoId))), { timeout: 20_000 })
    .toBe(true);
  console.log(`[07] photo changed (page ${pageIdxBefore ?? "?"})`);
  await closeSheet(page);

  // Regenerate page: a fresh layout for some story page, then Undo
  await backToCover(page);
  let regenerated = false;
  for (let i = 0; i < 12 && !regenerated; i++) {
    await page.getByTestId("carousel-next").click();
    await page.waitForTimeout(300);
    await openStoryTool(page);
    const btn = page.getByTestId("story-action-page");
    if (!(await btn.isEnabled())) {
      await closeSheet(page);
      continue;
    }
    const layoutsBefore = JSON.stringify((await bookRow()).doc.pages?.map((p) => p.layout));
    await btn.click();
    const toast = page.getByTestId("editor-toast");
    await expect(toast.or(page.getByTestId("story-action-message"))).toBeVisible({ timeout: 10_000 });
    if (await toast.isVisible()) {
      await expect(toast).toContainText(/New layout for page \d+/);
      await waitSaved(page);
      await expect.poll(async () => JSON.stringify((await bookRow()).doc.pages?.map((p) => p.layout)) !== layoutsBefore, { timeout: 20_000 }).toBe(true);
      await shot(page, "09-regenerate-page-375");
      await toast.getByRole("button", { name: "Undo" }).click();
      await waitSaved(page);
      await expect.poll(async () => JSON.stringify((await bookRow()).doc.pages?.map((p) => p.layout)), { timeout: 20_000 }).toBe(layoutsBefore);
      regenerated = true;
    } else {
      await closeSheet(page);
    }
  }
  expect(regenerated, "Regenerate page worked on at least one page").toBe(true);
  await closeSheet(page);

  // View chapters: titles + ranges, tap to jump
  await openStoryTool(page);
  await page.getByTestId("story-action-chapters").click();
  await expect(page.getByTestId("story-chapters")).toBeVisible();
  const rows = page.locator('[data-testid^="story-chapter-"]');
  const n = await rows.count();
  console.log(`[07] chapters=${n}`);
  expect(n).toBeGreaterThanOrEqual(1);
  await expect(rows.first()).toContainText(/Pages? \d/);
  await noHorizontalOverflow(page);
  await shot(page, "10-view-chapters-375");
  await rows.nth(n - 1).click();
  await expect(page.getByTestId("story-chapters")).toHaveCount(0);
  done["07"] = true;
});

test("08 a user's own page text survives Regenerate story", async () => {
  need("06");
  test.setTimeout(480_000);
  await backToCover(page);
  expect(await walkTo(page, "page-text-target")).toBe(true);
  await current(page).getByTestId("page-text-target").first().click();
  const input = page.getByTestId("page-text-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("dir", "auto");
  await input.fill(USER_TEXT);
  await waitSaved(page);
  await expect.poll(async () => allTexts((await bookRow()).doc).includes(USER_TEXT), { timeout: 20_000 }).toBe(true);
  await closeSheet(page);
  await openStoryTool(page);
  await page.getByTestId("story-action-regen").click();
  await page.getByTestId("story-regen-start").click();
  const dialog = page.getByTestId("story-regen-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 420_000 });
  await expect(page.getByTestId("editor-toast")).toContainText("your own edits were kept", { timeout: 15_000 });
  await waitSaved(page);
  const row = await bookRow();
  const kept = (row.doc.pages ?? []).flatMap((p) => p.texts ?? []).find((t) => t.text === USER_TEXT);
  console.log(`[08] user text kept=${!!kept} source=${kept?.source}`);
  expect(kept).toBeTruthy();
  expect(kept?.source).toBe("user");
  await page.reload();
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
  expect(await walkTo(page, "page-text-target", 40)).toBe(true);
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    found = (await current(page).getByText(USER_TEXT).count()) > 0;
    if (!found) {
      const next = page.getByTestId("carousel-next");
      if (!(await next.isEnabled().catch(() => false))) break;
      await next.click();
      await page.waitForTimeout(250);
    }
  }
  expect(found, "the user's text is on a page in the editor after reload").toBe(true);
  done["08"] = true;
});

test("09 publish → the anonymous /b/<slug> viewer", async ({ browser }) => {
  need("06");
  await page.getByTestId("editor-done").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
  await noHorizontalOverflow(page);
  await shot(page, "11-publish-375", true);
  const row = await bookRow();
  slug = row.slug ?? "";
  expect(slug).not.toBe("");
  expect(row.published_doc?.pages?.length).toBe(row.doc.pages?.length);
  if (done["08"]) expect(allTexts(row.published_doc)).toContain(USER_TEXT);
  const anon = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true, baseURL });
  const v = await anon.newPage();
  const res = await v.goto(`/b/${slug}`);
  expect(res?.status()).toBe(200);
  await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(v.getByTestId("watermark")).toHaveCount(0);
  await noHorizontalOverflow(v);
  // the cover photo really loads in the viewer (not only the frame)
  const loadedImgs = () =>
    v.getByTestId("flipbook").evaluate((el) => [...el.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 0).length);
  await expect.poll(loadedImgs, { timeout: 20_000 }).toBeGreaterThan(0);
  await v.waitForTimeout(500);
  await shot(v, "12-viewer-375");
  await anon.close();
  done["09"] = true;
});

test("10 revoke the link: the old slug 404s; publishing again gives a new link that works", async ({ browser }) => {
  need("09");
  await page.getByTestId("unpublish-button").click();
  await expect(page.getByTestId("unpublish-confirm")).toBeVisible();
  await page.getByTestId("reset-link-button").click();
  await expect(page.getByTestId("publish-button")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await bookRow()).slug, { timeout: 15_000 }).not.toBe(slug);
  const anon = await browser.newContext({ viewport: VIEWPORT, baseURL });
  const v = await anon.newPage();
  const gone = await v.goto(`/b/${slug}`);
  expect(gone?.status()).toBe(404);
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 60_000 });
  const fresh = (await bookRow()).slug ?? "";
  expect(fresh).not.toBe("");
  expect(fresh).not.toBe(slug);
  const again = await v.goto(`/b/${slug}`);
  expect(again?.status()).toBe(404);
  const ok = await v.goto(`/b/${fresh}`);
  expect(ok?.status()).toBe(200);
  await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await anon.close();
  slug = fresh;
  done["10"] = true;
});

test("11 PDF export downloads; the print package gives a cover + an interior PDF", async ({ request }) => {
  need("09");
  test.setTimeout(400_000);
  await expect(page.getByTestId("publish-pdf")).toBeVisible({ timeout: 30_000 });
  const btn = page.getByTestId("pdf-download");
  await expect(btn).toBeEnabled();
  const download = page.waitForEvent("download", { timeout: 300_000 });
  const t0 = Date.now();
  await btn.click();
  const d = await download;
  const pdfFile = test.info().outputPath("storybook.pdf");
  await d.saveAs(pdfFile);
  const ms = Date.now() - t0;
  await expect(page.getByTestId("pdf-status-text")).toHaveText("Your PDF is ready", { timeout: 30_000 });
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(pdfFile);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const pdf = await PDFDocument.load(bytes);
  const row = await bookRow();
  const pages = row.doc.pages?.length ?? 0;
  console.log(`[11] pdf ${Math.round(ms / 1000)} s, ${Math.round(bytes.length / 1024)} kB, sheets=${pdf.getPageCount()} doc pages=${pages}`);
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(pages);
  await noHorizontalOverflow(page);
  await shot(page, "13-pdf-ready-375", true);

  await page.getByTestId("print-files-button").click();
  await expect(page.getByTestId("print-files-links")).toBeVisible({ timeout: 120_000 });
  for (const id of ["cover", "interior"] as const) {
    const href = await page.getByTestId(`print-files-${id}`).getAttribute("href");
    expect(href).toMatch(/^https?:\/\//);
    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(body);
    console.log(`[11] print ${id}: sheets=${doc.getPageCount()} ${Math.round(body.length / 1024)} kB`);
    if (id === "cover") expect(doc.getPageCount()).toBe(1);
    else expect(doc.getPageCount()).toBe(pdf.getPageCount() - 1);
  }
  await shot(page, "14-print-files-375", true);
  const exportFiles = await listAll("exports", `${uid}/${bookId}`);
  console.log(`[11] export objects=${exportFiles.length}`);
  expect(exportFiles.length).toBeGreaterThanOrEqual(3);
  done["11"] = true;
});

test("12 delete: the paid book is refused, a draft book is deleted with its photos, account delete removes everything", async () => {
  need("01");
  test.setTimeout(400_000);
  // A second, unpaid book with photos (left on the Story step).
  await page.goto("/books/new");
  draftId = await createBookViaWizard(page, { title: "Draft to delete", occasion: "family", goto: false });
  await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 2, 901));
  await expect(page.getByTestId("upload-wizard-continue")).toBeVisible({ timeout: 240_000 });
  const draftObjects = (await listAll("photos", `${uid}/${draftId}`)).length;
  expect(draftObjects).toBeGreaterThan(0);

  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-heading")).toBeVisible({ timeout: 30_000 });
  const cards = page.getByTestId("book-card");
  await expect(cards).toHaveCount(bookId ? 2 : 1, { timeout: 30_000 });
  if (bookId && done["06"]) {
    // the finished storybook's card opens the editor
    expect(await page.locator("li", { hasText: "Our trip to the coast" }).getByTestId("book-card").getAttribute("href")).toBe(`/books/${bookId}/edit`);
    const paidCard = page.locator("li", { hasText: "Our trip to the coast" }); // the menu sits next to the card link
    await paidCard.getByTestId("book-menu").click();
    await page.getByTestId("book-menu-delete").click();
    await page.getByTestId("delete-book-dialog").getByTestId("delete-book-confirm").click();
    await expect(page.getByTestId("delete-book-error")).toContainText("This book has a payment", { timeout: 20_000 });
    await shot(page, "15-delete-paid-refused-375");
    await page.getByTestId("delete-book-cancel").click();
    expect(await countRows("books", "id", bookId)).toBe(1);
  }
  const draftCard = page.locator("li", { hasText: "Draft to delete" });
  await draftCard.getByTestId("book-menu").click();
  await page.getByTestId("book-menu-delete").click();
  await page.getByTestId("delete-book-dialog").getByTestId("delete-book-confirm").click();
  await expect(cards).toHaveCount(bookId ? 1 : 0, { timeout: 30_000 });
  expect(await countRows("books", "id", draftId)).toBe(0);
  expect(await countRows("photos", "book_id", draftId)).toBe(0);
  expect(await countRows("storybooks", "book_id", draftId)).toBe(0);
  expect((await listAll("photos", `${uid}/${draftId}`)).length).toBe(0);
  console.log(`[12] draft deleted: objects before=${draftObjects} after=0`);

  // Account deletion removes the paid storybook and everything under it.
  await captureOwnedRows(); // runs + orders keep their rows (ids nulled) — remember them for afterAll
  console.log(`[12] captured runs=${runIds.size} orders=${orderIds.size}`);
  await page.goto("/settings");
  await expect(page.getByTestId("settings-heading")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("settings-delete-input").fill("DELETE");
  await page.getByTestId("settings-delete-button").click();
  await expect(page.getByTestId("account-deleted-notice")).toBeVisible({ timeout: 60_000 });
  accountDeleted = true;
  await shot(page, "16-account-deleted-375");
  if (bookId) {
    const tables = ["photos", "storybooks", "storybook_versions", "photo_ingest", "photo_analyses", "photo_quality", "photo_moments", "photo_duplicate_groups", "story_ai_calls", "exports", "book_entitlements"];
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = await countRows(t, "book_id", bookId);
    counts.books = await countRows("books", "id", bookId);
    counts.photoObjects = (await listAll("photos", `${uid}/${bookId}`)).length;
    counts.exportObjects = (await listAll("exports", `${uid}/${bookId}`)).length;
    console.log(`[12] after account delete: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    for (const [k, v] of Object.entries(counts)) expect(v, k).toBe(0);
  }
  done["12"] = true;
});
