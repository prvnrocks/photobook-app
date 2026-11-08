/**
 * Milestone 2 — signed-in upload flow against the LIVE hosted Supabase project (opt-in).
 *
 * SKIPPED unless E2E_AUTH=1. It writes to the real (production) project, so it:
 *   - creates ONE throwaway user `e2e+m2-<random>@example.com` with the admin API
 *     (email_confirm: true) and signs in through /auth/confirm with a token_hash from
 *     auth.admin.generateLink — no email is ever sent;
 *   - makes at most ~2 real Mapbox reverse-geocoding calls (fake fixture point
 *     24.47, 54.33 — one cluster per book that has GPS photos);
 *   - in afterAll (always, also on failure) removes every storage object under
 *     `<uid>/` in bucket `photos` and deletes the user (cascades books/photos),
 *     then asserts nothing is left.
 * Logs are counts/booleans only — never photo metadata, ids, places or keys.
 *
 * Needs in .env.local (loaded automatically if not already in the environment):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY,
 *   MAPBOX_TOKEN (used by the app server for place names).
 *
 * Run (uses the dev server from playwright.config.ts on :3000):
 *   E2E_AUTH=1 npx playwright test e2e/upload-auth.spec.ts
 * Or against a production build on another port with your own config, e.g.
 *   npm run build && E2E_AUTH=1 npx playwright test -c <config with next start -p 3200> e2e/upload-auth.spec.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseBookDoc, validateBookDoc } from "../src/lib/book/schema";
import { mapUploadDbError } from "../src/lib/upload/errors";

const ENABLED = process.env.E2E_AUTH === "1";
test.skip(!ENABLED, "set E2E_AUTH=1 to run the live signed-in upload flow");

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
const HEX16 = /^[0-9a-f]{16}$/;

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

function fixture(name: string, mimeType: string): FileSpec {
  return { name, mimeType, buffer: fs.readFileSync(path.join(FIXTURES, name)) };
}

// ----- shared state (serial) -----
let admin: SupabaseClient;
let userClient: SupabaseClient;
let uid = "";
let email = "";
let context: BrowserContext;
let page: Page;
let files: FileSpec[] = [];
const ACCEPTED = 5; // orient6.jpg, orient6.heic, screenshot.png, dupA, dupB
const TOO_SMALL = 2; // exif-gps.jpg + no-exif.jpg are 32x24 (< 200 px)
let book1 = "";
let book3 = "";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function signInLink(): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
  return data.properties.hashed_token;
}

async function listObjects(prefix: string): Promise<{ name: string; updated_at: string | null }[]> {
  const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw new Error(`storage list failed (${error.message})`);
  return (data ?? []).map((o) => ({ name: o.name, updated_at: o.updated_at ?? null }));
}

/** All object paths under `<uid>/` (two levels: <uid>/<bookId>/<file>). */
async function listAllUserObjects(): Promise<string[]> {
  const out: string[] = [];
  const top = await admin.storage.from(BUCKET).list(uid, { limit: 1000 });
  if (top.error) throw new Error(`storage list failed (${top.error.message})`);
  for (const entry of top.data ?? []) {
    if (entry.id) {
      out.push(`${uid}/${entry.name}`);
      continue;
    }
    const inner = await listObjects(`${uid}/${entry.name}`);
    for (const o of inner) out.push(`${uid}/${entry.name}/${o.name}`);
  }
  return out;
}

async function photoRows(bookId: string) {
  const { data, error } = await admin
    .from("photos")
    .select(
      "id, fingerprint, upload_state, taken_at, date_source, width, height, phash, blur_score, original_bytes, original_mime, original_path, web_path, thumb_path, lat, lng, place, dup_group",
    )
    .eq("book_id", bookId);
  if (error) throw new Error(`photos select failed (${error.code})`);
  return data ?? [];
}

async function bookDoc(bookId: string): Promise<unknown> {
  const { data, error } = await admin.from("books").select("doc, max_pages").eq("id", bookId).single();
  if (error) throw new Error(`books select failed (${error.code})`);
  return data.doc;
}

