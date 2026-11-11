/**
 * Milestone 8 — PDF export end to end against the LIVE hosted Supabase project (opt-in).
 * "Done when: a paid 40-page book downloads as a crisp PDF in < 60 s."
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic (server: AI_MODE=replay, no ANTHROPIC_API_KEY),
 * never calls Stripe: the book is made paid with a service-role update of is_paid / max_pages /
 * expires_at (the column guard lets service_role through), exactly the columns the webhook sets.
 *
 * The server must be a production build (`next start`) whose NEXT_PUBLIC_APP_URL is ITS OWN
 * origin (Chromium renders /print/[bookId] on renderOrigin()), with PDF_CHROME_PATH (local Chrome)
 * and BOOK_ACCESS_SECRET set.
 *
 * Creates throwaway users `e2e+m8-<random>@example.com` (admin createUser + generateLink, no
 * email): the owner builds a book in replay mode from 40 synthetic 2000×2667 JPEGs that carry GPS
 * EXIF, the doc is grown to 40 pages (mixed layouts, an Arabic caption in Cairo, a Playfair
 * caption), the book is made paid, and the owner taps "Download PDF" on the publish screen. The
 * PDF is saved and inspected with scripts/pdf-inspect.mjs (pdf-lib + pdfjs-dist).
 * A second user checks cross-user access. afterAll (always): storage objects under `<uid>/` in
 * the photos AND exports buckets, exports rows, books, users. Per-test timeouts (no
 * --global-timeout) so afterAll runs. Logs: counts / timings / statuses only.
 *
 * Preconditions detected in beforeAll (tests skip with a clear message instead of failing):
 *   - migration 20261113001400_exports (exports table → PGRST205 / create_export_job → PGRST202
 *     when missing): c, d, e, g skip; b (402) and f (print route 404s) still run.
 *
 * Env (test process): E2E_AUTH=1; optional PDF_OUT_DIR (where the PDF + PNG renders go; default
 * the test output dir); optional PDF_ALLOW_TYPE3=1 (accept vector-only Type3 fonts, see test d).
 *
 * Example:
 *   (scratch copy) NEXT_PUBLIC_APP_URL=http://localhost:3660 AI_MODE=replay ANTHROPIC_API_KEY= next build
 *   NEXT_PUBLIC_APP_URL=http://localhost:3660 AI_MODE=replay ANTHROPIC_API_KEY= next start -p 3660
 *   E2E_AUTH=1 npx playwright test -c <config with baseURL :3660, no webServer> e2e/pdf.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live PDF export flow");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const PHOTOS = "photos";
const EXPORTS = "exports";
const VIEWPORT = { width: 375, height: 812 };
const REPO = path.join(__dirname, "..");
const PAGES = 40;
const N_PHOTOS = 40;
const DONE_WHEN_MS = 60_000;
const ARABIC_CAPTION = "ذكريات جميلة في أبوظبي مع العائلة";
const PLAYFAIR_CAPTION = "Golden hour on the corniche";
/** Page indexes (0-based in doc.pages) → PDF page number = index + 2 (sheet 0 = cover). */
const ARABIC_PAGE_INDEX = 1;
const PLAYFAIR_PAGE_INDEX = 3;
/** Mixed layouts, photo count each; cycled over the 40 pages. */
const LAYOUT_CYCLE: { id: string; photos: number; caption: boolean }[] = [
  { id: "full-page", photos: 1, caption: false },
  { id: "one-portrait", photos: 1, caption: true },
  { id: "full-page", photos: 1, caption: false },
  { id: "two-vertical", photos: 2, caption: true },
  { id: "full-page", photos: 1, caption: false },
  { id: "one-portrait", photos: 1, caption: true },
  { id: "two-horizontal", photos: 2, caption: true },
  { id: "full-page", photos: 1, caption: false },
  { id: "three-mixed", photos: 3, caption: true },
  { id: "four-grid", photos: 4, caption: true },
];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

type User = { uid: string; email: string; context?: BrowserContext; page?: Page };

let admin: SupabaseClient;
let baseURL = "";
let owner: User = { uid: "", email: "" };
let other: User = { uid: "", email: "" };
let page: Page;
let bookId = "";
let exportsMigration: boolean | null = null;
let exportsProbe = "";
let firstExportId = "";
let pdfPath = "";
let outDir = "";

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

