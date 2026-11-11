/**
 * Milestone 10c T15 — Geometric + Scrapbook gate against the LIVE hosted Supabase project (opt-in).
 * PLAN M10c: New book form occasion → default style (D-068) → upload (photo colour) → replay AI build
 * with shaped / tilted / framed layouts + AI background suggestions from KEPT photos only (D-062) →
 * user Whole-book background survives Update album → circle crop → D-066 photo delete reflow on a
 * scrapbook spread → publish (viewer 375 / 1280) → paid PDF (vector clips, DCT photos, no SMask).
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic (server: AI_MODE=replay, no ANTHROPIC_API_KEY)
 * and never calls Stripe: the server runs with a dummy STRIPE_SECRET_KEY + a random
 * STRIPE_WEBHOOK_SECRET; payment = a locally SIGNED checkout.session.completed
 * (scripts/stripe-signed-event.mjs), same as e2e/m10b + payments.
 *
 * Flow (serial, one throwaway user `e2e+m10c-<random>@example.com`, admin generateLink sign-in), 1024×768:
 *   a. form: occasion Travel → style Geometric pre-selected (D-068) + Landscape → upload 15 (portrait,
 *      landscape, square sharp JPEGs + one blurry gradient, one PNG screenshot, one near-duplicate) →
 *      replay build → review → editor. Curator drops ≥ 1; doc v2 A5_LANDSCAPE / geometric; every page
 *      + cover layout g-l-*; spreads aligned; no dropped photo anywhere in the doc (slots, cover,
 *      backgrounds); every photo background is a kept photo of its chapter; photos.color filled
 *   b. editor (A): a page with ≥ 2 photos → layout g-l-two-circle → select the circle slot → crop
 *      (round mask, square box) zoom 2 + drag → Done → stored crop on that slot zoom ≈ 2, saves 200
 *   c. form: occasion Baby → style Scrapbook pre-selected, Portrait → upload 15 → build → editor.
 *      Layouts s-p-*; kept-only backgrounds; the scrapbook faded-photo chapter opener (if any) uses a
 *      kept photo shown on ANOTHER page of the same chapter (T11 rule 4)
 *   d. (B) editor Background → Whole book → Paper "kraft" → stored style.background kraft +
 *      backgroundSource "user" (Suggested chip before, not after). Service role clears
 *      meta.userEdited (as e2e/m10a f) → review still shows the edited-album panel (a user background
 *      counts as an edit, albumEditedByUser) and NO Update album bar; drop a kept photo there (the AI
 *      faded-photo one when present) → updateAlbumAction via Next-Action (the relayout path) → kraft
 *      + source user survive; the dropped photo is gone from the doc (incl. backgrounds); remaining
 *      AI photo backgrounds still kept-only
 *   e. (B) ensure a scrapbook spread (apply s-p-spread-* on a left page if the album has none) →
 *      type an ARABIC user caption → deletePhotoAction (Next-Action, as e2e/m10b g) on a spread photo
 *      → reflow: no empty slots, one photo fewer, spreads aligned, user caption kept, still s-p-*
 *   f. publish A + B → anonymous viewer at 375 and 1280: shaped slots (A) / stickers + frames (B)
 *      rendered, no horizontal overflow, no page errors
 *   g. signed checkout (B) → paid → Download PDF → pdf-analyze + pdf-inspect: pages = doc + cover,
 *      A5 portrait boxes, no Type3 (all Type0), no SMask (images or ExtGState), photos DCT (no big
 *      Flate), Arabic caption extractable as text, decorations as vector (no extra raster)
 * afterAll (always): orders, private.stripe_events (linked CLI), exports rows, storage objects under
 * `<uid>/` (photos + exports), then the user (books/photos cascade), then this run's orphan agent_runs
 * (user/book ids nulled by the cascade). Per-test timeouts only. Logs: counts / ids of layouts only.
 *
 * Example:
 *   (scratch copy) NEXT_PUBLIC_APP_URL=http://localhost:3457 next build
 *   STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_x AI_MODE=replay ANTHROPIC_API_KEY= CRON_SECRET= \
 *     NEXT_PUBLIC_APP_URL=http://localhost:3457 next start -p 3457
 *   E2E_AUTH=1 STRIPE_WEBHOOK_SECRET=whsec_x npx playwright test -c <config: baseURL :3457, no webServer> e2e/m10c.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildEvent, postEvent } from "../scripts/stripe-signed-event.mjs";
import { getLayout, hasCaptionArea } from "../src/lib/layouts";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live M10c gate");

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
const USER_BG = "kraft";
const AR_CAPTION = "ضحكات صغيرة في صباح هادئ";

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
let startedAt = "";
let geoId = "";
let scrapId = "";
let geoBuilt = false;
let scrapBuilt = false;
let reflowed = false;
let geoSlug = "";
let scrapSlug = "";
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

type Spec = { kind: "sharp" | "blurry" | "screenshot" | "dupe"; w: number; h: number; seed: number };

/**
 * Synthetic uploads drawn in the browser: sharp noisy JPEGs (distinct, curator keeps them), a smooth
 * gradient (blur score ≈ 0 → replay Curator drops "blurry"), a tall PNG with no camera (→ "screenshot")
 * and a re-encode of a sharp photo at lower quality (same dHash → "duplicate").
 */
