/**
 * Milestone 5 — signed-in editor flow against the LIVE hosted Supabase project (opt-in).
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic: the server must run with AI_MODE=replay and no
 * ANTHROPIC_API_KEY. Like e2e/ai-auth.spec.ts it creates ONE throwaway user
 * `e2e+m5-<random>@example.com`, signs in via an admin generateLink token_hash (no email), and in
 * afterAll (always) removes every storage object under `<uid>/` and deletes the user.
 * Logs are counts/booleans only — never captions, titles, ids or keys.
 *
 * Migration 0900 (books.doc_rev + server-only doc columns) is deployed AFTER the code (D-036).
 * The spec detects it via the admin client:
 *   - before 0900: the editor opens read-only ("Saving unavailable" banner) and
 *     PUT /api/books/[id]/doc answers 503 saving_unavailable;
 *   - after 0900: PUT saves (200, rev bump, meta.userEdited forced, title sync), stale rev → 409,
 *     21 pages on a free book → 422 page_limit, and a direct PostgREST update of books.doc with the
 *     user's own session is a no-op (column guard).
 *
 * Example:
 *   (production build in a scratch copy) AI_MODE=replay ANTHROPIC_API_KEY= next start -p 3500
 *   E2E_AUTH=1 npx playwright test -c <config with baseURL :3500, no webServer> e2e/editor-auth.spec.ts
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live signed-in editor flow");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const BUCKET = "photos";
const VIEWPORT = { width: 375, height: 812 };

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
/** null = migration 0900 not applied (no doc_rev column). */
let docRevSupported: boolean | null = null;

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

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

/** `n` distinct, sharp JPEGs (not duplicates, not blurry) drawn in the browser. */
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
    for (let i = 0; i < count; i++) out.push(await draw(i + 101));
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `edit-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

async function bookRow(): Promise<{ doc: Record<string, unknown>; title: string | null; page_count: number; doc_rev?: number | null }> {
  const cols = docRevSupported ? "doc, title, page_count, doc_rev" : "doc, title, page_count";
  const { data, error } = await admin.from("books").select(cols).eq("id", bookId).single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as { doc: Record<string, unknown>; title: string | null; page_count: number; doc_rev?: number | null };
}

async function putDoc(doc: unknown, baseRev: number) {
  return page.evaluate(
    async ({ id, d, rev }) => {
      const res = await fetch(`/api/books/${id}/doc`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: d, baseRev: rev }),
        credentials: "same-origin",
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body };
    },
    { id: bookId, d: doc, rev: baseRev },
  );
}

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

test.beforeAll(async ({ browser }, info) => {
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Migration 0900 present? (books.doc_rev column)
  const probe = await admin.from("books").select("doc_rev").limit(1);
  docRevSupported = !probe.error;
  console.log(`[setup] migration 0900 (doc_rev) applied=${docRevSupported}${probe.error ? ` code=${probe.error.code}` : ""}`);

  email = `e2e+m5-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;

  context = await browser.newContext({ viewport: VIEWPORT, baseURL, hasTouch: true, isMobile: true });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/);
});

test.afterAll(async () => {
  if (!uid) return;
  await context?.close().catch(() => {});
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
  const left = await listAllUserObjects();
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const photos = await admin.from("photos").select("id", { count: "exact", head: true }).eq("user_id", uid);
  console.log(`[cleanup] objects removed=${removed} left=${left.length} books=${books.count} photos=${photos.count} userDeleted=${!error}`);
  expect(error).toBeNull();
  expect(left.length).toBe(0);
  expect(books.count).toBe(0);
  expect(photos.count).toBe(0);
});

test("a. build an album (replay) → review → Continue opens the editor at 375 px", async () => {
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await page.getByRole("radio", { name: /Modern/ }).check(); // D-068: travel now defaults to Geometric; this spec covers Modern.
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  bookId = new URL(page.url()).pathname.split("/")[2];

  const files = await makeSynthetic(page, 6);
  await page.getByTestId("upload-input").setInputFiles(files);
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("build-album").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/review$/, { timeout: 420_000 });

  // Dashboard: a built, never-edited book opens review.
  await page.goto("/dashboard");
  await expect(page.getByTestId("book-card")).toHaveAttribute("href", `/books/${bookId}/review`);

  await page.goto(`/books/${bookId}/review`);
  await page.getByTestId("review-continue").click();
  await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: 30_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await expect(page.getByTestId("page-counter")).toContainText("Cover");
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(VIEWPORT.width);
  const row = await bookRow();
  console.log(`[a] pages=${row.page_count}`);
  expect(row.page_count).toBeGreaterThan(0);
});

test("r. ✨ POST /api/ai/rewrite in replay → 200/502 after 0900 (503 ai_unavailable before); doc untouched", async () => {
  const before = await bookRow();
  const pages = (before.doc as { pages?: { id: string; caption: { text: string } | null }[] }).pages ?? [];
  const p = pages.find((x) => x.caption && x.caption.text.trim().length > 0) ?? pages[0];
  const text = p.caption?.text?.trim() || "A quiet walk by the sea";
  const res = await page.evaluate(
    async (body) => {
      const r = await fetch("/api/ai/rewrite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    { bookId, pageId: p.id, instruction: "rewrite", text },
  );
  console.log(`[r] status=${res.status} keys=${Object.keys(res.body).sort().join(",")}`);
  if (docRevSupported !== true) {
    // create_rewrite_run_capped ships in 0900: before it the route answers 503 ai_unavailable.
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "ai_unavailable" });
    expect(JSON.stringify((await bookRow()).doc)).toBe(JSON.stringify(before.doc));
    return;
  }
  // Replay rewrites can be judged unusable by the post-checks (502 rewrite_unusable) — both are valid contracts.
  expect([200, 502]).toContain(res.status);
  if (res.status === 200) {
    expect(typeof res.body.text).toBe("string");
    expect(["en", "ar"]).toContain(res.body.lang);
    expect(res.body.remaining === null || Number(res.body.remaining) <= 20).toBe(true);
  } else {
    expect(typeof res.body.error).toBe("string");
  }
  // The route never writes the doc (D-037 #1).
  expect(JSON.stringify((await bookRow()).doc)).toBe(JSON.stringify(before.doc));
});