async function signInHash(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  return data.properties.hashed_token;
}

async function createSignedInUser(browser: Browser, tag: string): Promise<User> {
  const email = `e2e+m8${tag}-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  const u: User = { uid: data.user.id, email };
  u.context = await browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true, acceptDownloads: true });
  u.page = await u.context.newPage();
  u.page.on("dialog", (d) => void d.accept());
  await u.page.goto(`/auth/confirm?token_hash=${await signInHash(email)}&type=magiclink&next=/books/new`);
  await expect(u.page).toHaveURL(/\/books\/new$/);
  return u;
}

async function listAll(bucket: string, uid: string): Promise<string[]> {
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

async function removeAll(bucket: string, uid: string): Promise<number> {
  let removed = 0;
  for (let round = 0; round < 3; round++) {
    const paths = await listAll(bucket, uid);
    if (paths.length === 0) break;
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
      if (error) console.log(`[cleanup] ${bucket} remove error (${error.message})`);
    }
    removed += paths.length;
  }
  return removed;
}

/** Inserts an EXIF APP1 segment with GPS lat/lng right after SOI (same as publish-auth.spec). */
function withGpsExif(jpeg: Buffer, lat: number, lng: number): Buffer {
  const t = Buffer.alloc(128);
  t.write("II", 0, "latin1");
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8);
  t.writeUInt16LE(0x8825, 10);
  t.writeUInt16LE(4, 12);
  t.writeUInt32LE(1, 14);
  t.writeUInt32LE(26, 18);
  t.writeUInt32LE(0, 22);
  let o = 26;
  t.writeUInt16LE(4, o);
  o += 2;
  const ent = (tag: number, type: number, count: number, val: (p: number) => void) => {
    t.writeUInt16LE(tag, o);
    t.writeUInt16LE(type, o + 2);
    t.writeUInt32LE(count, o + 4);
    val(o + 8);
    o += 12;
  };
  ent(1, 2, 2, (p) => t.write("N\0", p, "latin1"));
  ent(2, 5, 3, (p) => t.writeUInt32LE(80, p));
  ent(3, 2, 2, (p) => t.write("E\0", p, "latin1"));
  ent(4, 5, 3, (p) => t.writeUInt32LE(104, p));
  t.writeUInt32LE(0, o);
  const dms = (v: number, at: number) => {
    const d = Math.floor(v);
    const mf = (v - d) * 60;
    const m = Math.floor(mf);
    const s = Math.round((mf - m) * 60 * 100);
    [
      [d, 1],
      [m, 1],
      [s, 100],
    ].forEach(([n, den], i) => {
      t.writeUInt32LE(n, at + i * 8);
      t.writeUInt32LE(den, at + i * 8 + 4);
    });
  };
  dms(lat, 80);
  dms(lng, 104);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]);
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16BE(0xffe1, 0);
  hdr.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), hdr, payload, jpeg.subarray(2)]);
}

/**
 * `count` distinct, sharp, large JPEGs (2000×2667 portrait; every 5th 2667×2000 landscape) drawn
 * in the browser: 40 px colour tiles + light noise (sharp edges → not blurry; distinct seeds → no
 * duplicates). Each gets GPS EXIF so the PDF can prove it was stripped.
 */
async function makeLarge(p: Page, start: number, count: number): Promise<FileSpec[]> {
  const list = await p.evaluate(
    async ({ start, count }) => {
      function rng(seed: number) {
        let s = seed >>> 0;
        return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      }
      async function draw(seed: number, landscape: boolean): Promise<string> {
        const r = rng(seed * 7919 + 17);
        const c = document.createElement("canvas");
        c.width = landscape ? 2667 : 2000;
        c.height = landscape ? 2000 : 2667;
        const g = c.getContext("2d")!;
        const T = 40;
        for (let y = 0; y < c.height; y += T) {
          for (let x = 0; x < c.width; x += T) {
            g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${20 + Math.floor(r() * 60)}%)`;
            g.fillRect(x, y, T, T);
          }
        }
        g.fillStyle = "#fff";
        g.font = "bold 160px sans-serif";
        g.fillText(String(seed), 120, 300);
        const img = g.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < img.data.length; i += 4) {
          const d = Math.floor((r() - 0.5) * 16);
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
            0.88,
          ),
        );
      }
      const out: string[] = [];
      for (let i = start; i < start + count; i++) out.push(await draw(i + 801, i % 5 === 4));
      return out;
    },
    { start, count },
  );
  return list.map((b64, i) => ({
    name: `pdf-${start + i + 1}.jpg`,
    mimeType: "image/jpeg",
    buffer: withGpsExif(Buffer.from(b64, "base64"), 24.4539 + (start + i) * 0.0001, 54.3773),
  }));
}

