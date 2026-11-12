/**
 * Milestone 13 T1 — BASELINE first-time-user walkthrough (before any M13 code), LIVE Supabase, 375 px.
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic (server: AI_MODE=replay, empty ANTHROPIC_API_KEY).
 * Measures today's path for a brand-new user with 40 photos, taking every default:
 *   landing "Start your book" → login (simulated: admin generateLink → /auth/confirm, no email) →
 *   new book form (occasion = Travel, everything else default) → Continue to photos → Choose photos
 *   (native picker = filechooser, excluded) → upload + finalize → Build my album → build (replay) →
 *   review → Continue → editor (first page preview) → Done → Publish → Send on WhatsApp (wa.me stubbed).
 *
 * Records (console `[m13-baseline]` lines + a JSON summary):
 *   - app taps (every tap the user must make; login typing and the native picker excluded)
 *   - screens (route-level) and states, with a screenshot per state:
 *       docs/design/m13-before-<nn>-<name>-375.png (dir override: M13_SHOT_DIR)
 *   - decisions shown per screen: radio groups, text inputs, buttons, links visible in <main>
 *   - time from photos chosen (filechooser.setFiles) to the first book page preview with a loaded
 *     photo, and to the shared link (publish live) / WhatsApp intent.
 *
 * Fixtures: 40 JPEGs drawn in the browser before the clock starts (24 landscape 1600×1200,
 * 16 portrait 1200×1600; 2 exact byte copies, 2 near-duplicates re-encoded, 3 blurred), written to
 * the Playwright output dir and chosen by path. No EXIF (canvas JPEGs carry no date/GPS).
 *
 * One throwaway user `e2e+m13base-<random>@example.com`. afterAll (always): storage objects under
 * `<uid>/`, the user (books/photos cascade), then the replay agent_runs this user created (replay = $0;
 * agent_steps cascade). Per-test timeouts only. Logs: counts / timings / statuses only.
 *
 * Example (pinned scratch copy, see .agentos/runs/m13-brief.md):
 *   NEXT_PUBLIC_APP_URL=http://localhost:3613 AI_MODE=replay ANTHROPIC_API_KEY= next build
 *   AI_MODE=replay ANTHROPIC_API_KEY= STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_<random> \
 *     CRON_SECRET= NEXT_PUBLIC_APP_URL=http://localhost:3613 next start -p 3613
 *   E2E_AUTH=1 npx playwright test -c <config: baseURL :3613, no webServer> e2e/m13-baseline.spec.ts
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live M13 baseline walkthrough");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const BUCKET = "photos";
const VIEWPORT = { width: 375, height: 812 };
const SHOT_DIR = process.env.M13_SHOT_DIR || path.join(__dirname, "..", "docs", "design");
const PHOTO_COUNT = 40;

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
let photoPaths: string[] = [];
const runIds = new Set<string>();

// ---- measurement -------------------------------------------------------------------------------

type Decisions = { radioGroups: number; textInputs: number; buttons: number; links: number };
type ScreenRec = { n: number; name: string; route: string; atMs: number; decisions: Decisions };
type TapRec = { n: number; label: string; route: string; atMs: number };

const t0 = Date.now();
const screens: ScreenRec[] = [];
const taps: TapRec[] = [];
const marks: Record<string, number> = {};

function now() {
  return Date.now() - t0;
}
function route(p: Page) {
  return new URL(p.url()).pathname.replace(/[0-9a-f-]{36}/, ":id");
}

async function tap(target: Locator, label: string) {
  await target.scrollIntoViewIfNeeded();
  await target.tap();
  taps.push({ n: taps.length + 1, label, route: route(page), atMs: now() });
  console.log(`[m13-baseline] tap ${taps.length}: ${label} (${route(page)})`);
}

/** Visible choices inside <main> (header nav excluded). */
async function decisions(p: Page): Promise<Decisions> {
  return p.evaluate(() => {
    const root = document.querySelector("main") ?? document.body;
    const vis = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const radios = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    const groups = new Set(radios.filter((r) => vis(r.closest("label") ?? r)).map((r) => r.name));
    const textInputs = Array.from(
      root.querySelectorAll<HTMLElement>('input[type="text"], input[type="email"], input:not([type]), textarea'),
    ).filter((el) => vis(el) && !(el as HTMLInputElement).readOnly).length;
    const buttons = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"]')).filter(
      (el) => vis(el) && !(el as HTMLButtonElement).disabled,
    ).length;
    const links = Array.from(root.querySelectorAll<HTMLElement>("a[href]")).filter(vis).length;
    return { radioGroups: groups.size, textInputs, buttons, links };
  });
}

