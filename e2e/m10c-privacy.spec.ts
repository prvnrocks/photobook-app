/**
 * M10c review-fix re-gate (D-062 privacy, review SHOULD 1) — LIVE hosted Supabase, opt-in (E2E_AUTH=1).
 * Replay AI only (server AI_MODE=replay, no key), dummy Stripe + random whsec, signed checkout event.
 *   a. Baby → Scrapbook portrait → upload 15 → replay build → stay on review; the doc has an AI
 *      faded-photo chapter-opener background (photo V1)
 *   b. review: drop V1 (tile → togglePhotoAction) WITHOUT Update album → stored doc no longer has
 *      any background referencing V1 (pruned right away), doc_rev bumped, nothing else changed
 *   c. drop V2 too → Update album → doc free of V1/V2. Plant (service role, simulating a draft the
 *      best-effort prune missed): AI photo background V1 on a chapter opener A + USER photo background
 *      V2 on page B. Publish → published_doc has no V1 anywhere, page A without background, page B
 *      keeps the user-picked V2 background (D-062)
 *   d. signed checkout → paid PDF: exports.doc snapshot has no V1, keeps V2 on B; PDF sheet A has
 *      only its slot photos (+ texture tile), sheet B its slot photos + the V2 background (control)
 * afterAll: orders, stripe_events (linked CLI), exports, storage, user, this run's orphan agent_runs.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildEvent, postEvent } from "../scripts/stripe-signed-event.mjs";
import { getLayout } from "../src/lib/layouts";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1");
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
if (ENABLED && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* env() reports */
  }
}
const BUCKETS = ["photos", "exports"] as const;
const REPO = path.join(__dirname, "..");
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
let V1 = "";
let V2 = "";
let fadedBg: Record<string, unknown> | null = null;
let pageA = -1;
let pageB = -1;
let published = false;
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

type Bg = { kind: string; photoId?: string; source?: string; [k: string]: unknown };
type DPage = { id: string; chapterId: string | null; layout: string; slots: { photoId: string | null }[]; side?: string; background?: Bg | null };
type Doc = { cover: { photoId: string | null }; style: { background: Bg; backgroundSource?: string }; pages: DPage[]; meta?: Record<string, unknown> } & Record<string, unknown>;
async function row() {
  const { data, error } = await admin.from("books").select("doc, doc_rev, published_doc, slug, is_paid").eq("id", bookId).single();
  if (error) throw new Error(`books select (${error.code})`);
  return data as { doc: Doc; doc_rev: number; published_doc: Doc | null; slug: string | null; is_paid: boolean };
}
const bgRefs = (d: Doc, id: string) => {
  const out: string[] = [];
  if (d.style.background.kind === "photo" && d.style.background.photoId === id) out.push("book");
  d.pages.forEach((p, i) => p.background?.kind === "photo" && p.background.photoId === id && out.push(`p${i}:${p.background.source}`));
  return out;
};
const slotHas = (d: Doc, id: string) => d.pages.some((p) => p.slots.some((s) => s.photoId === id));

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async ({ browser }, info) => {
  baseURL = String(info.project.use.baseURL ?? "");
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  email = `e2e+m10cpriv-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser (${error?.code})`);
  uid = data.user.id;
  context = await browser.newContext({ viewport: { width: 1024, height: 768 }, baseURL });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/);
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  if (!uid) return;
  await context?.close().catch(() => {});
  const runIds = bookId ? ((await admin.from("agent_runs").select("id").eq("book_id", bookId)).data ?? []).map((r) => (r as { id: string }).id) : [];
  await admin.from("orders").delete().eq("user_id", uid);
  if (bookId) await admin.from("orders").delete().eq("book_id", bookId);
  await admin.from("exports").delete().eq("user_id", uid);
  let eventsLeft: number | string = 0;
  const ids = eventIds.filter((id) => /^evt_test_[0-9a-f]{24}$/.test(id));
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    try {
      execFileSync("npx", ["supabase", "db", "query", "--linked", `delete from private.stripe_events where id in (${list})`], { cwd: REPO, stdio: "pipe", timeout: 60_000 });
      const out = execFileSync("npx", ["supabase", "db", "query", "--linked", `select count(*)::int as n from private.stripe_events where id in (${list})`], { cwd: REPO, stdio: "pipe", timeout: 60_000 }).toString();
      eventsLeft = Number(/"n"\s*:\s*(\d+)/.exec(out)?.[1] ?? "NaN");
    } catch {
      eventsLeft = "unknown";
    }
  }
  for (const bucket of BUCKETS)
    for (let r = 0; r < 3; r++) {
      const paths = await listAllUserObjects(bucket);
      if (!paths.length) break;
      for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
    }
  const { error } = await admin.auth.admin.deleteUser(uid);
  let runsDeleted = 0;
  for (let i = 0; i < runIds.length; i += 100) runsDeleted += (await admin.from("agent_runs").delete().in("id", runIds.slice(i, i + 100)).select("id")).data?.length ?? 0;
  let left = 0;
  for (const bucket of BUCKETS) left += (await listAllUserObjects(bucket)).length;
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  console.log(`[cleanup] left=${left} books=${books.count} runs=${runIds.length} runsDeleted=${runsDeleted} stripeEventsLeft=${eventsLeft} userDeleted=${!error}`);
  expect(error).toBeNull();
  expect(left).toBe(0);
  expect(books.count).toBe(0);
});

