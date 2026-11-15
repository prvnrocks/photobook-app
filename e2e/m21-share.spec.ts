/**
 * M21 — share page redesign, LIVE (opt-in, E2E_AUTH=1, hosted Supabase; server: production build
 * `next start` with AI_MODE=off or replay and an empty ANTHROPIC_API_KEY — a rule album is enough).
 *
 * ONE throwaway user `e2e+m21-<random>@example.com` (admin createUser + generateLink, no email), ONE
 * book with an Arabic title (classic, portrait, 6 synthetic JPEGs). Two signed-in contexts: a phone
 * (375×812, touch) and a desktop (1280×800). Serial:
 *   a. wizard → editor; /books/<id>/publish before any Share = draft (band: Arabic title in a
 *      dir=auto span, chip "Draft", 3-step bar; free plan card + locked PDF card that never calls the
 *      PDF API); phone sticky bar = Publish once the card button scrolls off, never covering the last
 *      card at the end of the page; a11y audit 375 + 1280.
 *   b. back to the editor → edit (a caption, saved through the editor's doc API) → Share publishes
 *      (D-070) → share page "Your book is live" + celebration (burst in the preview, running
 *      animations), chip "Live", "Open flipbook" inside the preview; sticky bar = WhatsApp; copy
 *      feedback + clipboard; native share hidden on desktop Chromium; a11y audit.
 *   c. back to the editor → edit → open /books/<id>/publish → "Your edits aren't live yet" → sticky bar
 *      = Update link → Update link → "Changes published", live again; a11y audit.
 *   d. expiry (admin sets expires_at): +3 days → chip "Expires in 3 days"; past → Expired card +
 *      upgrade, no sticky bar; restored.
 *   e. reduced motion (fresh context, ?shared=live): no running animations, burst hidden.
 *   f. paid (admin sets is_paid on the throwaway book): "Paid · permanent" chip + plan card, PDF
 *      download card, no upgrade.
 *   g. Unpublish via the danger zone (confirm) → draft, "keeps the same link".
 *   z. audit summary (no horizontal scroll, ≥ 44 px targets, one h1, visible focus, AA contrast).
 * Screenshots: M21_SHOT_DIR=<dir> → m21-share-{draft,live,changes,expired,paid}-{375,1280}.png
 * (else the test output folder). afterAll (always): storage under <uid>/ (photos + exports), exports,
 * orders, the user (books cascade) and the agent_runs this user created. Per-test timeouts only.
 * Logs: counts / booleans / measurements only — never titles, slugs, URLs, ids or keys.
 *
 *   E2E_AUTH=1 npx playwright test -c <config: baseURL of next start, no webServer> e2e/m21-share.spec.ts
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hasCaptionArea } from "../src/lib/ai/captions";
import { createBookViaWizard, finishWizardToEditor, waitForSortingOrReview } from "./helpers/create-book";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live share page flow");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
const BUCKETS = ["photos", "exports"];
const ARABIC_TITLE = "رحلتنا إلى العين";
const TAB_STOPS = 8;
const DAY = 86_400_000;
/** The leather band's lightest point (#0e3b2e + the top glow ≈ #1f5443 — conservative). */
const LEATHER_LIGHTEST: [number, number, number] = [0x1f, 0x54, 0x43];
const SHOT_DIR = process.env.M21_SHOT_DIR ?? "";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

type Ctx = { context: BrowserContext; page: Page };

let admin: SupabaseClient;
let uid = "";
let email = "";
let baseURL = "";
let bookId = "";
let phone: Ctx;
let desk: Ctx;
let firstExpiresAt = "";
const runIds = new Set<string>();
/** Every audit problem is collected here and asserted by "z. audit summary". */
const auditIssues: string[] = [];

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

async function signInHash(): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  return data.properties.hashed_token;
}

