/**
 * Milestone 3 — signed-in AI pipeline flow against the LIVE hosted Supabase project (opt-in).
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic: every server must run with
 * AI_MODE=replay (or off) and no ANTHROPIC_API_KEY. It writes to the real (production)
 * project, so — like e2e/upload-auth.spec.ts — it:
 *   - creates ONE throwaway user `e2e+m3-<random>@example.com` (admin API, email_confirm) and
 *     signs in through /auth/confirm with a token_hash from auth.admin.generateLink (no email);
 *   - makes at most ~1 Mapbox call per book with GPS photos (fake fixture point);
 *   - in afterAll (always) removes every storage object under `<uid>/`, deletes the user
 *     (cascades books/photos), asserts nothing is left, and reports what remains of the
 *     agent_runs it created (by design D-027: rows stay with user_id/book_id null, step
 *     outputs scrubbed, costs kept).
 * Logs are counts/booleans only — never photo descriptions, metadata, ids, places or keys.
 *
 * Servers (cookies are per host, not per port, so one sign-in works on all of them):
 *   baseURL            AI_MODE=replay (scenario ok)              — required
 *   E2E_REFUSAL_URL    AI_MODE=replay AI_REPLAY_SCENARIO=refusal — optional, test skipped if unset
 *   E2E_OFF_URL        AI_MODE=off                               — optional, test skipped if unset
 *   E2E_USER_ID        optional uuid for the throwaway user; if the baseURL server runs with
 *                      ADMIN_USER_IDS=<that uuid>, the admin trace page is checked too,
 *                      otherwise the trace page must 404 for this (non-admin) user.
 *   E2E_ADMIN=1        set when the baseURL server has ADMIN_USER_IDS=E2E_USER_ID.
 *   E2E_PLANT_URL      AI_MODE=replay AI_REPLAY_SCENARIO=plant_bad_caption — optional (M4 Critic catch)
 *   E2E_CRITIC_REFUSAL_URL  AI_MODE=replay server started from an app copy whose
 *                      tests/fixtures/ai/critic.ok.json is {"parsed":null,"stopReason":"refusal"}
 *                      → only the Critic refuses — optional (M4)
 *
 * M4 (captions, Critic, memory): the main book is created with a non-default tone (nostalgic for
 * travel) so the Memory Keeper learns it; caption checks log counts only — never caption text.
 * M10b: the main book picks Classic (the form defaults to Modern, whose spreads leave too few
 * captionable pages for m). D-037 #2: once the album has user captions / meta.userEdited, review
 * shows only "Continue in the editor" (h, m, f); memory is learned on editor Done (m).
 *
 * Example (production build in another folder, three `next start` servers):
 *   AI_MODE=replay ADMIN_USER_IDS=$U next start -p 3500
 *   AI_MODE=replay AI_REPLAY_SCENARIO=refusal next start -p 3501
 *   AI_MODE=off next start -p 3502
 *   E2E_AUTH=1 E2E_USER_ID=$U E2E_ADMIN=1 E2E_REFUSAL_URL=http://localhost:3501 \
 *     E2E_OFF_URL=http://localhost:3502 npx playwright test -c <config baseURL :3500> e2e/ai-auth.spec.ts
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PLANTED_PRECHECK_TEXT, isPlantedMismatch } from "../src/lib/ai/agents/caption-writer-replay";
import { buildCaptionContext, checkCaption } from "../src/lib/ai/caption-check";
import { hasCaptionArea } from "../src/lib/ai/captions";
import { wordCount } from "../src/lib/ai/schemas";
import { parseBookDoc, validateBookDoc } from "../src/lib/book/schema";
import { styleCaptionFont } from "../src/lib/design/styles";
import type { DesignStyle } from "../src/lib/book/types";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live signed-in AI flow");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by the env check below */
  }
}

const FIXTURES = path.join(__dirname, "..", "tests", "fixtures");
const BUCKET = "photos";
const VIEWPORT = { width: 375, height: 812 };
const REFUSAL_URL = process.env.E2E_REFUSAL_URL ?? "";
const OFF_URL = process.env.E2E_OFF_URL ?? "";
const PLANT_URL = process.env.E2E_PLANT_URL ?? "";
const CRITIC_REFUSAL_URL = process.env.E2E_CRITIC_REFUSAL_URL ?? "";
const FIXED_UID = process.env.E2E_USER_ID ?? "";
const IS_ADMIN = process.env.E2E_ADMIN === "1" && !!FIXED_UID;
const USER_EDITED_MSG = "You've edited this album, so we won't rebuild it over your changes.";
const EDITED_TITLE = "You've edited this album — continue in the editor"; // EDITED_ALBUM_COPY.title

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

function fixture(name: string, mimeType: string): FileSpec {
  return { name, mimeType, buffer: fs.readFileSync(path.join(FIXTURES, name)) };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// ----- shared state (serial) -----
let admin: SupabaseClient;
let uid = "";
let email = "";
let context: BrowserContext;
let page: Page;
let baseURL = "";
let mainFiles: FileSpec[] = [];
let synth: FileSpec[] = [];
const MAIN_COUNT = 12; // orient6 jpg + heic, screenshot, near-dup pair, 7 synthetic
let bookA = "";
let toggledId = "";
let userDroppedId = "";
const runIds = new Set<string>();

type PhotoRow = {
  id: string;
  status: string;
  drop_reason: string | null;
  user_override: boolean;
  dup_group: number | null;
  width: number | null;
  height: number | null;
  original_mime: string | null;
  upload_state: string;
  ai: unknown;
};

async function photoRows(bookId: string): Promise<PhotoRow[]> {
  const { data, error } = await admin
    .from("photos")
    .select("id, status, drop_reason, user_override, dup_group, width, height, original_mime, upload_state, ai")
    .eq("book_id", bookId);
  if (error) throw new Error(`photos select failed (${error.code})`);
  return (data ?? []) as PhotoRow[];
}

async function bookRow(bookId: string) {
  const { data, error } = await admin
    .from("books")
    .select("doc, ai_status, max_pages, page_count, updated_at, title, tone, caption_lang, design_style")
    .eq("id", bookId)
    .single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as {
    doc: unknown;
    ai_status: string;
    max_pages: number;
    page_count: number;
    updated_at: string;
    title: string | null;
    tone: string;
    caption_lang: string;
    design_style: DesignStyle | null;
  };
}

type RunRow = {
  id: string;
  trigger: string;
  mode: string;
  state: string;
  ai_status: string | null;
  error_code: string | null;
  total_cost_usd: number | string;
  critic_score: number | string | null;
  started_at: string;
  finished_at: string | null;
};

async function runsFor(bookId: string): Promise<RunRow[]> {
  const { data, error } = await admin
    .from("agent_runs")
    .select("id, trigger, mode, state, ai_status, error_code, total_cost_usd, critic_score, started_at, finished_at")
    .eq("book_id", bookId)
    .order("started_at", { ascending: true });
  if (error) throw new Error(`agent_runs select failed (${error.code})`);
  for (const r of data ?? []) runIds.add(r.id);
  return (data ?? []) as RunRow[];
}

type StepRow = {
  agent: string;
  step_key: string;
  attempt: number;
  status: string;
  output: unknown;
  input_summary: unknown;
  cost_usd: number | string;
  input_tokens: number;
};

async function stepsFor(runId: string): Promise<StepRow[]> {
  const { data, error } = await admin
    .from("agent_steps")
    .select("agent, step_key, attempt, status, output, input_summary, cost_usd, input_tokens")
    .eq("run_id", runId);
  if (error) throw new Error(`agent_steps select failed (${error.code})`);
  return (data ?? []) as StepRow[];
}

/** Every value of a "photoId" key anywhere in the doc. */
function docPhotoIds(doc: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "photoId" && typeof x === "string") out.add(x);
        else walk(x);
      }
    }
  };
  walk(doc);
  return out;
}

function metaOf(doc: unknown): Record<string, unknown> {
  const m = (doc as { meta?: unknown } | null)?.meta;
  return m && typeof m === "object" ? (m as Record<string, unknown>) : {};
}

/** True if a "description" key appears anywhere in the value. */
function hasDescriptionKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasDescriptionKey);
  if (v && typeof v === "object") {
    return Object.entries(v).some(([k, x]) => k === "description" || hasDescriptionKey(x));
  }
  return false;
}

function expectValidDoc(doc: unknown, keptIds: Set<string>, maxPages: number, tag: string) {
  const parsed = parseBookDoc(doc);
  expect(parsed.ok, `${tag}: parseBookDoc`).toBe(true);
  if (!parsed.ok) return;
  const issues = validateBookDoc(parsed.doc, { photoIds: keptIds, maxPages });
  console.log(`[${tag}] doc pages=${parsed.doc.pages.length} issues=${issues.length}`);
  expect(issues).toEqual([]);
  expect(parsed.doc.pages.length).toBeGreaterThan(0);
}

// ----- M4 caption helpers (counts only; caption text is never logged) -----
type DocCaption = { text: string; font: string; align: string; source: string };
type DocPage = {
  id: string;
  layout: string;
  side?: "left" | "right";
  chapterId: string | null;
  slots: { photoId?: string | null }[];
  caption: DocCaption | null;
};
type DocChapter = { id: string; title: string; dateLabel: string; place: string | null };

function pagesOf(doc: unknown): DocPage[] {
  return ((doc as { pages?: DocPage[] } | null)?.pages ?? []) as DocPage[];
}
function chaptersOf(doc: unknown): DocChapter[] {
  return ((doc as { chapters?: DocChapter[] } | null)?.chapters ?? []) as DocChapter[];
}
/** The book style's caption face (doc.style.font: Cormorant/Amiri in Modern books, Playfair/Cairo in Classic). */
function styleFontOf(doc: unknown): string {
  return (doc as { style?: { font?: string } } | null)?.style?.font ?? "Playfair Display";
}
/** Single page with a caption area, or the LEFT half of a spread (Modern, the form default since
 * A12, stores spreads as page pairs: the right half shares the layout id but never has a caption). */
