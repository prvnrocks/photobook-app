/**
 * Milestone 6 — publish → public flipbook → republish → password → expiry → unpublish, against the
 * LIVE hosted Supabase project (opt-in).
 *
 * SKIPPED unless E2E_AUTH=1. Never calls Anthropic: run the server with AI_MODE=replay and no
 * ANTHROPIC_API_KEY. Like e2e/editor-auth.spec.ts it creates ONE throwaway user
 * `e2e+m6-<random>@example.com`, signs in via an admin generateLink token_hash (no email), and in
 * afterAll (always) removes every storage object under `<uid>/` and deletes the user (books,
 * photos and unlock attempts cascade). Per-test timeouts (no --global-timeout) so afterAll runs.
 * Logs are counts/booleans only — never captions, titles, ids, slugs, passwords or keys.
 *
 * Preconditions detected in beforeAll (tests skip with a clear message instead of failing):
 *   - migration 1000 (books.published_rev / published_doc) applied on the live project;
 *   - migration 0900 (doc_rev) applied (saving);
 *   - BOOK_ACCESS_SECRET present in the env the server was started with (only presence is
 *     checked, from .env.local / process.env; the value is never printed). Without it the
 *     password tests skip.
 *
 * Example:
 *   (production build in a scratch copy) AI_MODE=replay ANTHROPIC_API_KEY= next start -p 3622
 *   E2E_AUTH=1 npx playwright test -c <config with baseURL :3622, no webServer> e2e/publish-auth.spec.ts
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import exifr from "exifr";
import { hasCaptionArea } from "../src/lib/ai/captions";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live publish/viewer flow");

if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const BUCKET = "photos";
const VIEWPORT = { width: 375, height: 812 };
const DAY = 86_400_000;
const PASSWORD = `e2e-${randomBytes(4).toString("hex")}`;
const NEW_TITLE = `Unpublished title ${randomBytes(3).toString("hex")}`;
const NEW_CAPTION = `Republished caption ${randomBytes(3).toString("hex")}`;

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
let firstExpiresAt = "";
let shareT0 = 0;
let migration1000: boolean | null = null;
let migration0900: boolean | null = null;
const hasAccessSecret = (process.env.BOOK_ACCESS_SECRET ?? "").trim().length >= 32;

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
    for (const o of inner.data ?? []) {
      if (o.id) {
        out.push(`${uid}/${entry.name}/${o.name}`);
        continue;
      }
      const deeper = await admin.storage.from(BUCKET).list(`${uid}/${entry.name}/${o.name}`, { limit: 1000 });
      for (const d of deeper.data ?? []) out.push(`${uid}/${entry.name}/${o.name}/${d.name}`);
    }
  }
  return out;
}

/** Inserts an EXIF APP1 segment with GPS lat/lng right after SOI (verified with exifr). */
function withGpsExif(jpeg: Buffer, lat: number, lng: number): Buffer {
  const t = Buffer.alloc(128);
  t.write("II", 0, "latin1");
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8); // IFD0: one entry → GPSInfo pointer
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
    for (let i = 0; i < count; i++) out.push(await draw(i + 301));
    return out;
  }, n);
  return list.map((b64, i) => {
    const raw = Buffer.from(b64, "base64");
    // Every photo carries GPS (Abu Dhabi), so whichever one the viewer shows must have lost it.
    return { name: `pub-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: withGpsExif(raw, 24.4539 + i * 0.0001, 54.3773) };
  });
}

type BookRow = {
  doc: Record<string, unknown>;
  doc_rev: number;
  slug: string | null;
  published_at: string | null;
  expires_at: string | null;
  published_rev: number | null;
  published_doc: Record<string, unknown> | null;
  is_paid: boolean;
};

async function bookRow(): Promise<BookRow> {
  const { data, error } = await admin
    .from("books")
    .select("doc, doc_rev, slug, published_at, expires_at, published_rev, published_doc, is_paid")
    .eq("id", bookId)
    .single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data as unknown as BookRow;
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
      return { status: res.status };
    },
    { id: bookId, d: doc, rev: baseRev },
  );
}

/** Fresh anonymous phone context (no cookies), optionally with its own client ip header. */
async function anonContext(browser: Browser, ip?: string): Promise<BrowserContext> {
  return browser.newContext({
    viewport: VIEWPORT,
    baseURL,
    hasTouch: true,
    isMobile: true,
    extraHTTPHeaders: ip ? { "x-forwarded-for": ip } : undefined,
  });
}

async function viewerHtml(req: APIRequestContext): Promise<{ status: number; html: string; headers: Record<string, string> }> {
  const res = await req.get(`/b/${slug}`, { maxRedirects: 0 });
  return { status: res.status(), html: await res.text(), headers: res.headers() };
}

/** HTML minus signed storage URLs (which contain the storage path by design, D-041). */
function stripSignedUrls(html: string): string {
  return html.replace(/https?:(?:\\?\/){2}[^"'\s\\]+?\/storage\/v1\/object\/sign\/[^"'\s\\]+/g, "<signed>");
}

async function noHorizontalOverflow(p: Page) {
  const { sw, cw } = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const p1000 = await admin.from("books").select("published_rev, published_doc").limit(1);
  migration1000 = !p1000.error;
  const p0900 = await admin.from("books").select("doc_rev").limit(1);
  migration0900 = !p0900.error;
  console.log(
    `[setup] migration 1000 applied=${migration1000}${p1000.error ? ` code=${p1000.error.code}` : ""} 0900=${migration0900} accessSecret=${hasAccessSecret}`,
  );
  if (!migration1000 || !migration0900) return; // every test skips; nothing to clean up

  email = `e2e+m6-${randomBytes(6).toString("hex")}@example.com`;
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
  test.setTimeout(120_000);
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
  const attempts = bookId
    ? await admin.from("book_unlock_attempts").select("book_id", { count: "exact", head: true }).eq("book_id", bookId)
    : { count: 0 };
  console.log(
    `[cleanup] objects removed=${removed} left=${left.length} books=${books.count} photos=${photos.count} attempts=${attempts.count} userDeleted=${!error}`,
  );
  expect(error).toBeNull();
  expect(left.length).toBe(0);
  expect(books.count).toBe(0);
  expect(photos.count).toBe(0);
  expect(attempts.count ?? 0).toBe(0);
});

function needMigrations() {
  test.skip(migration1000 !== true, "migration 1000 (publish snapshot) is not applied to the live project yet — run `npx supabase db push`");
  test.skip(migration0900 !== true, "migration 0900 is not applied");
}

test("a. build (replay) → editor → Share (free 30-day note) publishes and lands on the share screen", async () => {
  needMigrations();
  test.setTimeout(600_000);
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await page.getByRole("radio", { name: /Modern/ }).check(); // D-068: travel now defaults to Geometric; this spec covers Modern.
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  bookId = new URL(page.url()).pathname.split("/")[2];

  await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 6));
  // M13 T6: no Build tap — the first build starts by itself once the upload settles (≥ 5 photos).
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/build\?auto=1$/, { timeout: 180_000 });
  // The originals really carried GPS (else the EXIF check in c proves nothing).
  const gps = await admin.from("photos").select("lat").eq("book_id", bookId).not("lat", "is", null);
  console.log(`[a] photos with gps=${gps.data?.length ?? 0}`);
  expect((gps.data ?? []).length).toBeGreaterThan(0);

  // M13 T7: the build hands over to the editor (review is reached from the "AI kept X of Y" chip).
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/edit$/, { timeout: 420_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await expect(page.getByTestId("editor-publish-changes")).toHaveCount(0); // never published
  // M13 T9: the free 30-day note is on the Share button before the tap.
  await expect(page.getByTestId("editor-share-note")).toHaveText("Free · 30 days");
  expect((await bookRow()).published_doc).toBeNull();
  shareT0 = Date.now();
  await page.getByTestId("editor-done").click();
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish(\\?shared=live)?$`), { timeout: 30_000 });
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
  await expect(page.getByTestId("publish-panel")).toHaveAttribute("data-state", "published");
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`)); // ?shared= dropped
  await noHorizontalOverflow(page);
});

test("b. Share published → link shown, expires ≈ 30 days, snapshot = saved doc", async () => {
  needMigrations();
  test.skip(!bookId || !shareT0, "needs test a");
  const t0 = shareT0;
  await expect(page.getByTestId("publish-live")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("share-whatsapp")).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);
  await expect(page.getByTestId("publish-expiry")).toHaveText(/^Link expires \d{1,2} [A-Z][a-z]{2}( \d{4})?$/);
  const url = await page.getByTestId("publish-url").inputValue();
  const row = await bookRow();
  slug = row.slug ?? "";
  expect(url.endsWith(`/b/${slug}`)).toBe(true);
  expect(slug).toMatch(/^([a-z0-9-]{1,30}-)?[1-9A-HJ-NP-Za-km-z]{10}$/);
  expect(row.published_at).not.toBeNull();
  expect(row.published_rev).toBe(row.doc_rev);
  firstExpiresAt = row.expires_at ?? "";
  const exp = Date.parse(firstExpiresAt);
  expect(Math.abs(exp - (t0 + 30 * DAY))).toBeLessThan(10 * 60_000);
  const pub = JSON.stringify(row.published_doc);
  for (const k of ['"meta"', '"source"', '"place"', '"occasion"']) expect(pub, k).not.toContain(k);
  await noHorizontalOverflow(page);

  // Dashboard shows it as live.
  await page.goto("/dashboard");
  await expect(page.getByTestId("book-card").first()).toBeVisible();
});

test("b2. owner's own session cannot write publish columns; get_published_book / unlock tables are service-only", async () => {
  needMigrations();
  test.skip(!slug, "needs test b");
  const before = await bookRow();
  const user = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const v = await user.auth.verifyOtp({ type: "magiclink", token_hash: await signInHash() });
  expect(v.error).toBeNull();
  try {
    const upd = await user
      .from("books")
      .update({ published_doc: { hacked: true }, published_rev: 999, expires_at: null, password_hash: "x", is_paid: true })
      .eq("id", bookId)
      .select("id");
    console.log(`[b2] direct update error=${upd.error?.code ?? "none"} rows=${upd.data?.length ?? 0}`);
    const after = await bookRow();
    expect(JSON.stringify(after.published_doc)).toBe(JSON.stringify(before.published_doc));
    expect(after.published_rev).toBe(before.published_rev);
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.is_paid).toBe(false);
    const { data: pw } = await admin.from("books").select("password_hash").eq("id", bookId).single();
    expect((pw as { password_hash: string | null }).password_hash).toBeNull();

    const rpcUser = await user.rpc("get_published_book", { p_slug: slug });
    expect(rpcUser.error, "authenticated must not execute get_published_book").not.toBeNull();
    const att = await user.from("book_unlock_attempts").select("book_id").limit(1);
    expect(att.error !== null || (att.data ?? []).length === 0).toBe(true);
    const tryUnlock = await user.rpc("try_book_unlock", { p_book: bookId, p_ip_hash: "x", p_ip_limit: 1000, p_book_limit: 1000, p_window_s: 1 });
    expect(tryUnlock.error, "authenticated must not execute try_book_unlock").not.toBeNull();
  } finally {
    await user.auth.signOut({ scope: "local" }).catch(() => {});
  }
  const anon = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rpcAnon = await anon.rpc("get_published_book", { p_slug: slug });
  expect(rpcAnon.error, "anon must not execute get_published_book").not.toBeNull();
  const anonBooks = await anon.from("books").select("id").eq("slug", slug);
  expect(anonBooks.error !== null || (anonBooks.data ?? []).length === 0).toBe(true);
});

test("c. anonymous phone: flipbook, watermark + footer, private data absent, OG card, EXIF-free image", async ({ browser }) => {
  needMigrations();
  test.skip(!slug, "needs test b");
  const anon = await anonContext(browser);
  try {
    const v = await anon.newPage();
    const imageRequests = new Set<string>();
    v.on("request", (r) => {
      if (r.url().includes("/storage/v1/object/sign/")) imageRequests.add(r.url().split("?")[0]);
    });
    const resp = await v.goto(`/b/${slug}`);
    expect(resp?.status()).toBe(200);
    expect(resp?.headers()["x-robots-tag"]).toContain("noindex");
    expect(resp?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(v.getByTestId("flipbook")).toHaveAttribute("data-spread", "false");
    await expect(v.getByTestId("made-with-footer")).toBeVisible();
    await expect(v.getByTestId("watermark").first()).toBeVisible();
    await noHorizontalOverflow(v);
    await v.getByTestId("next-page").click();
    await expect(v.getByTestId("page-counter")).toHaveText(/^1 \/ \d+$/);
    // Signed images on the visible page actually load (not broken).
    await expect
      .poll(
        () =>
          v.locator('img[src*="/storage/v1/object/sign/"]').evaluateAll((els) =>
            els.filter((e) => {
              const i = e as HTMLImageElement;
              const r = i.getBoundingClientRect();
              return i.complete && i.naturalWidth > 0 && r.width > 0 && r.right > 0 && r.left < window.innerWidth;
            }).length,
          ),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    // All signed images are web copies, never originals/thumbs.
    const imgs = await v.locator('img[src*="/storage/v1/object/sign/"]').evaluateAll((els) =>
      els.map((e) => ({ src: (e as HTMLImageElement).src, ok: (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0 })),
    );
    console.log(`[c] signed imgs=${imgs.length} loaded=${imgs.filter((i) => i.ok).length} requests=${imageRequests.size}`);
    expect(imgs.length).toBeGreaterThan(0);
    for (const i of imgs) {
      expect(i.src).not.toMatch(/\/original|\/thumb/);
    }

    // HTML / RSC payload: no private keys; outside signed URLs no book id or user id.
    const { html } = await viewerHtml(anon.request);
    for (const k of ['"user_id"', '"userId"', '"original"', '"original_path"', '"lat"', '"lng"', '"taken_at"', '"takenAt"', '"meta"', '"ai"', '"bookId"', '"password_hash"']) {
      expect(html, k).not.toContain(k);
    }
    const stripped = stripSignedUrls(html);
    expect(stripped.includes(bookId), "book id outside signed URLs").toBe(false);
    expect(stripped.includes(uid), "user id outside signed URLs").toBe(false);

    // OG meta: absolute og:image with ?v=<rev>-0, served as a PNG < 600 KB.
    const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(og).toBeTruthy();
    expect(og!).toMatch(new RegExp(`^https?://[^/]+/b/${slug}/og\\?v=\\d+-0$`));
    expect(html).toMatch(/<meta name="twitter:card" content="summary_large_image"/);
    const ogPath = new URL(og!).pathname + new URL(og!).search;
    const png = await anon.request.get(ogPath);
    expect(png.status()).toBe(200);
    expect(png.headers()["content-type"]).toBe("image/png");
    const body = await png.body();
    console.log(`[c] og bytes=${body.length}`);
    expect(body.length).toBeLessThan(600 * 1024);
    expect(body.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.headers()["cache-control"]).toContain("s-maxage=3600");

    // One signed web image: downloadable anonymously, no GPS / no EXIF location.
    const img = await anon.request.get(imgs[0].src);
    expect(img.status()).toBe(200);
    const bytes = new Uint8Array(await img.body());
    const gps = await exifr.gps(bytes).catch(() => undefined);
    const tags = (await exifr.parse(bytes, { gps: true }).catch(() => undefined)) as Record<string, unknown> | undefined;
    console.log(`[c] web image gps=${gps ? "present" : "none"} exifKeys=${tags ? Object.keys(tags).length : 0}`);
    expect(gps?.latitude).toBeUndefined();
    expect(tags?.GPSLatitude).toBeUndefined();
  } finally {
    await anon.close();
  }
});