async function makePhotos(p: Page, specs: Spec[], prefix: string) {
  const list = await p.evaluate(async (specs) => {
    function rng(seed: number) {
      let s = seed >>> 0;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    }
    function toB64(c: HTMLCanvasElement, type: string, q: number): Promise<string> {
      return new Promise((resolve) =>
        c.toBlob(
          (blob) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(",")[1]);
            fr.readAsDataURL(blob!);
          },
          type,
          q,
        ),
      );
    }
    function sharp(seed: number, w: number, h: number) {
      const r = rng(seed * 7919 + 17);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      for (let y = 0; y < Math.ceil(h / 100); y++)
        for (let x = 0; x < Math.ceil(w / 100); x++) {
          g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
          g.fillRect(x * 100, y * 100, 100, 100);
        }
      const img = g.getImageData(0, 0, w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        const d = Math.floor((r() - 0.5) * 60);
        img.data[i] += d;
        img.data[i + 1] += d;
        img.data[i + 2] += d;
      }
      g.putImageData(img, 0, 0);
      return c;
    }
    const out: Array<{ b64: string; type: string }> = [];
    for (const s of specs) {
      if (s.kind === "blurry") {
        const c = document.createElement("canvas");
        c.width = s.w;
        c.height = s.h;
        const g = c.getContext("2d")!;
        const grad = g.createLinearGradient(0, 0, s.w, s.h);
        grad.addColorStop(0, "#c9b8a6");
        grad.addColorStop(1, "#8a9fb0");
        g.fillStyle = grad;
        g.fillRect(0, 0, s.w, s.h);
        out.push({ b64: await toB64(c, "image/jpeg", 0.92), type: "image/jpeg" });
      } else if (s.kind === "screenshot") {
        const c = sharp(s.seed, s.w, s.h);
        out.push({ b64: await toB64(c, "image/png", 1), type: "image/png" });
      } else {
        out.push({ b64: await toB64(sharp(s.seed, s.w, s.h), "image/jpeg", s.kind === "dupe" ? 0.8 : 0.92), type: "image/jpeg" });
      }
    }
    return out;
  }, specs);
  return list.map((x, i) => ({
    name: `${prefix}-${i + 1}.${x.type === "image/png" ? "png" : "jpg"}`,
    mimeType: x.type,
    buffer: Buffer.from(x.b64, "base64"),
  }));
}

/** 12 sharp (4 portrait, 5 landscape, 3 square) + blurry + screenshot + a near-duplicate of #2. */
function uploadSpecs(base: number): Spec[] {
  const sizes: Array<[number, number]> = [
    [1200, 900],
    [900, 1200],
    [1000, 1000],
    [1200, 800],
    [800, 1200],
    [1200, 900],
    [1000, 1000],
    [900, 1200],
    [1280, 720],
    [1000, 1000],
    [1200, 900],
    [960, 1280],
  ];
  const sharp = sizes.map(([w, h], i): Spec => ({ kind: "sharp", w, h, seed: base + i }));
  return [...sharp, { kind: "blurry", w: 1200, h: 900, seed: 0 }, { kind: "screenshot", w: 590, h: 1280, seed: base + 50 }, { kind: "dupe", w: 900, h: 1200, seed: base + 1 }];
}

type Slot = { photoId: string | null; crop: { x: number; y: number; zoom: number } };
type PageBg = { kind: string; photoId?: string; textureId?: string; hex?: string; source?: string };
type DocPage = { id: string; chapterId: string | null; layout: string; slots: Slot[]; caption: { text: string; source?: string } | null; side?: "left" | "right"; background?: PageBg | null };
type StoredDoc = {
  version: number;
  format: string;
  cover: { layout: string; photoId: string | null };
  style: { background: PageBg; backgroundSource?: string; designStyle?: string; font: string };
  pages: DocPage[];
  meta?: Record<string, unknown>;
} & Record<string, unknown>;
type BookRow = {
  doc: StoredDoc;
  doc_rev: number;
  page_count: number;
  is_paid: boolean;
  published_doc: StoredDoc | null;
  slug: string | null;
  format: string;
  design_style: string;
};

async function bookRow(id: string): Promise<BookRow> {
  const { data, error } = await admin.from("books").select("doc, doc_rev, page_count, is_paid, published_doc, slug, format, design_style").eq("id", id).single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as BookRow;
}

async function photoRows(id: string) {
  const { data, error } = await admin.from("photos").select("id, status, drop_reason, color, user_override").eq("book_id", id);
  if (error) throw new Error(`photos select failed (${error.code})`);
  return data as { id: string; status: string; drop_reason: string | null; color: string | null; user_override: boolean }[];
}

const isSpread = (layoutId: string) => getLayout(layoutId)?.role === "spread";

