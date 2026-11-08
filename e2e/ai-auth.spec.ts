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
import { parseBookDoc, validateBookDoc } from "../src/lib/book/schema";

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
const FIXED_UID = process.env.E2E_USER_ID ?? "";
const IS_ADMIN = process.env.E2E_ADMIN === "1" && !!FIXED_UID;
const USER_EDITED_MSG = "You've edited this album, so we won't rebuild it over your changes.";

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
    .select("doc, ai_status, max_pages, page_count, updated_at")
    .eq("id", bookId)
    .single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as { doc: unknown; ai_status: string; max_pages: number; page_count: number; updated_at: string };
}

type RunRow = {
  id: string;
  trigger: string;
  mode: string;
  state: string;
  ai_status: string | null;
  error_code: string | null;
  total_cost_usd: number | string;
  started_at: string;
  finished_at: string | null;
};

async function runsFor(bookId: string): Promise<RunRow[]> {
  const { data, error } = await admin
    .from("agent_runs")
    .select("id, trigger, mode, state, ai_status, error_code, total_cost_usd, started_at, finished_at")
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

async function createBookAt(base: string): Promise<string> {
  await page.goto(`${base}/books/new`);
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await expect(page.getByTestId("occasion-travel")).toBeChecked();
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
  });
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

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test.beforeAll(async ({ browser }, info) => {
  baseURL = String(info.project.use.baseURL ?? "");
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  admin = createClient(url, env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  email = `e2e+m3-${randomBytes(6).toString("hex")}@example.com`;
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
    const w = window as unknown as { __buildStates: string[] };
    w.__buildStates = [];
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="build-progress"]');
      const s = el?.getAttribute("data-state");
      if (s && w.__buildStates[w.__buildStates.length - 1] !== s) w.__buildStates.push(s);
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
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
  bookA = await createBookAt(baseURL);
  await uploadAndWaitSummary(mainFiles, MAIN_COUNT);
  const rows = await photoRows(bookA);
  expect(rows.length).toBe(MAIN_COUNT);
  await resetBuildStates();

  const t0 = Date.now();
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/build$/, { timeout: 30_000 });
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 180_000 });
  const ms = Date.now() - t0;
  const states = await buildStates();
  console.log(`[a] build→review ms=${ms} states=${states.join(">")}`);
  expect(states.length).toBeGreaterThanOrEqual(2);
  expect(new URL(page.url()).pathname).toBe(`/books/${bookA}/review`);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(VIEWPORT.width);
});

test("b. review: header, screenshot + duplicate dropped, toggle persists; DB run/steps/doc/photos", async () => {
  const rows = await photoRows(bookA);
  const kept = rows.filter((r) => r.status !== "dropped");
  await expect(page.getByTestId("review-header")).toHaveText(`AI kept ${kept.length} of ${rows.length}`);
  await expect(page.getByTestId("review-banner-partial")).toHaveCount(0);
  await expect(page.getByTestId("review-banner-failed")).toHaveCount(0);
  await expect(page.getByTestId("rebuild-button")).toHaveText("Rebuild album");

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
  expect(caption.map((s) => s.status)).toEqual(["skipped"]);
  expect(critic.map((s) => s.status)).toEqual(["skipped"]);
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
  console.log(`[c] toggled photo in doc=${inDoc}`);
  expect(inDoc).toBe(true);
  await expect(page.getByTestId("review-header")).toHaveText(`AI kept ${keptIds.size} of ${rows.length}`);
});

test("f. userEdited guard: rebuild refused 409 user_edited, message shown, doc unchanged", async () => {
  const before = await bookRow(bookA);
  const doc = before.doc as Record<string, unknown>;
  const edited = { ...doc, meta: { ...metaOf(doc), userEdited: true } };
  const upd = await admin.from("books").update({ doc: edited }).eq("id", bookA);
  expect(upd.error).toBeNull();
  const snapshot = (await bookRow(bookA)).doc;
  const runsBefore = (await runsFor(bookA)).length;

  const res = await postRun(bookA, "rebuild");
  console.log(`[f] POST status=${res.status} error=${String(res.body.error)}`);
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ error: "user_edited" });

  await page.reload();
  await page.getByTestId("rebuild-button").click();
  await expect(page.getByTestId("rebuild-error")).toHaveText(USER_EDITED_MSG);
  expect(new URL(page.url()).pathname).toBe(`/books/${bookA}/review`);

  // Build screen too (no run id) → user_edited box.
  await page.goto(`/books/${bookA}/build`);
  await expect(page.getByTestId("build-user-edited")).toBeVisible({ timeout: 30_000 });

  const after = await bookRow(bookA);
  expect(after.doc).toEqual(snapshot);
  expect((await runsFor(bookA)).length).toBe(runsBefore);
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

  // "Rebuild album" in off mode re-runs the rules in place.
  await page.getByTestId("rebuild-button").click();
  await expect(page.getByTestId("rebuild-done")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(`/books/${bookC}/review`);
  const runs2 = await runsFor(bookC);
  expect(runs2.length).toBe(2);
  expect(runs2[1]).toMatchObject({ mode: "rule", trigger: "rebuild", state: "done" });
});