test("a. scrapbook replay build has an AI faded-photo chapter-opener background", async () => {
  test.setTimeout(720_000);
  await page.goto("/books/new");
  await page.getByTestId("book-title").fill("Privacy Days");
  await page.locator("label", { has: page.getByTestId("occasion-baby") }).click();
  await expect(page.getByTestId("style-scrapbook")).toBeChecked();
  await page.getByRole("radio", { name: /Portrait/ }).check();
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  bookId = new URL(page.url()).pathname.split("/")[2];
  await page.getByTestId("upload-input").setInputFiles(await makePhotos(page, uploadSpecs(5300), "priv"));
  // M13 T6: no Build tap — the first build starts by itself once the upload settles (≥ 5 photos).
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/build\?auto=1$/, { timeout: 240_000 });
  // M13 T7: the build hands over to the editor (review is reached from the "AI kept X of Y" chip).
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/edit$/, { timeout: 420_000 });
  const { doc } = await row();
  const i = doc.pages.findIndex((p) => p.background?.kind === "photo" && p.background.source === "ai");
  console.log(`[a] pages=${doc.pages.length} aiPhotoBgPage=${i} bookBg=${doc.style.background.kind}/${doc.style.backgroundSource} pageBgs=${JSON.stringify(doc.pages.map((p, j) => (p.background ? `${j}:${p.background.kind}:${p.background.source}` : null)).filter(Boolean))}`);
  expect(i).toBeGreaterThanOrEqual(0);
  fadedBg = doc.pages[i].background as Record<string, unknown>;
  V1 = String(fadedBg.photoId);
  expect(slotHas(doc, V1)).toBe(true); // T11 rule 4: shown on another page of the chapter
});

test("b. review drop of V1 WITHOUT Update album prunes the AI background from the stored doc", async () => {
  test.skip(!V1, "needs a");
  const before = await row();
  await page.goto(`/books/${bookId}/review`);
  const tile = page.locator(`[data-testid="review-tile"][data-photo-id="${V1}"]`);
  await expect(tile).toHaveAttribute("data-state", "kept", { timeout: 30_000 });
  await tile.click();
  await expect(tile).toHaveAttribute("data-state", "dropped");
  await expect.poll(async () => (await admin.from("photos").select("status").eq("id", V1).single()).data?.status, { timeout: 15_000 }).toBe("dropped");
  await expect.poll(async () => bgRefs((await row()).doc, V1).length, { timeout: 15_000 }).toBe(0);
  const after = await row();
  await expect(page.getByTestId("update-album-bar")).toBeVisible();
  // Only the AI photo background changed: same pages/slots/book background otherwise.
  const strip = (d: Doc) => JSON.stringify({ ...d, pages: d.pages.map((p) => ({ ...p, background: p.background?.kind === "photo" && p.background.photoId === V1 ? null : p.background ?? null })) });
  console.log(`[b] rev ${before.doc_rev}→${after.doc_rev} refsBefore=${JSON.stringify(bgRefs(before.doc, V1))} refsAfter=${JSON.stringify(bgRefs(after.doc, V1))} V1StillInSlot=${slotHas(after.doc, V1)} userEdited=${String(after.doc.meta?.userEdited)}`);
  expect(after.doc_rev).toBe(before.doc_rev + 1);
  expect(strip(after.doc)).toBe(strip(before.doc));
});