async function screen(name: string) {
  const d = await decisions(page);
  const n = screens.length + 1;
  screens.push({ n, name, route: route(page), atMs: now(), decisions: d });
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(
    `[m13-baseline] screen ${n}: ${name} (${route(page)}) radioGroups=${d.radioGroups} textInputs=${d.textInputs} buttons=${d.buttons} links=${d.links} scrollWidth=${sw}`,
  );
  // Let in-viewport images finish loading so the screenshot shows what a user sees (≤ 10 s).
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.images).every((img) => {
            const r = img.getBoundingClientRect();
            const inView = r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
            return !inView || (img.complete && img.naturalWidth > 0);
          }),
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
    .catch(() => console.log(`[m13-baseline] screen ${n}: some in-view images still loading`));
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SHOT_DIR, `m13-before-${String(n).padStart(2, "0")}-${name}-375.png`),
    fullPage: true,
  });
}

function mark(name: string) {
  marks[name] = now();
  console.log(`[m13-baseline] mark ${name} @ ${marks[name]} ms`);
}

// ---- fixtures ----------------------------------------------------------------------------------

async function makeFixtures(p: Page, dir: string): Promise<string[]> {
  const list = await p.evaluate(async (count) => {
    function rng(seed: number) {
      let s = seed >>> 0;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    }
    function toB64(c: HTMLCanvasElement, q: number): Promise<string> {
      return new Promise((resolve) =>
        c.toBlob(
          (blob) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(",")[1]);
            fr.readAsDataURL(blob!);
          },
          "image/jpeg",
          q,
        ),
      );
    }
    function draw(seed: number, landscape: boolean): HTMLCanvasElement {
      const r = rng(seed * 7919 + 31);
      const c = document.createElement("canvas");
      c.width = landscape ? 1600 : 1200;
      c.height = landscape ? 1200 : 1600;
      const g = c.getContext("2d")!;
      const cols = landscape ? 8 : 6;
      const rows = landscape ? 6 : 8;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
          g.fillRect(x * 200, y * 200, 200, 200);
        }
      }
      for (let i = 0; i < 12; i++) {
        g.fillStyle = `hsla(${Math.floor(r() * 360)}, 70%, ${20 + Math.floor(r() * 60)}%, 0.85)`;
        g.beginPath();
        g.arc(r() * c.width, r() * c.height, 40 + r() * 220, 0, Math.PI * 2);
        g.fill();
      }
      const img = g.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const d = Math.floor((r() - 0.5) * 50);
        img.data[i] += d;
        img.data[i + 1] += d;
        img.data[i + 2] += d;
      }
      g.putImageData(img, 0, 0);
      return c;
    }
    function blurred(src: HTMLCanvasElement): HTMLCanvasElement {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const g = c.getContext("2d")!;
      g.filter = "blur(14px)";
      g.drawImage(src, 0, 0);
      return c;
    }
    function nearCopy(src: HTMLCanvasElement): HTMLCanvasElement {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const g = c.getContext("2d")!;
      g.filter = "brightness(1.04)";
      g.drawImage(src, 0, 0);
      return c;
    }
    // 33 unique (+ 2 exact copies + 2 near copies + 3 blurred = 40). 24 landscape / 16 portrait overall.
    const out: { name: string; b64: string }[] = [];
    const uniques: { c: HTMLCanvasElement; b64: string; land: boolean }[] = [];
    for (let i = 0; i < 33; i++) {
      const land = i % 5 !== 1 && i % 5 !== 3; // 3 of every 5 landscape
      const c = draw(1300 + i, land);
      const b64 = await toB64(c, 0.9);
      uniques.push({ c, b64, land });
      out.push({ name: `trip-${String(i + 1).padStart(2, "0")}.jpg`, b64 });
    }
    out.push({ name: "trip-03-copy.jpg", b64: uniques[2].b64 });
    out.push({ name: "trip-10-copy.jpg", b64: uniques[9].b64 });
    out.push({ name: "trip-05-again.jpg", b64: await toB64(nearCopy(uniques[4].c), 0.82) });
    out.push({ name: "trip-18-again.jpg", b64: await toB64(nearCopy(uniques[17].c), 0.82) });
    for (const k of [6, 13, 21]) {
      const src = draw(9000 + k, k % 2 === 0);
      out.push({ name: `blurry-${k}.jpg`, b64: await toB64(blurred(src), 0.9) });
    }
    return out.slice(0, count);
  }, PHOTO_COUNT);
  mkdirSync(dir, { recursive: true });
  return list.map(({ name, b64 }) => {
    const file = path.join(dir, name);
    writeFileSync(file, Buffer.from(b64, "base64"));
    return file;
  });
}

