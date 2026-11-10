/**
 * Milestone 10a A10 — design-system gate against the LIVE hosted Supabase project (opt-in).
 * PLAN M10a: "smoke: set paper + faded-photo background, then editor, published viewer and PDF
 * (pdf-inspect: Type0, image dpi) all show it" + facing pages at ≥ 768 px + landscape geometry.
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic (server: AI_MODE=replay, no ANTHROPIC_API_KEY) and
 * never calls Stripe: the server runs with a dummy STRIPE_SECRET_KEY + a random STRIPE_WEBHOOK_SECRET;
 * payment = a locally SIGNED checkout.session.completed (scripts/stripe-signed-event.mjs).
 *
 * Flow (serial, one throwaway user `e2e+m10a-<random>@example.com`, admin generateLink sign-in), owner at 1024×768:
 *   a. new book → upload 6 synthetic JPEGs → build (replay) → review → editor: facing pages
 *   b. Background tool: Whole book → Paper "paper-cream"; page 1 (left) → Paper "linen" (This page);
 *      page 2 (right, via the strip) → Photo + fade 0.8 (This page) → autosave → stored doc v2 checked
 *   c. Done → publish → anonymous viewer at 375 and 1280: texture layers (cream + linen), background
 *      photo <img> (loaded) and the 0.8 veil in the DOM
 *   d. signed checkout.session.completed → paid → Download PDF → pdf-analyze + pdf-inspect: each texture
 *      tile JPEG embedded once (tiling pattern), background photo DCT on its page, veil = constant alpha,
 *      no Type3, no Chromium-rasterised (Flate) photo/page images, MediaBox portrait 437×612 pt
 *   e. landscape: service-role write of the same doc with format A5_LANDSCAPE (no UI until M10b; the
 *      books_set_doc_rev trigger bumps doc_rev, the write is guarded by the current doc_rev like the
 *      save route) → Publish changes → viewer 375 + 1280 pages are 210:148 → Download PDF → MediaBox
 *      612×437 pt, backgrounds still present
 *   f. review fix B1: service-role reset of meta.userEdited (+ portrait) → review screen drops the page-2
 *      background photo → Update album succeeds; the photo leaves every slot/cover, the page background
 *      (photo, veil 0.8, source user) survives on the page that kept its companions
 *   g. review fix S3: book default also set to that photo (service role) → the real deletePhotoAction
 *      (POST with the Next-Action id from this build's .next manifest — no UI calls it yet) → photo row
 *      gone, no reference left in the doc (book → white, v1 again), doc_rev bumped, meta unchanged →
 *      editor background change saves 200 (no 422 foreign_photo); published viewer still loads
 * afterAll (always): orders, private.stripe_events (linked CLI), exports rows, storage objects under
 * `<uid>/` (photos + exports), then the user (books/photos cascade). Per-test timeouts only.
 * Logs: counts / booleans / timings only.
 *
 * Example:
 *   (scratch copy) NEXT_PUBLIC_APP_URL=http://localhost:3817 AI_MODE=replay ANTHROPIC_API_KEY= next build
 *   STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_x AI_MODE=replay ANTHROPIC_API_KEY= \
 *     NEXT_PUBLIC_APP_URL=http://localhost:3817 next start -p 3817
 *   E2E_AUTH=1 STRIPE_WEBHOOK_SECRET=whsec_x npx playwright test -c <config: baseURL :3817, no webServer> e2e/m10a.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildEvent, postEvent } from "../scripts/stripe-signed-event.mjs";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live M10a gate");

// Captured before .env.local is loaded (its STRIPE_* entries are not the scratch server's).
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const BUCKETS = ["photos", "exports"] as const;
const DESKTOP = { width: 1024, height: 768 };
const PHONE = { width: 375, height: 812 };
const WIDE = { width: 1280, height: 800 };
const REPO = path.join(__dirname, "..");
const BOOK_TEXTURE = "paper-cream";
const PAGE_TEXTURE = "linen";
const FADE = 0.8;

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
let bgPhotoId = "";
let paid = false;
let landscape = false;
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
    for (let i = 0; i < count; i++) out.push(await draw(i + 1301));
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `m10a-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

type StoredBg = { kind: string; textureId?: string; photoId?: string; veil?: number; veilColor?: string; source?: string; hex?: string };
type StoredDoc = {
  version: number;
  format: string;
  style: { background: StoredBg | string };
  pages: { background?: StoredBg | null }[];
} & Record<string, unknown>;
type BookRow = {
  doc: StoredDoc;
  doc_rev: number;
  published_doc: StoredDoc | null;
  slug: string | null;
  is_paid: boolean;
};

async function bookRow(): Promise<BookRow> {
  const { data, error } = await admin.from("books").select("doc, doc_rev, published_doc, slug, is_paid").eq("id", bookId).single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as BookRow;
}

async function noHorizontalOverflow(p: Page, width: number) {
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(width);
}

const cur = (p: Page) => p.locator('[data-testid="carousel-item"][aria-hidden="false"]');
const side = (p: Page, s: "left" | "right") => cur(p).locator(`[data-testid="spread-page"][data-side="${s}"]`);

/** The current slide rests flush with the carousel's left edge. */
async function settle(p: Page) {
  await expect
    .poll(
      async () => {
        const c = (await p.getByTestId("page-carousel").boundingBox())?.x ?? 0;
        const x1 = (await cur(p).boundingBox())?.x ?? 999;
        await p.waitForTimeout(100);
        const x2 = (await cur(p).boundingBox())?.x ?? 999;
        return Math.abs(x1 - x2) < 1 && Math.abs(x2 - c) < 2;
      },
      { timeout: 8_000 },
    )
    .toBe(true);
}