test("c. publish strips a (planted) AI photo bg of a dropped photo; a user-picked bg of a dropped photo publishes", async () => {
  test.skip(!V1, "needs a");
  test.setTimeout(300_000);
  const cur = await row();
  V2 = cur.doc.pages.flatMap((p) => p.slots.map((s) => s.photoId)).find((id): id is string => !!id && id !== V1 && id !== cur.doc.cover.photoId)!;
  await page.goto(`/books/${bookId}/review`);
  const t2 = page.locator(`[data-testid="review-tile"][data-photo-id="${V2}"]`);
  await expect(t2).toHaveAttribute("data-state", "kept", { timeout: 30_000 });
  await t2.click();
  await expect(t2).toHaveAttribute("data-state", "dropped");
  await expect.poll(async () => (await admin.from("photos").select("status").eq("id", V2).single()).data?.status, { timeout: 15_000 }).toBe("dropped");
  await page.getByTestId("update-album").click();
  await expect(page.getByTestId("update-album-bar")).toHaveCount(0, { timeout: 60_000 });
  const rel = await row();
  expect(JSON.stringify(rel.doc)).not.toContain(V1);
  expect(JSON.stringify(rel.doc)).not.toContain(V2);
  await page.getByTestId("review-continue").click();
  await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: 30_000 });

  // Plant: simulate a draft the best-effort prune missed + a user pick of a dropped photo (D-062).
  const r = await row();
  const doc = structuredClone(r.doc);
  const single = (i: number) => doc.pages[i].side === undefined && getLayout(doc.pages[i].layout)?.role !== "spread" && doc.pages[i].slots.some((s) => s.photoId);
  const firstOf = new Map<string, number>();
  doc.pages.forEach((p, i) => p.chapterId && !firstOf.has(p.chapterId) && firstOf.set(p.chapterId, i));
  pageA = [...firstOf.values()].find(single) ?? -1;
  pageB = doc.pages.findIndex((_, i) => i !== pageA && single(i) && !doc.pages[i].background);
  expect(pageA).toBeGreaterThanOrEqual(0);
  expect(pageB).toBeGreaterThanOrEqual(0);
  const look = Object.fromEntries(Object.entries(fadedBg as Record<string, unknown>).filter(([k]) => k !== "source" && k !== "photoId"));
  doc.pages[pageA].background = { ...look, kind: "photo", photoId: V1, source: "ai" };
  doc.pages[pageB].background = { ...look, kind: "photo", photoId: V2, source: "user" };
  const upd = await admin.from("books").update({ doc }).eq("id", bookId).eq("doc_rev", r.doc_rev).select("doc_rev");
  expect(upd.error).toBeNull();
  expect(upd.data?.length).toBe(1);

  await page.goto(`/books/${bookId}/publish`);
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
  const pub = await row();
  const pd = pub.published_doc!;
  console.log(`[c] A=${pageA} B=${pageB} draftRefsV1=${JSON.stringify(bgRefs(pub.doc, V1))} publishedRefsV1=${JSON.stringify(bgRefs(pd, V1))} publishedRefsV2=${JSON.stringify(bgRefs(pd, V2))} pubA.bg=${JSON.stringify(pd.pages[pageA]?.background ?? null)} pubPages=${pd.pages.length}`);
  expect(JSON.stringify(pd)).not.toContain(V1);
  expect(pd.pages[pageA].background ?? null).toBeNull();
  expect(pd.pages[pageB].background).toMatchObject({ kind: "photo", photoId: V2 });
  // Anonymous viewer never requests V1.
  const ctx = await page.context().browser()!.newContext({ baseURL, viewport: { width: 375, height: 812 } });
  const v = await ctx.newPage();
  const urls: string[] = [];
  v.on("request", (q) => urls.push(q.url()));
  await v.goto(`/b/${pub.slug}`);
  await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const html = await v.content();
  await ctx.close();
  expect(html.includes(V1)).toBe(false);
  expect(urls.some((u) => u.includes(V1))).toBe(false);
  published = true;
});

