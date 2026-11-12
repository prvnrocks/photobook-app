/**
 * Milestone 12 — Reliability gate against the LIVE hosted Supabase project (opt-in), 375 px phone.
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic (server: AI_MODE=replay, empty ANTHROPIC_API_KEY).
 * Faults are injected in the browser with page.route — the server and Supabase are untouched:
 *   a. one browser storage upload (a thumb) is HELD past the browser deadline budget
 *      (src/lib/supabase/deadline.ts: 30 s + bytes at 16 KB/s) → the deadline fetch answers a
 *      synthetic 504 SUPABASE_TIMEOUT → the upload queue retries → every photo ends ready with its
 *      3 storage objects → finalize writes the album → Build my album reaches review.
 *   b. the first POST /api/books/:id/finalize answers 503 + Retry-After → the upload screen keeps
 *      "finalizing", waits and calls again by itself → summary, no finalize error.
 *   c. the first POST /api/ai/runs/:id/advance answers 503 + Retry-After → the build screen shows
 *      "Taking longer than usual — retrying…" (data-cause=server) and finishes on review.
 *   d. editor autosave: the first doc PUT reaches the server (route.fetch → applied) but its
 *      response is lost (route.abort) → the client's retry is an identical replay → 200, never
 *      "Changed in another tab"; doc_rev bumped exactly once; the next edit saves normally.
 *   e. editor autosave: the first doc PUT answers 503 {error:"unavailable"} + Retry-After (a Supabase
 *      timeout) → "Saving delayed – retrying", the editor stays editable (not read-only), then saves.
 * (Server-side timeouts never answering a login redirect are covered by vitest:
 *  tests/m12-timeout-routes.test.ts, tests/supabase-middleware.test.ts.)
 *
 * One throwaway user `e2e+m12-<random>@example.com` (admin generateLink sign-in, no email).
 * afterAll (always): storage objects under `<uid>/`, the user (books/photos cascade), then the
 * replay agent_runs this user created (D-027 would keep them detached; replay runs cost $0, so the
 * gate removes its own orphans; agent_steps cascade). Logs: counts / booleans / statuses only.
 *
 * Example:
 *   (scratch copy) NEXT_PUBLIC_APP_URL=http://localhost:3410 ANTHROPIC_API_KEY= next build
 *   AI_MODE=replay ANTHROPIC_API_KEY= NEXT_PUBLIC_APP_URL=http://localhost:3410 next start -p 3410
 *   E2E_AUTH=1 npx playwright test -c <config: baseURL :3410, no webServer> e2e/m12-reliability.spec.ts
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live M12 reliability flow");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const BUCKET = "photos";
const VIEWPORT = { width: 375, height: 812 };
const RETRY_COPY = "Taking longer than usual — retrying…";

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

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
let book1 = "";
let book2 = "";
const runIds = new Set<string>();

async function signInHash(): Promise<string> {
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

async function makeSynthetic(p: Page, n: number, seedBase: number): Promise<FileSpec[]> {
  const list = await p.evaluate(
    async ({ count, base }) => {
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
      for (let i = 0; i < count; i++) out.push(await draw(base + i));
      return out;
    },
    { count: n, base: seedBase },
  );
  return list.map((b64, i) => ({ name: `m12-${seedBase + i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

async function createBook(): Promise<string> {
  await page.goto("/books/new");
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await page.getByRole("radio", { name: /Modern/ }).check(); // D-068: travel defaults to Geometric; Modern keeps captions simple.
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split("/")[2];
  await expect(page.getByTestId("upload-pick")).toBeVisible();
  return id;
}

async function photoRows(bookId: string) {
  const { data, error } = await admin
    .from("photos")
    .select("id, upload_state, original_path, web_path, thumb_path")
    .eq("book_id", bookId);
  if (error) throw new Error(`photos select failed (${error.code})`);
  return data ?? [];
}

async function bookRow(bookId: string) {
  const { data, error } = await admin.from("books").select("doc, doc_rev, page_count").eq("id", bookId).single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as { doc: { pages?: { caption?: { text?: string } | null }[] } | null; doc_rev: number; page_count: number };
}

async function runsOf(bookId: string) {
  const { data, error } = await admin.from("agent_runs").select("id, state, mode, trigger").eq("book_id", bookId);
  if (error) throw new Error(`agent_runs select failed (${error.code})`);
  for (const r of data ?? []) runIds.add(r.id);
  return data ?? [];
}

async function noHorizontalOverflow() {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);
}

/** M11 loading.tsx: /review is in the URL before the review content streams in. */
async function reviewLoaded() {
  await expect(page.getByRole("status").filter({ hasText: "Loading your album…" })).toHaveCount(0, { timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, info) => {
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  email = `e2e+m12-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;

  context = await browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true });
  // Record every save-status / build-progress state the page ever shows (client navigations keep window).
  await context.addInitScript(() => {
    const w = window as unknown as { __saveStates: string[]; __buildCauses: string[] };
    w.__saveStates = [];
    w.__buildCauses = [];
    new MutationObserver(() => {
      const s = document.querySelector('[data-testid="save-status"]')?.getAttribute("data-state");
      if (s && w.__saveStates[w.__saveStates.length - 1] !== s) w.__saveStates.push(s);
      const c = document.querySelector('[data-testid="build-reconnecting"]')?.getAttribute("data-cause");
      if (c && w.__buildCauses[w.__buildCauses.length - 1] !== c) w.__buildCauses.push(c);
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "data-cause"] });
  });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/);
});

test.afterAll(async () => {
  if (!uid) return;
  await context?.close().catch(() => {});
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

  // Replay orphans of this user (detached by the delete): remove them; steps cascade.
  const ids = [...runIds];
  let runsLeft = 0;
  if (ids.length) {
    const del = await admin.from("agent_runs").delete().in("id", ids);
    if (del.error) console.log(`[cleanup] agent_runs delete error (${del.error.code})`);
    const r = await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", ids);
    runsLeft = r.count ?? -1;
  }
  const left = await listAllUserObjects();
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const photos = await admin.from("photos").select("id", { count: "exact", head: true }).eq("user_id", uid);
  console.log(
    `[cleanup] objects removed=${removed} left=${left.length} books=${books.count} photos=${photos.count} runs created=${ids.length} runsLeft=${runsLeft} userDeleted=${!error}`,
  );
  expect(error).toBeNull();
  expect(left.length).toBe(0);
  expect(books.count).toBe(0);
  expect(photos.count).toBe(0);
  expect(runsLeft).toBe(0);
});

test("a. a held storage upload hits its budget → queue retries → upload, finalize and build continue", async () => {
  test.setTimeout(480_000);
  book1 = await createBook();

  // Hold the FIRST thumb upload forever (never answered): only the browser deadline can end it.
  let heldAt = 0;
  let heldUrl = "";
  let retriedAt = 0;
  const thumbPosts: string[] = [];
  const held: Route[] = [];
  await page.route("**/storage/v1/object/photos/**", async (route) => {
    const req = route.request();
    const url = req.url();
    if ((req.method() === "POST" || req.method() === "PUT") && url.includes("-thumb.")) {
      thumbPosts.push(url);
      if (!heldUrl) {
        heldUrl = url;
        heldAt = Date.now();
        held.push(route);
        return; // never answered
      }
      if (url === heldUrl && !retriedAt) retriedAt = Date.now();
    }
    await route.continue();
  });
  let uploadFailures = 0;
  page.on("requestfailed", (r) => {
    if (r.url().includes("/storage/v1/object/photos/")) uploadFailures++;
  });

  const files = await makeSynthetic(page, 4, 201);
  await page.getByTestId("upload-input").setInputFiles(files);
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("finalize-error")).toHaveCount(0);
  await expect(page.getByTestId("summary-failed")).toHaveCount(0);
  await expect(page.getByTestId("summary-added")).toHaveText("4 photos added");
  await noHorizontalOverflow();
  await page.unroute("**/storage/v1/object/photos/**");

  const heldMs = retriedAt && heldAt ? retriedAt - heldAt : -1;
  console.log(
    `[a] thumbPosts=${thumbPosts.length} held=${held.length} retriedSameObject=${retriedAt > 0} heldToRetryMs=${heldMs} browserFailedUploads=${uploadFailures}`,
  );
  expect(held.length).toBe(1);
  expect(retriedAt).toBeGreaterThan(0);
  // The browser upload budget is ≥ 30 s (deadline.ts); the retry comes after the deadline + queue back-off.
  expect(heldMs).toBeGreaterThanOrEqual(29_000);
  expect(heldMs).toBeLessThan(150_000);

  const rows = await photoRows(book1);
  const ready = rows.filter((r) => r.upload_state === "ready").length;
  const objects = new Set(
    ((await admin.storage.from(BUCKET).list(`${uid}/${book1}`, { limit: 1000 })).data ?? []).map((o) => `${uid}/${book1}/${o.name}`),
  );
  const missing = rows.flatMap((r) => [r.original_path, r.web_path, r.thumb_path]).filter((p) => !p || !objects.has(p)).length;
  console.log(`[a] rows=${rows.length} ready=${ready} objects=${objects.size} missing=${missing}`);
  expect(rows.length).toBe(4);
  expect(ready).toBe(4);
  expect(objects.size).toBe(12);
  expect(missing).toBe(0);
  const row = await bookRow(book1);
  expect((row.doc?.pages ?? []).length).toBeGreaterThan(0); // finalize wrote the fallback album

  // Build continues (replay) to the editor (M13 T7).
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/build$/, { timeout: 30_000 });
  // M13 T7: the build hands over to the editor.
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/edit$/, { timeout: 240_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 30_000 });
  const runs = await runsOf(book1);
  console.log(`[a] runs=${runs.length} states=${runs.map((r) => r.state).join(",")} modes=${runs.map((r) => r.mode).join(",")}`);
  expect(runs.some((r) => r.state === "done")).toBe(true);
});

test("b. finalize answers 503 + Retry-After once → the upload screen waits and continues by itself", async () => {
  test.setTimeout(300_000);
  book2 = await createBook();

  const finalizeCalls: { at: number; status: number }[] = [];
  await page.route(`**/api/books/${book2}/finalize`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (finalizeCalls.length === 0) {
      finalizeCalls.push({ at: Date.now(), status: 503 });
      return route.fulfill({
        status: 503,
        headers: { "retry-after": "3", "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ error: "unavailable" }),
      });
    }
    const res = await route.fetch();
    finalizeCalls.push({ at: Date.now(), status: res.status() });
    return route.fulfill({ response: res });
  });

  await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 4, 301));
  // While the client waits out the 503 the screen stays in "finalizing" (no error, no retry button).
  await expect.poll(() => finalizeCalls.length, { timeout: 180_000, intervals: [250] }).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("upload-finalizing")).toBeVisible();
  await expect(page.getByTestId("finalize-error")).toHaveCount(0);
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("finalize-error")).toHaveCount(0);
  await expect(page.getByTestId("finalize-retry")).toHaveCount(0);
  await expect(page.getByTestId("summary-added")).toHaveText("4 photos added");
  await page.unroute(`**/api/books/${book2}/finalize`);

  const gap = finalizeCalls.length >= 2 ? finalizeCalls[1].at - finalizeCalls[0].at : -1;
  console.log(`[b] finalize calls=${finalizeCalls.length} statuses=${finalizeCalls.map((c) => c.status).join(",")} gapMs=${gap}`);
  expect(finalizeCalls[0].status).toBe(503);
  expect(finalizeCalls.length).toBeGreaterThanOrEqual(2);
  expect(finalizeCalls[1].status).toBe(200);
  expect(gap).toBeGreaterThanOrEqual(2_900); // honoured Retry-After: 3
  expect((((await bookRow(book2)).doc?.pages) ?? []).length).toBeGreaterThan(0);
});

test("c. advance answers 503 once → build shows 'Taking longer than usual — retrying…' and finishes", async () => {
  test.setTimeout(300_000);
  let advanceCalls = 0;
  let injected = 0;
  await page.route("**/api/ai/runs/*/advance", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    advanceCalls++;
    if (injected === 0) {
      injected++;
      return route.fulfill({
        status: 503,
        headers: { "retry-after": "4", "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ error: "unavailable" }),
      });
    }
    return route.continue();
  });

  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/build$/, { timeout: 30_000 });
  const reconnecting = page.getByTestId("build-reconnecting");
  await expect(reconnecting).toBeVisible({ timeout: 60_000 });
  await expect(reconnecting).toHaveAttribute("data-cause", "server");
  await expect(reconnecting).toContainText(RETRY_COPY);
  await expect(page.getByTestId("build-error")).toHaveCount(0);
  await noHorizontalOverflow();
  // M13 T7: the build hands over to the editor.
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/edit$/, { timeout: 240_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 30_000 });
  await page.unroute("**/api/ai/runs/*/advance");

  const causes = await page.evaluate(() => (window as unknown as { __buildCauses?: string[] }).__buildCauses ?? []);
  const runs = await runsOf(book2);
  console.log(`[c] advanceCalls=${advanceCalls} injected503=${injected} causesSeen=${causes.join(",")} runs=${runs.length} states=${runs.map((r) => r.state).join(",")}`);
  expect(injected).toBe(1);
  expect(advanceCalls).toBeGreaterThanOrEqual(2);
  expect(runs.length).toBe(1); // the retry drove the same run, no second run started
  expect(runs[0].state).toBe("done");
});

test("d. autosave: the PUT is applied but its response is lost → retry accepted, never 'Changed in another tab'", async () => {
  test.setTimeout(240_000);
  await page.goto(`/books/${book1}/review`);
  await reviewLoaded();
  await page.getByTestId("review-continue").click();
  await page.waitForURL(new RegExp(`/books/${book1}/edit$`), { timeout: 30_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", /idle|saved/);
  await page.evaluate(() => {
    (window as unknown as { __saveStates: string[] }).__saveStates = [];
  });
  const rev0 = Number((await bookRow(book1)).doc_rev);

  const puts: { status: number | null; delivered: boolean }[] = [];
  await page.route(`**/api/books/${book1}/doc`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (puts.length === 0) {
      // The server gets and applies the save; the page never sees the answer.
      const res = await route.fetch();
      puts.push({ status: res.status(), delivered: false });
      return route.abort("failed");
    }
    const res = await route.fetch();
    puts.push({ status: res.status(), delivered: true });
    return route.fulfill({ response: res });
  });

  const cur = page.locator('[data-testid="carousel-item"][aria-hidden="false"]');
  let steps = 0;
  for (; steps < 25; steps++) {
    if ((await cur.getByTestId("caption-target").count()) > 0) break;
    await page.getByTestId("carousel-next").click();
    await page.waitForTimeout(400);
  }
  const target = cur.getByTestId("caption-target");
  await expect(target).toHaveCount(1);
  await target.click();
  const input = page.getByTestId("caption-input");
  await expect(input).toBeVisible();
  const CAPTION = "M12 lost response caption";
  await input.fill(CAPTION);

  await expect.poll(() => puts.length, { timeout: 60_000, intervals: [250] }).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
  const afterReplay = await bookRow(book1);
  const states1 = await page.evaluate(() => (window as unknown as { __saveStates?: string[] }).__saveStates ?? []);
  console.log(
    `[d] caption target after ${steps} steps; puts=${puts.map((p) => `${p.status}${p.delivered ? "" : "(lost)"}`).join(",")} rev0=${rev0} revAfter=${afterReplay.doc_rev} states=${states1.join(">")}`,
  );
  expect(puts[0].status).toBe(200); // the server applied the first save
  expect(puts[1].status).toBe(200); // the replay was accepted, not 409
  expect(states1).not.toContain("conflict");
  expect(states1).toContain("retrying");
  await expect(page.getByTestId("save-status")).not.toContainText("Changed in another tab");
  expect(afterReplay.doc_rev).toBe(rev0 + 1); // applied once
  expect(JSON.stringify(afterReplay.doc)).toContain(CAPTION);

  // The client's rev is right: the next edit saves normally (no conflict).
  await page.unroute(`**/api/books/${book1}/doc`);
  const CAPTION2 = "M12 next edit caption";
  await input.fill(CAPTION2);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect.poll(async () => (await bookRow(book1)).doc_rev, { timeout: 15_000 }).toBe(rev0 + 2);
  const states2 = await page.evaluate(() => (window as unknown as { __saveStates?: string[] }).__saveStates ?? []);
  expect(states2).not.toContain("conflict");
  expect(JSON.stringify((await bookRow(book1)).doc)).toContain(CAPTION2);
  await noHorizontalOverflow();
  await page.keyboard.press("Escape");
});

test("e. autosave: doc PUT answers 503 'unavailable' + Retry-After once → 'Saving delayed – retrying', stays editable, then saves", async () => {
  test.setTimeout(180_000);
  await page.goto(`/books/${book1}/edit`);
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", /idle|saved/);
  await page.evaluate(() => {
    (window as unknown as { __saveStates: string[] }).__saveStates = [];
  });
  const rev0 = Number((await bookRow(book1)).doc_rev);

  const puts: number[] = [];
  await page.route(`**/api/books/${book1}/doc`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (puts.length === 0) {
      puts.push(503);
      return route.fulfill({
        status: 503,
        headers: { "retry-after": "1", "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ error: "unavailable" }),
      });
    }
    const res = await route.fetch();
    puts.push(res.status());
    return route.fulfill({ response: res });
  });

  const cur = page.locator('[data-testid="carousel-item"][aria-hidden="false"]');
  for (let steps = 0; steps < 25; steps++) {
    if ((await cur.getByTestId("caption-target").count()) > 0) break;
    await page.getByTestId("carousel-next").click();
    await page.waitForTimeout(400);
  }
  const target = cur.getByTestId("caption-target");
  await expect(target).toHaveCount(1);
  await target.click();
  const input = page.getByTestId("caption-input");
  await expect(input).toBeVisible();
  const CAPTION3 = "M12 delayed save caption";
  await input.fill(CAPTION3);

  const status = page.getByTestId("save-status");
  await expect(status).toContainText("Saving delayed – retrying", { timeout: 30_000 });
  await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-readonly", "false");
  await expect(page.getByTestId("save-banner-unavailable")).toHaveCount(0);
  await expect(input).toBeEditable();
  await expect(status).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
  await page.unroute(`**/api/books/${book1}/doc`);

  const states = await page.evaluate(() => (window as unknown as { __saveStates?: string[] }).__saveStates ?? []);
  const row = await bookRow(book1);
  console.log(`[e] puts=${puts.join(",")} states=${states.join(">")} rev0=${rev0} revAfter=${row.doc_rev}`);
  expect(puts[0]).toBe(503);
  expect(puts[1]).toBe(200);
  expect(states).toContain("retrying");
  expect(states).not.toContain("unavailable");
  expect(states).not.toContain("conflict");
  expect(row.doc_rev).toBe(rev0 + 1);
  expect(JSON.stringify(row.doc)).toContain(CAPTION3);
  await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-readonly", "false");
  await noHorizontalOverflow();
  await page.keyboard.press("Escape");
});