async function openBgTool(p: Page) {
  const panel = p.getByTestId("editor-panel-background");
  if ((await panel.count()) === 0) await p.getByTestId("editor-tool-background").click();
  await expect(panel).toBeVisible();
}

async function closePanel(p: Page) {
  if ((await p.getByTestId("editor-panel-close").count()) > 0) await p.getByTestId("editor-panel-close").click();
}

async function saved(p: Page) {
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
}

type ViewerBg = { cream: number; linen: number; photos: number; photosLoaded: number; veils: string[]; ratios: number[] };

/** Anonymous visit of /b/<slug>; flips once so pages 1–2 are inside the photo window. */
async function viewerBackgrounds(browser: Browser, viewport: { width: number; height: number }, mobile: boolean): Promise<ViewerBg> {
  const ctx = await browser.newContext({ viewport, baseURL, hasTouch: mobile, isMobile: mobile });
  try {
    const v = await ctx.newPage();
    const res = await v.goto(`/b/${slug}`);
    expect(res?.status()).toBe(200);
    await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await v.getByTestId("next-page").click();
    await v.waitForTimeout(1_500);
    const fb = v.getByTestId("flipbook");
    await expect(fb.locator(`[data-bg="texture"][data-bg-texture="${PAGE_TEXTURE}"]`).first()).toBeAttached();
    await expect
      .poll(async () => fb.locator('img[data-bg="photo"]').evaluateAll((els) => els.filter((e) => (e as HTMLImageElement).naturalWidth > 0).length), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const out = await fb.evaluate((root, tex) => {
      const imgs = [...root.querySelectorAll<HTMLImageElement>('img[data-bg="photo"]')];
      const frames = [...root.querySelectorAll<HTMLElement>("[data-mode]")].filter((e) => e.getBoundingClientRect().width > 0);
      return {
        cream: root.querySelectorAll(`[data-bg="texture"][data-bg-texture="${tex.book}"]`).length,
        linen: root.querySelectorAll(`[data-bg="texture"][data-bg-texture="${tex.page}"]`).length,
        photos: imgs.filter((i) => !!i.getAttribute("src")).length,
        photosLoaded: imgs.filter((i) => i.naturalWidth > 0).length,
        veils: [...root.querySelectorAll<HTMLElement>('[data-bg="veil"]')].map((e) => getComputedStyle(e).backgroundColor),
        ratios: frames.map((e) => {
          const r = e.getBoundingClientRect();
          return Math.round((r.width / r.height) * 1000) / 1000;
        }),
      };
    }, { book: BOOK_TEXTURE, page: PAGE_TEXTURE });
    await noHorizontalOverflow(v, viewport.width);
    await v.screenshot({ path: test.info().outputPath(`viewer-${landscape ? "landscape" : "portrait"}-${viewport.width}.png`) });
    return out;
  } finally {
    await ctx.close();
  }
}

type AnalyzePage = {
  page: number;
  images: { k: string; where: string; w: number; h: number; filter: string | null; cs: string; smask: string; bytes: number }[];
  patterns: { key: string; type: string }[];
  gstates: { ca?: number | string; CA?: number | string; BM?: string | null; smask?: string }[];
};
type InspectResult = {
  pageCount: number;
  fonts: { baseFont: string | null; subtype: string | null; type3: boolean }[];
  imageStreams: { count: number; dct: number; filters: string[]; maxPx: number };
  dpi: { count: number; min: number | null; median: number | null; max: number | null };
  pages: { n: number; mediaBox: { wPt: number; hPt: number } | null; images: { px: number[]; placedMm: number[]; dpiMin: number }[] }[];
};

function analyze(file: string): { pages: AnalyzePage[]; summary: { bytes: number; uniqueImages: number } } {
  const out = execFileSync(process.execPath, [path.join(REPO, "scripts", "pdf-analyze.mjs"), file], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  })
    .toString()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  return { pages: out.slice(0, -1) as AnalyzePage[], summary: out[out.length - 1] };
}