// ---- cleanup helpers ---------------------------------------------------------------------------

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

async function collectRuns() {
  const byUser = await admin.from("agent_runs").select("id").eq("user_id", uid);
  for (const r of byUser.data ?? []) runIds.add(r.id);
  if (bookId) {
    const byBook = await admin.from("agent_runs").select("id").eq("book_id", bookId);
    for (const r of byBook.data ?? []) runIds.add(r.id);
  }
}

async function noHorizontalOverflow() {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);
}

// ---- spec --------------------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  email = `e2e+m13base-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;

  context = await browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true });
  // WhatsApp intent: never leave the machine.
  await context.route(/^https:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\//, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp (stub)</title>" }),
  );
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  // Fixtures before the clock that matters (photos chosen) starts.
  await page.goto("about:blank");
  photoPaths = await makeFixtures(page, info.outputPath("m13-fixtures"));
  console.log(`[m13-baseline] fixtures=${photoPaths.length}`);
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  if (!uid) return;
  await context?.close().catch(() => {});
  await collectRuns().catch(() => {});
  let removed = 0;
  for (let round = 0; round < 3; round++) {
    const paths = await listAllUserObjects();
    if (paths.length === 0) break;
    for (let i = 0; i < paths.length; i += 100) await admin.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    removed += paths.length;
  }
  const { error } = await admin.auth.admin.deleteUser(uid);
  const left = (await listAllUserObjects()).length;
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  let runsDeleted = 0;
  let runsLeft = 0;
  const ids = [...runIds];
  if (ids.length) {
    runsDeleted = (await admin.from("agent_runs").delete().in("id", ids).select("id")).data?.length ?? 0;
    runsLeft = (await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", ids)).count ?? 0;
  }
  console.log(
    `[cleanup] objects removed=${removed} left=${left} books=${books.count} runsFound=${ids.length} runsDeleted=${runsDeleted} runsLeft=${runsLeft} userDeleted=${!error}`,
  );
  expect(error).toBeNull();
  expect(left).toBe(0);
  expect(books.count).toBe(0);
  expect(runsLeft).toBe(0);
});