async function createBookViaUi(): Promise<string> {
  await page.goto("/books/new");
  await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
  await expect(page.getByTestId("occasion-travel")).toBeChecked();
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload$/, { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split("/")[2];
  await expect(page.getByTestId("upload-pick")).toBeVisible();
  return id;
}

async function finalizeFromPage(bookId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async (id) => {
    const res = await fetch(`/api/books/${id}/finalize`, { method: "POST", credentials: "same-origin" });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }, bookId);
}

/** Two 800x600 JPEGs (no EXIF) that differ by one small dot → near-duplicates. */
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

async function waitForSummary() {
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("finalize-error")).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test.beforeAll(async ({ browser }) => {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  admin = createClient(url, env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  email = `e2e+m2-${randomBytes(6).toString("hex")}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
  uid = data.user.id;

  // Browser session via the app's own /auth/confirm route.
  context = await browser.newContext({ viewport: VIEWPORT });
  page = await context.newPage();
  page.on("dialog", (d) => void d.accept()); // beforeunload on reload during upload
  const hashed = await signInLink();
  await page.goto(`/auth/confirm?token_hash=${hashed}&type=magiclink&next=/books/new`);
  await expect(page).toHaveURL(/\/books\/new$/);

  // A separate user-session client (publishable key, RLS) for live error-shape checks.
  userClient = createClient(url, env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const v = await userClient.auth.verifyOtp({ type: "magiclink", token_hash: await signInLink() });
  if (v.error) throw new Error(`verifyOtp failed (${v.error.code})`);

  const [dupA, dupB] = await makeNearDupPair(page);
  files = [
    fixture("exif-gps.jpg", "image/jpeg"),
    fixture("photo-orient6.jpg", "image/jpeg"),
    fixture("photo-orient6.heic", "image/heic"),
    fixture("screenshot.png", "image/png"),
    fixture("no-exif.jpg", "image/jpeg"),
    dupA,
    dupB,
  ];
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
  if (error) console.log(`[cleanup] deleteUser error (${error.code})`);

  const left = await listAllUserObjects();
  const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
  const photos = await admin.from("photos").select("id", { count: "exact", head: true }).eq("user_id", uid);
  console.log(
    `[cleanup] objects removed=${removed} left=${left.length} books left=${books.count} photos left=${photos.count} userDeleted=${!error}`,
  );
  expect(left.length).toBe(0);
  expect(books.count).toBe(0);
  expect(photos.count).toBe(0);
  expect(error).toBeNull();
});

test("upload at 375px: rows, storage objects, places, fallback album", async () => {
  book1 = await createBookViaUi();
  await expect(page.getByTestId("upload-occasion")).toHaveText("Travel");

  await page.getByTestId("upload-input").setInputFiles(files);
  await waitForSummary();

  await expect(page.getByTestId("summary-added")).toHaveText(`${ACCEPTED} photos added`);
  await expect(page.getByTestId("summary-skipped-too_small")).toHaveText(`${TOO_SMALL} too small`);
  await expect(page.getByTestId("summary-failed")).toHaveCount(0);
  await expect(page.getByTestId("summary-places")).toHaveText("Places found for 2 of 2 with a location");
  await expect(page.getByTestId("summary-pages")).toBeVisible();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(VIEWPORT.width);

  const rows = await photoRows(book1);
  const ok = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
  const counts = {
    rows: rows.length,
    ready: ok((r) => r.upload_state === "ready"),
    takenAt: ok((r) => r.taken_at !== null),
    dateSourceFile: ok((r) => r.date_source === "file"),
    dims: ok((r) => (r.width ?? 0) >= 200 && (r.height ?? 0) >= 200),
    phash: ok((r) => HEX16.test(r.phash ?? "")),
    blur: ok((r) => typeof r.blur_score === "number" && r.blur_score >= 0),
    bytes: ok((r) => (r.original_bytes ?? 0) > 0),
    mime: ok((r) => r.original_mime === "image/jpeg" || r.original_mime === "image/png"),
    gps: ok((r) => r.lat !== null && r.lng !== null),
    gpsWithPlace: ok((r) => r.lat !== null && typeof r.place === "string" && r.place.length > 0),
    dupGrouped: ok((r) => r.dup_group !== null),
  };
  console.log(`[book1] ${JSON.stringify(counts)}`);
  expect(counts).toMatchObject({
    rows: ACCEPTED,
    ready: ACCEPTED,
    takenAt: ACCEPTED,
    dims: ACCEPTED,
    phash: ACCEPTED,
    blur: ACCEPTED,
    bytes: ACCEPTED,
    mime: ACCEPTED,
    gps: 2,
    gpsWithPlace: 2,
  });
  expect(counts.dateSourceFile).toBeGreaterThanOrEqual(2); // canvas JPEGs have no EXIF
  expect(counts.dupGrouped).toBeGreaterThanOrEqual(2); // near-dup pair (and/or orient6 jpg+heic)

  // Orientation 6 → stored display size 300x400 for both the JPEG and the HEIC.
  const gpsRows = rows.filter((r) => r.lat !== null);
  expect(gpsRows.every((r) => r.width === 300 && r.height === 400)).toBe(true);
  // JPEG original kept as-is (same bytes); HEIC original converted to JPEG (different size).
  const jpgSize = files[1].buffer.length;
  const keptAsIs = gpsRows.filter((r) => r.original_bytes === jpgSize);
  const converted = gpsRows.filter((r) => r.original_bytes !== jpgSize);
  expect(keptAsIs.length).toBe(1);
  expect(converted.length).toBe(1);
  expect(converted[0].original_mime).toBe("image/jpeg");
  expect(converted[0].original_path?.endsWith("-original.jpg")).toBe(true);
  const dl = await admin.storage.from(BUCKET).download(converted[0].original_path!);
  expect(dl.error).toBeNull();
  const head = new Uint8Array(await dl.data!.arrayBuffer()).subarray(0, 3);
  expect(Array.from(head)).toEqual([0xff, 0xd8, 0xff]); // JPEG SOI, not HEIC
  // Screenshot PNG kept as PNG with the same bytes.
  const png = rows.filter((r) => r.original_mime === "image/png");
  expect(png.length).toBe(1);
  expect(png[0].original_bytes).toBe(files[3].buffer.length);

  // Storage: exactly 3 objects per photo, and every path in the rows exists.
  const objects = new Set((await listObjects(`${uid}/${book1}`)).map((o) => `${uid}/${book1}/${o.name}`));
  const expected = rows.flatMap((r) => [r.original_path, r.web_path, r.thumb_path]);
  const missing = expected.filter((p) => !p || !objects.has(p)).length;
  console.log(`[book1] storage objects=${objects.size} expected=${expected.length} missing=${missing}`);
  expect(objects.size).toBe(ACCEPTED * 3);
  expect(missing).toBe(0);

  // Fallback album written and valid.
  const doc = await bookDoc(book1);
  const parsed = parseBookDoc(doc);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const issues = validateBookDoc(parsed.doc, { photoIds: new Set(rows.map((r) => r.id)), maxPages: 20 });
  console.log(`[book1] doc pages=${parsed.doc.pages.length} issues=${issues.length}`);
  expect(issues).toEqual([]);
  expect(parsed.doc.pages.length).toBeGreaterThan(0);
});

test("finalize again: idempotent, wroteDoc false, doc unchanged (jsonb eq.{} guard)", async () => {
  const before = await bookDoc(book1);
  const res = await finalizeFromPage(book1);
  console.log(
    `[finalize#2] status=${res.status} wroteDoc=${String(res.body.wroteDoc)} placesPending=${String(res.body.placesPending)}`,
  );
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ photos: ACCEPTED, withGps: 2, withPlace: 2, placesPending: 0, wroteDoc: false });
  const after = await bookDoc(book1);
  expect(after).toEqual(before);

  // Not-my-book / unknown uuid → 404 with a session.
  const nf = await finalizeFromPage(randomUUID());
  expect(nf.status).toBe(404);
  expect(nf.body).toMatchObject({ error: "not_found" });
});