function inspect(file: string): InspectResult {
  const out = execFileSync(process.execPath, [path.join(REPO, "scripts", "pdf-inspect.mjs"), file, "--no-text"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  }).toString();
  return JSON.parse(out) as InspectResult;
}

async function downloadPdf(name: string): Promise<string> {
  await page.goto(`/books/${bookId}/publish`);
  await expect(page.getByTestId("publish-pdf")).toBeVisible({ timeout: 30_000 });
  const btn = page.getByTestId("pdf-download");
  await expect(btn).toBeEnabled();
  const t0 = Date.now();
  const download = page.waitForEvent("download", { timeout: 240_000 });
  await btn.click();
  const d = await download;
  const file = test.info().outputPath(name);
  await d.saveAs(file);
  const bytes = readFileSync(file);
  console.log(`[pdf ${name}] click→download ${((Date.now() - t0) / 1000).toFixed(1)} s bytes=${bytes.length}`);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  return file;
}

/** Shared PDF structure checks; returns a compact summary for the log. */
function checkPdf(file: string, orientation: "portrait" | "landscape", pagesInDoc: number) {
  const a = analyze(file);
  const ins = inspect(file);
  const [wPt, hPt] = orientation === "portrait" ? [437.04, 612] : [612, 437.04];

  // Page count = cover + pages; every sheet has the expected MediaBox.
  expect(ins.pageCount).toBe(pagesInDoc + 1);
  for (const p of ins.pages) {
    expect(Math.abs((p.mediaBox?.wPt ?? 0) - wPt)).toBeLessThan(1.5);
    expect(Math.abs((p.mediaBox?.hPt ?? 0) - hPt)).toBeLessThan(1.5);
  }

  // Fonts: no Type3 at all.
  const type3 = ins.fonts.filter((f) => f.type3 || f.subtype === "Type3").length;
  expect(type3).toBe(0);

  // Texture tiles: 512×512 DCT images reached through tiling patterns; one XObject per texture for the
  // whole document (cover + every page uses paper-cream; page 1 uses linen).
  const tileRefs = new Set<string>();
  let pagesWithTile = 0;
  for (const p of a.pages) {
    const tiles = p.images.filter((i) => i.w === 512 && i.h === 512 && /DCT/.test(i.filter ?? "") && /pattern/.test(i.where));
    if (tiles.length) pagesWithTile++;
    for (const t of tiles) tileRefs.add(t.k);
  }
  expect(tileRefs.size).toBe(2);
  expect(pagesWithTile).toBe(ins.pageCount - 1); // every sheet but the photo-background page

  // Background photo page (doc page index 1 = PDF page 3): a DCT image placed over the whole sheet,
  // the veil is a constant-alpha fill (ca 0.8), no soft-mask / transparency group.
  const bgPage = a.pages[2];
  const bgInspect = ins.pages[2];
  const sheet = orientation === "portrait" ? [154, 216] : [216, 154];
  const fullSheet = bgInspect.images.filter((i) => i.placedMm[0] >= sheet[0] - 2 && i.placedMm[1] >= sheet[1] - 2);
  expect(fullSheet.length).toBeGreaterThanOrEqual(1);
  expect(bgPage.images.some((i) => /DCT/.test(i.filter ?? "") && !/pattern/.test(i.where))).toBe(true);
  const veil = bgPage.gstates.some((g) => Math.abs(Number(g.ca) - FADE) < 0.01);
  expect(veil).toBe(true);
  expect(bgPage.gstates.some((g) => !!g.smask)).toBe(false);

  // No Chromium raster: every image of real size is DCT passthrough (Flate only for tiny masks).
  const allImgs = a.pages.flatMap((p) => p.images);
  const flateBig = allImgs.filter((i) => !/DCT/.test(i.filter ?? "") && i.w * i.h > 400 * 400).length;
  expect(flateBig).toBe(0);

  const summary = {
    bytes: a.summary.bytes,
    pages: ins.pageCount,
    mediaBox: `${ins.pages[0].mediaBox?.wPt}x${ins.pages[0].mediaBox?.hPt}`,
    uniqueImages: a.summary.uniqueImages,
    tileXObjects: tileRefs.size,
    pagesWithTile,
    bgFullSheetImages: fullSheet.length,
    bgDpiMin: Math.min(...fullSheet.map((i) => i.dpiMin)),
    veilCa: veil,
    flateBig,
    fonts: ins.fonts.length,
    fontSubtypes: [...new Set(ins.fonts.map((f) => f.subtype))].join(","),
    type3,
    dpi: ins.dpi,
    filters: ins.imageStreams.filters,
  };
  console.log(`[pdf ${orientation}] ${JSON.stringify(summary)}`);
  return summary;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  email = `e2e+m10a-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;
  context = await browser.newContext({ viewport: DESKTOP, baseURL });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/);
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  if (!uid) return;
  await context?.close().catch(() => {});
  let ordersDeleted = (await admin.from("orders").delete().eq("user_id", uid).select("id")).data?.length ?? 0;
  if (bookId) ordersDeleted += (await admin.from("orders").delete().eq("book_id", bookId).select("id")).data?.length ?? 0;
  const exportRows = (await admin.from("exports").delete().eq("user_id", uid).select("id")).data?.length ?? 0;

  let eventsLeft: number | string = 0;
  const ids = eventIds.filter((id) => /^evt_test_[0-9a-f]{24}$/.test(id));
  if (ids.length) {
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
  let left = 0;
  for (const bucket of BUCKETS) left += (await listAllUserObjects(bucket)).length;
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const orders = bookId ? await admin.from("orders").select("id", { count: "exact", head: true }).eq("book_id", bookId) : { count: 0 };
  console.log(
    `[cleanup] objects removed=${removed} left=${left} books=${books.count} ordersDeleted=${ordersDeleted} ordersLeft=${orders.count} exportRows=${exportRows} stripeEventsSent=${ids.length} stripeEventsLeft=${eventsLeft} userDeleted=${!error}`,
  );
  expect(error).toBeNull();
  expect(left).toBe(0);
  expect(books.count).toBe(0);
  expect(orders.count ?? 0).toBe(0);
});

test("a. new book → upload → build (replay) → editor at 1024 shows facing pages", async () => {
  test.setTimeout(600_000);
  const t0 = Date.now();
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  bookId = new URL(page.url()).pathname.split("/")[2];
  await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 6));
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 420_000 });
  await page.getByTestId("review-continue").click();
  await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: 30_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  console.log(`[a] upload→editor ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const row = await bookRow();
  expect(row.doc.version).toBe(1); // nothing v2 yet → stored as v1 (rollback-safe)
  expect(row.doc.pages.length).toBeGreaterThanOrEqual(2);

  await expect(page.getByTestId("page-carousel")).toHaveAttribute("data-mode", "spread");
  await expect(cur(page).getByTestId("editor-spread")).toHaveAttribute("data-kind", "cover");
  await page.getByTestId("carousel-next").click();
  await settle(page);
  await expect(page.getByTestId("page-counter")).toHaveText(new RegExp(`^1–2 / ${row.doc.pages.length}$`));
  const l = (await side(page, "left").boundingBox())!;
  const r = (await side(page, "right").boundingBox())!;
  expect(Math.abs(l.y - r.y)).toBeLessThan(1);
  expect(Math.abs(l.x + l.width - r.x)).toBeLessThan(1);
  expect(Math.abs(l.width - r.width)).toBeLessThan(1);
  await expect(cur(page).getByTestId("spread-fold")).toHaveCount(1);
  await expect(side(page, "left")).toHaveAttribute("data-active", "true");
  await noHorizontalOverflow(page, DESKTOP.width);
});