test("baseline: landing → login → new book → upload 40 → build → review → editor → Done → publish → WhatsApp", async () => {
  test.setTimeout(900_000);

  // 1. Landing
  await page.goto("/");
  await expect(page.getByTestId("cta-create")).toBeVisible();
  await screen("landing");
  await tap(page.getByTestId("cta-create"), "Start your book (landing)");

  // 2. Login (typing excluded; magic link simulated)
  await page.waitForURL(/\/login\?/, { timeout: 30_000 });
  await expect(page.getByTestId("login-email")).toBeVisible();
  await screen("login");
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/, { timeout: 30_000 });

  // 3. New book form — first-time user takes the defaults, picks the required occasion.
  await expect(page.getByTestId("create-book")).toBeVisible({ timeout: 30_000 });
  await screen("new-book");
  await tap(page.locator("label", { has: page.getByTestId("occasion-travel") }), "Occasion: Travel");
  await tap(page.getByTestId("create-book"), "Continue to photos");
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  bookId = new URL(page.url()).pathname.split("/")[2];

  // 4. Upload — tap Choose photos; the native picker (filechooser) is excluded from taps.
  await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
  await screen("upload-empty");
  const chooserP = page.waitForEvent("filechooser");
  await tap(page.getByTestId("upload-pick"), "Choose photos");
  const chooser = await chooserP;
  mark("photosChosen");
  await chooser.setFiles(photoPaths);
  await expect(page.getByTestId("upload-progress")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await screen("upload-progress");
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 420_000 });
  mark("uploadSummary");
  await noHorizontalOverflow();
  await screen("upload-summary");

  // 5. Build (replay) — auto-advances to review.
  await tap(page.getByTestId("build-album"), "Build my album");
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/build$/, { timeout: 30_000 });
  await expect(page.getByTestId("build-progress")).toBeVisible({ timeout: 30_000 });
  mark("buildVisible");
  await screen("build");
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 420_000 });
  await expect(page.getByRole("status").filter({ hasText: "Loading your album…" })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("review-continue")).toBeVisible({ timeout: 30_000 });
  mark("reviewVisible");
  await noHorizontalOverflow();
  await screen("review");

  // 6. Review → Continue → editor.
  await tap(page.getByTestId("review-continue"), "Continue (review)");
  await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: 30_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 30_000 });
  // First book page preview: any rendered book page (cover included) inside the viewport …
  const inView = `(el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }`;
  await expect
    .poll(
      () =>
        page.evaluate((f) => {
          const vis = eval(f) as (el: Element) => boolean;
          return Array.from(document.querySelectorAll("[data-page]")).some(vis);
        }, inView),
      { timeout: 60_000, intervals: [100, 200, 250] },
    )
    .toBe(true);
  mark("firstPagePreview");
  const coach = await page.getByTestId("editor-coach").count();
  console.log(`[m13-baseline] editor coach line shown=${coach > 0}`);
  await noHorizontalOverflow();
  await screen("editor");
  // … and the first of the user's photos shown on a book page (the cover may be title-only).
  const photoOnScreen = () =>
    page.evaluate((f) => {
      const vis = eval(f) as (el: Element) => boolean;
      return Array.from(document.querySelectorAll("[data-page] img")).some(
        (el) => vis(el) && (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
      );
    }, inView);
  let pagesStepped = 0;
  for (; pagesStepped < 5 && !(await photoOnScreen()); pagesStepped++) {
    await page.waitForTimeout(1500);
    if (await photoOnScreen()) break;
    // Not a counted tap: only used to find when a photo page is first on screen.
    await page.getByTestId("carousel-next").click();
  }
  await expect.poll(photoOnScreen, { timeout: 20_000 }).toBe(true);
  mark("firstPhotoPage");
  console.log(`[m13-baseline] first photo page after ${pagesStepped} carousel steps (not counted as taps)`);
  await screen("editor-first-photo-page");
  if (pagesStepped > 0) {
    await page.getByTestId("carousel-prev").click();
    await page.waitForTimeout(300);
  }

  // 7. Done → publish screen.
  await tap(page.getByTestId("editor-done"), "Done (editor)");
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
  await expect(page.getByTestId("publish-button")).toBeVisible({ timeout: 30_000 });
  await screen("publish-draft");
  await tap(page.getByTestId("publish-button"), "Publish");
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 60_000 });
  await expect(page.getByTestId("share-whatsapp")).toBeVisible();
  mark("sharedLink");
  await noHorizontalOverflow();
  await screen("publish-live");

  // 8. WhatsApp intent.
  const href = (await page.getByTestId("share-whatsapp").getAttribute("href")) ?? "";
  expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
  const popupP = page.waitForEvent("popup", { timeout: 15_000 });
  await tap(page.getByTestId("share-whatsapp"), "Send on WhatsApp");
  const popup = await popupP;
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  expect(popup.url()).toMatch(/^https:\/\/wa\.me\//);
  mark("whatsappIntent");
  await popup.close();

  await collectRuns();
  const { data: row } = await admin.from("books").select("page_count, slug, is_paid").eq("id", bookId).single();
  const { count: photoRows } = await admin.from("photos").select("id", { count: "exact", head: true }).eq("book_id", bookId);

  const routes = [...new Set(screens.map((s) => s.route))];
  const summary = {
    viewport: "375x812",
    photosSelected: photoPaths.length,
    photoRows,
    pageCount: (row as { page_count?: number } | null)?.page_count ?? null,
    appTaps: taps.length,
    taps: taps.map((t) => `${t.n}. ${t.label}`),
    screensRoutes: routes.length + 1, // + the WhatsApp app
    routes: [...routes, "wa.me (WhatsApp)"],
    states: screens.map((s) => ({ n: s.n, name: s.name, route: s.route, ...s.decisions })),
    ms: {
      photosChosenToUploadSummary: marks.uploadSummary - marks.photosChosen,
      photosChosenToReview: marks.reviewVisible - marks.photosChosen,
      photosChosenToFirstPagePreview: marks.firstPagePreview - marks.photosChosen,
      photosChosenToFirstPhotoPage: marks.firstPhotoPage - marks.photosChosen,
      photosChosenToSharedLink: marks.sharedLink - marks.photosChosen,
      photosChosenToWhatsapp: marks.whatsappIntent - marks.photosChosen,
      buildScreen: marks.reviewVisible - marks.buildVisible,
    },
    runs: runIds.size,
  };
  console.log(`[m13-baseline] SUMMARY ${JSON.stringify(summary)}`);
  expect(taps.length).toBeGreaterThan(0);
});