test("resume after reload mid-run: skips ready, retries pending (storage upsert), no duplicates", async () => {
  const book2 = await createBookViaUi();

  // Let the first photo's thumb upload through, hang every later thumb upload so a
  // photo is left `pending` with its original + web objects already in storage.
  let thumbsSeen = 0;
  const hung: Route[] = [];
  await page.route("**/storage/v1/object/photos/**", async (route) => {
    if (route.request().url().includes("-thumb.jpg")) {
      thumbsSeen += 1;
      if (thumbsSeen > 1) {
        hung.push(route);
        return; // never answered; aborted by the reload
      }
    }
    await route.continue();
  });

  await page.getByTestId("upload-input").setInputFiles(files);

  // Wait until ≥1 ready row and a pending row whose original + web objects exist.
  let pendingId = "";
  let pendingPaths: string[] = [];
  await expect
    .poll(
      async () => {
        const rows = await photoRows(book2);
        const ready = rows.filter((r) => r.upload_state === "ready").length;
        const pend = rows.filter((r) => r.upload_state === "pending");
        if (ready < 1 || pend.length < 1) return false;
        const names = new Set((await listObjects(`${uid}/${book2}`)).map((o) => o.name));
        const hit = pend.find((r) => {
          const prefix = r.id;
          return names.has(`${prefix}-web.jpg`) && [...names].some((n) => n.startsWith(`${prefix}-original.`));
        });
        if (!hit) return false;
        pendingId = hit.id;
        pendingPaths = [...names].filter((n) => n.startsWith(hit.id));
        return true;
      },
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(true);

  const readyBefore = (await photoRows(book2)).filter((r) => r.upload_state === "ready").length;
  console.log(`[resume] before reload ready=${readyBefore} hungThumbs=${hung.length}`);

  // Reload while the thumb is still hung (the navigation cancels it), then drop the route.
  await page.reload();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await expect(page.getByTestId("upload-pick")).toBeVisible();
  await expect(page.getByTestId("upload-resume")).toBeVisible();
  const rowsMid = await photoRows(book2);
  const pendingMid = rowsMid.filter((r) => r.upload_state === "pending").length;
  const readyMid = rowsMid.length - pendingMid;
  await expect(page.getByTestId("upload-capacity")).toContainText(`${readyMid} added`);
  // The tracked row must still be pending, with objects in storage that the retry overwrites.
  expect(rowsMid.find((r) => r.id === pendingId)?.upload_state).toBe("pending");
  const objsBefore = await listObjects(`${uid}/${book2}`);
  const stampBefore = new Map(objsBefore.map((o) => [o.name, o.updated_at]));
  pendingPaths = objsBefore.map((o) => o.name).filter((n) => n.startsWith(pendingId));
  expect(pendingPaths.length).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(1100); // updated_at must be able to differ

  await page.getByTestId("upload-input").setInputFiles(files);
  await waitForSummary();
  const addedNow = ACCEPTED - readyMid;
  await expect(page.getByTestId("summary-added")).toHaveText(
    addedNow === 1 ? "1 photo added" : `${addedNow} photos added`,
  );
  await expect(page.getByTestId("summary-skipped-already")).toHaveText(`${readyMid} already added`);
  await expect(page.getByTestId("upload-resume")).toHaveCount(0);

  const rows = await photoRows(book2);
  const fps = new Set(rows.map((r) => r.fingerprint));
  const retried = rows.find((r) => r.id === pendingId);
  const objsAfter = await listObjects(`${uid}/${book2}`);
  const overwritten = pendingPaths.filter((n) => {
    const after = objsAfter.find((o) => o.name === n)?.updated_at;
    return after && after !== stampBefore.get(n);
  }).length;
  console.log(
    `[resume] mid ready=${readyMid} pending=${pendingMid}; after rows=${rows.length} ready=${rows.filter((r) => r.upload_state === "ready").length} uniqueFps=${fps.size} objects=${objsAfter.length} retriedSameId=${retried?.upload_state === "ready"} upsertOverwritten=${overwritten}/${pendingPaths.length}`,
  );
  expect(rows.length).toBe(ACCEPTED);
  expect(fps.size).toBe(ACCEPTED);
  expect(rows.every((r) => r.upload_state === "ready")).toBe(true);
  expect(retried?.upload_state).toBe("ready"); // the pending row was reused, not duplicated
  expect(objsAfter.length).toBe(ACCEPTED * 3);
  expect(overwritten).toBe(pendingPaths.length); // upsert replaced the existing objects
});

test("cap: 150 ready rows in a free book → UI limit notice, 0 rows added; DB trigger + error shapes live", async () => {
  book3 = await createBookViaUi();
  const seed = Array.from({ length: 150 }, (_, i) => ({
    user_id: uid,
    book_id: book3,
    fingerprint: `e2e-cap-${String(i).padStart(4, "0")}-${randomBytes(4).toString("hex")}`,
    upload_state: "ready",
  }));
  const ins = await admin.from("photos").insert(seed);
  expect(ins.error).toBeNull();

  await page.reload();
  await expect(page.getByTestId("upload-capacity")).toContainText("150 added");
  await page.getByTestId("upload-input").setInputFiles([files[1]]);
  await expect(page.getByTestId("upload-limit")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("upload-limit")).toContainText("Free books hold 150 photos");
  await expect(page.getByTestId("upload-summary")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("summary-added")).toHaveText("No new photos added");
  const count = await admin.from("photos").select("id", { count: "exact", head: true }).eq("book_id", book3);
  console.log(`[cap] rows after UI select=${count.count} finalizeError=${await page.getByTestId("finalize-error").count()}`);
  expect(count.count).toBe(150);

  // DB trigger as the service role (not exempt) …
  const adminOver = await admin.from("photos").insert({
    user_id: uid,
    book_id: book3,
    fingerprint: `e2e-cap-over-${randomBytes(6).toString("hex")}`,
  });
  // … and as the user through RLS (the shape the browser queue sees).
  const userOver = await userClient.from("photos").insert({
    user_id: uid,
    book_id: book3,
    fingerprint: `e2e-cap-user-${randomBytes(6).toString("hex")}`,
  });
  console.log(
    `[cap] admin code=${adminOver.error?.code} msg=${adminOver.error?.message} hint=${adminOver.error?.hint}; user code=${userOver.error?.code} mapped=${mapUploadDbError(userOver.error).kind}`,
  );
  expect(adminOver.error?.code).toBe("P0001");
  expect(mapUploadDbError(userOver.error)).toEqual({ kind: "photo_limit_reached", limit: 150 });

  // Duplicate fingerprint as the user → 23505 on photos_book_fingerprint_key → "duplicate".
  const existingFp = (await photoRows(book1))[0].fingerprint;
  const dup = await userClient.from("photos").insert({ user_id: uid, book_id: book1, fingerprint: existingFp });
  console.log(`[errors] dup code=${dup.error?.code} mapped=${mapUploadDbError(dup.error).kind}`);
  expect(mapUploadDbError(dup.error)).toEqual({ kind: "duplicate" });

  // Someone else's book → RLS (42501) → not_allowed.
  const other = await userClient.from("photos").insert({ user_id: uid, book_id: randomUUID(), fingerprint: "e2e-other-0000000" });
  console.log(`[errors] other-book code=${other.error?.code} mapped=${mapUploadDbError(other.error).kind}`);
  expect(other.error).not.toBeNull();

  // Storage error shapes as the user.
  const blob = new Blob([new Uint8Array(files[1].buffer)], { type: "image/jpeg" });
  const foreign = await userClient.storage.from(BUCKET).upload(`${randomUUID()}/${book1}/x-web.jpg`, blob, { upsert: true });
  const own = `${uid}/${book1}/e2e-probe-web.jpg`;
  const first = await userClient.storage.from(BUCKET).upload(own, blob, { upsert: false });
  const again = await userClient.storage.from(BUCKET).upload(own, blob, { upsert: false });
  const upsert = await userClient.storage.from(BUCKET).upload(own, blob, { upsert: true });
  const shape = (e: unknown) => {
    if (!e) return "ok";
    const o = e as { statusCode?: unknown; status?: unknown };
    return `statusCode=${typeof o.statusCode}:${String(o.statusCode)} status=${typeof o.status}:${String(o.status)}`;
  };
  console.log(`[storage] foreign ${shape(foreign.error)}; first ${shape(first.error)}; again ${shape(again.error)}; upsert ${shape(upsert.error)}`);
  expect(foreign.error).not.toBeNull();
  expect(first.error).toBeNull();
  expect(again.error).not.toBeNull();
  expect(upsert.error).toBeNull();
});