type BookRow = { doc: Record<string, unknown>; doc_rev: number; is_paid: boolean; max_pages: number; page_count: number };

async function bookRow(): Promise<BookRow> {
  const { data, error } = await admin.from("books").select("doc, doc_rev, is_paid, max_pages, page_count").eq("id", bookId).single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as BookRow;
}

async function api(p: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return p.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
    { method, url, body },
  );
}

async function putDoc(doc: unknown, baseRev: number) {
  return api(page, "PUT", `/api/books/${bookId}/doc`, { doc, baseRev });
}

type Caption = { text: string; font: string; align: "left" | "center" | "right"; source: "ai" | "user" | "auto" };

/** A valid 40-page doc on the built doc's cover/chapters/style: mixed layouts, unique photos. */
function fortyPages(base: Record<string, unknown>, photoIds: string[]): Record<string, unknown> {
  const doc = structuredClone(base) as {
    cover: { photoId: string | null; title: string };
    pages: { id: string; chapterId: string | null; layout: string; slots: unknown[]; caption: Caption | null }[];
  };
  const chapterId = doc.pages[0]?.chapterId ?? null;
  const pool = [...photoIds];
  const pages: typeof doc.pages = [];
  for (let i = 0; i < PAGES; i++) {
    const l = LAYOUT_CYCLE[i % LAYOUT_CYCLE.length];
    const slots = Array.from({ length: l.photos }, () => ({ photoId: pool.shift() ?? null, crop: { x: 0.5, y: 0.5, zoom: 1 } }));
    let caption: Caption | null = null;
    if (i === ARABIC_PAGE_INDEX) caption = { text: ARABIC_CAPTION, font: "Cairo", align: "center", source: "user" };
    else if (i === PLAYFAIR_PAGE_INDEX) caption = { text: PLAYFAIR_CAPTION, font: "Playfair", align: "center", source: "user" };
    else if (l.caption) caption = { text: `Page ${i + 1} of the trip`, font: "Inter", align: "left", source: "user" };
    pages.push({ id: `m8p${i}`, chapterId, layout: l.id, slots, caption });
  }
  doc.pages = pages;
  doc.cover.title = "PDF export test";
  return doc as unknown as Record<string, unknown>;
}

function inspect(file: string, render: number[]): InspectResult {
  const args = [path.join(REPO, "scripts", "pdf-inspect.mjs"), file];
  if (render.length) args.push("--render", render.join(","), "--out", outDir);
  const out = execFileSync(process.execPath, args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 }).toString();
  return JSON.parse(out) as InspectResult;
}

type Box = { pt: number[]; wMm: number; hMm: number } | null;
type InspectResult = {
  file: { bytes: number; mb: number };
  pageCount: number;
  metadata: Record<string, string | boolean | null>;
  fonts: { baseFont: string | null; family: string | null; subtype: string | null; subset: boolean; embedded: boolean; type3: boolean; type3Bitmap: boolean }[];
  imageStreams: { count: number; dct: number; withExif: number; withXmp: number; withGpsTag: number; filters: string[]; maxPx: number };
  dpi: { count: number; min: number | null; median: number | null; max: number | null };
  pages: { n: number; mediaBox: Box; trimBox: Box; bleedBox: Box; trimInsetMm: number[] | null; text: string; images: { px: number[]; placedMm: number[]; dpiMin: number }[] }[];
  rendered: string[];
};