test("b. before 0900: editor is read-only and PUT doc → 503 saving_unavailable", async () => {
  test.skip(docRevSupported === true, "migration 0900 is applied — see test c");
  await page.goto(`/books/${bookId}/edit`);
  await expect(page.getByTestId("save-banner-readOnly")).toBeVisible();
  await expect(page.getByTestId("save-status")).toContainText("Saving unavailable");
  await expect(page.getByTestId("editor-tool-add-page")).toHaveCount(0);

  const before = await bookRow();
  const res = await putDoc(before.doc, 0);
  expect(res.status).toBe(503);
  expect(res.body).toMatchObject({ error: "saving_unavailable" });
  expect(JSON.stringify((await bookRow()).doc)).toBe(JSON.stringify(before.doc));

  // Done on a read-only editor goes straight to the dashboard.
  await page.getByTestId("editor-done").click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("c. after 0900: save 200 + rev bump + persisted; 409 stale; 422 page_limit; direct PostgREST doc update is a no-op", async () => {
  test.skip(docRevSupported !== true, "migration 0900 not applied yet — saving is unavailable (test b covers it)");
  const before = await bookRow();
  const rev0 = Number(before.doc_rev);
  const doc = structuredClone(before.doc) as { cover: { title: string }; pages: unknown[]; meta?: Record<string, unknown> };
  doc.cover.title = "E2E edited title";
  if (doc.meta) doc.meta.userEdited = false; // server must force true

  const ok = await putDoc(doc, rev0);
  expect(ok.status).toBe(200);
  expect(Number(ok.body.rev)).toBeGreaterThan(rev0);
  const after = await bookRow();
  expect(Number(after.doc_rev)).toBe(Number(ok.body.rev));
  expect(after.title).toBe("E2E edited title");
  expect((after.doc as { meta?: { userEdited?: boolean } }).meta?.userEdited).toBe(true);

  // M12 T3: re-sending the SAME doc on rev0 is an identical replay of the save that made rev0 + 1
  // (its response may have been lost) → 200 with that rev, nothing written again.
  const replay = await putDoc(doc, rev0);
  expect(replay.status).toBe(200);
  expect(Number(replay.body.rev)).toBe(Number(ok.body.rev));
  expect(Number((await bookRow()).doc_rev)).toBe(Number(ok.body.rev));

  // A DIFFERENT doc on the stale rev is a real conflict.
  const changed = structuredClone(doc);
  changed.cover.title = "E2E stale tab title";
  const stale = await putDoc(changed, rev0);
  expect(stale.status).toBe(409);
  expect(stale.body).toMatchObject({ error: "conflict" });
  expect((await bookRow()).title).toBe("E2E edited title");

  const big = structuredClone(after.doc) as { pages: { id: string }[] };
  const first = big.pages[0];
  while (big.pages.length < 21) big.pages.push({ ...structuredClone(first), id: `x${big.pages.length}`, slots: [] } as never);
  const limit = await putDoc(big, Number(after.doc_rev));
  expect(limit.status).toBe(422);
  expect(limit.body).toMatchObject({ error: "page_limit" });

  // Direct PostgREST write with the user's own session must not change doc/page_count/doc_rev.
  const anon = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const v = await anon.auth.verifyOtp({ type: "magiclink", token_hash: await signInHash() });
  expect(v.error).toBeNull();
  const upd = await anon.from("books").update({ doc: { hacked: true }, page_count: 99, doc_rev: 1 }).eq("id", bookId).select("id");
  console.log(`[c] direct update error=${upd.error?.code ?? "none"} rows=${upd.data?.length ?? 0}`);
  const final = await bookRow();
  expect(JSON.stringify(final.doc)).toBe(JSON.stringify(after.doc));
  expect(final.page_count).toBe(after.page_count);
  expect(Number(final.doc_rev)).toBe(Number(after.doc_rev));
  // scope "local": the default "global" sign-out would also end the browser session.
  await anon.auth.signOut({ scope: "local" }).catch(() => {});

  // Edited book → dashboard card opens the editor.
  await page.goto("/dashboard");
  await expect(page.getByTestId("book-card")).toHaveAttribute("href", `/books/${bookId}/edit`);
});

test("d. after 0900: edit the cover title in the UI → Saved ✓ → DB + Done → publish screen", async () => {
  test.skip(docRevSupported !== true, "migration 0900 not applied yet");
  await page.goto(`/books/${bookId}/edit`);
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  // Post-0900 counterpart of test b: the editor is editable, no read-only banner.
  await expect(page.getByTestId("save-banner-readOnly")).toHaveCount(0);
  await expect(page.getByTestId("save-banner-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("editor-tool-add-page")).toBeVisible();
  await page.getByTestId("cover-text-target").click();
  await page.getByTestId("cover-title-input").fill("عطلتنا");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  await expect.poll(async () => (await bookRow()).title, { timeout: 10_000 }).toBe("عطلتنا");
  await page.getByTestId("editor-panel-close").click();
  await page.getByTestId("editor-done").click();
  // M6 (D-040): Done opens the publish step.
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
});