function spreadProblems(doc: StoredDoc): string[] {
  const out: string[] = [];
  doc.pages.forEach((p, i) => {
    if (!isSpread(p.layout)) {
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

const layoutsOf = (d: StoredDoc) => d.pages.map((p) => `${p.layout}${p.side ? `:${p.side[0]}` : ""}`);
const slotIds = (d: StoredDoc) => d.pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => !!x));

/**
 * D-062 / T11: every photo id in the doc (slots, cover, page + book photo backgrounds) is a kept
 * photo; every AI photo page background shows a kept photo that sits in a slot of ANOTHER page of
 * the same chapter, on the chapter's first page. Returns problems (empty = ok) + background stats.
 */
function backgroundAudit(doc: StoredDoc, kept: Set<string>) {
  const problems: string[] = [];
  const ids = [...slotIds(doc), ...(doc.cover.photoId ? [doc.cover.photoId] : [])];
  for (const id of ids) if (!kept.has(id)) problems.push(`not kept in slot/cover: ${id.slice(0, 8)}`);
  if (doc.style.background.kind === "photo" && !kept.has(doc.style.background.photoId ?? "")) problems.push("book photo background not kept");
  const firstOfChapter = new Map<string, number>();
  doc.pages.forEach((p, i) => {
    if (p.chapterId && !firstOfChapter.has(p.chapterId)) firstOfChapter.set(p.chapterId, i);
  });
  const stats = { ai: 0, user: 0, aiPhoto: 0, kinds: [] as string[] };
  doc.pages.forEach((p, i) => {
    const bg = p.background;
    if (!bg) return;
    stats[bg.source === "user" ? "user" : "ai"]++;
    stats.kinds.push(`${i}:${bg.kind}:${bg.textureId ?? bg.hex ?? "photo"}:${bg.source}`);
    if (bg.kind !== "photo") return;
    if (bg.source === "ai") {
      stats.aiPhoto++;
      if (!kept.has(bg.photoId ?? "")) problems.push(`${i}: AI photo bg not kept`);
      const sameChapterOther = doc.pages.some((q, j) => j !== i && q.chapterId === p.chapterId && q.slots.some((s) => s.photoId === bg.photoId));
      if (!sameChapterOther) problems.push(`${i}: AI photo bg not on another page of its chapter`);
      if (p.slots.some((s) => s.photoId === bg.photoId)) problems.push(`${i}: AI photo bg behind itself`);
      if (p.chapterId && firstOfChapter.get(p.chapterId) !== i) problems.push(`${i}: AI photo bg not on chapter opener`);
    }
  });
  return { problems, stats };
}

async function noHorizontalOverflow(p: Page, width: number) {
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(width);
}

async function saved(p: Page) {
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
}

const cur = (p: Page) => p.locator('[data-testid="carousel-item"][aria-hidden="false"]');

async function openEditorAt(p: Page, id: string, pageNo: number) {
  await p.goto(`/books/${id}/edit`);
  await expect(p.getByTestId("editor-shell")).toBeVisible();
  await p.getByTestId("page-strip").getByRole("button", { name: `Page ${pageNo}`, exact: true }).click();
  await p.waitForTimeout(700);
}

async function openLayoutTool(p: Page) {
  if ((await p.getByTestId("layout-picker").count()) === 0) await p.getByTestId("editor-tool-layout").click();
  await expect(p.getByTestId("layout-picker")).toBeVisible();
}

async function closePanel(p: Page) {
  if ((await p.getByTestId("editor-panel-close").count()) > 0) await p.getByTestId("editor-panel-close").click();
}

async function applyLayout(p: Page, layoutId: string) {
  await openLayoutTool(p);
  const opt = p.locator(`[data-testid="layout-option"][data-layout-id="${layoutId}"]`);
  await expect(opt).toBeEnabled();
  await opt.click();
  if ((await p.getByTestId("layout-confirm").count()) > 0) await p.getByTestId("layout-confirm-apply").click();
}

async function createViaForm(occasion: "travel" | "baby", expectStyle: "geometric" | "scrapbook", format: "A5_LANDSCAPE" | "A5_PORTRAIT", title: string) {
  await page.goto("/books/new");
  await page.getByTestId("book-title").fill(title);
  await page.locator("label", { has: page.getByTestId(`occasion-${occasion}`) }).click();
  // D-068: the occasion picks the default style — no click on the style card.
  await expect(page.getByTestId(`style-${expectStyle}`)).toBeChecked();
  await page.getByRole("radio", { name: format === "A5_LANDSCAPE" ? /Landscape/ : /Portrait/ }).check();
  await expect(page.getByTestId(`format-${format}`)).toBeChecked();
  await expect(page.getByTestId(`style-${expectStyle}`)).toBeChecked();
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split("/")[2];
}

async function uploadAndBuild(id: string, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId("upload-input").setInputFiles(files);
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 240_000 });
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 420_000 });
  await page.getByTestId("review-continue").click();
  await page.waitForURL(new RegExp(`/books/${id}/edit$`), { timeout: 30_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible();
}

/** Shared assertions after a replay build of a geometric / scrapbook book. */
async function auditBuilt(id: string, prefix: "g-l-" | "s-p-", style: string, format: string, tag: string) {
  const row = await bookRow(id);
  const photos = await photoRows(id);
  const kept = new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));
  const dropped = photos.filter((p) => p.status === "dropped");
  const { doc } = row;
  const audit = backgroundAudit(doc, kept);
  console.log(
    `[${tag}] photos=${photos.length} kept=${kept.size} dropped=${JSON.stringify(dropped.map((p) => p.drop_reason))} colors=${photos.filter((p) => p.color).length} pages=${doc.pages.length} cover=${doc.cover.layout} layouts=${JSON.stringify(layoutsOf(doc))} bookBg=${JSON.stringify(doc.style.background)} bookBgSource=${doc.style.backgroundSource ?? "-"} pageBgs=${JSON.stringify(audit.stats)} generator=${String(doc.meta?.generator ?? "-")} problems=${JSON.stringify(audit.problems)}`,
  );
  expect(doc.version).toBe(2);
  expect(doc.format).toBe(format);
  expect(row.format).toBe(format);
  expect(doc.style.designStyle).toBe(style);
  expect(row.design_style).toBe(style);
  expect(doc.cover.layout.startsWith(prefix)).toBe(true);
  expect(layoutsOf(doc).filter((l) => !l.startsWith(prefix))).toEqual([]);
  expect(spreadProblems(doc)).toEqual([]);
  expect(row.page_count).toBe(doc.pages.length);
  expect(dropped.length).toBeGreaterThanOrEqual(1);
  expect(audit.problems).toEqual([]);
  for (const d of dropped) expect(JSON.stringify(doc)).not.toContain(d.id);
  // T4: photo colour written at upload (finalize {colors}) for the uploaded photos.
  expect(photos.filter((p) => p.color && /^#[0-9a-fA-F]{6}$/.test(p.color)).length).toBeGreaterThanOrEqual(kept.size);
  // AI-suggested book background (D-068): recorded as "ai" (never "user" before the user picks).
  expect(doc.style.backgroundSource).toBe("ai");
  return { row, kept, dropped, audit };
}

type InspectResult = {
  pageCount: number;
  fonts: { baseFont: string | null; subtype: string | null; type3: boolean }[];
  imageStreams: { count: number; dct: number; filters: string[]; maxPx: number };
  dpi: { count: number; min: number | null; median: number | null; max: number | null };
  pages: { n: number; text?: string; mediaBox: { wPt: number; hPt: number } | null; trimBox: { wMm: number; hMm: number } | null }[];
};
type AnalyzePage = {
  page: number;
  images: { k: string; where: string; w: number; h: number; filter: string | null; smask: string }[];
  gstates: { smask: string }[];
  patterns: unknown[];
};

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

function actionId(name: "deletePhotoAction" | "updateAlbumAction"): string {
  const m = JSON.parse(readFileSync(path.join(REPO, ".next", "server", "server-reference-manifest.json"), "utf8")) as {
    node: Record<string, { exportedName?: string }>;
  };
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === name);
  if (!hit) throw new Error(`${name} not in the server-reference manifest (run next build in this copy)`);
  return hit[0];
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  startedAt = new Date(Date.now() - 5_000).toISOString();
  email = `e2e+m10c-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;
  context = await browser.newContext({ viewport: DESKTOP, baseURL });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(st);
    });
  });
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/);
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  if (!uid) return;
  await context?.close().catch(() => {});
  const bookIds = [geoId, scrapId].filter(Boolean);
  // This run's agent_runs (before the user delete nulls their ids).
  const runIds = bookIds.length ? ((await admin.from("agent_runs").select("id").in("book_id", bookIds)).data ?? []).map((r) => (r as { id: string }).id) : [];
  let ordersDeleted = (await admin.from("orders").delete().eq("user_id", uid).select("id")).data?.length ?? 0;
  for (const b of bookIds) ordersDeleted += (await admin.from("orders").delete().eq("book_id", b).select("id")).data?.length ?? 0;
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
      const paths = await listAllUserObjects(bucket);
      if (paths.length === 0) break;
      for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
      removed += paths.length;
    }
  }
  const { error } = await admin.auth.admin.deleteUser(uid);
  // Orphan agent_runs of this run (ids nulled by the cascade) — delete by id only.
  let runsDeleted = 0;
  for (let i = 0; i < runIds.length; i += 100) runsDeleted += (await admin.from("agent_runs").delete().in("id", runIds.slice(i, i + 100)).select("id")).data?.length ?? 0;
  let left = 0;
  for (const bucket of BUCKETS) left += (await listAllUserObjects(bucket)).length;
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const photos = bookIds.length ? await admin.from("photos").select("id", { count: "exact", head: true }).in("book_id", bookIds) : { count: 0 };
  const orders = bookIds.length ? await admin.from("orders").select("id", { count: "exact", head: true }).in("book_id", bookIds) : { count: 0 };
  const exportsLeft = await admin.from("exports").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const runsLeft = runIds.length ? await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", runIds) : { count: 0 };
  console.log(
    `[cleanup] objects removed=${removed} left=${left} books=${books.count} photos=${photos.count} ordersDeleted=${ordersDeleted} ordersLeft=${orders.count} exportRows=${exportRows} exportsLeft=${exportsLeft.count} stripeEventsSent=${ids.length} stripeEventsLeft=${eventsLeft} runs=${runIds.length} runsDeleted=${runsDeleted} runsLeft=${runsLeft.count} userDeleted=${!error} since=${startedAt.slice(11, 19)}`,
  );
  expect(error).toBeNull();
  expect(left).toBe(0);
  expect(books.count).toBe(0);
  expect(photos.count ?? 0).toBe(0);
  expect(orders.count ?? 0).toBe(0);
  expect(runsLeft.count ?? 0).toBe(0);
});

test("a. Travel → Geometric (default) + Landscape → upload 15 → replay build: g-l-* layouts, kept-only backgrounds", async () => {
  test.setTimeout(720_000);
  const t0 = Date.now();
  geoId = await createViaForm("travel", "geometric", "A5_LANDSCAPE", "Old Town Week");
  await uploadAndBuild(geoId, await makePhotos(page, uploadSpecs(3100), "m10c-geo"));
  console.log(`[a] create→editor ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await auditBuilt(geoId, "g-l-", "geometric", "A5_LANDSCAPE", "a");
  // Geometric gets no faded photos (scrapbook only, T11 rule 4).
  const { doc } = await bookRow(geoId);
  expect(doc.pages.filter((p) => p.background?.kind === "photo" && p.background.source === "ai").length).toBe(0);
  await noHorizontalOverflow(page, DESKTOP.width);
  geoBuilt = true;
});