/** Arabic letters only, presentation forms folded (NFKC), bidi marks / tatweel / spaces removed. */
function arabicLetters(s: string): string[] {
  return [...s.normalize("NFKC").replace(/[‌-‏‪-‮⁦-⁩ـ\s]/g, "")]
    .filter((ch) => /[؀-ۿ]/.test(ch))
    .sort();
}

function needExports() {
  test.skip(
    exportsMigration !== true,
    `migration 20261113001400_exports is NOT applied to the live project (probe ${exportsProbe}) — run \`npx supabase db push\`, then re-run`,
  );
}

async function waitReady(p: Page, exportId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const r = await api(p, "GET", `/api/books/${bookId}/pdf?exportId=${exportId}`);
    if (r.status !== 200) throw new Error(`poll status ${r.status}`);
    if (r.body.status === "ready" || r.body.status === "failed") return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error(`export still ${String(r.body.status)} after ${timeoutMs} ms`);
    await p.waitForTimeout(1_000);
  }
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  outDir = process.env.PDF_OUT_DIR ? path.resolve(process.env.PDF_OUT_DIR) : info.outputPath("pdf");
  mkdirSync(outDir, { recursive: true });
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const t = await admin.from("exports").select("id").limit(1);
  const rpc = await admin.rpc("create_export_job" as never, {
    p_book: null,
    p_user: null,
    p_doc_rev: null,
    p_doc: null,
    p_caption_lang: null,
    p_renderer_version: null,
    p_daily_cap: null,
    p_stale_seconds: null,
  } as never);
  // With 1400 + 1500 (8-arg signature): table readable, RPC raises 22023 on null args.
  // Without: PGRST205 / PGRST202.
  exportsMigration = !t.error && rpc.error?.code === "22023";
  exportsProbe = `table=${t.error?.code ?? "ok"} rpc=${rpc.error?.code ?? "ok"}`;
  console.log(`[setup] exportsMigration=${exportsMigration} (${exportsProbe})`);

  owner = await createSignedInUser(browser, "");
  page = owner.page!;
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  // Let an in-flight export finish first, or its upload lands after the cleanup (orphan PDF).
  if (exportsMigration && bookId) {
    for (let i = 0; i < 90; i++) {
      const { data } = await admin.from("exports").select("id").eq("book_id", bookId).in("status", ["queued", "rendering"]);
      if (!data || data.length === 0) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  for (const u of [owner, other]) {
    if (!u.uid) continue;
    await u.context?.close().catch(() => {});
    let exportRows = 0;
    if (exportsMigration) {
      const del = await admin.from("exports").delete().eq("user_id", u.uid).select("id");
      exportRows = del.data?.length ?? 0;
    }
    const removedExports = await removeAll(EXPORTS, u.uid);
    const removedPhotos = await removeAll(PHOTOS, u.uid);
    const { error } = await admin.auth.admin.deleteUser(u.uid);
    const leftE = await listAll(EXPORTS, u.uid);
    const leftP = await listAll(PHOTOS, u.uid);
    const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", u.uid);
    const exportsLeft = exportsMigration
      ? (await admin.from("exports").select("id", { count: "exact", head: true }).eq("user_id", u.uid)).count
      : 0;
    console.log(
      `[cleanup] exportRows=${exportRows} exportObjects=${removedExports} photoObjects=${removedPhotos} left=${leftE.length + leftP.length} books=${books.count} exportsLeft=${exportsLeft} userDeleted=${!error}`,
    );
    expect(error).toBeNull();
    expect(leftE.length + leftP.length).toBe(0);
    expect(books.count).toBe(0);
    expect(exportsLeft ?? 0).toBe(0);
  }
});