function isCaptionable(p: DocPage): boolean {
  return hasCaptionArea(p.layout, p.side);
}
function pagePhotoIds(p: DocPage): string[] {
  return p.slots.map((s) => s.photoId).filter((x): x is string => typeof x === "string");
}
/** layout + photo ids — a page with the same signature is "untouched". */
function pageSig(p: DocPage): string {
  return `${p.layout}|${pagePhotoIds(p).join(",")}`;
}

type CaptionStats = {
  pages: number;
  captionable: number;
  withCaption: number;
  captionableWithCaption: number;
  ai: number;
  user: number;
  nonCaptionableWithCaption: number;
  maxWords: number;
  over18: number;
};
function captionStats(doc: unknown): CaptionStats {
  const pages = pagesOf(doc);
  const st: CaptionStats = { pages: pages.length, captionable: 0, withCaption: 0, captionableWithCaption: 0, ai: 0, user: 0, nonCaptionableWithCaption: 0, maxWords: 0, over18: 0 };
  for (const p of pages) {
    const cap = isCaptionable(p);
    if (cap) st.captionable++;
    if (!p.caption) continue;
    st.withCaption++;
    if (cap) st.captionableWithCaption++;
    else st.nonCaptionableWithCaption++;
    if (p.caption.source === "ai") st.ai++;
    if (p.caption.source === "user") st.user++;
    const w = wordCount(p.caption.text);
    st.maxWords = Math.max(st.maxWords, w);
    if (w > 18) st.over18++;
  }
  return st;
}
/** Every caption text + chapter title in the doc (to assert they never leak into logs). */
function captionTexts(doc: unknown): string[] {
  const out = pagesOf(doc).flatMap((p) => (p.caption ? [p.caption.text] : []));
  return out.filter((t) => t.trim().length >= 8);
}
function leaks(haystack: string, needles: string[]): number {
  return needles.filter((n) => haystack.includes(n) || haystack.includes(JSON.stringify(n).slice(1, -1))).length;
}
function hasKey(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKey(x, key));
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => k === key || hasKey(x, key));
  return false;
}
async function runCursor(runId: string): Promise<unknown> {
  const { data, error } = await admin.from("agent_runs").select("cursor").eq("id", runId).single();
  if (error) throw new Error(`cursor select failed (${error.code})`);
  return (data as { cursor: unknown }).cursor;
}
async function memoryRow(): Promise<{ prefs: Record<string, unknown> } | null> {
  const { data, error } = await admin.from("user_memory").select("prefs").eq("user_id", uid).maybeSingle();
  if (error) throw new Error(`user_memory select failed (${error.code})`);
  return (data as { prefs: Record<string, unknown> } | null) ?? null;
}
function memoryKeysOfStep(s: StepRow): string[] {
  const k = (s.input_summary as { memoryKeys?: unknown } | null)?.memoryKeys;
  return Array.isArray(k) ? k.map(String) : [];
}

async function signInLink(): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  return data.properties.hashed_token;
}

async function listAllUserObjects(): Promise<string[]> {
  const out: string[] = [];
  const top = await admin.storage.from(BUCKET).list(uid, { limit: 1000 });
  if (top.error) throw new Error(`storage list failed (${top.error.message})`);
  for (const entry of top.data ?? []) {
    if (entry.id) {
      out.push(`${uid}/${entry.name}`);
      continue;
    }
    const inner = await admin.storage.from(BUCKET).list(`${uid}/${entry.name}`, { limit: 1000 });
    if (inner.error) throw new Error(`storage list failed (${inner.error.message})`);
    for (const o of inner.data ?? []) out.push(`${uid}/${entry.name}/${o.name}`);
  }
  return out;
}

/** Two 800x600 JPEGs that differ by one small dot → near-duplicates (same as upload-auth). */
async function makeNearDupPair(p: Page): Promise<[FileSpec, FileSpec]> {
  const [a, b] = await p.evaluate(async () => {
    function draw(dot: boolean): Promise<string> {
      const c = document.createElement("canvas");
      c.width = 800;
      c.height = 600;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 800, 600);
      grad.addColorStop(0, "#1d4ed8");
      grad.addColorStop(1, "#f59e0b");
      g.fillStyle = grad;
      g.fillRect(0, 0, 800, 600);
      for (let i = 0; i < 12; i++) {
        g.fillStyle = `hsl(${i * 30}, 70%, ${30 + (i % 3) * 20}%)`;
        g.beginPath();
        g.arc(60 + i * 60, 150 + ((i * 97) % 300), 40 + (i % 4) * 10, 0, Math.PI * 2);
        g.fill();
      }
      if (dot) {
        g.fillStyle = "#ffffff";
        g.fillRect(700, 40, 6, 6);
      }
      return new Promise((resolve) =>
        c.toBlob(
          (blob) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(",")[1]);
            r.readAsDataURL(blob!);
          },
          "image/jpeg",
          0.9,
        ),
      );
    }
    return [await draw(false), await draw(true)];
  });
  return [
    { name: "trip-a.jpg", mimeType: "image/jpeg", buffer: Buffer.from(a, "base64") },
    { name: "trip-b.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b, "base64") },
  ];
}