async function newContext(browser: Browser, viewport: { width: number; height: number }, opts: { reducedMotion?: boolean } = {}): Promise<Ctx> {
  const mobile = viewport.width < 600;
  const context = await browser.newContext({
    viewport,
    baseURL,
    locale: "en-US",
    ...(mobile ? { hasTouch: true, isMobile: true } : {}),
    ...(opts.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("pb.editor.coach.v1", "1");
    } catch {
      /* ignore */
    }
  });
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/dashboard`);
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  return { context, page };
}

async function listUserObjects(bucket: string): Promise<string[]> {
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
    for (let i = 0; i < count; i++) out.push(await draw(2101 + i));
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `m21-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

type BookRow = { doc: Record<string, unknown>; doc_rev: number; slug: string | null; expires_at: string | null; published_rev: number | null; is_paid: boolean };

async function bookRow(): Promise<BookRow> {
  const { data, error } = await admin.from("books").select("doc, doc_rev, slug, expires_at, published_rev, is_paid").eq("id", bookId).single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as BookRow;
}

/** An editor save: the caption of the first captionable page, through the editor's doc API. */
async function editCaption(p: Page, text: string) {
  const before = await bookRow();
  const doc = structuredClone(before.doc) as { pages: { layout: string; side?: "left" | "right"; caption: unknown }[]; style: { font: string } };
  const target = doc.pages.find((pg) => hasCaptionArea(pg.layout, pg.side));
  expect(target, "a captionable page").toBeTruthy();
  target!.caption = { text, font: doc.style.font, align: "center", source: "user" };
  const status = await p.evaluate(
    async ({ id, d, rev }) => {
      const res = await fetch(`/api/books/${id}/doc`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: d, baseRev: rev }),
        credentials: "same-origin",
      });
      return res.status;
    },
    { id: bookId, d: doc, rev: before.doc_rev },
  );
  expect(status).toBe(200);
}

async function openShare(p: Page, query = "") {
  await p.goto(`/books/${bookId}/publish${query}`);
  await expect(p.getByTestId("publish-panel")).toBeVisible({ timeout: 30_000 });
  await p.evaluate(() => document.fonts.ready);
}

async function shot(p: Page, name: string) {
  const w = p.viewportSize()?.width ?? 0;
  const file = `m21-share-${name}-${w}.png`;
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(300);
  // A fixed bar would be painted mid-page in a full-page capture: hide it for the shot only
  // (its own placement is asserted in checkStickyBar; the above-the-fold view goes to *-fold.png).
  await p.screenshot({ path: test.info().outputPath(file.replace(".png", "-fold.png")), animations: "disabled" });
  const style = await p.addStyleTag({ content: "[data-share-bar]{visibility:hidden!important}" });
  await p.screenshot({ path: SHOT_DIR ? path.join(SHOT_DIR, file) : test.info().outputPath(file), fullPage: true, animations: "disabled" });
  await style.evaluate((el) => (el as Element).remove());
}

/** Sticky phone bar: hidden while the card control is on screen, shown (right action) once it scrolls off, and at the very end it never covers the last card. */
async function checkStickyBar(p: Page, action: "publish" | "update" | "whatsapp", target: string, label: string) {
  const bar = p.getByTestId("publish-sticky-bar");
  await expect(bar).toHaveAttribute("data-action", action);
  await p.evaluate(() => window.scrollTo(0, 0));
  const t = (await p.getByTestId(target).boundingBox())!;
  const vh = p.viewportSize()!.height;
  const targetOnScreen = t.y + t.height <= vh - 96;
  console.log(`[bar ${label}] target bottom=${Math.round(t.y + t.height)} vh=${vh} onScreenAtTop=${targetOnScreen}`);
  if (targetOnScreen) await expect(bar).toHaveAttribute("data-visible", "false");
  // Scroll the card control off the top → the bar slides in.
  await p.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)!;
    window.scrollBy(0, el.getBoundingClientRect().bottom + 40);
  }, target);
  await expect(bar).toHaveAttribute("data-visible", "true");
  const inner = action === "whatsapp" ? p.getByTestId("publish-bar-whatsapp") : p.getByTestId("publish-bar-button");
  await expect(inner).toBeVisible();
  if (action === "update") await expect(inner).toHaveText("Update link");
  if (action === "publish") await expect(inner).toHaveText("Publish");
  if (action === "whatsapp") {
    await expect(inner).toHaveText("Send on WhatsApp");
    await expect(inner).toHaveAttribute("href", (await p.getByTestId("share-whatsapp").getAttribute("href"))!);
  }
  const ib = (await inner.boundingBox())!;
  expect(ib.height).toBeGreaterThanOrEqual(44);
  // End of the page: the last card clears the bar.
  await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await p.waitForTimeout(400);
  const m = await p.evaluate(() => {
    const bar = document.querySelector('[data-testid="publish-sticky-bar"]')!.getBoundingClientRect();
    const col = document.querySelector('[data-testid="publish-message-slot"]')!.nextElementSibling as HTMLElement;
    const last = col.lastElementChild!.getBoundingClientRect();
    return { barTop: bar.top, lastBottom: last.bottom, lastId: col.lastElementChild!.getAttribute("data-testid") };
  });
  console.log(`[bar ${label}] end of page: last=${m.lastId} bottom=${Math.round(m.lastBottom)} barTop=${Math.round(m.barTop)}`);
  expect(m.lastBottom, `${label}: the sticky bar covers the last card`).toBeLessThanOrEqual(m.barTop + 0.5);
  await p.evaluate(() => window.scrollTo(0, 0));
}