test("b. Background tool: whole book paper, page 1 linen, page 2 faded photo → autosaved v2 doc", async () => {
  test.skip(!bookId, "needs test a");
  test.setTimeout(180_000);
  // Whole book → Paper → paper-cream.
  await openBgTool(page);
  await expect(page.getByTestId("bg-scope-page")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("bg-scope-book").click();
  await page.getByTestId("bg-tab-texture").click();
  await page.getByTestId(`bg-texture-${BOOK_TEXTURE}`).click();
  await expect(page.getByTestId(`bg-texture-${BOOK_TEXTURE}`)).toHaveAttribute("aria-checked", "true");
  await expect(side(page, "left").locator(`[data-bg="texture"][data-bg-texture="${BOOK_TEXTURE}"]`)).toHaveCount(1);
  await expect(side(page, "right").locator(`[data-bg="texture"][data-bg-texture="${BOOK_TEXTURE}"]`)).toHaveCount(1);
  await saved(page);

  // Page 1 (left, current) → This page → linen.
  await page.getByTestId("bg-scope-page").click();
  await page.getByTestId(`bg-texture-${PAGE_TEXTURE}`).click();
  await expect(side(page, "left").locator(`[data-bg-texture="${PAGE_TEXTURE}"]`)).toHaveCount(1);
  await expect(side(page, "right").locator(`[data-bg-texture="${BOOK_TEXTURE}"]`)).toHaveCount(1);
  await saved(page);
  await closePanel(page);

  // Page 2 (right) via the strip (no selection) → This page → Photo → fade 0.8.
  await page.getByTestId("page-strip").getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(side(page, "right")).toHaveAttribute("data-active", "true");
  await openBgTool(page);
  await expect(page.getByTestId("bg-scope-page")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("bg-tab-photo").click();
  const first = page.getByTestId("bg-photo").first();
  bgPhotoId = (await first.getAttribute("data-photo-id")) ?? "";
  expect(bgPhotoId).toMatch(/^[0-9a-f-]{36}$/);
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("bg-fade").fill(String(FADE));
  await expect(page.getByTestId("bg-fade-value")).toHaveText("80%");
  await expect(side(page, "right").locator('img[data-bg="photo"]')).toHaveCount(1);
  await expect(side(page, "right").locator('[data-bg="veil"]')).toHaveCount(1);
  const veil = await side(page, "right").locator('[data-bg="veil"]').evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(veil).toMatch(/0\.8\)$/);
  await expect(side(page, "left").locator(`[data-bg-texture="${PAGE_TEXTURE}"]`)).toHaveCount(1);
  await saved(page);
  await closePanel(page);
  await noHorizontalOverflow(page, DESKTOP.width);
  await page.screenshot({ path: test.info().outputPath("editor-1024-backgrounds.png") });

  const { doc } = await bookRow();
  expect(doc.version).toBe(2);
  expect(doc.format).toBe("A5_PORTRAIT");
  expect(doc.style.background).toEqual({ kind: "texture", textureId: BOOK_TEXTURE });
  expect(doc.pages[0].background).toEqual({ kind: "texture", textureId: PAGE_TEXTURE, source: "user" });
  expect(doc.pages[1].background).toMatchObject({ kind: "photo", photoId: bgPhotoId, veil: FADE, source: "user" });
  expect(doc.pages.slice(2).every((p) => p.background === undefined)).toBe(true);
  console.log(`[b] stored v2: book=${BOOK_TEXTURE} p1=${PAGE_TEXTURE} p2=photo veil=${FADE} veilColor=${doc.pages[1].background?.veilColor ?? "none"}`);
});

test("c. Done → publish → anonymous viewer at 375 and 1280 shows textures, background photo and veil", async ({ browser }) => {
  test.skip(!bgPhotoId, "needs test b");
  test.setTimeout(240_000);
  await page.getByTestId("editor-done").click();
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
  const row = await bookRow();
  slug = row.slug ?? "";
  expect(slug).not.toBe("");
  expect(row.published_doc?.version).toBe(2);
  expect(row.published_doc?.pages[1].background).toMatchObject({ kind: "photo", photoId: bgPhotoId, veil: FADE });
  expect(row.published_doc?.pages[1].background).not.toHaveProperty("source");

  for (const [vp, mobile] of [
    [PHONE, true],
    [WIDE, false],
  ] as const) {
    const v = await viewerBackgrounds(browser, vp, mobile);
    console.log(`[c ${vp.width}] ${JSON.stringify(v)}`);
    expect(v.cream).toBeGreaterThan(0);
    expect(v.linen).toBeGreaterThan(0);
    expect(v.photos).toBeGreaterThan(0);
    expect(v.photosLoaded).toBeGreaterThan(0);
    expect(v.veils.some((c) => /0\.8\)$/.test(c))).toBe(true);
  }
});