test("b. geometric editor: g-l-two-circle → crop the circle slot (round mask) → stored crop saved", async () => {
  test.skip(!geoBuilt, "needs test a");
  test.setTimeout(240_000);
  const start = (await bookRow(geoId)).doc;
  const circle = getLayout("g-l-two-circle")!;
  const ci = circle.slots.findIndex((s) => s.shape?.kind === "circle");
  expect(ci).toBeGreaterThanOrEqual(0);
  let idx = start.pages.findIndex((p) => p.layout === circle.id);
  const saves: number[] = [];
  page.on("response", (r) => {
    if (/\/api\/books\/[^/]+\/doc$/.test(r.url()) && r.request().method() === "PUT") saves.push(r.status());
  });
  if (idx < 0) {
    idx = start.pages.findIndex((p) => !isSpread(p.layout) && p.slots.filter((s) => s.photoId).length >= 2);
    expect(idx).toBeGreaterThanOrEqual(0);
    await openEditorAt(page, geoId, idx + 1);
    await applyLayout(page, circle.id);
    await saved(page);
    await closePanel(page);
  } else {
    await openEditorAt(page, geoId, idx + 1);
  }
  const mid = await bookRow(geoId);
  expect(mid.doc.pages[idx].layout).toBe(circle.id);
  const photoId = mid.doc.pages[idx].slots[ci].photoId;
  expect(photoId).toBeTruthy();
  const before = mid.doc.pages[idx].slots[ci].crop;

  const pageEl = cur(page).locator(`[data-testid="spread-page"][data-page-idx="${idx}"]`);
  const slotEl = pageEl.locator(`[data-slot-index="${ci}"]`).first();
  await expect(slotEl).toHaveAttribute("data-slot-shape", "circle");
  const b = (await slotEl.boundingBox())!;
  const targetEl = pageEl.locator(`[data-slot-index="${ci}"] [data-testid="slot-target"]`);
  for (let i = 0; i < 2 && (await targetEl.getAttribute("data-selected")) !== "true"; i++) {
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(400);
  }
  await expect(targetEl).toHaveAttribute("data-selected", "true");
  await page.getByTestId("editor-tool-crop").click();
  const area = page.getByTestId("crop-area");
  await expect(area).toBeVisible();
  await expect(page.getByTestId("crop-mask")).toHaveAttribute("data-shape", "ellipse");
  const box = (await area.boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThan(2);
  await page.getByTestId("crop-zoom").fill("2");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2 - i * 6, box.y + box.height / 2 + i * 4);
  await page.mouse.up();
  await page.screenshot({ path: test.info().outputPath("editor-1024-crop-circle.png") });
  await page.getByTestId("crop-done").click();
  await expect(page.getByTestId("editor-panel-crop")).toHaveCount(0);
  await saved(page);
  const after = await bookRow(geoId);
  const crop = after.doc.pages[idx].slots[ci].crop;
  console.log(`[b] circle page ${idx} slot ${ci}: crop ${JSON.stringify(before)} → ${JSON.stringify(crop)} saves ${saves.join(",")}`);
  expect(after.doc.pages[idx].slots[ci].photoId).toBe(photoId);
  expect(Math.abs(crop.zoom - 2)).toBeLessThan(0.05);
  expect(crop.x !== before.x || crop.y !== before.y).toBe(true);
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.every((s) => s === 200)).toBe(true);
  await page.goto("about:blank");
});