test("d. edit a caption → viewer keeps the old snapshot → Publish changes → viewer updated, expiry unchanged", async ({ browser }) => {
  needMigrations();
  test.skip(!slug, "needs test b");
  const before = await bookRow();
  const doc = structuredClone(before.doc) as { pages: { layout: string; side?: "left" | "right"; caption: unknown }[]; style: { font: string } };
  // Since A12 the form defaults to Modern, whose full-bleed / photo-only layouts and spread right
  // halves have no caption area (a caption there is invalid_doc) — edit the first page that has one.
  const target = doc.pages.find((p) => hasCaptionArea(p.layout, p.side));
  expect(target, "a captionable page").toBeTruthy();
  target!.caption = { text: NEW_CAPTION, font: doc.style.font, align: "center", source: "user" };
  const put = await putDoc(doc, before.doc_rev);
  expect(put.status).toBe(200);

  const anon = await anonContext(browser);
  try {
    expect((await viewerHtml(anon.request)).html.includes(NEW_CAPTION)).toBe(false);

    // M13 T9: the Share button says "Publish changes"; one tap publishes them and opens sharing.
    await page.goto(`/books/${bookId}/edit`);
    await expect(page.getByTestId("editor-publish-changes")).toHaveText("Publish changes", { timeout: 30_000 });
    await page.getByTestId("editor-done").click();
    await expect(page.getByTestId("publish-message")).toHaveText("Changes published", { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
    await expect(page.getByTestId("publish-changes")).toHaveCount(0);

    const after = await bookRow();
    expect(after.slug).toBe(slug);
    expect(after.published_at).toBe(before.published_at);
    expect(Date.parse(after.expires_at ?? "")).toBe(Date.parse(firstExpiresAt));
    expect(after.published_rev).toBe(after.doc_rev);
    expect((await viewerHtml(anon.request)).html.includes(NEW_CAPTION)).toBe(true);

    // Editor chip gone after republish.
    await page.goto(`/books/${bookId}/edit`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expect(page.getByTestId("editor-publish-changes")).toHaveCount(0);
  } finally {
    await anon.close();
  }
});

test("d2. an unpublished cover-title edit does not leak into the live viewer header (D-039)", async ({ browser }) => {
  needMigrations();
  test.skip(!slug, "needs test b");
  // D-039: viewers see only the snapshot. books.title (live column, synced by every editor save)
  // changes immediately; the viewer title must keep the published cover title (M6 review B1).
  const before = await bookRow();
  const doc = structuredClone(before.doc) as { cover: { title: string } };
  doc.cover.title = NEW_TITLE;
  expect((await putDoc(doc, before.doc_rev)).status).toBe(200);
  const { data } = await admin.from("books").select("title").eq("id", bookId).single();
  expect((data as { title: string | null }).title).toBe(NEW_TITLE);
  const anon = await anonContext(browser);
  try {
    const v = await anon.newPage();
    await v.goto(`/b/${slug}`);
    await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(v.getByTestId("viewer-title")).not.toHaveText(NEW_TITLE, { timeout: 5_000 });
  } finally {
    await anon.close();
  }
});

test("e. password: gate (no title), wrong → message, right → viewer; cookie scoped httpOnly; 11 wrong tries → rate limited", async ({ browser }) => {
  needMigrations();
  test.skip(!slug, "needs test b");
  test.skip(!hasAccessSecret, "BOOK_ACCESS_SECRET is not set in .env.local — password unlock answers 'unavailable'");
  await page.goto(`/books/${bookId}/publish`);
  await page.getByTestId("password-edit").click();
  await page.getByTestId("password-input").fill(PASSWORD);
  await page.getByTestId("password-save").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Password saved", { timeout: 30_000 });
  await expect(page.getByTestId("password-status")).toContainText("On");

  const ip = (n: number) => `203.0.113.${n}`;
  const anon = await anonContext(browser, ip(10 + Math.floor(Math.random() * 200)));
  try {
    const v = await anon.newPage();
    await v.goto(`/b/${slug}`);
    await expect(v.getByTestId("password-gate")).toBeVisible();
    const { html } = await viewerHtml(anon.request);
    expect(html).toContain("A private photobook");
    expect(html.includes(NEW_CAPTION), "snapshot leaked behind the gate").toBe(false);
    expect(html).not.toContain("/storage/v1/object/sign/");
    expect(html).toMatch(new RegExp(`/b/${slug}/og\\?v=\\d+-1`));
    // Locked OG card: generic, short cache.
    const og = await anon.request.get(`/b/${slug}/og?v=0-1`);
    expect(og.status()).toBe(200);
    expect(og.headers()["cache-control"]).toContain("s-maxage=300");

    await v.getByTestId("password-input").fill("definitely-wrong");
    await v.getByTestId("password-submit").click();
    await expect(v.getByTestId("password-error")).toHaveText("That password isn't right. Check it with the person who shared the link.");
    await v.getByTestId("password-input").fill(PASSWORD);
    await v.getByTestId("password-submit").click();
    await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const cookies = await anon.cookies();
    const access = cookies.filter((c) => c.name.startsWith("pb_a_"));
    expect(access.length).toBe(1);
    expect(access[0].path).toBe(`/b/${slug}`);
    expect(access[0].httpOnly).toBe(true);
    expect(access[0].sameSite).toBe("Lax");
    expect(access[0].value).not.toContain(PASSWORD);
    expect(access[0].expires * 1000 - Date.now()).toBeGreaterThan(29 * DAY);
    expect((await viewerHtml(anon.request)).html.includes(NEW_CAPTION)).toBe(true);
  } finally {
    await anon.close();
  }

  // Rate limit: a fresh "network" gets 10 tries per 15 min; the 11th (even the right password) is refused.
  const rl = await anonContext(browser, ip(220 + Math.floor(Math.random() * 30)));
  try {
    const v = await rl.newPage();
    await v.goto(`/b/${slug}`);
    await expect(v.getByTestId("password-gate")).toBeVisible();
    const seen: string[] = [];
    for (let i = 1; i <= 11; i++) {
      await v.getByTestId("password-input").fill(i === 11 ? PASSWORD : `wrong-${i}`);
      await v.getByTestId("password-submit").click();
      await expect(v.getByTestId("password-submit")).toHaveText("Open photobook", { timeout: 30_000 });
      const msg = (await v.getByTestId("password-error").textContent({ timeout: 10_000 })) ?? "";
      seen.push(msg.startsWith("Too many") ? "rate" : msg.startsWith("That password") ? "wrong" : "other");
    }
    console.log(`[e] tries=${seen.join(",")}`);
    expect(seen[0]).toBe("wrong");
    expect(seen[10]).toBe("rate");
    expect(seen.filter((s) => s === "other")).toEqual([]);
    await expect(v.getByTestId("password-error")).toHaveText("Too many tries — wait 15 minutes and try again.");
    expect((await rl.cookies()).filter((c) => c.name.startsWith("pb_a_"))).toEqual([]);
  } finally {
    await rl.close();
  }

  // Remove the password again for the next steps.
  await page.goto(`/books/${bookId}/publish`);
  await page.getByTestId("password-remove").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Password removed", { timeout: 30_000 });
});

test("f. expired (admin sets expires_at in the past): owner vs anonymous copy, republish blocked", async ({ browser }) => {
  needMigrations();
  test.skip(!slug, "needs test b");
  const past = new Date(Date.now() - 60_000).toISOString();
  const { error } = await admin.from("books").update({ expires_at: past }).eq("id", bookId);
  expect(error).toBeNull();

  const anon = await anonContext(browser);
  try {
    const v = await anon.newPage();
    const r = await v.goto(`/b/${slug}`);
    expect(r?.status()).toBe(200);
    await expect(v.getByTestId("expired-book")).toBeVisible();
    await expect(v.getByTestId("expired-create")).toBeVisible();
    await expect(v.getByTestId("expired-upgrade")).toHaveCount(0);
    await expect(v.getByTestId("expired-open-editor")).toHaveCount(0);
    const { html } = await viewerHtml(anon.request);
    expect(html).not.toContain("/storage/v1/object/sign/");
    expect(html.includes(NEW_CAPTION)).toBe(false);
    expect(html.includes(bookId)).toBe(false);
    await noHorizontalOverflow(v);
  } finally {
    await anon.close();
  }

  // Owner (signed in) sees the upgrade CTA + editor link.
  await page.goto(`/b/${slug}`);
  await expect(page.getByTestId("expired-book")).toBeVisible();
  await expect(page.getByTestId("expired-upgrade")).toBeVisible();
  await expect(page.getByTestId("expired-open-editor")).toHaveAttribute("href", `/books/${bookId}/edit`);

  // Publish screen: expired, no publish button; the expiry is never extended.
  await page.goto(`/books/${bookId}/publish`);
  await expect(page.getByTestId("publish-panel")).toHaveAttribute("data-state", "expired");
  await expect(page.getByTestId("publish-expired")).toContainText("Upgrade to bring it back");
  await expect(page.getByTestId("publish-button")).toHaveCount(0);
  expect(Date.parse((await bookRow()).expires_at ?? "")).toBe(Date.parse(past));

  // M13 review fix: editor Share on an expired free book says "Link expired" and, instead of trying
  // to republish (blocked, D-039), opens the share screen where Upgrade lives. Expiry unchanged.
  await page.goto(`/books/${bookId}/edit`);
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("editor-done")).toContainText("Link expired");
  await page.getByTestId("editor-done").click();
  await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish$`), { timeout: 30_000 });
  await expect(page.getByTestId("publish-panel")).toHaveAttribute("data-state", "expired");
  await expect(page.getByTestId("publish-message")).toHaveCount(0); // nothing was published
  expect(Date.parse((await bookRow()).expires_at ?? "")).toBe(Date.parse(past));
});

test("g. unpublish → /b/slug 404 for everyone, OG falls back to the generic card", async ({ browser }) => {
  needMigrations();
  test.skip(!slug, "needs test b");
  await page.goto(`/books/${bookId}/publish`);
  await page.getByTestId("unpublish-button").click();
  await page.getByTestId("unpublish-confirm-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Unpublished — the link no longer works", { timeout: 30_000 });
  const row = await bookRow();
  expect(row.published_doc).toBeNull();
  expect(row.slug).toBe(slug); // slug never changes

  const anon = await anonContext(browser);
  try {
    const res = await viewerHtml(anon.request);
    expect(res.status).toBe(404);
    expect(res.headers["x-robots-tag"]).toContain("noindex");
    const og = await anon.request.get(`/b/${slug}/og?v=9-0`);
    expect(og.status()).toBe(200);
    expect(og.headers()["cache-control"]).toContain("s-maxage=300");
  } finally {
    await anon.close();
  }
  const owner = await page.request.get(`/b/${slug}`, { maxRedirects: 0 });
  expect(owner.status()).toBe(404);

  // Dashboard (S1): published_rev / published_at / slug survive unpublish, but "published"
  // means a live snapshot exists → chip "Draft" and no Share link on this book's card.
  await page.goto("/dashboard");
  const card = page
    .getByTestId("book-list")
    .locator("li")
    .filter({ has: page.locator(`a[data-testid="book-card"][href*="${bookId}"]`) });
  await expect(card.getByTestId("book-publish-chip")).toHaveText("Draft");
  await expect(card.getByTestId("book-share")).toHaveCount(0);
});