test("d. signed checkout → paid → Download PDF: texture once, bg photo DCT, veil alpha, no Type3/raster, portrait", async () => {
  test.skip(!slug, "needs test c");
  test.skip(!WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET (same as the server's) is required");
  test.setTimeout(360_000);
  const ev = buildEvent({ type: "completed", bookId, userId: uid, amount: 3900, currency: "aed" });
  eventIds.push(ev.id);
  expect(await postEvent({ baseURL, payload: ev.payload, secret: WEBHOOK_SECRET })).toBe(200);
  expect((await bookRow()).is_paid).toBe(true);
  paid = true;
  const pages = (await bookRow()).doc.pages.length;
  const file = await downloadPdf("m10a-portrait.pdf");
  checkPdf(file, "portrait", pages);
});

test("e. landscape doc (service-role write) → Publish changes → viewer 210:148 at 375 + 1280 → PDF 612×437", async ({ browser }) => {
  test.skip(!paid, "needs test d");
  test.setTimeout(420_000);
  const before = await bookRow();
  const doc = { ...before.doc, format: "A5_LANDSCAPE" };
  const upd = await admin.from("books").update({ doc }).eq("id", bookId).eq("doc_rev", before.doc_rev).select("doc_rev");
  expect(upd.error).toBeNull();
  expect(upd.data?.length).toBe(1);
  const after = await bookRow();
  expect(after.doc_rev).toBeGreaterThan(before.doc_rev);
  expect(after.doc.format).toBe("A5_LANDSCAPE");
  landscape = true;

  // The editor opens the landscape doc without errors (spread mode, wide pages).
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/books/${bookId}/edit`);
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await page.getByTestId("carousel-next").click();
  await settle(page);
  const lb = (await side(page, "left").locator('[data-testid="editor-page"]').boundingBox())!;
  expect(Math.abs(lb.width / lb.height - 210 / 148)).toBeLessThan(0.03);
  await expect(side(page, "left").locator(`[data-bg-texture="${PAGE_TEXTURE}"]`)).toHaveCount(1);
  await expect(side(page, "right").locator('img[data-bg="photo"]')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("editor-1024-landscape.png") });
  expect(errors).toEqual([]);

  await page.goto(`/books/${bookId}/publish`);
  await page.getByTestId("publish-changes-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Changes published", { timeout: 30_000 });
  expect((await bookRow()).published_doc?.format).toBe("A5_LANDSCAPE");

  for (const [vp, mobile] of [
    [PHONE, true],
    [WIDE, false],
  ] as const) {
    const v = await viewerBackgrounds(browser, vp, mobile);
    console.log(`[e ${vp.width}] ${JSON.stringify(v)}`);
    expect(v.linen).toBeGreaterThan(0);
    expect(v.photosLoaded).toBeGreaterThan(0);
    expect(v.veils.some((c) => /0\.8\)$/.test(c))).toBe(true);
    const pageRatios = v.ratios.filter((x) => x > 0);
    expect(pageRatios.length).toBeGreaterThan(0);
    for (const x of pageRatios) expect(Math.abs(x - 210 / 148)).toBeLessThan(0.03);
  }

  const file = await downloadPdf("m10a-landscape.pdf");
  checkPdf(file, "landscape", after.doc.pages.length);
});

// ---- M10a review fixes (A12a) ------------------------------------------------------------------

type DocPage = { slots: { photoId: string | null }[]; background?: StoredBg | null };
const slotIds = (d: StoredDoc) => (d.pages as unknown as DocPage[]).flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => !!x));
const coverId = (d: StoredDoc) => ((d as unknown as { cover: { photoId: string | null } }).cover.photoId ?? null);
let b1Done = false;

test("f. B1: Update album keeps a page background whose photo was DROPPED on review", async () => {
  test.skip(!paid, "needs test d");
  test.setTimeout(180_000);
  // Make the album replaceable again (the editor saves set meta.userEdited) and portrait (M10a has
  // no format UI). A user-set page background (source user) on a not-edited album is exactly the
  // shape a future AI suggestion (M10c) or a never-edited album would have; Update album must keep it.
  const before = await bookRow();
  const meta = (before.doc as unknown as { meta?: Record<string, unknown> }).meta ?? {};
  const doc = { ...before.doc, format: "A5_PORTRAIT", meta: { ...meta, userEdited: false } };
  const upd = await admin.from("books").update({ doc }).eq("id", bookId).eq("doc_rev", before.doc_rev).select("doc_rev");
  expect(upd.error).toBeNull();
  expect(upd.data?.length).toBe(1);

  const start = await bookRow();
  const bgIdx = (start.doc.pages as unknown as DocPage[]).findIndex((p) => p.background?.kind === "photo" && p.background.photoId === bgPhotoId);
  expect(bgIdx).toBeGreaterThanOrEqual(0);
  const inAlbum = slotIds(start.doc).includes(bgPhotoId) || coverId(start.doc) === bgPhotoId;
  // Companion photos on the background page (to find the page again after the relayout).
  const companions = (start.doc.pages as unknown as DocPage[])[bgIdx].slots.map((s) => s.photoId).filter((x): x is string => !!x && x !== bgPhotoId);

  // Drop the background photo on the review screen.
  await page.goto(`/books/${bookId}/review`);
  const tile = page.locator(`[data-testid="review-tile"][data-photo-id="${bgPhotoId}"]`);
  await expect(tile).toHaveAttribute("data-state", "kept", { timeout: 30_000 });
  await tile.click();
  await expect(tile).toHaveAttribute("data-state", "dropped");
  await expect
    .poll(async () => (await admin.from("photos").select("status, user_override").eq("id", bgPhotoId).single()).data, { timeout: 15_000 })
    .toMatchObject({ status: "dropped", user_override: true });

  await expect(page.getByTestId("update-album-bar")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("update-album").click();
  await expect(page.getByTestId("update-album-toast")).toHaveText("Album updated", { timeout: 30_000 });
  await expect(page.getByTestId("update-album-error")).toHaveCount(0);

  const after = await bookRow();
  const pages = after.doc.pages as unknown as DocPage[];
  expect(slotIds(after.doc)).not.toContain(bgPhotoId);
  expect(coverId(after.doc)).not.toBe(bgPhotoId);
  const withBg = pages.map((p, i) => ({ p, i })).filter(({ p }) => p.background?.kind === "photo" && p.background.photoId === bgPhotoId);
  expect(withBg.length).toBe(1);
  expect(withBg[0].p.background).toMatchObject({ kind: "photo", photoId: bgPhotoId, veil: FADE, source: "user" });
  if (companions.length) expect(withBg[0].p.slots.some((s) => s.photoId && companions.includes(s.photoId))).toBe(true);
  expect(after.doc.version).toBe(2);
  expect((after.doc.style as { background: StoredBg }).background).toEqual({ kind: "texture", textureId: BOOK_TEXTURE });
  console.log(
    `[f] B1 relayout: bgPhotoInAlbumBefore=${inAlbum} pagesBefore=${start.doc.pages.length} pagesAfter=${pages.length} bgPageBefore=${bgIdx} bgPageAfter=${withBg[0].i} companions=${companions.length} docRev ${start.doc_rev}→${after.doc_rev}`,
  );
  b1Done = true;
});

function deletePhotoActionId(): string {
  const m = JSON.parse(readFileSync(path.join(REPO, ".next", "server", "server-reference-manifest.json"), "utf8")) as {
    node: Record<string, { exportedName?: string }>;
  };
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === "deletePhotoAction");
  if (!hit) throw new Error("deletePhotoAction not in the server-reference manifest (run next build in this copy)");
  return hit[0];
}

test("g. S3: deletePhotoAction on a background photo strips it from the doc; editor saves afterwards", async () => {
  test.skip(!b1Done, "needs test f");
  test.setTimeout(180_000);
  // Also make it the book default (whole-book faded photo) so both strip paths run: book → white, page → removed.
  const before = await bookRow();
  const doc = { ...before.doc, style: { ...before.doc.style, background: { kind: "photo", photoId: bgPhotoId, veil: FADE, veilColor: "#FFFFFF" } } };
  const upd = await admin.from("books").update({ doc }).eq("id", bookId).eq("doc_rev", before.doc_rev).select("doc_rev");
  expect(upd.error).toBeNull();
  expect(upd.data?.length).toBe(1);
  const start = await bookRow();
  const metaBefore = JSON.stringify((start.doc as { meta?: unknown }).meta ?? null);

  // The real server action (no UI calls it yet — UI deletion is a later milestone): POST with the
  // Next-Action id from this build's manifest and the signed-in user's cookies.
  const res = await page.request.post(`/books/${bookId}/upload`, {
    headers: {
      "Next-Action": deletePhotoActionId(),
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "text/x-component",
      Origin: baseURL,
    },
    data: JSON.stringify([bgPhotoId, bookId]),
  });
  const body = await res.text();
  expect(res.status()).toBe(200);
  expect(body).toContain('"ok":true');

  expect((await admin.from("photos").select("id").eq("id", bgPhotoId)).data?.length ?? -1).toBe(0);
  const after = await bookRow();
  const raw = JSON.stringify(after.doc);
  expect(raw).not.toContain(bgPhotoId);
  // Book default → white; with no v2 feature left, serializeDoc writes v1 again (style.background = hex).
  const bookBg = (after.doc.style as { background: StoredBg | string }).background;
  if (after.doc.version === 1) expect(bookBg).toBe("#FFFFFF");
  else expect(bookBg).toEqual({ kind: "color", hex: "#FFFFFF" });
  expect(after.doc_rev).toBeGreaterThan(start.doc_rev);
  expect(JSON.stringify((after.doc as { meta?: unknown }).meta ?? null)).toBe(metaBefore);

  // The editor opens and a save succeeds (no 422 foreign_photo).
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const saves: number[] = [];
  const saveBodies: string[] = [];
  const consoleMsgs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 200)}`);
  });
  page.on("response", async (r) => {
    if (/\/api\/books\/[^/]+\/doc/.test(r.url()) && r.request().method() !== "GET") {
      saves.push(r.status());
      saveBodies.push(`${r.status()} ${(await r.text().catch(() => "")).slice(0, 300)}`);
    }
  });
  page.on("requestfailed", (r) => {
    if (/\/api\/books\//.test(r.url())) saveBodies.push(`FAILED ${r.method()} ${r.failure()?.errorText}`);
  });
  await page.goto(`/books/${bookId}/edit`);
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await page.getByTestId("carousel-next").click();
  await settle(page);
  await openBgTool(page);
  await page.getByTestId("bg-scope-page").click();
  await page.getByTestId("bg-tab-texture").click();
  await page.getByTestId("bg-texture-kraft").click();
  // Published book: after a save the header shows "Publish changes" instead of the save status,
  // so wait for the PUT itself and the stored doc.
  try {
    await expect.poll(() => saves.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect
      .poll(async () => ((await bookRow()).doc.pages as unknown as DocPage[])[0]?.background, { timeout: 20_000 })
      .toMatchObject({ kind: "texture", textureId: "kraft", source: "user" });
  } finally {
    console.log(`[g] save responses: ${JSON.stringify(saveBodies)} console=${JSON.stringify(consoleMsgs.slice(-10))}`);
  }
  await expect(page.getByTestId("editor-publish-changes")).toBeVisible();
  await closePanel(page);
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.every((s) => s >= 200 && s < 300)).toBe(true);
  expect(errors).toEqual([]);
  const final = await bookRow();
  expect(JSON.stringify(final.doc)).not.toContain(bgPhotoId);

  // The published snapshot still names the deleted photo (publish is a snapshot) — the viewer must still load.
  const v = await page.context().browser()!.newContext({ baseURL, viewport: PHONE });
  try {
    const vp = await v.newPage();
    const r = await vp.goto(`/b/${slug}`);
    expect(r?.status()).toBe(200);
    await expect(vp.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  } finally {
    await v.close();
  }
  console.log(`[g] S3 delete: status=${res.status()} docRev ${start.doc_rev}→${after.doc_rev}→${final.doc_rev} saves=${JSON.stringify(saves)} publishedStillRefs=${JSON.stringify(final.published_doc).includes(bgPhotoId)}`);
});