async function bandChecks(p: Page, chip: string | RegExp) {
  const title = p.getByTestId("publish-title");
  await expect(title).toHaveText(ARABIC_TITLE);
  await expect(title).toHaveAttribute("dir", "auto");
  expect(await title.evaluate((el) => el.closest("h1") !== null)).toBe(true);
  await expect(p.getByTestId("publish-status-chip")).toHaveText(chip);
  await expect(p.getByTestId("share-progress-share")).toHaveAttribute("aria-current", "step");
  await expect(p.getByTestId("publish-back")).toHaveAttribute("href", `/books/${bookId}/edit`);
}

function trackPdfApi(p: Page): string[] {
  const calls: string[] = [];
  p.on("request", (r) => {
    if (/\/api\/books\/[^/]+\/pdf/.test(new URL(r.url()).pathname)) calls.push(r.method());
  });
  return calls;
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  email = `e2e+m21-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;
  phone = await newContext(browser, PHONE);
  desk = await newContext(browser, DESKTOP);
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  if (!uid) return;
  await phone?.context.close().catch(() => {});
  await desk?.context.close().catch(() => {});
  for (const r of (await admin.from("agent_runs").select("id").eq("user_id", uid)).data ?? []) runIds.add((r as { id: string }).id);
  if (bookId) for (const r of (await admin.from("agent_runs").select("id").eq("book_id", bookId)).data ?? []) runIds.add((r as { id: string }).id);
  let removed = 0;
  for (const bucket of BUCKETS) {
    for (let round = 0; round < 3; round++) {
      const paths = await listUserObjects(bucket).catch(() => [] as string[]);
      if (paths.length === 0) break;
      for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
      removed += paths.length;
    }
  }
  if (bookId) await admin.from("exports").delete().eq("book_id", bookId);
  await admin.from("orders").delete().eq("user_id", uid);
  const { error } = await admin.auth.admin.deleteUser(uid);
  let left = 0;
  for (const bucket of BUCKETS) left += (await listUserObjects(bucket).catch(() => [] as string[])).length;
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const ids = [...runIds];
  let runsDeleted = 0;
  let runsLeft = 0;
  if (ids.length) {
    runsDeleted = (await admin.from("agent_runs").delete().in("id", ids).select("id")).data?.length ?? 0;
    runsLeft = (await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", ids)).count ?? 0;
  }
  console.log(`[cleanup] objects removed=${removed} left=${left} books=${books.count} runsFound=${ids.length} runsDeleted=${runsDeleted} runsLeft=${runsLeft} userDeleted=${!error}`);
  expect(error).toBeNull();
  expect(left).toBe(0);
  expect(books.count ?? 0).toBe(0);
  expect(runsLeft).toBe(0);
});

test("a. wizard → editor; share page before any Share = draft (band, plan, locked PDF, sticky Publish)", async () => {
  test.setTimeout(600_000);
  const { page } = phone;
  bookId = await createBookViaWizard(page, { title: ARABIC_TITLE, occasion: "travel", format: "A5_PORTRAIT", style: "classic" });
  await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 6));
  await waitForSortingOrReview(page, bookId, 180_000);
  await finishWizardToEditor(page, bookId, { timeout: 420_000 });
  for (const r of (await admin.from("agent_runs").select("id").eq("book_id", bookId)).data ?? []) runIds.add((r as { id: string }).id);

  for (const p of [page, desk.page]) {
    const pdfCalls = trackPdfApi(p);
    await openShare(p);
    await expect(p.getByTestId("publish-panel")).toHaveAttribute("data-state", "unpublished");
    await bandChecks(p, "Draft");
    await expect(p.getByTestId("publish-draft")).toContainText("Ready to share?");
    await expect(p.getByTestId("publish-button")).toBeEnabled();
    await expect(p.getByTestId("publish-free-notice")).toContainText("Free link works for 30 days");
    await expect(p.getByTestId("publish-upgrade")).toHaveCount(1);
    await expect(p.getByTestId("publish-pdf-locked")).toBeVisible();
    await expect(p.getByTestId("publish-pdf")).toHaveCount(0);
    await expect(p.getByTestId("pdf-download")).toHaveCount(0);
    await expect(p.getByTestId("publish-open")).toHaveCount(0); // nothing live yet
    await expect(p.getByTestId("unpublish-section")).toHaveCount(0);
    await shot(p, "draft");
    await audit(p, `draft-${p.viewportSize()!.width}`);
    expect(pdfCalls, "locked PDF card never calls the PDF API").toEqual([]);
  }
  // Desktop: two columns, no sticky bar visible (lg:hidden).
  await expect(desk.page.getByTestId("publish-sticky-bar")).toBeHidden();
  await checkStickyBar(page, "publish", "publish-button", "draft-375");
});

test("b. editor edit → Share publishes (D-070) → live + celebration, Open flipbook in the preview, copy, sticky WhatsApp", async () => {
  test.setTimeout(240_000);
  test.skip(!bookId, "needs a");
  const { page } = phone;
  await page.goto(`/books/${bookId}/edit`);
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 30_000 });
  await editCaption(page, `Before share ${randomBytes(3).toString("hex")}`);
  await page.reload();
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("editor-share-note")).toHaveText("Free · 30 days");
  await page.getByTestId("editor-done").click();
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish(\\?shared=live)?$`), { timeout: 30_000 });
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`)); // ?shared= dropped
  const panel = page.getByTestId("publish-panel");
  await expect(panel).toHaveAttribute("data-state", "published");
  await expect(panel).toHaveAttribute("data-celebrate", "on");
  // The burst runs in the preview (motion allowed in this context).
  const burst = page.getByTestId("share-preview").getByTestId("share-burst");
  await expect(burst).toHaveCSS("display", "block");
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
  console.log(`[b] running animations after Share=${running}`);
  expect(running).toBeGreaterThan(0);
  await expect(page.getByTestId("publish-live-heading")).toHaveText("Share your link"); // the notice says "live"
  await bandChecks(page, "Live");

  const row = await bookRow();
  firstExpiresAt = row.expires_at ?? "";
  expect(row.slug).toBeTruthy();
  expect(row.published_rev).toBe(row.doc_rev);
  const open = page.getByTestId("share-preview").getByTestId("publish-open");
  await expect(page.getByTestId("publish-open")).toHaveCount(1);
  await expect(open).toHaveAttribute("href", `/b/${row.slug}`);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(page.getByTestId("publish-url")).toHaveValue(new RegExp(`/b/${row.slug}$`));
  await expect(page.getByTestId("publish-expiry")).toHaveText(/^Link expires \d{1,2} [A-Z][a-z]{2}( \d{4})?$/);
  await expect(page.getByTestId("publish-pdf-locked")).toBeVisible();
  await shot(page, "live");
  await audit(page, "live-375");
  await checkStickyBar(page, "whatsapp", "share-whatsapp", "live-375");

  // Copy: "Copied" + ring, the URL on the clipboard, then back to "Copy".
  for (const p of [page, desk.page]) {
    if (p === desk.page) await openShare(p);
    const copy = p.getByTestId("share-copy");
    await copy.scrollIntoViewIfNeeded();
    await copy.click();
    await expect(copy).toContainText("Copied");
    await expect(copy).toHaveAttribute("data-copied", "");
    await expect(p.getByTestId("share-copy-status")).toContainText("Link copied");
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    expect(clip.endsWith(`/b/${row.slug}`)).toBe(true);
    await expect(copy).toContainText("Copy", { timeout: 5_000 });
    await expect(copy).not.toHaveAttribute("data-copied", "");
  }
  // Native share: hidden where the browser has no navigator.share (desktop Chromium).
  const hasShare = await desk.page.evaluate(() => typeof navigator.share === "function");
  console.log(`[b] desktop navigator.share=${hasShare}`);
  await expect(desk.page.getByTestId("share-native")).toHaveCount(hasShare ? 1 : 0);
  expect(hasShare, "desktop Chromium is expected to have no navigator.share").toBe(false);
  await expect(desk.page.getByTestId("publish-sticky-bar")).toBeHidden();
  // Desktop preview aside is sticky and beside the cards.
  const aside = (await desk.page.getByTestId("publish-aside").boundingBox())!;
  const live = (await desk.page.getByTestId("publish-live-card").boundingBox())!;
  expect(aside.x + aside.width).toBeLessThanOrEqual(live.x);
  await shot(desk.page, "live");
  await audit(desk.page, "live-1280");
});

test("c. edit again → share page 'Your edits aren't live yet' → Update link → live", async () => {
  test.setTimeout(180_000);
  test.skip(!firstExpiresAt, "needs b");
  const { page } = phone;
  await page.goto(`/books/${bookId}/edit`);
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 30_000 });
  await editCaption(page, `After share ${randomBytes(3).toString("hex")}`);
  await page.reload();
  await expect(page.getByTestId("editor-publish-changes")).toHaveText("Publish changes", { timeout: 30_000 });

  await openShare(desk.page);
  await expect(desk.page.getByTestId("publish-changes")).toContainText("Your edits aren't live yet");
  await shot(desk.page, "changes");
  await audit(desk.page, "changes-1280");

  await openShare(page);
  await expect(page.getByTestId("publish-panel")).toHaveAttribute("data-state", "published");
  const card = page.getByTestId("publish-changes");
  await expect(card).toContainText("Your edits aren't live yet");
  await expect(page.getByTestId("publish-last-published")).toHaveText(/^Last published \d{1,2} [A-Z][a-z]{2}( \d{4})?$/);
  await expect(page.getByTestId("publish-changes-button")).toHaveText("Update link");
  // The link card stays below while live (people still have the old version).
  await expect(page.getByTestId("publish-live")).toBeVisible();
  await bandChecks(page, "Live");
  await shot(page, "changes");
  await audit(page, "changes-375");
  await checkStickyBar(page, "update", "publish-changes-button", "changes-375");

  await page.getByTestId("publish-changes-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Changes published", { timeout: 30_000 });
  await expect(page.getByTestId("publish-changes")).toHaveCount(0);
  await expect(page.getByTestId("publish-live-card")).toBeVisible();
  await expect(page.getByTestId("publish-sticky-bar")).toHaveAttribute("data-action", "whatsapp");
  const row = await bookRow();
  expect(row.published_rev).toBe(row.doc_rev);
  expect(Date.parse(row.expires_at ?? "")).toBe(Date.parse(firstExpiresAt));
});

test("d. expiry chip: +3 days → 'Expires in 3 days'; past → Expired card, upgrade, no sticky bar", async () => {
  test.setTimeout(120_000);
  test.skip(!firstExpiresAt, "needs b");
  const { page } = phone;
  try {
    const soon = new Date(Date.now() + 3 * DAY - 60_000).toISOString();
    expect((await admin.from("books").update({ expires_at: soon }).eq("id", bookId)).error).toBeNull();
    await openShare(page);
    await bandChecks(page, "Expires in 3 days");
    await expect(page.getByTestId("publish-status-chip")).toHaveAttribute("data-kind", /.+/);

    const past = new Date(Date.now() - DAY).toISOString();
    expect((await admin.from("books").update({ expires_at: past }).eq("id", bookId)).error).toBeNull();
    for (const p of [page, desk.page]) {
      await openShare(p);
      await expect(p.getByTestId("publish-panel")).toHaveAttribute("data-state", "expired");
      await bandChecks(p, "Expired");
      await expect(p.getByTestId("publish-expired")).toContainText("Upgrade to bring it back");
      await expect(p.getByTestId("publish-upgrade")).toHaveCount(1);
      await expect(p.getByTestId("publish-button")).toHaveCount(0);
      await expect(p.getByTestId("publish-open")).toHaveCount(0);
      await expect(p.getByTestId("publish-live")).toHaveCount(0);
      await expect(p.getByTestId("password-section")).toHaveCount(0);
      await expect(p.getByTestId("publish-sticky-bar")).toHaveCount(0);
      await shot(p, "expired");
      await audit(p, `expired-${p.viewportSize()!.width}`);
    }
  } finally {
    await admin.from("books").update({ expires_at: firstExpiresAt }).eq("id", bookId);
  }
});

test("e. reduced motion: ?shared=live shows the message but nothing animates; the burst stays hidden", async ({ browser }) => {
  test.setTimeout(120_000);
  test.skip(!firstExpiresAt, "needs b");
  const rm = await newContext(browser, PHONE, { reducedMotion: true });
  try {
    await openShare(rm.page, "?shared=live");
    await expect(rm.page.getByTestId("publish-message")).toHaveText("Your book is live");
    await expect(rm.page.getByTestId("publish-panel")).toHaveAttribute("data-celebrate", "on");
    await expect(rm.page.getByTestId("share-burst")).toHaveCSS("display", "none");
    await rm.page.waitForTimeout(300);
    const anims = await rm.page.evaluate(() =>
      document.getAnimations().filter((a) => a.playState === "running").map((a) => (a as CSSAnimation).animationName ?? "transition"),
    );
    console.log(`[e] running animations under reduced motion=${anims.length}`);
    expect(anims).toEqual([]);
    // The sticky bar just appears (no transition) when scrolled.
    await rm.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(rm.page.getByTestId("publish-sticky-bar")).toHaveAttribute("data-visible", "true");
    expect(await rm.page.getByTestId("publish-sticky-bar").evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/);
  } finally {
    await rm.context.close();
  }
});

test("f. paid (server is_paid): 'Paid · permanent' chip + plan, PDF download card, no upgrade", async () => {
  test.setTimeout(120_000);
  test.skip(!firstExpiresAt, "needs b");
  const upd = await admin.from("books").update({ is_paid: true }).eq("id", bookId);
  expect(upd.error).toBeNull();
  test.skip((await bookRow()).is_paid !== true, "is_paid could not be set on the live project (column guard)");
  try {
    for (const p of [phone.page, desk.page]) {
      const pdfCalls = trackPdfApi(p);
      await openShare(p);
      await bandChecks(p, "Paid · permanent");
      await expect(p.getByTestId("publish-plan-paid")).toContainText("Paid · permanent");
      await expect(p.getByTestId("publish-upgrade")).toHaveCount(0);
      await expect(p.getByTestId("publish-free-notice")).toHaveCount(0);
      await expect(p.getByTestId("publish-pdf")).toBeVisible();
      await expect(p.getByTestId("publish-pdf-locked")).toHaveCount(0);
      await expect(p.getByTestId("pdf-download")).toHaveText("Download PDF");
      await expect(p.getByTestId("publish-expiry")).toHaveText("Permanent link");
      await shot(p, "paid");
      await audit(p, `paid-${p.viewportSize()!.width}`);
      expect(pdfCalls, "no PDF call until the button is tapped").toEqual([]);
    }
  } finally {
    await admin.from("books").update({ is_paid: false }).eq("id", bookId);
  }
});

test("g. Unpublish via the danger zone → draft, same link note", async () => {
  test.setTimeout(120_000);
  test.skip(!firstExpiresAt, "needs b");
  const { page } = phone;
  await openShare(page);
  await expect(page.getByTestId("publish-panel")).toHaveAttribute("data-state", "published");
  const btn = page.getByTestId("unpublish-button");
  await btn.scrollIntoViewIfNeeded();
  expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await btn.click();
  await expect(page.getByTestId("unpublish-confirm")).toContainText("The link stops working for everyone");
  await page.getByTestId("unpublish-confirm-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Unpublished — the link no longer works", { timeout: 30_000 });
  await expect(page.getByTestId("publish-panel")).toHaveAttribute("data-state", "unpublished", { timeout: 30_000 });
  await expect(page.getByTestId("publish-draft")).toContainText("keeps the same link and expiry date");
  await expect(page.getByTestId("publish-status-chip")).toHaveText("Draft");
  await expect(page.getByTestId("unpublish-section")).toHaveCount(0);
  const { data } = await admin.from("books").select("published_rev, slug").eq("id", bookId).single();
  console.log(`[g] after unpublish published_rev null=${(data as { published_rev: number | null }).published_rev === null}`);
  const anon = await page.context().browser()!.newContext({ baseURL });
  try {
    const res = await anon.request.get(`/b/${(data as { slug: string }).slug}`, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  } finally {
    await anon.close();
  }
});

test("z. audit summary: no horizontal scroll, ≥ 44 px targets, one h1, visible focus, AA text contrast", () => {
  for (const i of auditIssues) console.log(`  [issue] ${i}`);
  expect(auditIssues).toEqual([]);
});

// ---- a11y audit (rules of e2e/m11.spec.ts + computed text contrast, as e2e/m20-wizard.spec.ts) -----

type Target = { desc: string; w: number; h: number };
type LowContrast = { desc: string; ratio: number; need: number; fg: string; bg: string };

async function measure(p: Page, leather: [number, number, number]) {
  return p.evaluate((leatherRgb) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      return (el as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;
    };
    const desc = (el: Element) => {
      const tid = el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid");
      const label = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${label}"`;
    };
    const isInline = (el: Element) => {
      if (el.tagName !== "A") return false;
      if (getComputedStyle(el).display !== "inline") return false;
      let block = el.parentElement;
      while (block && getComputedStyle(block).display === "inline") block = block.parentElement;
      const own = ((el as HTMLElement).innerText ?? "").trim().length;
      const all = ((block as HTMLElement | null)?.innerText ?? "").trim().length;
      return all > own + 10;
    };
    const sel = "a[href],button,[role=button],[role=tab],[role=menuitem],[role=link],summary,select,textarea,input:not([type=hidden])";
    const small: Target[] = [];
    const inline: Target[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (el.closest(".sr-only")) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      const t = { desc: desc(el), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
      if (isInline(el)) inline.push(t);
      else small.push(t);
    }
    const h1 = Array.from(document.querySelectorAll("h1")).filter((h) => (h as HTMLElement).checkVisibility?.() ?? true).length;

    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const blend = (top: number[], bottom: number[]) => {
      const a = top[3];
      return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
    };
    const band = document.querySelector('[data-testid="share-band"]');
    const bgOf = (el: Element): number[] | null => {
      if (band && band.contains(el)) {
        const layers: number[][] = [];
        for (let q: Element | null = el; q && q !== band; q = q.parentElement) {
          const c = parse(getComputedStyle(q).backgroundColor);
          if (getComputedStyle(q).backgroundImage !== "none" && !(c && c[3] >= 1)) return null; // foil fill etc.
          if (c && c[3] > 0) {
            layers.push(c);
            if (c[3] >= 1) break;
          }
        }
        let out = [...leatherRgb, 1];
        for (let i = layers.length - 1; i >= 0; i--) out = blend(layers[i], out);
        return out;
      }
      const layers: number[][] = [];
      for (let q: Element | null = el; q; q = q.parentElement) {
        const s = getComputedStyle(q);
        const c = parse(s.backgroundColor);
        if (s.backgroundImage.includes("url(")) return null;
        if (s.backgroundImage !== "none" && !(c && c[3] >= 1)) return null;
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let out = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) out = blend(layers[i], out);
      return out;
    };
    const low: LowContrast[] = [];
    let checked = 0;
    let bandChecked = 0;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (el.closest('[aria-hidden="true"], [data-page], svg, .sr-only, nextjs-portal')) continue;
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
      if (!own || !visible(el)) continue;
      const s = getComputedStyle(el);
      if (parseFloat(s.opacity) === 0) continue;
      const fg = parse(s.color);
      const bg = bgOf(el);
      if (!fg || !bg) continue;
      const f = fg[3] < 1 ? blend(fg, bg) : fg;
      const l1 = lum(f);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const disabled = (el as HTMLElement).closest("button:disabled, [aria-disabled=true], input:disabled");
      const need = large ? 3 : 4.5;
      checked++;
      if (band && band.contains(el)) bandChecked++;
      if (!disabled && ratio < need - 0.01) {
        low.push({ desc: desc(el), ratio: Math.round(ratio * 100) / 100, need, fg: s.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(",")})` });
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, h1, small, inline, low, checked, bandChecked };
  }, leather);
}

async function focusStops(p: Page) {
  await p.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.id = "m21-focus-start";
    document.body.prepend(start);
    start.focus({ preventScroll: true });
  });
  const out: { desc: string; visible: boolean }[] = [];
  for (let i = 0; i < TAB_STOPS; i++) {
    await p.keyboard.press("Tab");
    await p.waitForTimeout(120);
    const r = await p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const has = (e: Element) => {
        const s = getComputedStyle(e);
        return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow !== "none" && s.boxShadow !== "");
      };
      let ok = has(el);
      const label = el.closest("label");
      if (!ok && label) ok = has(label);
      let q = el.parentElement;
      for (let k = 0; !ok && q && k < 3; k++, q = q.parentElement) ok = has(q) && q.matches(":focus-within");
      const tid = el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid");
      const name = (el.getAttribute("aria-label") ?? el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
      return { desc: `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${name}"`, visible: ok };
    });
    if (!r) break;
    out.push(r);
  }
  await p.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.getElementById("m21-focus-start")?.remove();
  });
  return out;
}

