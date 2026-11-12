/**
 * Milestone 10b A16 — landscape + modern + spreads gate against the LIVE hosted Supabase project (opt-in).
 * PLAN M10b: New book form shape/style → album per format/style with spreads stored as page pairs →
 * editor spread layouts (2 pages toward the limits, columns are the authority) → viewer + PDF per format.
 *
 * SKIPPED unless E2E_AUTH=1 (and migration 1900 present — probed read-only). Never calls Anthropic
 * (server: AI_MODE=replay, no ANTHROPIC_API_KEY) and never calls Stripe: the server runs with a dummy
 * STRIPE_SECRET_KEY + a random STRIPE_WEBHOOK_SECRET; payment = a locally SIGNED
 * checkout.session.completed (scripts/stripe-signed-event.mjs), same as e2e/m10a + launch-smoke.
 *
 * Flow (serial, one throwaway user `e2e+m10b-<random>@example.com`, admin generateLink sign-in), 1024×768:
 *   a. New book form: Landscape + Modern + title → row format A5_LANDSCAPE / design_style modern →
 *      upload 10 synthetic landscape JPEGs (one moment ≥ 8 → replay Storyteller may use a spread) →
 *      build (replay) → review → editor. Stored doc v2, doc.format/designStyle = columns, every page +
 *      cover layout is a modern landscape one (m-l-*), spreads aligned (left even idx owns slots,
 *      right half same layout, slots [], caption null). Review captions preview counts only captionable
 *      pages (spread right halves excluded, Bug 1) and shows no "page has no caption yet" line
 *   b. Free limit with spreads (max_pages 20): service-role pad to 19 pages (empty m-l-one pages, slot
 *      count kept) → editor: page 19 (a left page with no next page) → spread enabled (19 + 1 = 20) →
 *      applied, saved: 20 pages / page_count 20. Add page now opens the Upgrade sheet (no page 21).
 *      Server: a 21-page doc whose spread counts 2 → 422 page_limit. Restore the pre-pad doc.
 *      (A spread that needs a NEW page can't be refused at cap 20: only an odd page count has a left
 *      page without a next page, and 19 + 1 = 20 fits. The refusal is unit-tested: tests/edit-ops-spreads.)
 *   c. Real editor: apply m-l-spread-panorama on a left page → saved 200, stored v2 with side left/right.
 *      Tampering: PUT the stored doc with format A5_PORTRAIT / designStyle classic → stored doc still
 *      A5_LANDSCAPE / modern (columns); right half without `side` → 422 invalid_doc, nothing stored.
 *      A19 (review B1): type the first caption on a captionable page with none (single page with a
 *      caption area or a captioned spread's left half) → saves 200, stored font Cormorant (modern face)
 *   d. Done → publish → anonymous viewer at 375 (each half its own page, data-spread-side left/right)
 *      and 1280 (both halves facing) — no horizontal overflow, landscape page ratio
 *   e. signed checkout → paid → Download PDF → pdf-analyze + pdf-inspect: pages = doc + cover, MediaBox
 *      612×437 / TrimBox 210×148 mm landscape on every sheet, no Type3, all fonts Type0 incl. new modern
 *      faces, panorama photo = ONE image XObject on both halves, no Chromium raster (no big Flate),
 *      cover title extractable as text
 *   f. New book form: Portrait + Classic → upload 3 → build → editor: stored v1 (no v2 key at all);
 *      a layout change in the editor saves 200 and the doc is still v1
 *   g. A19 (review S2): deletePhotoAction (Next-Action from this build's manifest, as e2e/m10a g) on a
 *      photo of a multi-photo spread → doc reflows: no empty slot, one photo fewer, spreads aligned,
 *      user caption kept, still modern landscape; an editor layout change afterwards saves 200
 * afterAll (always): orders, private.stripe_events (linked CLI), exports rows, storage objects under
 * `<uid>/` (photos + exports), then the user (books/photos cascade). Per-test timeouts only.
 * Logs: counts / booleans / layout ids / timings only.
 *
 * Example:
 *   (scratch copy) NEXT_PUBLIC_APP_URL=http://localhost:3916 AI_MODE=replay ANTHROPIC_API_KEY= next build
 *   STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_x AI_MODE=replay ANTHROPIC_API_KEY= \
 *     NEXT_PUBLIC_APP_URL=http://localhost:3916 next start -p 3916
 *   E2E_AUTH=1 STRIPE_WEBHOOK_SECRET=whsec_x npx playwright test -c <config: baseURL :3916, no webServer> e2e/m10b.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildEvent, postEvent } from "../scripts/stripe-signed-event.mjs";
import { hasCaptionArea } from "../src/lib/ai/captions";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live M10b gate");

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
const TITLE = "Desert Trip";
const SPREADS = ["m-l-spread-grid", "m-l-spread-mosaic", "m-l-spread-panorama"];
const PANORAMA = "m-l-spread-panorama";
const FREE_MAX = 20;

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
let migrated = false;
let bookId = "";
let classicId = "";
let slug = "";
let panoIdx = -1;
let built = false;
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

/** `n` distinct, sharp JPEGs (not duplicates, not blurry) drawn in the browser, w×h px. */
async function makeSynthetic(p: Page, n: number, w: number, h: number, prefix: string) {
  const list = await p.evaluate(
    async ({ count, w, h }) => {
      function rng(seed: number) {
        let s = seed >>> 0;
        return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      }
      async function draw(seed: number): Promise<string> {
        const r = rng(seed * 7919 + 17);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d")!;
        for (let y = 0; y < Math.ceil(h / 100); y++) {
          for (let x = 0; x < Math.ceil(w / 100); x++) {
            g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
            g.fillRect(x * 100, y * 100, 100, 100);
          }
        }
        const img = g.getImageData(0, 0, w, h);
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
      for (let i = 0; i < count; i++) out.push(await draw(i + 1601 + w));
      return out;
    },
    { count: n, w, h },
  );
  return list.map((b64, i) => ({ name: `${prefix}-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

type Slot = { photoId: string | null; crop: { x: number; y: number; zoom: number } };
type DocPage = { id: string; chapterId: string | null; layout: string; slots: Slot[]; caption: unknown; side?: "left" | "right"; background?: unknown };
type StoredDoc = {
  version: number;
  format: string;
  cover: { layout: string; photoId: string | null };
  style: { background: unknown; designStyle?: string; font: string };
  pages: DocPage[];
} & Record<string, unknown>;
type BookRow = {
  doc: StoredDoc;
  doc_rev: number;
  page_count: number;
  max_pages: number;
  is_paid: boolean;
  published_doc: StoredDoc | null;
  slug: string | null;
  format: string;
  design_style: string;
};

async function bookRow(id = bookId): Promise<BookRow> {
  const { data, error } = await admin
    .from("books")
    .select("doc, doc_rev, page_count, max_pages, is_paid, published_doc, slug, format, design_style")
    .eq("id", id)
    .single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as BookRow;
}

/** Service-role doc write guarded by doc_rev (like the save route); returns the new rev. */
async function writeDoc(doc: StoredDoc, rev: number): Promise<number> {
  const upd = await admin.from("books").update({ doc, page_count: doc.pages.length }).eq("id", bookId).eq("doc_rev", rev).select("doc_rev");
  expect(upd.error).toBeNull();
  expect(upd.data?.length).toBe(1);
  return (upd.data as { doc_rev: number }[])[0].doc_rev;
}

/** PUT /api/books/<id>/doc as the signed-in user (same origin). */
async function putDoc(doc: unknown, baseRev: number): Promise<{ status: number; body: string }> {
  const res = await page.request.put(`/api/books/${bookId}/doc`, {
    headers: { Origin: baseURL, "Content-Type": "application/json" },
    data: JSON.stringify({ doc, baseRev }),
  });
  return { status: res.status(), body: (await res.text()).slice(0, 200) };
}

/** Spread storage rules (PLAN "Spreads"): returns a list of problems (empty = aligned). */
function spreadProblems(doc: StoredDoc): string[] {
  const out: string[] = [];
  doc.pages.forEach((p, i) => {
    const isSpread = SPREADS.includes(p.layout);
    if (!isSpread) {
      if (p.side !== undefined) out.push(`${i}: side on a single page`);
      return;
    }
    if (p.side === "left") {
      const r = doc.pages[i + 1];
      if (i % 2 !== 0) out.push(`${i}: left half on odd index`);
      if (!r || r.layout !== p.layout || r.side !== "right") out.push(`${i}: no matching right half`);
    } else if (p.side === "right") {
      const l = doc.pages[i - 1];
      if (!l || l.layout !== p.layout || l.side !== "left") out.push(`${i}: no matching left half`);
      if (p.slots.length !== 0 || p.caption !== null) out.push(`${i}: right half owns slots/caption`);
    } else out.push(`${i}: spread page without side`);
  });
  return out;
}

const spreadStarts = (doc: StoredDoc) => doc.pages.flatMap((p, i) => (SPREADS.includes(p.layout) && p.side === "left" ? [i] : []));

async function noHorizontalOverflow(p: Page, width: number) {
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(width);
}

async function saved(p: Page) {
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
}

const cur = (p: Page) => p.locator('[data-testid="carousel-item"][aria-hidden="false"]');

async function openEditorAt(p: Page, pageNo: number) {
  await p.goto(`/books/${bookId}/edit`);
  await expect(p.getByTestId("editor-shell")).toBeVisible();
  await expect(p.getByTestId("page-carousel")).toHaveAttribute("data-mode", "spread");
  await p.getByTestId("page-strip").getByRole("button", { name: `Page ${pageNo}`, exact: true }).click();
  await p.waitForTimeout(600);
}

async function openLayoutTool(p: Page) {
  if ((await p.getByTestId("layout-picker").count()) === 0) await p.getByTestId("editor-tool-layout").click();
  await expect(p.getByTestId("layout-picker")).toBeVisible();
}

async function createViaForm(format: "A5_LANDSCAPE" | "A5_PORTRAIT", style: "modern" | "classic", title: string): Promise<string> {
  await page.goto("/books/new");
  await page.getByTestId("book-title").fill(title);
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await page.getByRole("radio", { name: format === "A5_LANDSCAPE" ? /Landscape/ : /Portrait/ }).check();
  await page.getByRole("radio", { name: style === "modern" ? /Modern/ : /Classic/ }).check();
  await expect(page.getByTestId(`format-${format}`)).toBeChecked();
  await expect(page.getByTestId(`style-${style}`)).toBeChecked();
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split("/")[2];
}

async function uploadAndBuild(id: string, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId("upload-input").setInputFiles(files);
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 420_000 });
  await page.getByTestId("review-continue").click();
  await page.waitForURL(new RegExp(`/books/${id}/edit$`), { timeout: 30_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible();
}

/** Next button until page-flip reports `index` as current (spread mode: the pair's left index). */
async function flipTo(v: Page, index: number) {
  const book = v.getByTestId("flipbook");
  for (let i = 0; i < 40; i++) {
    const n = Number(await book.getAttribute("data-current-page"));
    if (n >= index) break;
    await v.getByTestId("next-page").click();
    await expect(book).not.toHaveAttribute("data-current-page", String(n));
  }
  await expect(book).toHaveAttribute("data-current-page", String(index));
  await v.waitForTimeout(700);
}

type InspectResult = {
  pageCount: number;
  fonts: { baseFont: string | null; subtype: string | null; type3: boolean }[];
  imageStreams: { count: number; dct: number; filters: string[]; maxPx: number };
  dpi: { count: number; min: number | null; median: number | null; max: number | null };
  pages: {
    n: number;
    text?: string;
    mediaBox: { wPt: number; hPt: number } | null;
    trimBox: { wMm: number; hMm: number } | null;
    bleedBox: { wMm: number; hMm: number } | null;
  }[];
};
type AnalyzePage = { page: number; images: { k: string; where: string; w: number; h: number; filter: string | null; smask: string }[] };

function analyze(file: string): { pages: AnalyzePage[]; summary: { bytes: number; uniqueImages: number } } {
  const out = execFileSync(process.execPath, [path.join(REPO, "scripts", "pdf-analyze.mjs"), file], { cwd: REPO, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
    .toString()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  return { pages: out.slice(0, -1) as AnalyzePage[], summary: out[out.length - 1] };
}

function inspect(file: string): InspectResult {
  const out = execFileSync(process.execPath, [path.join(REPO, "scripts", "pdf-inspect.mjs"), file], { cwd: REPO, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 }).toString();
  return JSON.parse(out) as InspectResult;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const probe = await admin.from("books").select("format, design_style").limit(1);
  migrated = !probe.error;
  if (!migrated) return;
  email = `e2e+m10b-${randomBytes(6).toString("hex")}@example.com`;
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
  const bookIds = [bookId, classicId].filter(Boolean);
  let ordersDeleted = (await admin.from("orders").delete().eq("user_id", uid).select("id")).data?.length ?? 0;
  for (const b of bookIds) ordersDeleted += (await admin.from("orders").delete().eq("book_id", b).select("id")).data?.length ?? 0;
  const exportRows = (await admin.from("exports").delete().eq("user_id", uid).select("id")).data?.length ?? 0;

  let eventsLeft: number | string = 0;
  const ids = eventIds.filter((id) => /^evt_test_[0-9a-f]{24}$/.test(id));
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    try {
      execFileSync("npx", ["supabase", "db", "query", "--linked", `delete from private.stripe_events where id in (${list})`], { cwd: REPO, stdio: "pipe", timeout: 60_000 });
      const out = execFileSync("npx", ["supabase", "db", "query", "--linked", `select count(*)::int as n from private.stripe_events where id in (${list})`], {
        cwd: REPO,
        stdio: "pipe",
        timeout: 60_000,
      }).toString();
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
  const photos = bookIds.length ? await admin.from("photos").select("id", { count: "exact", head: true }).in("book_id", bookIds) : { count: 0 };
  const orders = bookIds.length ? await admin.from("orders").select("id", { count: "exact", head: true }).in("book_id", bookIds) : { count: 0 };
  const exportsLeft = await admin.from("exports").select("id", { count: "exact", head: true }).eq("user_id", uid);
  console.log(
    `[cleanup] objects removed=${removed} left=${left} books=${books.count} photos=${photos.count} ordersDeleted=${ordersDeleted} ordersLeft=${orders.count} exportRows=${exportRows} exportsLeft=${exportsLeft.count} stripeEventsSent=${ids.length} stripeEventsLeft=${eventsLeft} userDeleted=${!error}`,
  );
  expect(error).toBeNull();
  expect(left).toBe(0);
  expect(books.count).toBe(0);
  expect(photos.count ?? 0).toBe(0);
  expect(orders.count ?? 0).toBe(0);
});

test("a. form Landscape + Modern → upload → build (replay) → modern landscape doc, spreads aligned", async () => {
  test.skip(!migrated, "migration 1900 not applied (books.format/design_style missing)");
  test.setTimeout(600_000);
  const t0 = Date.now();
  bookId = await createViaForm("A5_LANDSCAPE", "modern", TITLE);
  const created = await bookRow();
  expect({ format: created.format, design_style: created.design_style }).toEqual({ format: "A5_LANDSCAPE", design_style: "modern" });
  expect(created.max_pages).toBe(FREE_MAX);

  await uploadAndBuild(bookId, await makeSynthetic(page, 10, 1200, 900, "m10b"));
  console.log(`[a] create→editor ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const { doc, format, design_style, page_count } = await bookRow();
  expect(doc.version).toBe(2);
  expect(doc.format).toBe(format);
  expect(doc.style.designStyle).toBe(design_style);
  expect(doc.cover.layout).toMatch(/^m-l-cover-/);
  const foreign = doc.pages.map((p) => p.layout).filter((l) => !l.startsWith("m-l-"));
  expect(foreign).toEqual([]);
  expect(spreadProblems(doc)).toEqual([]);
  expect(page_count).toBe(doc.pages.length);
  const starts = spreadStarts(doc);
  console.log(
    `[a] pages=${doc.pages.length} cover=${doc.cover.layout} layouts=${JSON.stringify(doc.pages.map((p) => p.layout + (p.side ? `:${p.side[0]}` : "")))} spreads=${JSON.stringify(starts)} generator=${(doc.meta as { generator?: string } | undefined)?.generator} font=${doc.style.font}`,
  );
  // Replay Storyteller: ≤ 1 spread per moment of ≥ 8 photos, on a left page (10 photos, one moment).
  expect(starts.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("page-carousel")).toHaveAttribute("data-mode", "spread");
  await noHorizontalOverflow(page, DESKTOP.width);
  built = true;

  // Review captions preview (M10b Bug 1, captionsPreviewOf passes side): a spread's right half is
  // not captionable → "Captions (n)" counts only single pages with a caption area + captioned
  // spread left halves, and a fully AI-captioned spread book shows no "page has no caption yet".
  const captionable = doc.pages.filter((p) => hasCaptionArea(p.layout, p.side)).length;
  const withCaption = doc.pages.filter((p) => hasCaptionArea(p.layout, p.side) && p.caption).length;
  await page.goto(`/books/${bookId}/review`);
  const preview = page.getByTestId("captions-preview");
  await expect(preview).toBeVisible();
  await preview.locator("summary").click();
  const count = (await page.getByTestId("captions-count").textContent())?.trim();
  const missing = await page.getByTestId("captions-missing").count();
  console.log(`[a] review preview=${count} captionable=${captionable} withCaption=${withCaption} rightHalves=${doc.pages.filter((p) => p.side === "right").length} missingLine=${missing}`);
  expect(withCaption).toBe(captionable);
  expect(count).toBe(`Captions (${captionable})`);
  expect(missing).toBe(0);
  await expect(page.getByTestId("captions-item")).toHaveCount(captionable);
});

test("b. free limit with spreads: 19 pages → spread on page 19 makes 20; no page 21 (UI + server)", async () => {
  test.skip(!built, "needs test a");
  test.setTimeout(240_000);
  const before = await bookRow();
  const original = before.doc;
  expect(original.pages.length).toBeLessThan(19);
  const last = original.pages[original.pages.length - 1];
  const pad: DocPage[] = Array.from({ length: 19 - original.pages.length }, (_, k) => ({
    id: `pad${k + 1}`,
    chapterId: last.chapterId,
    layout: "m-l-one",
    slots: [{ photoId: null, crop: { x: 0.5, y: 0.5, zoom: 1 } }],
    caption: null,
  }));
  const padded: StoredDoc = { ...original, pages: [...original.pages, ...pad] };
  let rev = await writeDoc(padded, before.doc_rev);
  expect((await bookRow()).doc.pages.length).toBe(19);

  // Page 19 = index 18: a left page with no next page → spreads enabled (adds page 20).
  await openEditorAt(page, 19);
  await openLayoutTool(page);
  const spreadOpts = page.getByTestId("layout-spreads").getByTestId("layout-option");
  await expect(spreadOpts).toHaveCount(SPREADS.length);
  for (const o of await spreadOpts.all()) await expect(o).toBeEnabled();
  await page.locator(`[data-testid="layout-option"][data-layout-id="m-l-spread-grid"]`).click();
  await saved(page);
  const after = await bookRow();
  expect(after.doc.pages.length).toBe(FREE_MAX);
  expect(after.page_count).toBe(FREE_MAX);
  expect(after.doc.pages[18]).toMatchObject({ layout: "m-l-spread-grid", side: "left" });
  expect(after.doc.pages[19]).toMatchObject({ layout: "m-l-spread-grid", side: "right", slots: [], caption: null });
  expect(spreadProblems(after.doc)).toEqual([]);
  rev = after.doc_rev;

  // At 20 pages: Add page opens the Upgrade sheet, nothing is added.
  // M13: Add page sits behind More.
  await page.getByTestId("editor-more").click();
  await page.getByTestId("editor-tool-add-page").click();
  await expect(page.getByTestId("upgrade-sheet")).toBeVisible();
  await page.waitForTimeout(1_500);
  expect((await bookRow()).doc.pages.length).toBe(FREE_MAX);

  // Server: 21 pages where the spread counts 2 (18 singles + spread + 1 single) → 422 page_limit.
  const extra: DocPage = { ...pad[0], id: "pad-extra" };
  const r21 = await putDoc({ ...after.doc, pages: [...after.doc.pages, extra] }, rev);
  expect(r21.status).toBe(422);
  expect(r21.body).toContain("page_limit");
  expect((await bookRow()).doc_rev).toBe(rev);
  console.log(`[b] 19→20 via spread ok; addPage→upgrade sheet; PUT 21 → ${r21.status} ${r21.body}`);

  // Restore the pre-pad doc (service role, rev-guarded).
  await page.goto("about:blank");
  await writeDoc(original, rev);
  expect((await bookRow()).doc.pages.length).toBe(original.pages.length);
});

test("c. editor: panorama spread on a left page → v2 with sides; client format/style tampering ignored", async () => {
  test.skip(!built, "needs test a");
  test.setTimeout(240_000);
  const start = (await bookRow()).doc;
  // First left page (even idx) whose page and next page are singles; else the last page if even.
  const isSingle = (i: number) => !!start.pages[i] && !SPREADS.includes(start.pages[i].layout);
  panoIdx = start.pages.findIndex((_, i) => i % 2 === 0 && isSingle(i) && isSingle(i + 1));
  if (panoIdx < 0 && start.pages.length % 2 === 1) panoIdx = start.pages.length - 1;
  expect(panoIdx).toBeGreaterThanOrEqual(0);

  const saves: number[] = [];
  page.on("response", (r) => {
    if (/\/api\/books\/[^/]+\/doc$/.test(r.url()) && r.request().method() === "PUT") saves.push(r.status());
  });
  await openEditorAt(page, panoIdx + 1);
  await expect(cur(page).locator('[data-testid="spread-page"][data-side="left"]')).toHaveAttribute("data-active", "true");
  await openLayoutTool(page);
  // Picker offers only modern landscape layouts.
  const ids = await page.getByTestId("layout-option").evaluateAll((els) => els.map((e) => e.getAttribute("data-layout-id") ?? ""));
  expect(ids.filter((id) => !id.startsWith("m-l-"))).toEqual([]);
  const pano = page.locator(`[data-testid="layout-option"][data-layout-id="${PANORAMA}"]`);
  await expect(pano).toBeEnabled();
  await pano.click();
  if ((await page.getByTestId("layout-confirm").count()) > 0) await page.getByTestId("layout-confirm-apply").click();
  await expect(cur(page).getByTestId("editor-spread")).toHaveAttribute("data-spread-layout", "true");
  await saved(page);
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.every((s) => s === 200)).toBe(true);

  const row = await bookRow();
  expect(row.doc.version).toBe(2);
  expect(row.doc.pages[panoIdx]).toMatchObject({ layout: PANORAMA, side: "left" });
  expect(row.doc.pages[panoIdx].slots.length).toBe(1);
  expect(row.doc.pages[panoIdx].slots[0].photoId).not.toBeNull();
  expect(row.doc.pages[panoIdx + 1]).toMatchObject({ layout: PANORAMA, side: "right", slots: [], caption: null });
  expect(spreadProblems(row.doc)).toEqual([]);
  expect(row.doc.format).toBe(row.format);
  expect(row.doc.style.designStyle).toBe(row.design_style);
  await page.screenshot({ path: test.info().outputPath("editor-1024-panorama.png") });
  await page.goto("about:blank"); // no autosave races with the raw PUTs below

  // Tampering: claim portrait + classic in the save body → the stored doc keeps the columns.
  const tampered = { ...row.doc, format: "A5_PORTRAIT", style: { ...row.doc.style, designStyle: "classic" } };
  const t1 = await putDoc(tampered, row.doc_rev);
  const afterT1 = await bookRow();
  console.log(`[c] tamper format/style → ${t1.status} ${t1.body}; stored ${afterT1.doc.format}/${afterT1.doc.style.designStyle} rev ${row.doc_rev}→${afterT1.doc_rev}`);
  expect([200, 422]).toContain(t1.status);
  expect(t1.status).toBe(200); // documented contract: columns win, the save itself is fine
  expect(afterT1.doc.format).toBe("A5_LANDSCAPE");
  expect(afterT1.doc.style.designStyle).toBe("modern");
  expect(afterT1.format).toBe("A5_LANDSCAPE");
  expect(afterT1.design_style).toBe("modern");

  // Right half without `side` → misaligned → 422 invalid_doc, nothing stored.
  const broken = structuredClone(afterT1.doc);
  delete broken.pages[panoIdx + 1].side;
  const t2 = await putDoc(broken, afterT1.doc_rev);
  expect(t2.status).toBe(422);
  expect(t2.body).toContain("invalid_doc");
  const afterT2 = await bookRow();
  expect(afterT2.doc_rev).toBe(afterT1.doc_rev);
  expect(afterT2.doc.pages[panoIdx + 1].side).toBe("right");
  console.log(`[c] panorama at ${panoIdx}; misaligned PUT → ${t2.status} ${t2.body}`);

  // M10b A19 (review B1): the FIRST user caption in a modern book gets the style face (Cormorant /
  // Amiri, newCaptionFont) and must save 200 (was 422 invalid_font). Make sure a single page with a
  // caption area has no caption (service-role write), then type one in the editor.
  // Captionable = a single page with a caption area or the LEFT half of a captioned spread
  // (hasCaptionArea): after the panorama the replay album may have no captioned single left
  // (e.g. full-bleed + three → panorama, mosaic spread).
  const capIdx = afterT2.doc.pages.findIndex((p) => hasCaptionArea(p.layout, p.side));
  console.log(`[c] caption target layouts=${JSON.stringify(afterT2.doc.pages.map((p) => `${p.layout}${p.side ? `:${p.side[0]}` : ""}`))} capIdx=${capIdx}`);
  expect(capIdx).toBeGreaterThanOrEqual(0);
  const cleared = structuredClone(afterT2.doc);
  cleared.pages[capIdx].caption = null;
  await writeDoc(cleared, afterT2.doc_rev);
  saves.length = 0;
  await openEditorAt(page, capIdx + 1);
  const capPage = cur(page).locator(`[data-testid="spread-page"][data-page-idx="${capIdx}"]`);
  await capPage.getByTestId("caption-target").click();
  const input = page.getByTestId("caption-input");
  await expect(input).toBeVisible();
  await input.fill("Sunset over the dunes");
  await expect(capPage.getByTestId("page-caption")).toHaveText("Sunset over the dunes");
  await saved(page);
  await page.keyboard.press("Escape");
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.every((s) => s === 200)).toBe(true);
  const afterCap = await bookRow();
  expect(afterCap.doc.pages[capIdx].caption).toMatchObject({ text: "Sunset over the dunes", font: "Cormorant", source: "user" });
  console.log(`[c] first user caption on page ${capIdx} → saves ${saves.join(",")}`);
  await page.goto("about:blank");
});

async function viewSpread(browser: Browser, viewport: { width: number; height: number }, mobile: boolean, leftIdx: number) {
  const ctx = await browser.newContext({ viewport, baseURL, hasTouch: mobile, isMobile: mobile });
  try {
    const v = await ctx.newPage();
    const errors: string[] = [];
    v.on("pageerror", (e) => errors.push(e.message));
    const res = await v.goto(`/b/${slug}`);
    expect(res?.status()).toBe(200);
    const fb = v.getByTestId("flipbook");
    await expect(fb).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(fb).toHaveAttribute("data-spread", mobile ? "false" : "true");
    await noHorizontalOverflow(v, viewport.width);
    const L = `[data-flip-index="${leftIdx + 1}"]`;
    const R = `[data-flip-index="${leftIdx + 2}"]`;
    await flipTo(v, leftIdx + 1);
    await expect(v.locator(`${L} [data-spread-side="left"]`)).toHaveCount(1);
    const rect = (sel: string) => v.locator(sel).first().evaluate((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
    const l = await rect(L);
    expect(Math.abs(l.width / l.height - 210 / 148)).toBeLessThan(0.03);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.x + l.width).toBeLessThanOrEqual(viewport.width);
    if (mobile) {
      await v.screenshot({ path: test.info().outputPath(`viewer-${viewport.width}-left.png`) });
      await flipTo(v, leftIdx + 2);
    }
    await expect(v.locator(`${R} [data-spread-side="right"]`)).toHaveCount(1);
    const r = await rect(R);
    if (!mobile) {
      expect(Math.abs(r.x - (l.x + l.width))).toBeLessThan(1);
      expect(Math.abs(r.y - l.y)).toBeLessThan(1);
    }
    await expect.poll(() => v.locator(`${R} img`).evaluateAll((imgs) => imgs.some((i) => (i as HTMLImageElement).naturalWidth > 0)), { timeout: 20_000 }).toBe(true);
    await noHorizontalOverflow(v, viewport.width);
    await v.screenshot({ path: test.info().outputPath(`viewer-${viewport.width}${mobile ? "-right" : ""}.png`) });
    expect(errors).toEqual([]);
    return { leftW: Math.round(l.width), ratio: Math.round((l.width / l.height) * 1000) / 1000 };
  } finally {
    await ctx.close();
  }
}

test("d. publish → viewer at 375 and 1280: spread halves present, no horizontal overflow", async ({ browser }) => {
  test.skip(panoIdx < 0, "needs test c");
  test.setTimeout(240_000);
  await page.goto(`/books/${bookId}/publish`);
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
  const row = await bookRow();
  slug = row.slug ?? "";
  expect(slug).not.toBe("");
  expect(row.published_doc?.version).toBe(2);
  expect(row.published_doc?.format).toBe("A5_LANDSCAPE");
  expect(row.published_doc?.pages[panoIdx]).toMatchObject({ layout: PANORAMA, side: "left" });
  expect(row.published_doc?.pages[panoIdx + 1]).toMatchObject({ layout: PANORAMA, side: "right" });
  for (const [vp, mobile] of [
    [PHONE, true],
    [WIDE, false],
  ] as const) {
    const out = await viewSpread(browser, vp, mobile, panoIdx);
    console.log(`[d ${vp.width}] ${JSON.stringify(out)}`);
  }
});

test("e. signed checkout → paid → PDF of the spread book: landscape boxes, Type0 fonts, shared panorama image, no raster", async () => {
  test.skip(!slug, "needs test d");
  test.skip(!WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET (same as the server's) is required");
  test.setTimeout(420_000);
  const ev = buildEvent({ type: "completed", bookId, userId: uid, amount: 3900, currency: "aed" });
  eventIds.push(ev.id);
  expect(await postEvent({ baseURL, payload: ev.payload, secret: WEBHOOK_SECRET })).toBe(200);
  const row = await bookRow();
  expect(row.is_paid).toBe(true);

  await page.goto(`/books/${bookId}/publish`);
  await expect(page.getByTestId("publish-pdf")).toBeVisible({ timeout: 30_000 });
  const btn = page.getByTestId("pdf-download");
  await expect(btn).toBeEnabled();
  const t0 = Date.now();
  const download = page.waitForEvent("download", { timeout: 300_000 });
  await btn.click();
  const file = test.info().outputPath("m10b-landscape-spreads.pdf");
  await (await download).saveAs(file);
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const a = analyze(file);
  const ins = inspect(file);
  expect(ins.pageCount).toBe(row.doc.pages.length + 1);
  for (const p of ins.pages) {
    expect(Math.abs((p.mediaBox?.wPt ?? 0) - 612)).toBeLessThan(1.5);
    expect(Math.abs((p.mediaBox?.hPt ?? 0) - 437.04)).toBeLessThan(1.5);
    expect(Math.abs((p.trimBox?.wMm ?? 0) - 210)).toBeLessThan(0.6);
    expect(Math.abs((p.trimBox?.hMm ?? 0) - 148)).toBeLessThan(0.6);
  }
  const type3 = ins.fonts.filter((f) => f.type3 || f.subtype === "Type3");
  expect(type3).toEqual([]);
  const nonType0 = ins.fonts.filter((f) => f.subtype !== "Type0").map((f) => `${f.baseFont}:${f.subtype}`);
  expect(nonType0).toEqual([]);
  const modernFaces = ins.fonts.filter((f) => /GreatVibes|Great.?Vibes|Cormorant|Bebas/i.test(f.baseFont ?? ""));
  expect(modernFaces.length).toBeGreaterThan(0);
  // Cover title is live text (not rasterised).
  expect((ins.pages[0].text ?? "").replace(/\s+/g, " ")).toContain(TITLE);

  // Panorama halves: PDF sheets panoIdx+2 / panoIdx+3 (1-based; 1 = cover) share ONE DCT image XObject.
  const dctKeys = (p: AnalyzePage) => new Set(p.images.filter((i) => /DCT/.test(i.filter ?? "") && !/pattern|smask/.test(i.where)).map((i) => i.k));
  const lk = dctKeys(a.pages[panoIdx + 1]);
  const rk = dctKeys(a.pages[panoIdx + 2]);
  const shared = [...lk].filter((k) => rk.has(k));
  expect(shared.length).toBeGreaterThanOrEqual(1);
  // Other spreads (built by the album): report shared images too.
  const otherSpreads = spreadStarts(row.doc)
    .filter((i) => i !== panoIdx)
    .map((i) => ({ i, layout: row.doc.pages[i].layout, shared: [...dctKeys(a.pages[i + 1])].filter((k) => dctKeys(a.pages[i + 2]).has(k)).length, left: dctKeys(a.pages[i + 1]).size, right: dctKeys(a.pages[i + 2]).size }));
  for (const s of otherSpreads) expect(s.left + s.right).toBeGreaterThan(0);

  // No Chromium raster: every image of real size is DCT passthrough; no soft-masked photos.
  const all = a.pages.flatMap((p) => p.images);
  const flateBig = all.filter((i) => !/DCT/.test(i.filter ?? "") && i.w * i.h > 400 * 400).length;
  expect(flateBig).toBe(0);
  const smaskedDct = all.filter((i) => /DCT/.test(i.filter ?? "") && i.smask === "yes").length;
  console.log(
    `[e] pdf ${secs} s bytes=${bytes.length} pages=${ins.pageCount} media=${ins.pages[0].mediaBox?.wPt}x${ins.pages[0].mediaBox?.hPt} trim=${ins.pages[0].trimBox?.wMm}x${ins.pages[0].trimBox?.hMm}mm bleed=${ins.pages[0].bleedBox?.wMm}x${ins.pages[0].bleedBox?.hMm}mm fonts=${JSON.stringify(ins.fonts.map((f) => `${(f.baseFont ?? "").replace(/^[A-Z]{6}\+/, "")}:${f.subtype}`))} uniqueImages=${a.summary.uniqueImages} panoShared=${shared.length} otherSpreads=${JSON.stringify(otherSpreads)} flateBig=${flateBig} smaskedDct=${smaskedDct} dpi=${JSON.stringify(ins.dpi)}`,
  );
});

test("f. form Portrait + Classic → upload → build → stored v1; an editor layout change still saves v1", async () => {
  test.skip(!migrated, "migration 1900 not applied (books.format/design_style missing)");
  test.setTimeout(600_000);
  classicId = await createViaForm("A5_PORTRAIT", "classic", "Family Day");
  const created = await bookRow(classicId);
  expect({ format: created.format, design_style: created.design_style }).toEqual({ format: "A5_PORTRAIT", design_style: "classic" });
  await uploadAndBuild(classicId, await makeSynthetic(page, 3, 900, 1200, "m10b-classic"));

  const v2Keys = (d: StoredDoc) => {
    const raw = JSON.stringify(d);
    return ["designStyle", '"side"', '"kind"', '"background":{'].filter((k) => raw.includes(k));
  };
  const built1 = await bookRow(classicId);
  expect(built1.doc.version).toBe(1);
  expect(built1.doc.format).toBe("A5_PORTRAIT");
  expect(typeof built1.doc.style.background).toBe("string");
  expect(v2Keys(built1.doc)).toEqual([]);
  expect(built1.doc.pages.every((p) => !p.layout.startsWith("m-") && !p.layout.startsWith("c-l-"))).toBe(true);

  // Editor (page 1, no selection) → another classic layout that is enabled.
  await page.getByTestId("page-strip").getByRole("button", { name: "Page 1", exact: true }).click();
  await page.waitForTimeout(500);
  await openLayoutTool(page);
  const opts = page.locator('[data-testid="layout-option"][data-role="page"]:not([data-disabled]):not([aria-pressed="true"])');
  const optIds = await opts.evaluateAll((els) => els.map((e) => e.getAttribute("data-layout-id") ?? ""));
  expect(optIds.length).toBeGreaterThan(0);
  expect(optIds.filter((id) => id.startsWith("m-") || id.startsWith("c-l-"))).toEqual([]);
  await expect(page.getByTestId("layout-spreads")).toHaveCount(0); // classic has no spreads
  const target = optIds[0];
  await page.locator(`[data-testid="layout-option"][data-layout-id="${target}"]`).click();
  if ((await page.getByTestId("layout-confirm").count()) > 0) await page.getByTestId("layout-confirm-apply").click();
  await saved(page);
  const after = await bookRow(classicId);
  expect(after.doc_rev).toBeGreaterThan(built1.doc_rev);
  expect(after.doc.pages[0].layout).toBe(target);
  expect(after.doc.version).toBe(1);
  expect(v2Keys(after.doc)).toEqual([]);
  // Same top-level keys as the v1 doc the album build wrote (no v2-only key appears).
  expect(Object.keys(after.doc)).toEqual(Object.keys(built1.doc));
  console.log(`[f] classic pages=${after.doc.pages.length} layout p1 ${built1.doc.pages[0].layout}→${target} version=${after.doc.version} keys=${Object.keys(after.doc).join(",")}`);
});

function deletePhotoActionId(): string {
  const m = JSON.parse(readFileSync(path.join(REPO, ".next", "server", "server-reference-manifest.json"), "utf8")) as {
    node: Record<string, { exportedName?: string }>;
  };
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === "deletePhotoAction");
  if (!hit) throw new Error("deletePhotoAction not in the server-reference manifest (run next build in this copy)");
  return hit[0];
}

test("g. A19 S2: deleting a photo of a modern spread reflows the doc (no empty slot, spreads aligned); editor saves 200 afterwards", async () => {
  test.skip(!built || panoIdx < 0, "needs tests a + c");
  test.setTimeout(240_000);
  const start = await bookRow();
  const coverId = start.doc.cover.photoId;
  // A photo on a multi-photo spread (the mosaic after c), not the cover photo.
  const left = start.doc.pages.findIndex((p) => SPREADS.includes(p.layout) && p.side === "left" && p.slots.filter((s) => s.photoId).length >= 2);
  expect(left).toBeGreaterThanOrEqual(0);
  const victim = start.doc.pages[left].slots.map((s) => s.photoId).find((id): id is string => !!id && id !== coverId);
  expect(victim).toBeTruthy();
  const userCaps = start.doc.pages.flatMap((p) => ((p.caption as { source?: string } | null)?.source === "user" ? [JSON.stringify(p.caption)] : []));
  const photosBefore = start.doc.pages.reduce((n, p) => n + p.slots.filter((s) => s.photoId).length, 0);

  // The real server action, as in e2e/m10a g (no UI calls it yet): Next-Action from this build's manifest.
  const res = await page.request.post(`/books/${bookId}/upload`, {
    headers: { "Next-Action": deletePhotoActionId(), "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: baseURL },
    data: JSON.stringify([victim, bookId]),
  });
  const body = await res.text();
  expect(res.status()).toBe(200);
  expect(body).toContain('"ok":true');
  expect((await admin.from("photos").select("id").eq("id", victim!)).data?.length ?? -1).toBe(0);

  const after = await bookRow();
  const layouts = (d: StoredDoc) => d.pages.map((p) => `${p.layout}${p.side ? `:${p.side[0]}` : ""}`);
  const emptySlots = after.doc.pages.reduce((n, p) => n + p.slots.filter((s) => !s.photoId).length, 0);
  const photosAfter = after.doc.pages.reduce((n, p) => n + p.slots.filter((s) => s.photoId).length, 0);
  const userCapsAfter = after.doc.pages.flatMap((p) => ((p.caption as { source?: string } | null)?.source === "user" ? [JSON.stringify(p.caption)] : []));
  console.log(
    `[g] delete photo on spread at ${left}: layouts ${JSON.stringify(layouts(start.doc))} → ${JSON.stringify(layouts(after.doc))} photos ${photosBefore}→${photosAfter} emptySlots=${emptySlots} spreadProblems=${spreadProblems(after.doc).length} userCaptions ${userCaps.length}→${userCapsAfter.length} rev ${start.doc_rev}→${after.doc_rev} page_count=${after.page_count}`,
  );
  expect(JSON.stringify(after.doc)).not.toContain(victim!);
  expect(emptySlots).toBe(0); // reflowed, not nulled out (M10a fallback)
  expect(photosAfter).toBe(photosBefore - 1);
  expect(spreadProblems(after.doc)).toEqual([]);
  expect(after.page_count).toBe(after.doc.pages.length);
  expect(userCapsAfter.sort()).toEqual(userCaps.sort()); // the user caption from c survives
  expect(after.doc_rev).toBeGreaterThan(start.doc_rev);
  expect(after.doc.format).toBe("A5_LANDSCAPE");
  expect(after.doc.style.designStyle).toBe("modern");
  expect(after.doc.pages.every((p) => p.layout.startsWith("m-l-"))).toBe(true);

  // Later edits save: the editor opens and a layout change on page 1 autosaves 200.
  const saves: number[] = [];
  page.on("response", (r) => {
    if (/\/api\/books\/[^/]+\/doc$/.test(r.url()) && r.request().method() === "PUT") saves.push(r.status());
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openEditorAt(page, 1);
  await openLayoutTool(page);
  const opts = page.locator('[data-testid="layout-option"]:not([data-disabled]):not([aria-pressed="true"])');
  const optIds = await opts.evaluateAll((els) => els.map((e) => e.getAttribute("data-layout-id") ?? ""));
  expect(optIds.length).toBeGreaterThan(0);
  await page.locator(`[data-testid="layout-option"][data-layout-id="${optIds[0]}"]`).click();
  if ((await page.getByTestId("layout-confirm").count()) > 0) await page.getByTestId("layout-confirm-apply").click();
  await expect.poll(() => saves.length, { timeout: 20_000 }).toBeGreaterThan(0);
  const final = await bookRow();
  console.log(`[g] editor change p1 → ${optIds[0]}: saves ${saves.join(",")} rev ${after.doc_rev}→${final.doc_rev} spreadProblems=${spreadProblems(final.doc).length} errors=${errors.length}`);
  expect(saves.every((s) => s === 200)).toBe(true);
  expect(final.doc_rev).toBeGreaterThan(after.doc_rev);
  expect(spreadProblems(final.doc)).toEqual([]);
  expect(errors).toEqual([]);
  await page.goto("about:blank");
});