test("d. paid PDF export snapshot + PDF exclude the dropped photo's AI background; the user pick prints", async () => {
  test.skip(!published, "needs c");
  test.skip(!WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET required");
  test.setTimeout(480_000);
  const ev = buildEvent({ type: "completed", bookId, userId: uid, amount: 3900, currency: "aed" });
  eventIds.push(ev.id);
  expect(await postEvent({ baseURL, payload: ev.payload, secret: WEBHOOK_SECRET })).toBe(200);
  expect((await row()).is_paid).toBe(true);
  await page.goto(`/books/${bookId}/publish`);
  const btn = page.getByTestId("pdf-download");
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  const download = page.waitForEvent("download", { timeout: 360_000 });
  await btn.click();
  const file = test.info().outputPath("m10c-privacy.pdf");
  await (await download).saveAs(file);
  expect(readFileSync(file).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const exp = await admin.from("exports").select("status, doc").eq("book_id", bookId).eq("status", "ready");
  expect(exp.data?.length).toBeGreaterThan(0);
  const snap = (exp.data![0] as { doc: Doc }).doc;
  const draft = (await row()).doc;
  const a = analyze(file);
  const ins = inspect(file);
  const sheet = (i: number) => a.pages[i + 1]?.images ?? [];
  const filled = (i: number) => snap.pages[i].slots.filter((s) => s.photoId).length;
  const dct = (i: number) => sheet(i).filter((im) => /DCT/.test(im.filter ?? "")).length;
  console.log(`[d] draftRefsV1=${JSON.stringify(bgRefs(draft, V1))} snapRefsV1=${JSON.stringify(bgRefs(snap, V1))} snapRefsV2=${JSON.stringify(bgRefs(snap, V2))} pdfPages=${ins.pageCount} uniqueImages=${a.summary.uniqueImages} A: slots=${filled(pageA)} dct=${dct(pageA)} imgs=${JSON.stringify(sheet(pageA).map((im) => `${im.w}x${im.h}:${im.filter}`))} B: slots=${filled(pageB)} dct=${dct(pageB)} imgs=${JSON.stringify(sheet(pageB).map((im) => `${im.w}x${im.h}:${im.filter}`))}`);
  expect(JSON.stringify(snap)).not.toContain(V1);
  expect(snap.pages[pageB].background).toMatchObject({ kind: "photo", photoId: V2, source: "user" });
  expect(ins.pageCount).toBe(snap.pages.length + 1);
  // Photo images per sheet = DCT images that are not the 512×512 texture tiles. A sheet shows one
  // image per filled slot, plus one for a photo background. The extra image on B is the V2 background.
  const photoImgs = (i: number) => sheet(i).filter((im) => /DCT/.test(im.filter ?? "") && !(im.w === 512 && im.h === 512));
  const dims = async (id: string) => (await admin.from("photos").select("width, height").eq("id", id).single()).data as { width: number; height: number };
  const d1 = await dims(V1);
  const d2 = await dims(V2);
  console.log(`[d] V1 ${d1.width}x${d1.height} V2 ${d2.width}x${d2.height} photoImgs A=${photoImgs(pageA).length} B=${photoImgs(pageB).length}`);
  expect(photoImgs(pageA).length).toBe(filled(pageA));
  expect(photoImgs(pageB).length).toBe(filled(pageB) + 1);
});