test("a. build (replay) from 40 large GPS-tagged photos", async () => {
  test.setTimeout(900_000);
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  // M10b A12: the form defaults to Modern; this M8 gate pads with classic portrait layouts
  // (Cairo + Playfair captions), so the book must be Classic (D-063: layouts must match the style).
  await page.getByRole("radio", { name: /Classic/ }).check();
  await expect(page.getByTestId("style-classic")).toBeChecked();
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  bookId = new URL(page.url()).pathname.split("/")[2];
  // On disk: Playwright refuses > 50 MB of in-memory buffers in setInputFiles.
  const photoDir = path.join(outDir, "photos");
  mkdirSync(photoDir, { recursive: true });
  const files: string[] = [];
  let bytes = 0;
  for (let s = 0; s < N_PHOTOS; s += 10) {
    for (const f of await makeLarge(page, s, 10)) {
      const fp = path.join(photoDir, f.name);
      writeFileSync(fp, f.buffer);
      files.push(fp);
      bytes += f.buffer.length;
    }
  }
  console.log(`[a] uploading ${files.length} photos, ${(bytes / 1048576).toFixed(1)} MB`);
  const t0 = Date.now();
  await page.getByTestId("upload-input").setInputFiles(files);
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 600_000 });
  console.log(`[a] upload ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 420_000 });
  const { data: photos, error } = await admin
    .from("photos")
    .select("id")
    .eq("book_id", bookId)
    .eq("upload_state", "ready");
  expect(error).toBeNull();
  console.log(`[a] ready photos=${photos?.length}`);
  expect(photos?.length).toBe(N_PHOTOS);
  const row = await bookRow();
  expect(Array.isArray((row.doc as { pages?: unknown[] }).pages)).toBe(true);
});

test("b. free book: POST /pdf → 402 not_paid; publish screen shows the upgrade, no PDF button", async () => {
  test.skip(!bookId, "needs test a");
  const r = await api(page, "POST", `/api/books/${bookId}/pdf`);
  console.log(`[b] free POST status=${r.status} error=${String(r.body.error ?? "-")}`);
  expect(r.status).toBe(402);
  expect(r.body).toMatchObject({ error: "not_paid" });
  await page.goto(`/books/${bookId}/publish`);
  await expect(page.getByTestId("publish-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("publish-free-notice")).toBeVisible();
  await expect(page.getByTestId("publish-upgrade")).toBeVisible();
  await expect(page.getByTestId("publish-pdf")).toHaveCount(0);
  await expect(page.getByTestId("pdf-download")).toHaveCount(0);
  // Free books cannot hold 40 pages (page_limit) — the 40-page doc is saved after test c's upgrade.
  const row = await bookRow();
  const { data: photos } = await admin.from("photos").select("id").eq("book_id", bookId).eq("upload_state", "ready");
  const big = await putDoc(fortyPages(row.doc, (photos ?? []).map((p) => p.id as string)), row.doc_rev);
  expect(big.status).toBe(422);
  expect(big.body).toMatchObject({ error: "page_limit" });
});

test("c. paid 40-page book: Download PDF on the publish screen → 'Preparing your PDF…' → file in < 60 s", async () => {
  test.skip(!bookId, "needs test a");
  test.setTimeout(300_000);
  // Paid entitlement exactly as the webhook writes it (service role passes the column guard).
  const up = await admin.from("books").update({ is_paid: true, max_pages: 100, expires_at: null }).eq("id", bookId).select("is_paid");
  expect(up.error).toBeNull();
  const row = await bookRow();
  expect(row.is_paid).toBe(true);
  const { data: photos } = await admin.from("photos").select("id").eq("book_id", bookId).eq("upload_state", "ready").order("created_at");
  const ids = (photos ?? []).map((p) => p.id as string);
  const coverPhoto = (row.doc as { cover?: { photoId?: string | null } }).cover?.photoId ?? null;
  const pool = [...ids.filter((id) => id !== coverPhoto), ...(coverPhoto ? [coverPhoto] : [])];
  const saved = await putDoc(fortyPages(row.doc, pool), row.doc_rev);
  console.log(`[c] 40-page save status=${saved.status} code=${String(saved.body.error ?? "-")}`);
  expect(saved.status).toBe(200);
  const after = await bookRow();
  expect(after.page_count).toBe(PAGES);

  needExports();
  await page.goto(`/books/${bookId}/publish`);
  const btn = page.getByTestId("pdf-download");
  await expect(btn).toBeVisible({ timeout: 30_000 });
  await expect(btn).toHaveText("Download PDF");
  await expect(page.getByTestId("publish-free-notice")).toHaveCount(0);

  const download = page.waitForEvent("download", { timeout: 120_000 });
  const t0 = Date.now();
  await btn.click();
  await expect(page.getByTestId("pdf-status-text")).toContainText("Preparing your PDF", { timeout: 10_000 });
  const d = await download;
  const ms = Date.now() - t0;
  pdfPath = path.join(outDir, "book-40.pdf");
  await d.saveAs(pdfPath);
  await expect(page.getByTestId("pdf-status-text")).toHaveText("Your PDF is ready", { timeout: 15_000 });
  await expect(page.getByTestId("pdf-download-again")).toBeVisible();

  const { data: rows } = await admin
    .from("exports")
    .select("id, status, bytes, page_count, attempt, created_at, finished_at, error_code")
    .eq("book_id", bookId);
  const ready = (rows ?? []).filter((r) => r.status === "ready");
  expect(ready).toHaveLength(1);
  firstExportId = ready[0].id as string;
  const serverMs = Date.parse(ready[0].finished_at as string) - Date.parse(ready[0].created_at as string);
  console.log(
    `[c] click→download ${(ms / 1000).toFixed(1)} s; server queued→ready ${(serverMs / 1000).toFixed(1)} s; attempt=${ready[0].attempt}; bytes=${ready[0].bytes}; pages=${ready[0].page_count}; suggested=${d.suggestedFilename()}`,
  );
  expect(d.suggestedFilename()).toMatch(/\.pdf$/);
  expect(ready[0].page_count).toBe(PAGES + 1);
  expect(ms).toBeLessThan(DONE_WHEN_MS);
});

test("d. inspect the PDF: 41 pages, bleed boxes, embedded fonts (Cairo + Playfair, no Type3), Arabic text, ≥ 200 dpi, < 50 MB, no watermark, no EXIF/GPS", async () => {
  needExports();
  test.skip(!pdfPath, "needs test c");
  test.setTimeout(240_000);
  const arabicPdfPage = ARABIC_PAGE_INDEX + 2;
  const r = inspect(pdfPath, [1, arabicPdfPage, PLAYFAIR_PAGE_INDEX + 2]);
  const families = [...new Set(r.fonts.map((f) => f.family))];
  console.log(
    `[d] pages=${r.pageCount} size=${r.file.mb} MB dpi min=${r.dpi.min} median=${r.dpi.median} max=${r.dpi.max} (n=${r.dpi.count}) streams=${r.imageStreams.count} dct=${r.imageStreams.dct} exif=${r.imageStreams.withExif} xmp=${r.imageStreams.withXmp} gps=${r.imageStreams.withGpsTag} maxPx=${r.imageStreams.maxPx}`,
  );
  console.log(`[d] fonts=${JSON.stringify(r.fonts.map((f) => `${f.baseFont}:${f.subtype}:${f.embedded ? "emb" : "NOT-emb"}`))}`);
  console.log(`[d] metadata=${JSON.stringify(r.metadata)}`);
  console.log(`[d] page1 media=${JSON.stringify(r.pages[0].mediaBox)} trim=${JSON.stringify(r.pages[0].trimBox)} inset=${JSON.stringify(r.pages[0].trimInsetMm)}`);
  console.log(`[d] rendered=${JSON.stringify(r.rendered)}`);

  expect(r.pageCount).toBe(PAGES + 1);
  for (const p of r.pages) {
    expect(p.mediaBox, `page ${p.n} MediaBox`).not.toBeNull();
    expect(Math.abs(p.mediaBox!.wMm - 154), `page ${p.n} width`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(p.mediaBox!.hMm - 216), `page ${p.n} height`).toBeLessThanOrEqual(0.5);
    expect(p.trimBox, `page ${p.n} TrimBox`).not.toBeNull();
    expect(Math.abs(p.trimBox!.wMm - 148)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(p.trimBox!.hMm - 210)).toBeLessThanOrEqual(0.5);
    for (const inset of p.trimInsetMm ?? []) expect(Math.abs(inset - 3), `page ${p.n} trim inset`).toBeLessThanOrEqual(0.2);
    expect(p.bleedBox, `page ${p.n} BleedBox`).not.toBeNull();
  }
  // Fonts: all embedded, no Type3, Arabic (Cairo/Tajawal) and Playfair present.
  expect(r.fonts.length).toBeGreaterThan(0);
  // Chromium/Skia writes variable fonts (next/font Google fonts) as Type3 with vector glyphs.
  // Type3 is a print-preflight problem → fails by default; PDF_ALLOW_TYPE3=1 accepts vector-only
  // Type3 (to check everything else). Bitmap Type3 glyphs always fail (not crisp).
  const allowType3 = process.env.PDF_ALLOW_TYPE3 === "1";
  for (const f of r.fonts) {
    expect(f.embedded, `font ${f.baseFont} embedded`).toBe(true);
    expect(f.type3Bitmap, `font ${f.baseFont} has bitmap Type3 glyphs`).toBe(false);
    if (!allowType3) expect(f.type3, `font ${f.baseFont} is Type3 (set PDF_ALLOW_TYPE3=1 to accept vector Type3)`).toBe(false);
  }
  expect(families.some((f) => /cairo|tajawal/i.test(f ?? ""))).toBe(true);
  expect(families.some((f) => /playfair/i.test(f ?? ""))).toBe(true);
  // Arabic caption survives as text (letters, order-insensitive: extraction is visual order).
  const arText = r.pages[arabicPdfPage - 1].text;
  expect(arabicLetters(arText).join("")).toBe(arabicLetters(ARABIC_CAPTION).join(""));
  // Each word must be present as text — in logical order, or reversed (visual-order extraction:
  // Skia's Type3 fonts map glyph by glyph, so copy/paste yields reversed Arabic; logged).
  const norm = arText.normalize("NFKC");
  let reversedWords = 0;
  for (const word of ARABIC_CAPTION.normalize("NFKC").split(" ")) {
    const rev = [...word].reverse().join("");
    if (!norm.includes(word)) reversedWords++;
    expect(norm.includes(word) || norm.includes(rev), `Arabic word present`).toBe(true);
  }
  console.log(`[d] arabic words=${ARABIC_CAPTION.split(" ").length} extractedReversed=${reversedWords}`);
  expect(r.pages[PLAYFAIR_PAGE_INDEX + 1].text).toContain(PLAYFAIR_CAPTION);
  // Crisp: every placed image ≥ 200 dpi.
  expect(r.dpi.count).toBeGreaterThanOrEqual(N_PHOTOS);
  const low = r.pages.flatMap((p) => p.images.filter((im) => im.dpiMin < 200).map((im) => ({ page: p.n, ...im })));
  if (low.length) console.log(`[d] low-dpi images=${JSON.stringify(low)}`);
  expect(low).toHaveLength(0);
  // Size, watermark, metadata, EXIF/GPS.
  expect(r.file.bytes).toBeLessThan(50 * 1024 * 1024);
  const all = r.pages.map((p) => p.text).join("\n").toLowerCase();
  expect(all).not.toContain("watermark");
  expect(all).not.toContain("made with");
  expect(r.metadata.author ?? "").toBe("");
  expect(String(r.metadata.creator ?? "")).not.toMatch(/chrome|mozilla|skia/i);
  expect(String(r.metadata.producer ?? "")).not.toMatch(/chrome|mozilla|skia/i);
  expect(r.imageStreams.withExif).toBe(0);
  expect(r.imageStreams.withXmp).toBe(0);
  expect(r.imageStreams.withGpsTag).toBe(0);
});

test("e. POST again without edits → 200 ready, same exportId; UI re-download is immediate; after an edit → new job, old PDF removed", async () => {
  needExports();
  test.skip(!firstExportId, "needs test c");
  test.setTimeout(240_000);
  const again = await api(page, "POST", `/api/books/${bookId}/pdf`);
  console.log(`[e] reuse POST status=${again.status} status=${String(again.body.status)} same=${again.body.exportId === firstExportId}`);
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ status: "ready", exportId: firstExportId, pageCount: PAGES + 1 });
  expect(String(again.body.url)).toMatch(/^https:\/\//);

  // UI: fresh load → Download PDF → download straight away (reuse).
  await page.goto(`/books/${bookId}/publish`);
  const download = page.waitForEvent("download", { timeout: 30_000 });
  const t0 = Date.now();
  await page.getByTestId("pdf-download").click();
  await download;
  console.log(`[e] reuse click→download ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  expect(Date.now() - t0).toBeLessThan(10_000);

  // Edit (Playfair caption text) → new job.
  const row = await bookRow();
  const doc = structuredClone(row.doc) as { pages: { caption: Caption | null }[] };
  doc.pages[PLAYFAIR_PAGE_INDEX].caption!.text = `${PLAYFAIR_CAPTION}, again`;
  const saved = await putDoc(doc, row.doc_rev);
  expect(saved.status).toBe(200);
  const next = await api(page, "POST", `/api/books/${bookId}/pdf`);
  console.log(`[e] after-edit POST status=${next.status} status=${String(next.body.status)} new=${next.body.exportId !== firstExportId}`);
  expect(next.status).toBe(202);
  expect(["queued", "rendering"]).toContain(next.body.status);
  expect(next.body.exportId).not.toBe(firstExportId);
  // Joining the running job: a second POST returns the same in-flight export.
  const join = await api(page, "POST", `/api/books/${bookId}/pdf`);
  expect(join.status).toBe(202);
  expect(join.body.exportId).toBe(next.body.exportId);

  const t1 = Date.now();
  const done = await waitReady(page, String(next.body.exportId), 120_000);
  console.log(`[e] second render ${((Date.now() - t1) / 1000).toFixed(1)} s status=${String(done.status)}`);
  expect(done.status).toBe("ready");
  // D-051: only the latest PDF of the book is kept.
  const objs = await listAll(EXPORTS, owner.uid);
  const { data: rows } = await admin.from("exports").select("id, status").eq("book_id", bookId);
  console.log(`[e] export objects=${objs.length} rows=${rows?.length} ready=${rows?.filter((x) => x.status === "ready").length}`);
  expect(objs).toHaveLength(1);
  expect(objs[0]).toContain(String(next.body.exportId));
  expect((rows ?? []).filter((x) => x.status === "ready")).toHaveLength(1);
});