async function audit(p: Page, name: string) {
  await p.locator("h1").first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() => window.scrollTo(0, 0));
  const m = await measure(p, LEATHER_LIGHTEST);
  const focus = await focusStops(p);
  console.log(
    `[a11y ${name}] sw=${m.scrollWidth}/${m.innerWidth} h1=${m.h1} small=${m.small.length} inline=${m.inline.length} contrastChecked=${m.checked} band=${m.bandChecked} low=${m.low.length} focus=${focus.filter((f) => f.visible).length}/${focus.length}`,
  );
  for (const s of m.small) console.log(`  [small ${name}] ${s.desc} ${s.w}×${s.h}`);
  for (const l of m.low) console.log(`  [contrast ${name}] ${l.desc} ${l.ratio} < ${l.need} fg=${l.fg} bg=${l.bg}`);
  for (const f of focus.filter((x) => !x.visible)) console.log(`  [focus ${name}] no ring: ${f.desc}`);
  if (m.scrollWidth > m.innerWidth) auditIssues.push(`${name}: horizontal scroll ${m.scrollWidth}/${m.innerWidth}`);
  if (m.h1 !== 1) auditIssues.push(`${name}: ${m.h1} h1`);
  if (m.bandChecked === 0) auditIssues.push(`${name}: no band text checked`);
  for (const s of m.small) auditIssues.push(`${name}: target under 44×44 ${s.desc} ${s.w}×${s.h}`);
  for (const l of m.low) auditIssues.push(`${name}: contrast ${l.ratio} < ${l.need} ${l.desc}`);
  if (focus.length === 0) auditIssues.push(`${name}: Tab reaches no control`);
  for (const f of focus.filter((x) => !x.visible)) auditIssues.push(`${name}: focus without a visible ring ${f.desc}`);
}