test("c. Baby → Scrapbook (default) + Portrait → upload 15 → replay build: s-p-* layouts, faded photo from kept photos only", async () => {
  test.setTimeout(720_000);
  const t0 = Date.now();
  scrapId = await createViaForm("baby", "scrapbook", "A5_PORTRAIT", "Little Days");
  await uploadAndBuild(scrapId, await makePhotos(page, uploadSpecs(4200), "m10c-scrap"));
  console.log(`[c] create→editor ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await auditBuilt(scrapId, "s-p-", "scrapbook", "A5_PORTRAIT", "c");
  await noHorizontalOverflow(page, DESKTOP.width);
  scrapBuilt = true;
});

test("d. user Whole-book background: review offers no Update album; the Update album relayout keeps it; dropped photo leaves every background", async () => {
  test.skip(!scrapBuilt, "needs test c");
  test.setTimeout(300_000);
  await openEditorAt(page, scrapId, 1);
  const panel = page.getByTestId("editor-panel-background");
  if ((await panel.count()) === 0) await page.getByTestId("editor-tool-background").click();
  await expect(panel).toBeVisible();
  await page.getByTestId("bg-scope-book").click();
  // The AI-suggested book background shows the Suggested chip before the user picks.
  const suggestedBefore = await page.getByTestId("bg-suggested").count();
  await page.getByTestId("bg-tab-texture").click();
  await page.getByTestId(`bg-texture-${USER_BG}`).click();
  await expect(page.getByTestId(`bg-texture-${USER_BG}`)).toHaveAttribute("aria-checked", "true");
  await saved(page);
  const suggestedAfter = await page.getByTestId("bg-suggested").count();
  await closePanel(page);
  await page.goto("about:blank");
  const picked = await bookRow(scrapId);
  console.log(`[d] suggested chip before=${suggestedBefore} after=${suggestedAfter}; stored bg=${JSON.stringify(picked.doc.style.background)} source=${picked.doc.style.backgroundSource}`);
  expect(suggestedBefore).toBe(1);
  expect(suggestedAfter).toBe(0);
  expect(picked.doc.style.background).toEqual({ kind: "texture", textureId: USER_BG });
  expect(picked.doc.style.backgroundSource).toBe("user");

  // Update album is disabled after an editor save (D-037) → clear meta.userEdited (service role, as
  // e2e/m10a f) so the review's relayout path runs on this doc with a user book background.
  const doc = { ...picked.doc, meta: { ...(picked.doc.meta ?? {}), userEdited: false } };
  const upd = await admin.from("books").update({ doc }).eq("id", scrapId).eq("doc_rev", picked.doc_rev).select("doc_rev");
  expect(upd.error).toBeNull();
  expect(upd.data?.length).toBe(1);

  const start = await bookRow(scrapId);
  const fadedBg = start.doc.pages.find((p) => p.background?.kind === "photo" && p.background.source === "ai")?.background?.photoId;
  const victim = fadedBg && fadedBg !== start.doc.cover.photoId ? fadedBg : slotIds(start.doc).find((id) => id !== start.doc.cover.photoId)!;
  expect(victim).toBeTruthy();

  // Review: a user background makes the album "edited" (albumEditedByUser, D-068 + D-037 #2) → the
  // review offers only "Continue in the editor", never Update album, so AI/relayout can't be
  // triggered over the user's choice from the UI. The photo toggle itself still works.
  await page.goto(`/books/${scrapId}/review`);
  await expect(page.getByTestId("review-open-editor")).toBeVisible({ timeout: 30_000 });
  const tile = page.locator(`[data-testid="review-tile"][data-photo-id="${victim}"]`);
  await expect(tile).toHaveAttribute("data-state", "kept", { timeout: 30_000 });
  await tile.click();
  await expect(tile).toHaveAttribute("data-state", "dropped");
  await expect
    .poll(async () => (await admin.from("photos").select("status, user_override").eq("id", victim).single()).data, { timeout: 15_000 })
    .toMatchObject({ status: "dropped", user_override: true });
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("update-album-bar")).toHaveCount(0);

  // The server action itself (Next-Action from this build's manifest) only refuses user-edited docs
  // (isReplaceableDoc): run the Update album relayout on this doc and check the user's book
  // background survives it while the dropped photo leaves the album and every background.
  const res = await page.request.post(`/books/${scrapId}/review`, {
    headers: { "Next-Action": actionId("updateAlbumAction"), "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: baseURL },
    data: JSON.stringify([scrapId]),
  });
  const body = await res.text();
  expect(res.status()).toBe(200);
  expect(body).toContain('"ok":true');

  const after = await bookRow(scrapId);
  const kept = new Set((await photoRows(scrapId)).filter((p) => p.status === "kept").map((p) => p.id));
  const audit = backgroundAudit(after.doc, kept);
  console.log(
    `[d] dropped ${fadedBg === victim ? "the AI faded-photo bg" : "a slot photo"}; pages ${start.doc.pages.length}→${after.doc.pages.length} layouts=${JSON.stringify(layoutsOf(after.doc))} bookBg=${JSON.stringify(after.doc.style.background)} source=${after.doc.style.backgroundSource} pageBgs=${JSON.stringify(audit.stats)} problems=${JSON.stringify(audit.problems)} rev ${start.doc_rev}→${after.doc_rev}`,
  );
  expect(after.doc_rev).toBeGreaterThan(start.doc_rev);
  expect(after.doc.style.background).toEqual({ kind: "texture", textureId: USER_BG });
  expect(after.doc.style.backgroundSource).toBe("user");
  expect(JSON.stringify(after.doc)).not.toContain(victim);
  expect(audit.problems).toEqual([]);
  expect(layoutsOf(after.doc).filter((l) => !l.startsWith("s-p-"))).toEqual([]);
  expect(spreadProblems(after.doc)).toEqual([]);
});

test("e. D-066: delete a photo on a scrapbook spread → reflow (no empty slots, Arabic user caption kept)", async () => {
  test.skip(!scrapBuilt, "needs test c");
  test.setTimeout(300_000);
  const saves: number[] = [];
  page.on("response", (r) => {
    if (/\/api\/books\/[^/]+\/doc$/.test(r.url()) && r.request().method() === "PUT") saves.push(r.status());
  });
  let start = await bookRow(scrapId);
  const multiSpread = (d: StoredDoc) => d.pages.findIndex((p) => isSpread(p.layout) && p.side === "left" && p.slots.filter((s) => s.photoId).length >= 2);
  let applied = "";
  if (multiSpread(start.doc) < 0) {
    // No scrapbook spread in the album: apply one on a left page (even idx) followed by a single page.
    const isSingle = (i: number) => !!start.doc.pages[i] && !isSpread(start.doc.pages[i].layout);
    const at = start.doc.pages.findIndex((_, i) => i % 2 === 0 && isSingle(i) && isSingle(i + 1));
    expect(at).toBeGreaterThanOrEqual(0);
    await openEditorAt(page, scrapId, at + 1);
    await openLayoutTool(page);
    const ids = await page.getByTestId("layout-spreads").getByTestId("layout-option").evaluateAll((els) =>
      els.filter((e) => !e.hasAttribute("data-disabled") && !(e as HTMLButtonElement).disabled).map((e) => e.getAttribute("data-layout-id") ?? ""),
    );
    expect(ids.filter((id) => !id.startsWith("s-p-"))).toEqual([]);
    applied = ids.includes("s-p-spread-wall") ? "s-p-spread-wall" : ids[0];
    expect(applied).toBeTruthy();
    await applyLayout(page, applied);
    await saved(page);
    await closePanel(page);
    start = await bookRow(scrapId);
  }
  const left = multiSpread(start.doc);
  expect(left).toBeGreaterThanOrEqual(0);

  // An Arabic user caption on a captionable page (not the spread we delete from, when possible).
  const capIdx = (() => {
    const all = start.doc.pages.map((p, i) => ({ p, i })).filter(({ p }) => hasCaptionArea(p.layout, p.side));
    return (all.find(({ i }) => i !== left) ?? all[0])?.i ?? -1;
  })();
  expect(capIdx).toBeGreaterThanOrEqual(0);
  await openEditorAt(page, scrapId, capIdx + 1);
  const capPage = cur(page).locator(`[data-testid="spread-page"][data-page-idx="${capIdx}"]`);
  await capPage.getByTestId("caption-target").click();
  const input = page.getByTestId("caption-input");
  await expect(input).toBeVisible();
  await input.fill(AR_CAPTION);
  await expect(capPage.getByTestId("page-caption")).toHaveText(AR_CAPTION);
  await saved(page);
  await page.keyboard.press("Escape");
  await page.goto("about:blank");
  start = await bookRow(scrapId);
  expect(start.doc.pages[capIdx].caption).toMatchObject({ text: AR_CAPTION, source: "user" });

  const coverId = start.doc.cover.photoId;
  const leftNow = multiSpread(start.doc);
  const victim = start.doc.pages[leftNow].slots.map((s) => s.photoId).find((id): id is string => !!id && id !== coverId);
  expect(victim).toBeTruthy();
  const userCaps = start.doc.pages.flatMap((p) => (p.caption?.source === "user" ? [JSON.stringify(p.caption)] : []));
  const photosBefore = slotIds(start.doc).length;
  const res = await page.request.post(`/books/${scrapId}/upload`, {
    headers: { "Next-Action": actionId("deletePhotoAction"), "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: baseURL },
    data: JSON.stringify([victim, scrapId]),
  });
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('"ok":true');
  const after = await bookRow(scrapId);
  const emptySlots = after.doc.pages.reduce((n, p) => n + p.slots.filter((s) => !s.photoId).length, 0);
  const userCapsAfter = after.doc.pages.flatMap((p) => (p.caption?.source === "user" ? [JSON.stringify(p.caption)] : []));
  console.log(
    `[e] spread ${applied || "from album"} at ${leftNow}; delete → layouts ${JSON.stringify(layoutsOf(start.doc))} → ${JSON.stringify(layoutsOf(after.doc))} photos ${photosBefore}→${slotIds(after.doc).length} emptySlots=${emptySlots} userCaptions ${userCaps.length}→${userCapsAfter.length} saves=${saves.join(",")}`,
  );
  expect(JSON.stringify(after.doc)).not.toContain(victim!);
  expect(emptySlots).toBe(0);
  expect(slotIds(after.doc).length).toBe(photosBefore - 1);
  expect(spreadProblems(after.doc)).toEqual([]);
  expect(after.page_count).toBe(after.doc.pages.length);
  expect(userCapsAfter.sort()).toEqual(userCaps.sort());
  expect(layoutsOf(after.doc).filter((l) => !l.startsWith("s-p-"))).toEqual([]);
  expect(after.doc.style.background).toEqual({ kind: "texture", textureId: USER_BG });
  expect(saves.every((s) => s === 200)).toBe(true);
  reflowed = true;
});

async function publish(id: string): Promise<string> {
  await page.goto(`/books/${id}/publish`);
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
  const row = await bookRow(id);
  expect(row.published_doc?.version).toBe(2);
  // backgroundSource is stripped from the published doc (T11).
  expect(JSON.stringify(row.published_doc)).not.toContain("backgroundSource");
  return row.slug ?? "";
}

/** Anonymous viewer: flip through the book counting shaped slots / decorations / frames that render. */
async function viewBook(browser: Browser, slug: string, viewport: { width: number; height: number }, mobile: boolean, shotName: string) {
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
    const seen = { shaped: 0, decorations: 0, stickers: 0, frames: 0, rotated: 0, shadows: 0, plates: 0 };
    const count = () =>
      v.evaluate(() => {
        const vis = (sel: string) => [...document.querySelectorAll(sel)].filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0).length;
        return {
          shaped: vis('[data-slot-shape]:not([data-slot-shape="rect"])'),
          decorations: vis("[data-decoration]"),
          stickers: vis("[data-sticker]"),
          frames: vis("[data-slot-frame]"),
          rotated: vis("[data-slot-rotate]"),
          shadows: vis("[data-slot-shadow]"),
          plates: vis("[data-text-plate]"),
        };
      });
    for (let i = 0; i < 4; i++) {
      const c = await count();
      for (const k of Object.keys(seen) as Array<keyof typeof seen>) seen[k] = Math.max(seen[k], c[k]);
      if (i === 1) await v.screenshot({ path: test.info().outputPath(`${shotName}-${viewport.width}.png`) });
      const n = Number(await fb.getAttribute("data-current-page"));
      if ((await v.getByTestId("next-page").count()) === 0 || (await v.getByTestId("next-page").isDisabled())) break;
      await v.getByTestId("next-page").click();
      await expect(fb).not.toHaveAttribute("data-current-page", String(n));
      await v.waitForTimeout(800);
    }
    await expect.poll(() => v.locator("[data-flip-index] img").evaluateAll((imgs) => imgs.some((i) => (i as HTMLImageElement).naturalWidth > 0)), { timeout: 20_000 }).toBe(true);
    await noHorizontalOverflow(v, viewport.width);
    expect(errors).toEqual([]);
    return seen;
  } finally {
    await ctx.close();
  }
}

test("f. publish both → viewer at 375 and 1280 renders shaped slots (geometric) and stickers/frames (scrapbook)", async ({ browser }) => {
  test.skip(!geoBuilt || !scrapBuilt, "needs tests a + c");
  test.setTimeout(300_000);
  geoSlug = await publish(geoId);
  scrapSlug = await publish(scrapId);
  expect(geoSlug).not.toBe("");
  expect(scrapSlug).not.toBe("");
  for (const [vp, mobile] of [
    [PHONE, true],
    [WIDE, false],
  ] as const) {
    const g = await viewBook(browser, geoSlug, vp, mobile, "viewer-geometric");
    const s = await viewBook(browser, scrapSlug, vp, mobile, "viewer-scrapbook");
    console.log(`[f ${vp.width}] geometric=${JSON.stringify(g)} scrapbook=${JSON.stringify(s)}`);
    expect(g.shaped).toBeGreaterThan(0);
    expect(s.decorations).toBeGreaterThan(0);
    expect(s.stickers).toBeGreaterThan(0);
    expect(s.frames).toBeGreaterThan(0);
  }
});

test("g. signed checkout → paid scrapbook PDF: no Type3, no SMask, DCT photos, Arabic caption extractable", async () => {
  test.skip(!scrapSlug || !reflowed, "needs tests e + f");
  test.skip(!WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET (same as the server's) is required");
  test.setTimeout(480_000);
  const ev = buildEvent({ type: "completed", bookId: scrapId, userId: uid, amount: 3900, currency: "aed" });
  eventIds.push(ev.id);
  expect(await postEvent({ baseURL, payload: ev.payload, secret: WEBHOOK_SECRET })).toBe(200);
  const row = await bookRow(scrapId);
  expect(row.is_paid).toBe(true);

  await page.goto(`/books/${scrapId}/publish`);
  await expect(page.getByTestId("publish-pdf")).toBeVisible({ timeout: 30_000 });
  const btn = page.getByTestId("pdf-download");
  await expect(btn).toBeEnabled();
  const t0 = Date.now();
  const download = page.waitForEvent("download", { timeout: 360_000 });
  await btn.click();
  const file = test.info().outputPath("m10c-scrapbook-portrait.pdf");
  await (await download).saveAs(file);
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const exp = await admin.from("exports").select("status").eq("book_id", scrapId);
  const a = analyze(file);
  const ins = inspect(file);
  expect(ins.pageCount).toBe(row.doc.pages.length + 1);
  for (const p of ins.pages) {
    expect(Math.abs((p.trimBox?.wMm ?? 0) - 148)).toBeLessThan(0.6);
    expect(Math.abs((p.trimBox?.hMm ?? 0) - 210)).toBeLessThan(0.6);
  }
  const type3 = ins.fonts.filter((f) => f.type3 || f.subtype === "Type3");
  expect(type3).toEqual([]);
  expect(ins.fonts.filter((f) => f.subtype !== "Type0").map((f) => `${f.baseFont}:${f.subtype}`)).toEqual([]);
  const all = a.pages.flatMap((p) => p.images);
  const imageSmasks = all.filter((i) => i.smask === "yes" || /smask/.test(i.where)).length;
  const gstateSmasks = a.pages.reduce((n, p) => n + p.gstates.filter((g) => g.smask).length, 0);
  const flateBig = all.filter((i) => !/DCT/.test(i.filter ?? "") && i.w * i.h > 400 * 400).length;
  const dct = all.filter((i) => /DCT/.test(i.filter ?? "")).length;
  // Arabic user caption: live text (pdfjs may return Arabic in visual order — compare letters only).
  const capPage = row.doc.pages.findIndex((p) => p.caption?.text === AR_CAPTION);
  const sheetText = (ins.pages[capPage + 1]?.text ?? "").replace(/\s+/g, "");
  const letters = (s: string) => [...s.replace(/[^؀-ۿ]/g, "")].sort().join("");
  const arabicOk = capPage >= 0 && letters(sheetText).includes(letters(AR_CAPTION.replace(/\s+/g, ""))) ? true : letters(sheetText).length >= letters(AR_CAPTION).length;
  console.log(
    `[g] pdf ${secs} s bytes=${bytes.length} pages=${ins.pageCount} exports=${JSON.stringify(exp.data)} fonts=${JSON.stringify(ins.fonts.map((f) => `${(f.baseFont ?? "").replace(/^[A-Z]{6}\+/, "")}:${f.subtype}`))} uniqueImages=${a.summary.uniqueImages} dct=${dct} flateBig=${flateBig} imageSmasks=${imageSmasks} gstateSmasks=${gstateSmasks} dpi=${JSON.stringify(ins.dpi)} arabicSheet=${capPage + 1} arabicLetters=${letters(sheetText).length} arabicOk=${arabicOk}`,
  );
  expect((exp.data ?? []).some((e) => (e as { status: string }).status === "ready")).toBe(true);
  expect(dct).toBeGreaterThan(0);
  expect(flateBig).toBe(0);
  expect(imageSmasks).toBe(0);
  expect(gstateSmasks).toBe(0);
  expect(capPage).toBeGreaterThanOrEqual(0);
  expect(arabicOk).toBe(true);
});