/** `n` distinct, sharp 900x700 JPEGs (seeded shapes + fine noise) → not duplicates, not blurry. */
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
      c.height = 700;
      const g = c.getContext("2d")!;
      // Big blocks in a seed-specific layout give each image a different dHash.
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 9; x++) {
          g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
          g.fillRect(x * 100, y * 100, 100, 100);
        }
      }
      for (let i = 0; i < 25; i++) {
        g.strokeStyle = `hsl(${Math.floor(r() * 360)}, 80%, ${Math.floor(r() * 100)}%)`;
        g.lineWidth = 1 + Math.floor(r() * 4);
        g.beginPath();
        g.moveTo(r() * 900, r() * 700);
        g.lineTo(r() * 900, r() * 700);
        g.stroke();
      }
      const img = g.getImageData(0, 0, 900, 700);
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
    for (let i = 0; i < count; i++) out.push(await draw(i + 1));
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `scene-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

async function createBookAt(
  base: string,
  opts: { tone?: string; lang?: "en" | "ar"; style?: "classic" | "modern" } = {},
): Promise<string> {
  await page.goto(`${base}/books/new`);
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await expect(page.getByTestId("occasion-travel")).toBeChecked();
  {
    // D-068: travel defaults to Geometric; these specs cover Modern (default here) or Classic.
    const style = opts.style ?? "modern";
    await page.getByRole("radio", { name: style === "classic" ? /Classic/ : /Modern/ }).check();
    await expect(page.getByTestId(`style-${style}`)).toBeChecked();
  }
  if (opts.tone) {
    await page.locator("label", { has: page.getByTestId(`tone-${opts.tone}`) }).click();
    await expect(page.getByTestId(`tone-${opts.tone}`)).toBeChecked();
  }
  if (opts.lang) {
    await page.locator("label", { has: page.getByTestId(`lang-${opts.lang}`) }).click();
    await expect(page.getByTestId(`lang-${opts.lang}`)).toBeChecked();
  }
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split("/")[2];
  await expect(page.getByTestId("upload-pick")).toBeVisible();
  return id;
}

async function uploadAndWaitSummary(files: FileSpec[], expected: number) {
  await page.getByTestId("upload-input").setInputFiles(files);
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("finalize-error")).toHaveCount(0);
  await expect(page.getByTestId("summary-added")).toHaveText(`${expected} photos added`);
}

async function buildStates(): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __buildStates?: string[] }).__buildStates ?? []);
}

async function resetBuildStates() {
  await page.evaluate(() => {
    (window as unknown as { __buildStates: string[] }).__buildStates = [];
    (window as unknown as { __buildTexts: string[] }).__buildTexts = [];
  });
}

/** Every distinct build-stage line seen (copy only — e.g. "Writing captions 1 / 4…"). */
async function buildTexts(): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __buildTexts?: string[] }).__buildTexts ?? []);
}

/** Build my album on the upload screen → build → review. */
async function buildToReview() {
  await resetBuildStates();
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/build$/, { timeout: 30_000 });
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 180_000 });
  await reviewLoaded();
}

/** M11 added route loading.tsx skeletons: the URL is /review before the review content streams in. */
async function reviewLoaded() {
  await expect(page.getByRole("status").filter({ hasText: "Loading your album…" })).toHaveCount(0, { timeout: 30_000 });
}

/** Opens the (collapsed) captions preview if present; returns its count text or null. */
async function openCaptionsPreview(): Promise<string | null> {
  await reviewLoaded();
  const preview = page.getByTestId("captions-preview");
  if ((await preview.count()) === 0) return null;
  await preview.locator("summary").click();
  await expect(preview).toHaveAttribute("open", "");
  return (await page.getByTestId("captions-count").textContent())?.trim() ?? null;
}

async function postRun(bookId: string, trigger: "build" | "rebuild") {
  return page.evaluate(
    async ({ id, t }) => {
      const res = await fetch("/api/ai/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookId: id, trigger: t }),
        credentials: "same-origin",
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    { id: bookId, t: trigger },
  );
}

/** Review captions preview of a fully captioned AI book: count = captionable pages (spread right
 * halves excluded, M10b Bug 1), no missing line, no captions banner. Logs counts only. */
async function expectPreviewIgnoresSpreadRightHalves(book: { doc: unknown; design_style: DesignStyle | null }, st: CaptionStats, tag: string) {
  const pages = pagesOf(book.doc);
  const rightHalves = pages.filter((p) => p.side === "right").length;
  const count = await openCaptionsPreview();
  const missing = await page.getByTestId("captions-missing").count();
  console.log(`[${tag}] style=${book.design_style} pages=${pages.length} spreadRightHalves=${rightHalves} captionable=${st.captionable} preview=${count ?? "absent"} missingLine=${missing}`);
  expect(count).toBe(`Captions (${st.captionable})`);
  await expect(page.getByTestId("captions-missing")).toHaveCount(0);
  await expect(page.getByTestId("review-banner-captions_missing")).toHaveCount(0);
  return rightHalves;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test.beforeAll(async ({ browser }, info) => {
  baseURL = String(info.project.use.baseURL ?? "");
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  admin = createClient(url, env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  email = `e2e+m4-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    ...(FIXED_UID ? { id: FIXED_UID } : {}),
  });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;

  context = await browser.newContext({ viewport: VIEWPORT, baseURL });
  // Records every data-state of the build progress box (client navigation keeps `window`).
  await context.addInitScript(() => {
    const w = window as unknown as { __buildStates: string[]; __buildTexts: string[] };
    w.__buildStates = [];
    w.__buildTexts = [];
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="build-progress"]');
      const s = el?.getAttribute("data-state");
      if (s && w.__buildStates[w.__buildStates.length - 1] !== s) w.__buildStates.push(s);
      const t = document.querySelector('[data-testid="build-stage"]')?.textContent?.trim();
      if (t && w.__buildTexts[w.__buildTexts.length - 1] !== t) w.__buildTexts.push(t);
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-state"] });
  });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  const hashed = await signInLink();
  await page.goto(`/auth/confirm?token_hash=${hashed}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/);

  const [dupA, dupB] = await makeNearDupPair(page);
  synth = await makeSynthetic(page, 7);
  mainFiles = [
    fixture("photo-orient6.jpg", "image/jpeg"),
    fixture("photo-orient6.heic", "image/heic"),
    fixture("screenshot.png", "image/png"),
    dupA,
    dupB,
    ...synth,
  ];
});

test.afterAll(async () => {
  if (!uid) return;
  await context?.close().catch(() => {});
  // Collect every run this user created (before the user delete nulls user_id).
  const mine = await admin.from("agent_runs").select("id").eq("user_id", uid);
  for (const r of mine.data ?? []) runIds.add(r.id);

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
  if (error) console.log(`[cleanup] deleteUser error (${error.code})`);

  const left = await listAllUserObjects();
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const photos = await admin.from("photos").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const runsByUser = await admin.from("agent_runs").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const memory = await admin.from("user_memory").select("user_id", { count: "exact", head: true }).eq("user_id", uid);
  const ids = [...runIds];
  let runsLeft = 0;
  let runsWithUser = 0;
  let runsWithBook = 0;
  let stepsLeft = 0;
  let stepsWithOutput = 0;
  let stepsWithInputSummary = 0;
  let costKept = 0;
  if (ids.length) {
    const r = await admin.from("agent_runs").select("id, user_id, book_id, total_cost_usd").in("id", ids);
    runsLeft = r.data?.length ?? 0;
    runsWithUser = (r.data ?? []).filter((x) => x.user_id !== null).length;
    runsWithBook = (r.data ?? []).filter((x) => x.book_id !== null).length;
    costKept = (r.data ?? []).filter((x) => Number(x.total_cost_usd) > 0).length;
    const s = await admin.from("agent_steps").select("output, input_summary").in("run_id", ids);
    stepsLeft = s.data?.length ?? 0;
    stepsWithOutput = (s.data ?? []).filter((x) => x.output !== null).length;
    stepsWithInputSummary = (s.data ?? []).filter((x) => x.input_summary !== null).length;
  }
  console.log(
    `[cleanup] objects removed=${removed} left=${left.length} books left=${books.count} photos left=${photos.count} runsByUser=${runsByUser.count} memory=${memory.count} userDeleted=${!error}`,
  );
  console.log(
    `[cleanup] runs created=${ids.length} remaining=${runsLeft} withUser=${runsWithUser} withBook=${runsWithBook} withCost=${costKept}; steps remaining=${stepsLeft} withOutput=${stepsWithOutput} withInputSummary=${stepsWithInputSummary}`,
  );
  expect(left.length).toBe(0);
  expect(books.count).toBe(0);
  expect(photos.count).toBe(0);
  expect(runsByUser.count).toBe(0);
  expect(error).toBeNull();
  // D-027: runs stay (costs kept) but are detached and step outputs scrubbed.
  expect(runsWithUser).toBe(0);
  expect(runsWithBook).toBe(0);
  expect(stepsWithOutput).toBe(0);
});

test("a. upload 12 photos → Build my album → progress → review (replay)", async () => {
  // M4: non-default tone for travel (default fun) → the Memory Keeper learns it on editor Done.
  // Classic (M10b: the form defaults to Modern): 9 kept photos then give m ≥ 3 captionable pages.
  bookA = await createBookAt(baseURL, { tone: "nostalgic", style: "classic" });
  await uploadAndWaitSummary(mainFiles, MAIN_COUNT);
  const rows = await photoRows(bookA);
  expect(rows.length).toBe(MAIN_COUNT);

  const t0 = Date.now();
  await buildToReview();
  const ms = Date.now() - t0;
  const states = await buildStates();
  const texts = await buildTexts();
  // Stage copy only (no user data): strip digits so the log stays generic.
  console.log(`[a] build→review ms=${ms} states=${states.join(">")} stageTexts=${texts.map((t) => t.replace(/\d+/g, "#")).join(" | ")}`);
  expect(states.length).toBeGreaterThanOrEqual(2);
  // M4 stages render. In replay one tick can run storyteller → caption writer → critic (calls take
  // ~0 ms), so "captioning" / "critiquing" and their copy ("Writing captions d / t…", "Final
  // check…") are only seen when a tick yields mid-way — verify on a live key (M4b); the copy is
  // covered by unit tests. Here: progress was shown (a planning stage or later) and the run ends
  // done with captions on every captionable page.
  const sawCaptioning = states.includes("captioning") || texts.some((t) => t.startsWith("Writing captions"));
  console.log(`[a] sawCaptioning=${sawCaptioning} sawFinalCheck=${texts.includes("Final check…")}`);
  const LATE = ["storytelling", "captioning", "critiquing", "validating", "done"];
  expect(states.some((s) => LATE.includes(s))).toBe(true);
  expect(new URL(page.url()).pathname).toBe(`/books/${bookA}/review`);
  const runs = await runsFor(bookA);
  expect(runs.length).toBe(1);
  expect(runs[0]).toMatchObject({ trigger: "build", state: "done", ai_status: "ok" });
  const book = await bookRow(bookA);
  expect(book.design_style).toBe("classic");
  const st = captionStats(book.doc);
  console.log(`[a] run=${runs[0].state}/${runs[0].ai_status} style=${book.design_style} captionable=${st.captionable} withCaption=${st.captionableWithCaption}`);
  expect(st.captionable).toBeGreaterThan(0);
  expect(st.captionableWithCaption).toBe(st.captionable);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(VIEWPORT.width);
});

test("b. review: header, screenshot + duplicate dropped, toggle persists; DB run/steps/doc/photos", async () => {
  const rows = await photoRows(bookA);
  const kept = rows.filter((r) => r.status !== "dropped");
  await expect(page.getByTestId("review-header")).toHaveText(`AI kept ${kept.length} of ${rows.length}`);
  await expect(page.getByTestId("review-banner-partial")).toHaveCount(0);
  await expect(page.getByTestId("review-banner-failed")).toHaveCount(0);
  await expect(page.getByTestId("rebuild-button")).toHaveText("Redo with AI");

  // Screenshot → dropped with a "Screenshot" chip.
  const png = rows.filter((r) => r.original_mime === "image/png");
  expect(png.length).toBe(1);
  expect(png[0]).toMatchObject({ status: "dropped", drop_reason: "screenshot" });
  await page.getByTestId("review-tab-dropped").click();
  const pngTile = page.locator(`[data-testid="review-tile"][data-photo-id="${png[0].id}"]`);
  await expect(pngTile).toHaveAttribute("data-state", "dropped");
  await expect(pngTile.getByTestId("review-reason")).toHaveText("Screenshot");

  // Near-dup pair (800x600): grouped, exactly one dropped as duplicate.
  const pair = rows.filter((r) => r.width === 800 && r.height === 600);
  const pairDropped = pair.filter((r) => r.status === "dropped");
  const counts = {
    rows: rows.length,
    kept: kept.length,
    dropped: rows.length - kept.length,
    reasons: rows.reduce<Record<string, number>>((m, r) => {
      if (r.status === "dropped") m[r.drop_reason ?? "none"] = (m[r.drop_reason ?? "none"] ?? 0) + 1;
      return m;
    }, {}),
    pair: pair.length,
    pairGrouped: pair.filter((r) => r.dup_group !== null).length,
    pairSameGroup: pair.length === 2 && pair[0].dup_group !== null && pair[0].dup_group === pair[1].dup_group,
    pairDroppedDup: pairDropped.filter((r) => r.drop_reason === "duplicate").length,
    synthKept: rows.filter((r) => r.width === 900 && r.status !== "dropped").length,
  };
  console.log(`[b] ${JSON.stringify(counts)}`);
  expect(pair.length).toBe(2);
  expect(counts.pairSameGroup).toBe(true);
  expect(pairDropped.length).toBe(1);
  expect(counts.pairDroppedDup).toBe(1);
  expect(counts.synthKept).toBe(7);

  // Toggle the dropped duplicate → kept; persists over reload with the user dot.
  toggledId = pairDropped[0].id;
  const tile = page.locator(`[data-testid="review-tile"][data-photo-id="${toggledId}"]`);
  await expect(tile).toHaveAttribute("data-state", "dropped");
  await expect(tile.getByTestId("review-reason")).toHaveText("Duplicate");
  await tile.click();
  await expect(tile).toHaveAttribute("data-state", "kept");
  await expect
    .poll(async () => (await photoRows(bookA)).find((r) => r.id === toggledId)?.user_override, { timeout: 15_000 })
    .toBe(true);
  await expect(page.getByTestId("review-toast")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("review-header")).toHaveText(`AI kept ${kept.length + 1} of ${rows.length}`);
  const keptTile = page.locator(`[data-testid="review-tile"][data-photo-id="${toggledId}"]`);
  await expect(keptTile).toHaveAttribute("data-state", "kept");
  await expect(keptTile.getByTestId("review-user-dot")).toHaveCount(1);
  // D-028: the kept photo isn't in the album yet → Update album bar + Continue warning.
  await expect(page.getByTestId("update-album-bar")).toBeVisible();
  await expect(page.getByTestId("update-album-count")).toHaveText("You changed 1 photo.");
  await expect(page.getByTestId("review-continue-warning")).toBeVisible();
  const toggled = (await photoRows(bookA)).find((r) => r.id === toggledId)!;
  expect(toggled).toMatchObject({ status: "kept", drop_reason: null, user_override: true });

  // agent_runs / agent_steps.
  const runs = await runsFor(bookA);
  expect(runs.length).toBe(1);
  const run = runs[0];
  expect(run).toMatchObject({ trigger: "build", mode: "replay", state: "done", ai_status: "ok", error_code: null });
  const steps = await stepsFor(run.id);
  const curator = steps.filter((s) => s.agent === "curator");
  const story = steps.filter((s) => s.agent === "storyteller");
  const caption = steps.filter((s) => s.agent === "caption_writer");
  const critic = steps.filter((s) => s.agent === "critic");
  const stepSum = steps.reduce((a, s) => a + Number(s.cost_usd), 0);
  const descInOutput = steps.filter((s) => hasDescriptionKey(s.output)).length;
  const descInSummary = steps.filter((s) => hasDescriptionKey(s.input_summary)).length;
  console.log(
    `[b] steps=${steps.length} curator=${curator.length} (ok=${curator.filter((s) => s.status === "ok").length}) storyteller=${story.length} caption=${caption.map((s) => s.status).join(",")} critic=${critic.map((s) => s.status).join(",")} descInOutput=${descInOutput} descInSummary=${descInSummary} total=${Number(run.total_cost_usd)} stepSum=${stepSum.toFixed(6)}`,
  );
  expect(curator.length).toBeGreaterThanOrEqual(2); // 12 photos, batches of ≤ 10
  expect(curator.every((s) => s.step_key.startsWith("curator:") && s.status === "ok")).toBe(true);
  expect(story.length).toBe(1);
  expect(story[0].status).toBe("ok");
  // M4: real Caption Writer batches (caption_writer:{i}, repairs caption_writer:repair:{i}) + one Critic
  expect(caption.length).toBeGreaterThanOrEqual(1);
  expect(caption.every((s) => /^caption_writer:(?:repair:)?\d+$/.test(s.step_key) && s.status === "ok")).toBe(true);
  expect(critic.map((s) => s.status)).toEqual(["ok"]);
  expect(descInOutput).toBe(0);
  expect(descInSummary).toBe(0);
  expect(Number(run.total_cost_usd)).toBeGreaterThan(0);
  expect(Math.abs(Number(run.total_cost_usd) - stepSum)).toBeLessThan(0.0001);

  // Owner GET of the run: explicit fields only.
  const got = await page.evaluate(async (id) => {
    const res = await fetch(`/api/ai/runs/${id}`, { credentials: "same-origin" });
    return { status: res.status, text: await res.text() };
  }, run.id);
  expect(got.status).toBe(200);
  expect(got.text.includes('"cursor"')).toBe(false);
  expect(got.text.includes("description")).toBe(false);

  // Book doc + status.
  const book = await bookRow(bookA);
  const meta = metaOf(book.doc);
  console.log(`[b] book ai_status=${book.ai_status} generator=${String(meta.generator)} runIdMatches=${meta.runId === run.id} userEdited=${String(meta.userEdited)}`);
  expect(book.ai_status).toBe("done");
  expect(meta.generator).toBe("ai");
  expect(meta.runId).toBe(run.id);
  const keptBefore = new Set(rows.filter((r) => r.status !== "dropped").map((r) => r.id));
  expectValidDoc(book.doc, keptBefore, book.max_pages ?? 20, "b");
  expect(docPhotoIds(book.doc).has(toggledId)).toBe(false); // toggling doesn't touch the doc
  expect(docPhotoIds(book.doc).has(png[0].id)).toBe(false);

  // photos.ai notes (server-only column): versioned + description for every analysed photo.
  const withNotes = rows.filter((r) => {
    const ai = r.ai as { v?: unknown; description?: unknown } | null;
    return !!ai && typeof ai.v === "number" && typeof ai.description === "string" && ai.description.length > 0;
  }).length;
  console.log(`[b] photos with ai notes=${withNotes}/${rows.length}`);
  expect(withNotes).toBe(rows.length);

  // Admin trace page.
  const traceRes = await page.goto(`/admin/runs/${run.id}`);
  if (IS_ADMIN) {
    expect(traceRes?.status()).toBe(200);
    await expect(page.getByTestId("trace-heading")).toBeVisible();
    await expect(page.getByTestId("trace-state")).toHaveText("done");
    await expect(page.getByTestId("trace-step")).toHaveCount(steps.length);
    await expect(page.getByTestId("trace-cost-mismatch")).toHaveCount(0);
    const html = await page.content();
    expect(html.includes("synthetic replay note")).toBe(false);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log(`[b] admin trace steps=${steps.length} scrollWidth=${sw}`);
  } else {
    expect(traceRes?.status()).toBe(404);
  }
  await page.goto(`/books/${bookA}/review`);
});

test("m4a. captions on every captionable page (en), Critic ok, preview count, no caption text in logs", async () => {
  const runs = await runsFor(bookA);
  const run = runs[0];
  const book = await bookRow(bookA);
  const st = captionStats(book.doc);
  const steps = await stepsFor(run.id);
  const skipped = steps.filter((s) => s.status === "skipped").length;
  const caption = steps.filter((s) => s.agent === "caption_writer");
  const critic = steps.filter((s) => s.agent === "critic");
  const repairs = caption.filter((s) => s.step_key.startsWith("caption_writer:repair:")).length;
  const stepSum = steps.reduce((a, s) => a + Number(s.cost_usd), 0);

  // Pre-check (lang en) over every caption, with the book's own metadata as allowlist.
  const chapters = chaptersOf(book.doc);
  const ctx = buildCaptionContext({ lang: "en", bookTitle: book.title, chapters });
  const issueCodes: Record<string, number> = {};
  for (const p of pagesOf(book.doc)) {
    if (!p.caption) continue;
    for (const i of checkCaption(p.caption.text, ctx)) issueCodes[i.code] = (issueCodes[i.code] ?? 0) + 1;
  }
  console.log(
    `[m4a] ${JSON.stringify(st)} lang=${book.caption_lang} criticScore=${run.critic_score !== null} skipped=${skipped} captionSteps=${caption.length} repairs=${repairs} critic=${critic.map((s) => s.status).join(",")} precheckIssues=${JSON.stringify(issueCodes)} total=${Number(run.total_cost_usd)} stepSum=${stepSum.toFixed(6)}`,
  );
  expect(book.caption_lang).toBe("en");
  expect(st.captionable).toBeGreaterThan(0);
  expect(st.captionableWithCaption).toBe(st.captionable); // every captionable page has a caption
  expect(st.ai).toBe(st.withCaption);
  expect(st.user).toBe(0);
  expect(st.nonCaptionableWithCaption).toBe(0);
  expect(st.over18).toBe(0);
  expect(skipped).toBe(0);
  expect(caption.every((s) => s.status === "ok")).toBe(true);
  expect(critic.map((s) => s.status)).toEqual(["ok"]);
  expect(run.critic_score).not.toBeNull();
  expect(Math.abs(Number(run.total_cost_usd) - stepSum)).toBeLessThan(0.0001);
  // Unknown names/numbers are allowed only from metadata (places come from Mapbox) — log only for places.
  expect(issueCodes.too_long ?? 0).toBe(0);
  expect(issueCodes.arabic_in_english ?? 0).toBe(0);

  // No caption text / Critic detail in steps, GET progress or the finished cursor.
  const texts = captionTexts(book.doc);
  const stepsJson = JSON.stringify(steps.map((s) => [s.output, s.input_summary]));
  const stepLeaks = leaks(stepsJson, texts);
  const detailKeys = steps.filter((s) => hasKey(s.output, "detail")).length;
  const got = await page.evaluate(async (id) => {
    const res = await fetch(`/api/ai/runs/${id}`, { credentials: "same-origin" });
    return { status: res.status, text: await res.text() };
  }, run.id);
  const progress = (JSON.parse(got.text) as { progress?: Record<string, unknown> }).progress ?? {};
  const getLeaks = leaks(got.text, texts);
  const cursor = await runCursor(run.id);
  const cursorJson = JSON.stringify(cursor ?? null);
  const cursorLeaks = leaks(cursorJson, texts);
  const cursorKeys = cursor && typeof cursor === "object" ? Object.keys(cursor as object) : [];
  const heavyKeys = ["plan", "captions", "headings", "critique", "memory"].filter((k) => {
    const v = (cursor as Record<string, unknown> | null)?.[k];
    return v !== undefined && v !== null && !(typeof v === "object" && Object.keys(v as object).length === 0);
  });
  console.log(
    `[m4a] captionTexts=${texts.length} stepLeaks=${stepLeaks} detailKeys=${detailKeys} GET=${got.status} getLeaks=${getLeaks} progressKeys=${Object.keys(progress).join(",")} captionsTotal=${String(progress.captionsTotal)} captionsDone=${String(progress.captionsDone)} cursorBytes=${cursorJson.length} cursorLeaks=${cursorLeaks} cursorHeavyKeys=${heavyKeys.join(",") || "none"} cursorKeys=${cursorKeys.length}`,
  );
  expect(texts.length).toBeGreaterThan(0);
  expect(stepLeaks).toBe(0);
  expect(detailKeys).toBe(0);
  expect(got.status).toBe(200);
  expect(getLeaks).toBe(0);
  expect(cursorLeaks).toBe(0);
  expect(heavyKeys).toEqual([]);

  // Review UI: collapsed preview → "Captions (n)", n = captionable pages; no missing line.
  await page.goto(`/books/${bookA}/review`);
  const count = await openCaptionsPreview();
  expect(count).toBe(`Captions (${st.captionable})`);
  await expect(page.getByTestId("captions-missing")).toHaveCount(0);
  // Complete AI album → no captions_missing / partial banner, "Rebuild with AI".
  await expect(page.getByTestId("review-banner-captions_missing")).toHaveCount(0);
  await expect(page.getByTestId("review-banner-partial")).toHaveCount(0);
  await expect(page.getByTestId("captions-item")).toHaveCount(st.captionable);
  await expect(page.getByTestId("captions-source-ai")).toHaveCount(st.captionable);
  const dirs = await page.getByTestId("captions-text").evaluateAll((els) => els.map((e) => e.getAttribute("dir")));
  expect(dirs.every((d) => d === "auto")).toBe(true);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(`[m4a] preview items=${st.captionable} chapters=${await page.getByTestId("captions-chapter").count()} scrollWidth=${sw}`);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);
});

test("u. Update album (D-028): drop 1 in-album photo + keep 1 dropped → re-layout, no AI run", async () => {
  const before = await bookRow(bookA);
  const runsBefore = (await runsFor(bookA)).length;
  const inAlbum = docPhotoIds(before.doc);
  const rows = await photoRows(bookA);
  // A kept synthetic photo that is in the album (not the cover, if possible).
  const cover = (before.doc as { cover?: { photoId?: string | null } }).cover?.photoId ?? null;
  const candidates = rows.filter((r) => r.width === 900 && r.status === "kept" && inAlbum.has(r.id));
  const target = candidates.find((r) => r.id !== cover) ?? candidates[0];
  expect(target).toBeTruthy();
  userDroppedId = target.id;

  const tile = page.locator(`[data-testid="review-tile"][data-photo-id="${userDroppedId}"]`);
  await expect(tile).toHaveAttribute("data-state", "kept");
  await tile.click();
  await expect(tile).toHaveAttribute("data-state", "dropped");
  await expect
    .poll(async () => (await photoRows(bookA)).find((r) => r.id === userDroppedId)?.user_override, { timeout: 15_000 })
    .toBe(true);
  await expect(page.getByTestId("update-album-count")).toHaveText("You changed 2 photos.");
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);

  await page.getByTestId("update-album").click();
  await expect(page.getByTestId("update-album-toast")).toHaveText("Album updated", { timeout: 30_000 });
  await expect(page.getByTestId("update-album-error")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("review-header")).toBeVisible();
  await expect(page.getByTestId("update-album-bar")).toHaveCount(0);
  await expect(page.getByTestId("review-continue-warning")).toHaveCount(0);

  const after = await bookRow(bookA);
  const ids = docPhotoIds(after.doc);
  const rowsAfter = await photoRows(bookA);
  const dropped = rowsAfter.find((r) => r.id === userDroppedId)!;
  const meta = metaOf(after.doc);
  const runsAfter = (await runsFor(bookA)).length;
  console.log(
    `[u] droppedInDoc=${ids.has(userDroppedId)} keptInDoc=${ids.has(toggledId)} generator=${String(meta.generator)} runIdSame=${meta.runId === metaOf(before.doc).runId} runs before=${runsBefore} after=${runsAfter} pages=${after.page_count} ai_status=${after.ai_status}`,
  );
  expect(dropped).toMatchObject({ status: "dropped", drop_reason: "user_removed", user_override: true });
  expect(ids.has(userDroppedId)).toBe(false);
  expect(ids.has(toggledId)).toBe(true);
  expect(meta.generator).toBe("ai");
  expect(meta.userEdited).not.toBe(true);
  expect(after.ai_status).toBe("done");
  expect(runsAfter).toBe(runsBefore);
  expectValidDoc(after.doc, new Set(rowsAfter.filter((r) => r.status !== "dropped").map((r) => r.id)), after.max_pages ?? 20, "u");

  // M4 (D-031): untouched pages (same layout + photos) keep their AI caption; re-fitted/new pages
  // get caption null. Compared by value — never printed.
  const beforeBySig = new Map(pagesOf(before.doc).map((p) => [pageSig(p), p.caption] as const));
  let untouched = 0;
  let untouchedKept = 0;
  let refit = 0;
  let refitNull = 0;
  for (const p of pagesOf(after.doc)) {
    if (beforeBySig.has(pageSig(p))) {
      untouched++;
      if (JSON.stringify(p.caption) === JSON.stringify(beforeBySig.get(pageSig(p)))) untouchedKept++;
    } else {
      refit++;
      if (p.caption === null) refitNull++;
    }
  }
  const chaptersBefore = chaptersOf(before.doc).map((c) => c.title);
  const chaptersAfter = chaptersOf(after.doc).map((c) => c.title);
  const headingsKept = chaptersAfter.filter((t) => chaptersBefore.includes(t)).length;
  console.log(
    `[u] captions: untouched=${untouched} kept=${untouchedKept} refit=${refit} refitNull=${refitNull} chapters before=${chaptersBefore.length} after=${chaptersAfter.length} headingsKept=${headingsKept} after=${JSON.stringify(captionStats(after.doc))}`,
  );
  expect(untouched).toBeGreaterThan(0);
  expect(untouchedKept).toBe(untouched);
  expect(refit).toBeGreaterThan(0);
  expect(refitNull).toBe(refit);
  expect(captionStats(after.doc).user).toBe(0);
});

test("c. rebuild: build → review; 0 new curator calls; user choice untouched; toggled photo in doc", async () => {
  await resetBuildStates();
  await page.getByTestId("rebuild-button").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/build$/, { timeout: 30_000 });
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 180_000 });
  const states = await buildStates();
  console.log(`[c] states=${states.join(">")}`);

  const runs = await runsFor(bookA);
  expect(runs.length).toBe(2);
  const run = runs[1];
  expect(run).toMatchObject({ trigger: "rebuild", mode: "replay", state: "done", ai_status: "ok" });
  const steps = await stepsFor(run.id);
  const curatorCalls = steps.filter((s) => s.agent === "curator" && s.status !== "skipped").length;
  const story = steps.filter((s) => s.agent === "storyteller");
  console.log(`[c] steps=${steps.length} curatorCalls=${curatorCalls} storyteller=${story.map((s) => s.status).join(",")}`);
  expect(curatorCalls).toBe(0);
  expect(story.map((s) => s.status)).toEqual(["ok"]);

  const rows = await photoRows(bookA);
  const toggled = rows.find((r) => r.id === toggledId)!;
  expect(toggled).toMatchObject({ status: "kept", drop_reason: null, user_override: true });
  const book = await bookRow(bookA);
  const meta = metaOf(book.doc);
  expect(book.ai_status).toBe("done");
  expect(meta.generator).toBe("ai");
  expect(meta.runId).toBe(run.id);
  const keptIds = new Set(rows.filter((r) => r.status !== "dropped").map((r) => r.id));
  expectValidDoc(book.doc, keptIds, book.max_pages ?? 20, "c");
  const inDoc = docPhotoIds(book.doc).has(toggledId);
  const ud = rows.find((r) => r.id === userDroppedId)!;
  console.log(`[c] toggled photo in doc=${inDoc} userDropped inDoc=${docPhotoIds(book.doc).has(userDroppedId)} status=${ud.status}`);
  expect(inDoc).toBe(true);
  expect(ud).toMatchObject({ status: "dropped", drop_reason: "user_removed", user_override: true });
  expect(docPhotoIds(book.doc).has(userDroppedId)).toBe(false);
  await expect(page.getByTestId("update-album-bar")).toHaveCount(0);
  await expect(page.getByTestId("review-header")).toHaveText(`AI kept ${keptIds.size} of ${rows.length}`);

  // M4: the rebuild writes captions again (no user captions in the doc yet).
  const st = captionStats(book.doc);
  const caption = steps.filter((s) => s.agent === "caption_writer");
  const critic = steps.filter((s) => s.agent === "critic");
  console.log(`[c] ${JSON.stringify(st)} captionSteps=${caption.map((s) => s.status).join(",")} critic=${critic.map((s) => s.status).join(",")} criticScore=${run.critic_score !== null}`);
  expect(st.captionableWithCaption).toBe(st.captionable);
  expect(st.ai).toBe(st.withCaption);
  expect(critic.map((s) => s.status)).toEqual(["ok"]);
  expect(run.critic_score).not.toBeNull();
});

/** Short user captions (≤ 10 words → Memory Keeper learns captionLength 'short'). */
const USER_CAPTIONS = ["Our quiet morning together", "Sun on our faces", "Back home at last", "One more slow walk"];

/** D-037 #2 (M5): an album with user edits (editor save → meta.userEdited, or any caption with
 * source "user") shows only "Continue in the editor" on review — no Rebuild with AI, no Update
 * album bar, no Continue (albumEditedByUser, src/lib/review/ui.ts). */
async function expectEditedReview() {
  await expect(page.getByTestId("review-edited")).toBeVisible();
  await expect(page.getByTestId("review-edited")).toContainText(EDITED_TITLE);
  await expect(page.getByTestId("review-open-editor")).toHaveAttribute("href", `/books/${bookA}/edit`);
  await expect(page.getByTestId("rebuild-button")).toHaveCount(0);
  await expect(page.getByTestId("update-album-bar")).toHaveCount(0);
  await expect(page.getByTestId("review-continue")).toHaveCount(0);
  await expect(page.getByTestId("review-continue-warning")).toHaveCount(0);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);
}

test("h. user caption (D-031/D-037): rebuild 409 user_edited (API + stale button), doc unchanged; review → continue in editor", async () => {
  // Review loaded while the album is still AI-only (after c) → "Rebuild with AI" is offered.
  await page.goto(`/books/${bookA}/review`);
  await expect(page.getByTestId("rebuild-button")).toHaveText("Redo with AI");
  await expect(page.getByTestId("review-edited")).toHaveCount(0);

  const before = await bookRow(bookA);
  const doc = structuredClone(before.doc) as { pages: DocPage[]; meta: Record<string, unknown>; cover: { photoId: string | null } };
  const capIdx = doc.pages.map((p, i) => [p, i] as const).filter(([p]) => isCaptionable(p));
  expect(capIdx.length).toBeGreaterThan(0);
  const [target, ti] = capIdx.find(([p]) => pagePhotoIds(p).length >= 2) ?? capIdx[0];
  doc.pages[ti] = {
    ...target,
    caption: { text: USER_CAPTIONS[0], font: target.caption?.font ?? styleFontOf(before.doc), align: "center", source: "user" },
  };
  // The user caption lands while the review page is open (e.g. another tab saved it).
  const upd = await admin.from("books").update({ doc }).eq("id", bookA);
  expect(upd.error).toBeNull();
  const snapshot = (await bookRow(bookA)).doc;
  expect(metaOf(snapshot).userEdited).toBe(false);
  const runsBefore = (await runsFor(bookA)).length;

  const res = await postRun(bookA, "rebuild");
  console.log(`[h] POST status=${res.status} error=${String(res.body.error)} targetPhotos=${pagePhotoIds(target).length}`);
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "user_edited" });
  expect((await bookRow(bookA)).doc).toEqual(snapshot);
  expect((await runsFor(bookA)).length).toBe(runsBefore);

  // The stale "Rebuild with AI" button (page loaded before the edit) → the user_edited message.
  await page.getByTestId("rebuild-button").click();
  await expect(page.getByTestId("rebuild-error")).toHaveText(USER_EDITED_MSG);
  expect(new URL(page.url()).pathname).toBe(`/books/${bookA}/review`);

  // Reload → D-037 #2 edited-album flow; the captions preview shows the user caption.
  await page.reload();
  await expectEditedReview();
  await openCaptionsPreview();
  await expect(page.getByTestId("captions-source-user")).toHaveCount(1);

  // Photo choices no longer change the album: a toggle persists on the photo, but no Update album
  // bar appears and the doc stays as it is. Toggle back so the next tests start from the same set.
  const rows = await photoRows(bookA);
  const inAlbum = rows.find((r) => r.status === "kept" && docPhotoIds(snapshot).has(r.id) && r.id !== doc.cover.photoId);
  expect(inAlbum).toBeTruthy();
  const tile = page.locator(`[data-testid="review-tile"][data-photo-id="${inAlbum!.id}"]`);
  await expect(tile).toHaveAttribute("data-state", "kept");
  await tile.click();
  await expect(tile).toHaveAttribute("data-state", "dropped");
  await expect
    .poll(async () => (await photoRows(bookA)).find((r) => r.id === inAlbum!.id)?.status, { timeout: 15_000 })
    .toBe("dropped");
  await expect(page.getByTestId("update-album-bar")).toHaveCount(0);
  await expect(page.getByTestId("review-continue-warning")).toHaveCount(0);
  expect((await bookRow(bookA)).doc).toEqual(snapshot);
  await tile.click();
  await expect(tile).toHaveAttribute("data-state", "kept");
  await expect
    .poll(async () => (await photoRows(bookA)).find((r) => r.id === inAlbum!.id)?.status, { timeout: 15_000 })
    .toBe("kept");
  await page.reload();
  await expectEditedReview();

  const after = await bookRow(bookA);
  const userPages = pagesOf(after.doc).filter((p) => p.caption?.source === "user");
  console.log(
    `[h] edited review: userCaptions=${userPages.length} onCaptionable=${userPages.filter(isCaptionable).length} runs=${(await runsFor(bookA)).length} docUnchanged=${JSON.stringify(after.doc) === JSON.stringify(snapshot)}`,
  );
  expect(after.doc).toEqual(snapshot);
  expect(userPages.length).toBe(1);
  expect((await runsFor(bookA)).length).toBe(runsBefore);
  const rowsAfter = await photoRows(bookA);
  expectValidDoc(after.doc, new Set(rowsAfter.filter((r) => r.status !== "dropped").map((r) => r.id)), after.max_pages ?? 20, "h");
});

test("m. Memory Keeper: ≥ 3 short user captions → review → Continue in the editor → Done → user_memory (tone, short, en)", async () => {
  expect(await memoryRow()).toBeNull();
  const before = await bookRow(bookA);
  const doc = structuredClone(before.doc) as { pages: DocPage[] };
  let users = doc.pages.filter((p) => p.caption?.source === "user").length;
  let next = 1;
  for (let i = 0; i < doc.pages.length && users < 4 && next < USER_CAPTIONS.length; i++) {
    const p = doc.pages[i];
    if (!isCaptionable(p) || p.caption?.source === "user") continue;
    doc.pages[i] = { ...p, caption: { text: USER_CAPTIONS[next++], font: p.caption?.font ?? styleFontOf(before.doc), align: "center", source: "user" } };
    users++;
  }
  console.log(`[m] user captions written=${users} captionable=${doc.pages.filter(isCaptionable).length}`);
  expect(users).toBeGreaterThanOrEqual(3);
  const upd = await admin.from("books").update({ doc }).eq("id", bookA);
  expect(upd.error).toBeNull();
  expect(metaOf((await bookRow(bookA)).doc).userEdited).toBe(false);

  // D-037 #2: user captions → review offers only "Continue in the editor"; the Memory Keeper
  // learns on editor Done (finishEditingAction, D-032) — review Continue is not shown.
  await page.goto(`/books/${bookA}/review`);
  await expectEditedReview();
  await page.getByTestId("review-open-editor").click();
  await page.waitForURL(new RegExp(`/books/${bookA}/edit$`), { timeout: 30_000 });
  await page.getByTestId("editor-done").click(); // M13 T9: Share publishes, then the share screen
  await page.waitForURL(new RegExp(`/books/${bookA}/publish(\\?shared=live)?$`), { timeout: 30_000 });
  await expect(page.getByTestId("editor-done-error")).toHaveCount(0);
  await expect.poll(async () => (await memoryRow()) !== null, { timeout: 15_000 }).toBe(true);
  const prefs = (await memoryRow())!.prefs;
  const keys = Object.keys(prefs).filter((k) => prefs[k] !== undefined && prefs[k] !== null).sort();
  const checks = {
    tone: prefs.tonePreference === "nostalgic",
    short: prefs.captionLength === "short",
    en: prefs.language === "en",
    noNames: !Array.isArray(prefs.knownNames) || prefs.knownNames.length === 0,
  };
  console.log(`[m] memory keys=${keys.join(",")} checks=${JSON.stringify(checks)}`);
  expect(checks).toEqual({ tone: true, short: true, en: true, noNames: true });
  // Opening the editor and Done without edits never rewrites the doc's captions.
  const after = await bookRow(bookA);
  expect(pagesOf(after.doc).filter((p) => p.caption?.source === "user").length).toBe(users);
  await page.goto(`/books/${bookA}/review`);
});

test("f. userEdited guard (meta.userEdited only): rebuild refused 409 user_edited, edited review, build screen box, doc unchanged", async () => {
  // Isolate the editor-save signal: no user captions left, only meta.userEdited = true.
  const before = await bookRow(bookA);
  const doc = structuredClone(before.doc) as { pages: DocPage[]; meta: Record<string, unknown> } & Record<string, unknown>;
  doc.pages = doc.pages.map((p) => (p.caption?.source === "user" ? { ...p, caption: null } : p));
  const edited = { ...doc, meta: { ...metaOf(doc), userEdited: true } };
  const upd = await admin.from("books").update({ doc: edited }).eq("id", bookA);
  expect(upd.error).toBeNull();
  const snapshot = (await bookRow(bookA)).doc;
  expect(pagesOf(snapshot).some((p) => p.caption?.source === "user")).toBe(false);
  expect(metaOf(snapshot).userEdited).toBe(true);
  const runsBefore = (await runsFor(bookA)).length;

  const res = await postRun(bookA, "rebuild");
  console.log(`[f] POST status=${res.status} error=${String(res.body.error)}`);
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "user_edited" });

  // Review: edited-album flow (no rebuild button to press any more — D-037 #2).
  await page.goto(`/books/${bookA}/review`);
  await expectEditedReview();

  // Build screen too (no run id) → user_edited box.
  await page.goto(`/books/${bookA}/build`);
  await expect(page.getByTestId("build-user-edited")).toBeVisible({ timeout: 30_000 });

  const after = await bookRow(bookA);
  expect(after.doc).toEqual(snapshot);
  expect((await runsFor(bookA)).length).toBe(runsBefore);
});

test("n. memory → new book prefilled (tone + hint); book 2 build gets memory; replay captions ≤ 10 words", async () => {
  await page.goto(`${baseURL}/books/new`);
  await expect(page.getByTestId("new-book-from-memory")).toBeVisible();
  await expect(page.getByTestId("tone-nostalgic")).toBeChecked();
  await expect(page.getByTestId("lang-en")).toBeChecked();
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await page.getByRole("radio", { name: /Modern/ }).check(); // D-068: travel now defaults to Geometric; this spec covers Modern.
  // The remembered tone survives picking an occasion whose default differs (travel → fun).
  await expect(page.getByTestId("tone-nostalgic")).toBeChecked();
  await expect(page.getByTestId("new-book-from-memory")).toBeVisible();
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  const bookM = new URL(page.url()).pathname.split("/")[2];
  const files = synth.slice(0, 6);
  await uploadAndWaitSummary(files, files.length);
  await buildToReview();

  const book = await bookRow(bookM);
  const runs = await runsFor(bookM);
  const steps = await stepsFor(runs[0].id);
  const story = steps.filter((s) => s.agent === "storyteller");
  const writers = steps.filter((s) => s.agent === "caption_writer");
  const st = captionStats(book.doc);
  console.log(
    `[n] tone=${book.tone} run=${runs[0].ai_status} storyMemoryKeys=${story.map((s) => memoryKeysOfStep(s).join("+")).join(",")} writerMemoryKeys=${writers.map((s) => memoryKeysOfStep(s).join("+")).join(",")} ${JSON.stringify(st)}`,
  );
  expect(book.tone).toBe("nostalgic");
  expect(runs[0]).toMatchObject({ mode: "replay", state: "done", ai_status: "ok" });
  expect(story.length).toBe(1);
  expect(memoryKeysOfStep(story[0])).toContain("captionLength");
  expect(writers.length).toBeGreaterThanOrEqual(1);
  expect(writers.every((s) => memoryKeysOfStep(s).includes("captionLength"))).toBe(true);
  expect(writers.every((s) => memoryKeysOfStep(s).includes("tonePreference"))).toBe(true);
  expect(st.captionable).toBeGreaterThan(0);
  expect(st.captionableWithCaption).toBe(st.captionable);
  expect(st.maxWords).toBeLessThanOrEqual(10);
  expect(leaks(JSON.stringify(steps.map((s) => [s.output, s.input_summary])), ["nostalgic\u0000"])).toBe(0);
  const rows = await photoRows(bookM);
  expectValidDoc(book.doc, new Set(rows.filter((r) => r.status !== "dropped").map((r) => r.id)), book.max_pages ?? 20, "n");

  // M10b Bug 1: in a Modern book the right half of a spread is not captionable → the review
  // preview counts only captionable pages and shows no "page has no caption yet" line.
  await expectPreviewIgnoresSpreadRightHalves(book, st, "n");
});

test("s. /settings shows learned rows; Clear → confirm → row deleted; next new book has no hint", async () => {
  await page.goto(`${baseURL}/settings`);
  await expect(page.getByTestId("settings-memory-list")).toBeVisible();
  await expect(page.getByTestId("settings-row-tone")).toHaveCount(1);
  await expect(page.getByTestId("settings-row-captionLength")).toHaveCount(1);
  await expect(page.getByTestId("settings-row-language")).toHaveCount(1);
  await expect(page.getByTestId("settings-privacy")).toBeVisible();
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(`[s] rows=${await page.locator('[data-testid^="settings-row-"]').count()} scrollWidth=${sw}`);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);

  // Cancel first: nothing deleted.
  await page.getByTestId("settings-clear").click();
  await expect(page.getByTestId("settings-clear-confirm")).toBeVisible();
  await page.getByTestId("settings-clear-cancel").click();
  await expect(page.getByTestId("settings-clear-confirm")).toHaveCount(0);
  expect(await memoryRow()).not.toBeNull();

  await page.getByTestId("settings-clear").click();
  await page.getByTestId("settings-clear-yes").click();
  await expect(page.getByTestId("settings-clear-done")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("settings-clear-error")).toHaveCount(0);
  await expect.poll(async () => (await memoryRow()) === null, { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect(page.getByTestId("settings-empty")).toBeVisible();
  await expect(page.getByTestId("settings-clear")).toHaveCount(0);

  await page.goto(`${baseURL}/books/new`);
  await expect(page.getByTestId("create-book")).toBeVisible();
  await expect(page.getByTestId("new-book-from-memory")).toHaveCount(0);
});

test("ar. Arabic book: native Arabic captions pass the pre-check; preview dir=auto lang=ar Cairo; memory cleared", async () => {
  const bookAr = await createBookAt(baseURL, { lang: "ar" });
  const files = synth.slice(1, 7);
  await uploadAndWaitSummary(files, files.length);
  await buildToReview();

  const book = await bookRow(bookAr);
  const runs = await runsFor(bookAr);
  const steps = await stepsFor(runs[0].id);
  const story = steps.filter((s) => s.agent === "storyteller");
  const writers = steps.filter((s) => s.agent === "caption_writer");
  const st = captionStats(book.doc);
  const ctx = buildCaptionContext({ lang: "ar", bookTitle: book.title, chapters: chaptersOf(book.doc) });
  let issues = 0;
  const codes: Record<string, number> = {};
  for (const p of pagesOf(book.doc)) {
    if (!p.caption) continue;
    for (const i of checkCaption(p.caption.text, ctx)) {
      issues++;
      codes[i.code] = (codes[i.code] ?? 0) + 1;
    }
  }
  const fonts = [...new Set(pagesOf(book.doc).flatMap((p) => (p.caption ? [p.caption.font] : [])))];
  console.log(
    `[ar] lang=${book.caption_lang} run=${runs[0].ai_status} ${JSON.stringify(st)} precheckIssues=${issues} ${JSON.stringify(codes)} captionFonts=${fonts.join(",")} storyMemoryKeys=${story.map((s) => memoryKeysOfStep(s).length).join(",")} writerMemoryKeys=${writers.map((s) => memoryKeysOfStep(s).length).join(",")}`,
  );
  expect(book.caption_lang).toBe("ar");
  expect(runs[0]).toMatchObject({ mode: "replay", state: "done", ai_status: "ok" });
  expect(st.captionable).toBeGreaterThan(0);
  expect(st.captionableWithCaption).toBe(st.captionable);
  expect(st.ai).toBe(st.withCaption);
  expect(st.over18).toBe(0);
  expect(issues).toBe(0);
  // The style's Arabic caption face: Cairo in Classic, Amiri in Modern (the form default since A12).
  expect(fonts).toEqual([styleCaptionFont(book.design_style, "ar")]);
  // Memory was cleared in "s" → nothing injected.
  expect(story.every((s) => memoryKeysOfStep(s).length === 0)).toBe(true);
  expect(writers.every((s) => memoryKeysOfStep(s).length === 0)).toBe(true);
  const rows = await photoRows(bookAr);
  expectValidDoc(book.doc, new Set(rows.filter((r) => r.status !== "dropped").map((r) => r.id)), book.max_pages ?? 20, "ar");

  const count = await openCaptionsPreview();
  expect(count).toBe(`Captions (${st.captionable})`);
  const attrs = await page.getByTestId("captions-text").evaluateAll((els) =>
    els.map((e) => ({ dir: e.getAttribute("dir"), lang: e.getAttribute("lang"), font: getComputedStyle(e).fontFamily, rtl: getComputedStyle(e).direction })),
  );
  const ok = attrs.filter((a) => a.dir === "auto" && a.lang === "ar" && /cairo/i.test(a.font)).length;
  const rtl = attrs.filter((a) => a.rtl === "rtl").length;
  await page.evaluate(() => document.fonts.ready);
  const cairoLoaded = await page.evaluate(() => [...document.fonts].some((f) => /cairo/i.test(f.family) && f.status === "loaded"));
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(`[ar] preview items=${attrs.length} dirAutoLangArCairo=${ok} rtl=${rtl} cairoLoaded=${cairoLoaded} scrollWidth=${sw}`);
  expect(attrs.length).toBe(st.captionable);
  expect(ok).toBe(attrs.length);
  await expect(page.getByTestId("review-banner-captions_missing")).toHaveCount(0);
  await expect(page.getByTestId("review-banner-partial")).toHaveCount(0);
  expect(rtl).toBe(attrs.length);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);
});

test("p. plant_bad_caption: pre-check + Critic catch the planted captions, one repair round, clean doc", async () => {
  test.skip(!PLANT_URL, "set E2E_PLANT_URL (server with AI_REPLAY_SCENARIO=plant_bad_caption)");
  const bookP = await createBookAt(PLANT_URL);
  const files = synth.slice(0, 7);
  await uploadAndWaitSummary(files, files.length);
  await buildToReview();

  const book = await bookRow(bookP);
  const runs = await runsFor(bookP);
  const run = runs[0];
  const steps = await stepsFor(run.id);
  const writers = steps.filter((s) => s.agent === "caption_writer");
  const repairs = writers.filter((s) => s.step_key.startsWith("caption_writer:repair:"));
  const critic = steps.filter((s) => s.agent === "critic");
  const criticOut = JSON.stringify(critic.map((s) => s.output));
  const pages = pagesOf(book.doc);
  const planted = pages.filter((p) => isPlantedMismatch(p.caption?.text)).length;
  const precheckPlanted = pages.filter((p) => p.caption?.text === PLANTED_PRECHECK_TEXT.en || p.caption?.text === PLANTED_PRECHECK_TEXT.ar).length;
  const st = captionStats(book.doc);
  const stepSum = steps.reduce((a, s) => a + Number(s.cost_usd), 0);
  console.log(
    `[p] run=${run.state}/${run.ai_status} book=${book.ai_status} steps=${steps.map((s) => `${s.step_key}:${s.status}`).join(",")} criticFlagsMismatch=${criticOut.includes("caption_mismatch")} criticScore=${run.critic_score !== null} planted=${planted} precheckPlanted=${precheckPlanted} ${JSON.stringify(st)} total=${Number(run.total_cost_usd)} stepSum=${stepSum.toFixed(6)}`,
  );
  expect(run).toMatchObject({ mode: "replay", state: "done", ai_status: "ok" });
  expect(book.ai_status).toBe("done");
  expect(repairs.length).toBeGreaterThanOrEqual(1);
  expect(writers.every((s) => s.status === "ok")).toBe(true);
  expect(critic.map((s) => s.status)).toEqual(["ok"]);
  expect(criticOut.includes("caption_mismatch")).toBe(true);
  expect(hasKey(critic.map((s) => s.output), "detail")).toBe(false);
  expect(planted).toBe(0);
  expect(precheckPlanted).toBe(0);
  expect(st.over18).toBe(0);
  expect(st.ai).toBe(st.withCaption);
  expect(Math.abs(Number(run.total_cost_usd) - stepSum)).toBeLessThan(0.0001);
  const rows = await photoRows(bookP);
  expectValidDoc(book.doc, new Set(rows.filter((r) => r.status !== "dropped").map((r) => r.id)), book.max_pages ?? 20, "p");
  await expect(page.getByTestId("review-banner-partial")).toHaveCount(0);
  await expect(page.getByTestId("review-banner-captions_missing")).toHaveCount(0);
  await expect(page.getByTestId("rebuild-button")).toHaveText("Redo with AI");
});

test("k. Critic refusal only: captions kept, critic refused, run partial, rule fallback not needed", async () => {
  test.skip(!CRITIC_REFUSAL_URL, "set E2E_CRITIC_REFUSAL_URL (app copy with a refusing critic.ok.json fixture)");
  const bookK = await createBookAt(CRITIC_REFUSAL_URL);
  const files = synth.slice(2, 7);
  await uploadAndWaitSummary(files, files.length);
  await buildToReview();

  const book = await bookRow(bookK);
  const runs = await runsFor(bookK);
  const run = runs[0];
  const steps = await stepsFor(run.id);
  const critic = steps.filter((s) => s.agent === "critic");
  const writers = steps.filter((s) => s.agent === "caption_writer");
  const st = captionStats(book.doc);
  console.log(
    `[k] run=${run.state}/${run.ai_status} error_code=${run.error_code} book=${book.ai_status} generator=${String(metaOf(book.doc).generator)} critic=${critic.map((s) => s.status).join(",")} writers=${writers.map((s) => s.status).join(",")} criticScore=${run.critic_score !== null} ${JSON.stringify(st)}`,
  );
  expect(run).toMatchObject({ mode: "replay", state: "done", ai_status: "partial", error_code: "critic_refusal" });
  // SF5: a Critic-only failure keeps the RUN partial (admin) but the book follows its captions.
  expect(book.ai_status).toBe("done");
  expect(metaOf(book.doc).generator).toBe("ai");
  expect(critic.length).toBeGreaterThanOrEqual(1);
  expect(critic.every((s) => s.status === "refused")).toBe(true);
  expect(run.critic_score).toBeNull();
  expect(writers.every((s) => s.status === "ok")).toBe(true);
  expect(st.captionableWithCaption).toBe(st.captionable);
  const rows = await photoRows(bookK);
  expectValidDoc(book.doc, new Set(rows.filter((r) => r.status !== "dropped").map((r) => r.id)), book.max_pages ?? 20, "k");
  // SF5: AI album used and every caption present → no "simple rules" / captions banner.
  await expect(page.getByTestId("review-banner-partial")).toHaveCount(0);
  await expect(page.getByTestId("review-banner-captions_missing")).toHaveCount(0);
  await expect(page.getByTestId("rebuild-button")).toHaveText("Redo with AI"); // book done → rebuild variant
});

test("d. refusal scenario: rule album, failed/partial banner, Try AI again", async () => {
  test.skip(!REFUSAL_URL, "set E2E_REFUSAL_URL (server with AI_REPLAY_SCENARIO=refusal)");
  const bookB = await createBookAt(REFUSAL_URL);
  const files = [fixture("screenshot.png", "image/png"), ...synth.slice(0, 4)];
  await uploadAndWaitSummary(files, files.length);
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 180_000 });

  const book = await bookRow(bookB);
  const meta = metaOf(book.doc);
  const runs = await runsFor(bookB);
  expect(runs.length).toBe(1);
  const steps = await stepsFor(runs[0].id);
  const refused = steps.filter((s) => s.status === "refused").length;
  const rows = await photoRows(bookB);
  const png = rows.find((r) => r.original_mime === "image/png")!;
  console.log(
    `[d] run mode=${runs[0].mode} state=${runs[0].state} ai_status=${runs[0].ai_status} error_code=${runs[0].error_code}; book ai_status=${book.ai_status} generator=${String(meta.generator)}; steps=${steps.length} refused=${refused}; pngDropped=${png.status === "dropped"}/${png.drop_reason}; withNotes=${rows.filter((r) => r.ai !== null).length}`,
  );
  expect(runs[0]).toMatchObject({ mode: "replay", state: "done" });
  expect(["partial", "failed"]).toContain(runs[0].ai_status);
  expect(["partial", "failed"]).toContain(book.ai_status);
  expect(meta.generator).toBe("rule");
  expect(refused).toBeGreaterThanOrEqual(1);
  expect(png).toMatchObject({ status: "dropped", drop_reason: "screenshot" }); // rule fallback
  expectValidDoc(book.doc, new Set(rows.filter((r) => r.status !== "dropped").map((r) => r.id)), book.max_pages ?? 20, "d");

  // M4: rule album → no captions, one skipped caption_writer step (reason rule_album), no Critic.
  const skippedCaption = steps.filter((s) => s.agent === "caption_writer" && s.status === "skipped");
  const reasons = skippedCaption.map((s) => String((s.input_summary as { reason?: unknown } | null)?.reason));
  const stD = captionStats(book.doc);
  console.log(`[d] captionSteps=${steps.filter((s) => s.agent === "caption_writer").length} skippedReasons=${reasons.join(",")} critic=${steps.filter((s) => s.agent === "critic").length} ${JSON.stringify(stD)}`);
  expect(reasons).toEqual(["rule_album"]);
  expect(steps.filter((s) => s.agent === "caption_writer").length).toBe(1);
  expect(steps.filter((s) => s.agent === "critic").length).toBe(0);
  expect(stD.withCaption).toBe(0);
  const countD = await openCaptionsPreview();
  const missingD = (await page.getByTestId("captions-missing").count()) ? await page.getByTestId("captions-missing").textContent() : null;
  console.log(`[d] preview=${countD ?? "absent"} missing=${missingD ?? "none"}`);
  if (stD.captionable === 0) expect(countD).toBeNull();
  else {
    expect(countD).toBe("Captions (0)");
    expect(missingD).toBe(stD.captionable === 1 ? "1 page has no caption yet" : `${stD.captionable} pages have no caption yet`);
  }
  await page.reload();

  const banner = book.ai_status === "failed" ? "review-banner-failed" : "review-banner-partial";
  await expect(page.getByTestId(banner)).toBeVisible();
  await expect(page.getByTestId("rebuild-button")).toHaveText("Try AI again");
  await expect(page.getByTestId("review-header")).toHaveText(
    book.ai_status === "failed"
      ? `Kept ${rows.filter((r) => r.status !== "dropped").length} of ${rows.length}`
      : `AI kept ${rows.filter((r) => r.status !== "dropped").length} of ${rows.length}`,
  );
});

test("e. AI off: Build my album → straight to review, rule album, ai_off banner, Try AI disabled", async () => {
  test.skip(!OFF_URL, "set E2E_OFF_URL (server with AI_MODE=off)");
  const bookC = await createBookAt(OFF_URL);
  const files = [fixture("screenshot.png", "image/png"), ...synth.slice(2, 5)];
  await uploadAndWaitSummary(files, files.length);
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 60_000 });

  await expect(page.getByTestId("review-banner-ai_off")).toBeVisible();
  await expect(page.getByTestId("try-ai-disabled")).toBeVisible();
  await expect(page.getByTestId("try-ai-disabled")).toBeDisabled();
  const rows = await photoRows(bookC);
  const kept = rows.filter((r) => r.status !== "dropped").length;
  await expect(page.getByTestId("review-header")).toHaveText(`Kept ${kept} of ${rows.length}`);

  const runs = await runsFor(bookC);
  const book = await bookRow(bookC);
  const steps = runs.length ? await stepsFor(runs[0].id) : [];
  console.log(
    `[e] runs=${runs.length} mode=${runs[0]?.mode} state=${runs[0]?.state} ai_status=${runs[0]?.ai_status}; steps=${steps.length}; book ai_status=${book.ai_status} generator=${String(metaOf(book.doc).generator)}; withNotes=${rows.filter((r) => r.ai !== null).length}`,
  );
  expect(runs.length).toBe(1);
  expect(runs[0]).toMatchObject({ mode: "rule", state: "done", ai_status: null });
  expect(steps.length).toBe(0);
  expect(metaOf(book.doc).generator).toBe("rule");
  expect(metaOf(book.doc).runId).toBe(runs[0].id);
  expect(book.ai_status).toBe("idle");
  expect(rows.every((r) => r.ai === null)).toBe(true);
  expectValidDoc(book.doc, new Set(rows.filter((r) => r.status !== "dropped").map((r) => r.id)), book.max_pages ?? 20, "e");
  // M4: rule album (AI off) → no captions; the preview is absent or "Captions (0)" + missing line.
  const stE = captionStats(book.doc);
  const countE = await openCaptionsPreview();
  const missingE = (await page.getByTestId("captions-missing").count()) ? await page.getByTestId("captions-missing").textContent() : null;
  console.log(`[e] ${JSON.stringify(stE)} preview=${countE ?? "absent"} missing=${missingE ?? "none"}`);
  expect(stE.withCaption).toBe(0);
  if (stE.captionable === 0) expect(countE).toBeNull();
  else {
    expect(countE).toBe("Captions (0)");
    expect(missingE).toBe(stE.captionable === 1 ? "1 page has no caption yet" : `${stE.captionable} pages have no caption yet`);
  }

  // Rule-mode POST /api/ai/runs is limited to 1 per 10 s per book → immediately 429 'rate'.
  const limited = await postRun(bookC, "rebuild");
  console.log(`[e] immediate rebuild status=${limited.status} limit=${String(limited.body.limit)}`);
  expect(limited.status).toBe(429);
  expect(limited.body).toMatchObject({ error: "limit", limit: "rate" });
  await page.waitForTimeout(11_000);
  // "Rebuild album" in off mode re-runs the rules in place.
  await expect(page.getByTestId("rebuild-button")).toHaveText("Rebuild album");
  await page.getByTestId("rebuild-button").click();
  await expect(page.getByTestId("rebuild-button")).toHaveText("Rebuilding…");
  await expect(page.getByTestId("rebuild-button")).toBeDisabled();
  // fix-ai-off-rebuild: the refresh under review/loading.tsx used to stay pending forever (lost React
  // ping) → "Rebuilding…" never cleared. Now the refresh commits: done line, button usable again.
  await expect(page.getByTestId("rebuild-done")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("rebuild-button")).toHaveText("Rebuild album");
  await expect(page.getByTestId("rebuild-button")).toBeEnabled();
  await expect(page.getByTestId("rebuild-error")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(`/books/${bookC}/review`);
  const runs2 = await runsFor(bookC);
  expect(runs2.length).toBe(2);
  expect(runs2[1]).toMatchObject({ mode: "rule", trigger: "rebuild", state: "done" });
  expect(metaOf((await bookRow(bookC)).doc).runId).toBe(runs2[1].id);
  await expect(page.getByTestId("review-header")).toHaveText(`Kept ${kept} of ${rows.length}`);
});