test("f. /print/{bookId}: no token → 404, garbage token → 404, noindex + no-store; robots.txt disallows /print/", async ({ request }) => {
  test.skip(!bookId, "needs test a");
  for (const url of [`/print/${bookId}`, `/print/${bookId}?token=garbage`, `/print/${bookId}?token=v1.${"A".repeat(43)}.${"B".repeat(43)}`]) {
    const res = await request.get(url, { maxRedirects: 0 });
    const h = res.headers();
    console.log(`[f] status=${res.status()} robots=${h["x-robots-tag"] ?? "-"} cache=${h["cache-control"] ?? "-"} referrer=${h["referrer-policy"] ?? "-"}`);
    expect(res.status()).toBe(404);
    expect(h["x-robots-tag"] ?? "").toContain("noindex");
    expect(h["cache-control"] ?? "").toContain("no-store");
    const html = await res.text();
    expect(html).not.toContain(PLAYFAIR_CAPTION);
  }
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toMatch(/Disallow:\s*\/print\//);
});

test("g. other users: anon → 401; another signed-in user → 404 on GET ?exportId= and POST", async ({ browser, playwright }) => {
  needExports();
  test.skip(!firstExportId, "needs test c");
  const anon = await playwright.request.newContext({ baseURL });
  try {
    const r = await anon.get(`/api/books/${bookId}/pdf?exportId=${firstExportId}`);
    expect(r.status()).toBe(401);
    const p = await anon.post(`/api/books/${bookId}/pdf`, { headers: { origin: baseURL } });
    expect(p.status()).toBe(401);
  } finally {
    await anon.dispose();
  }
  other = await createSignedInUser(browser, "x");
  const { data } = await admin.from("exports").select("id").eq("book_id", bookId).eq("status", "ready");
  const latest = String(data?.[0]?.id ?? firstExportId);
  const g = await api(other.page!, "GET", `/api/books/${bookId}/pdf?exportId=${latest}`);
  const p = await api(other.page!, "POST", `/api/books/${bookId}/pdf`);
  console.log(`[g] other user GET=${g.status} POST=${p.status}`);
  expect(g.status).toBe(404);
  expect(p.status).toBe(404);
  expect(JSON.stringify(g.body)).not.toContain("http");
});
