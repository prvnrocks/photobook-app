#!/usr/bin/env node
// Seed the landing page's example flipbooks (M9 T15, D-061 comped demo books). Admin-only tool.
//
// For each subfolder of --dir (one folder = one book) it drives the REAL app in a headless browser
// as the --owner admin (signed in with an admin generateLink token, no email): New book form →
// upload page (the real client pipeline: EXIF, HEIC, compression, thumbs, dHash, finalize) →
// /books/<id>/build with whatever AI mode the --app server runs → review → editor → Publish.
// The book is comped via public.comp_book (reason "demo") RIGHT AFTER it is created, before the
// upload: a free book is capped at 150 photos / 20 pages / 3 live AI builds per day, so comping
// first gives every demo book the paid limits, no watermark and a permanent link.
// Then the cover (as rendered by the public viewer, no chrome) is saved to
// public/examples/<slug>.jpg, a `{"slug","title"}` line is printed per book, and a ready-to-paste
// EXAMPLE_BOOKS snippet is written to <dir>/examples-snippet.ts (and printed).
//
// Why the browser and not the APIs: uploads are processed client-side (resize, thumbs, EXIF before
// HEIC conversion, duplicate fingerprints) — only the real page produces the same files and rows
// as a user's upload. Requires the --app server to use the SAME Supabase project as the env here.
//
// Folder layout:
//   <dir>/
//     wedding-sara/            ← one book; folder name → default title ("Wedding Sara")
//       book.json              ← optional: {"title": "...", "captionLang": "en"|"ar",
//       IMG_0001.HEIC             "occasion": "wedding|travel|baby|graduation|family|other",
//       IMG_0002.jpg ...          "tone": "romantic|fun|nostalgic|minimal"}
//     eid-2026/ ...
//   Folders starting with "." or "_" are ignored. Photos: .jpg .jpeg .png .heic .heif .webp (1–500).
//
// State: each book folder gets a `.seeded.json` ({bookId, slug}). Re-running skips folders that
// are already published and resumes half-done ones (no second book is created). To push editor
// changes of a seeded book live again (and refresh its cover): --update <slug>.
//
// Usage (from the repo root, app running, e.g. `npm run dev`):
//   node scripts/seed-demo-books.mjs --owner <admin uuid> --dir ~/demo-books --dry-run
//   node scripts/seed-demo-books.mjs --owner <admin uuid> --dir ~/demo-books [--app http://localhost:3000] [--headed]
//   node scripts/seed-demo-books.mjs --owner <admin uuid> --update <slug>
//
// Env (process env first, then .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
// ADMIN_USER_IDS (--owner must be listed). Never prints emails, tokens or keys.
// Exit codes: 0 ok, 1 a book failed, 2 bad arguments / env / folder structure.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compBook } from "./comp-book.mjs";
import {
  PHONE_VIEWPORT,
  REPO_ROOT,
  UUID_RE,
  UsageError,
  appReachable,
  confirmPath,
  createAdminClient,
  errCode,
  loadLocalEnv,
  missingEnv,
  normaliseAppUrl,
  parseAdminIds,
  signInTokenHash,
} from "./lib/demo-common.mjs";

export { UsageError };

// Mirrors src/lib/book/options.ts and src/lib/ai/limits.ts (tests assert they stay in sync).
export const OCCASIONS = ["wedding", "travel", "baby", "graduation", "family", "other"];
export const TONES = ["romantic", "fun", "nostalgic", "minimal"];
export const CAPTION_LANGS = ["en", "ar"];
export const DEFAULT_TONE = { wedding: "romantic", travel: "fun", baby: "nostalgic", graduation: "fun", family: "nostalgic", other: "minimal" };
export const TITLE_MAX_CHARS = 120;
export const MAX_PHOTOS_PER_BOOK = 500; // paid upload cap (books are comped before the upload)
export const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"];
export const STATE_FILE = ".seeded.json";
export const SNIPPET_FILE = "examples-snippet.ts";
export const COMP_REASON = "demo";
export const REQUIRED_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "ADMIN_USER_IDS"];
const SLUG_RE = /^([a-z0-9-]{1,30}-)?[1-9A-HJ-NP-Za-km-z]{10}$/;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const BookJsonSchema = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX_CHARS).optional(),
    captionLang: z.enum(CAPTION_LANGS).optional(),
    occasion: z.enum(OCCASIONS).optional(),
    tone: z.enum(TONES).optional(),
  })
  .strict();

const StateSchema = z.object({ bookId: z.string().regex(UUID_RE), slug: z.string().regex(SLUG_RE).nullable() });

// ---------------------------------------------------------------------------------------------
// Arguments

/** @returns {{ dryRun: boolean, headed: boolean, owner?: string, dir?: string, app?: string, update?: string }} */
export function parseArgs(argv) {
  /** @type {{ dryRun: boolean, headed: boolean, owner?: string, dir?: string, app?: string, update?: string }} */
  const out = { dryRun: false, headed: false };
  const valued = { "--owner": "owner", "--dir": "dir", "--app": "app", "--update": "update" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--headed") out.headed = true;
    else if (a in valued) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`missing value for ${a}`);
      out[valued[a]] = v;
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  return out;
}

/** Checks args against env. Returns normalised options or throws UsageError. */
export function validateArgs(args, env) {
  const missing = missingEnv(env, REQUIRED_ENV);
  if (missing.length) throw new UsageError(`missing env: ${missing.join(", ")} (process env or .env.local)`);
  const owner = String(args.owner ?? "").trim().toLowerCase();
  if (!UUID_RE.test(owner)) throw new UsageError("--owner must be a user uuid");
  if (!parseAdminIds(env.ADMIN_USER_IDS).includes(owner)) throw new UsageError("--owner is not listed in ADMIN_USER_IDS");
  if (Boolean(args.dir) === Boolean(args.update)) throw new UsageError("pass exactly one of --dir <folder> or --update <slug>");
  if (args.update && !SLUG_RE.test(args.update)) throw new UsageError("--update must be a book slug (the part after /b/)");
  const app = normaliseAppUrl(args.app ?? "http://localhost:3000");
  const dir = args.dir ? path.resolve(args.dir.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : null;
  return { owner, app, dir, update: args.update ?? null, dryRun: Boolean(args.dryRun), headed: Boolean(args.headed) };
}

// ---------------------------------------------------------------------------------------------
// Folder scan

/** "wedding-sara_2026" → "Wedding Sara 2026". */
export function humanizeFolder(name) {
  const t = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const s = t.replace(/(^|\s)(\p{Ll})/gu, (_m, sp, c) => sp + c.toUpperCase());
  return [...s].slice(0, TITLE_MAX_CHARS).join("");
}

function readState(dir) {
  const f = path.join(dir, STATE_FILE);
  if (!existsSync(f)) return null;
  try {
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(f, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeState(dir, state) {
  writeFileSync(path.join(dir, STATE_FILE), `${JSON.stringify({ bookId: state.bookId, slug: state.slug ?? null }, null, 2)}\n`);
}

/**
 * Validates the folder structure. Returns { books, errors, warnings }; books are sorted by folder
 * name, each { folder, dir, photos (absolute paths, sorted), options, state }.
 */
export function scanBooksDir(dir) {
  const errors = [];
  const warnings = [];
  const books = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { books, errors: [`--dir is not a folder: ${dir}`], warnings };
  const subs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  if (subs.length === 0) errors.push("no book folders found: put one subfolder per book inside --dir");
  for (const folder of subs) {
    const bdir = path.join(dir, folder);
    const files = readdirSync(bdir, { withFileTypes: true }).filter((f) => f.isFile() && !f.name.startsWith("."));
    let json = {};
    const jf = files.find((f) => f.name === "book.json");
    if (jf) {
      try {
        const parsed = BookJsonSchema.safeParse(JSON.parse(readFileSync(path.join(bdir, jf.name), "utf8")));
        if (parsed.success) json = parsed.data;
        else errors.push(`${folder}/book.json: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
      } catch {
        errors.push(`${folder}/book.json: not valid JSON`);
      }
    }
    const photos = [];
    for (const f of files) {
      if (f.name === "book.json" || f.name === STATE_FILE) continue;
      const ext = path.extname(f.name).toLowerCase();
      if (!PHOTO_EXTENSIONS.includes(ext)) {
        warnings.push(`${folder}/${f.name}: not a photo, ignored`);
        continue;
      }
      const p = path.join(bdir, f.name);
      if (statSync(p).size > MAX_FILE_BYTES) {
        warnings.push(`${folder}/${f.name}: larger than 200 MB, ignored`);
        continue;
      }
      photos.push(p);
    }
    photos.sort((a, b) => a.localeCompare(b));
    if (photos.length === 0) errors.push(`${folder}: no photos (${PHOTO_EXTENSIONS.join(" ")})`);
    if (photos.length > MAX_PHOTOS_PER_BOOK) errors.push(`${folder}: ${photos.length} photos, max ${MAX_PHOTOS_PER_BOOK} per book`);
    const occasion = json.occasion ?? "other";
    books.push({
      folder,
      dir: bdir,
      photos,
      options: {
        title: json.title ?? humanizeFolder(folder),
        captionLang: json.captionLang ?? "en",
        occasion,
        tone: json.tone ?? DEFAULT_TONE[occasion],
      },
      state: readState(bdir),
    });
  }
  return { books, errors, warnings };
}

// ---------------------------------------------------------------------------------------------
// Output

/** Ready-to-paste replacement for the EXAMPLE_BOOKS constant in src/lib/marketing/examples.ts. */
export function examplesSnippet(entries) {
  const lines = entries.map(
    (e) => `  { slug: ${JSON.stringify(e.slug)}, title: ${JSON.stringify(e.title)}, coverSrc: ${JSON.stringify(`/examples/${e.slug}.jpg`)} },`,
  );
  return [
    "// Paste over EXAMPLE_BOOKS in src/lib/marketing/examples.ts (generated by scripts/seed-demo-books.mjs).",
    "export const EXAMPLE_BOOKS: readonly ExampleBook[] = [",
    ...lines,
    "];",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Preflight (shared by --dry-run and real runs)

/**
 * Network checks. deps: { fetch, admin }. Returns a list of problems (empty = ok).
 * Never includes emails or keys.
 */
export async function preflight(opts, deps) {
  const problems = [];
  if (!(await appReachable(deps.fetch, opts.app))) problems.push(`app not reachable at ${opts.app}/login — start it (npm run dev) or pass --app`);
  try {
    const u = await deps.admin.auth.admin.getUserById(opts.owner);
    if (u.error || !u.data?.user) problems.push(`--owner not found in this Supabase project (${u.error ? errCode(u.error) : "no_user"})`);
    else if (!u.data.user.email) problems.push("--owner has no email (needed for the admin sign-in link)");
  } catch (err) {
    problems.push(`Supabase not reachable (${errCode(err)})`);
    return problems;
  }
  const prof = await deps.admin.from("profiles").select("id").eq("id", opts.owner).maybeSingle();
  if (prof.error || !prof.data) problems.push(`--owner has no profile row (${prof.error ? errCode(prof.error) : "missing"})`);
  // comp_book + orders.note/comped_by come with migration 1700.
  const m1700 = await deps.admin.from("orders").select("note, comped_by").limit(1);
  if (m1700.error) problems.push(`migration 1700 (comp_book) not applied to this project (${errCode(m1700.error)}) — run npx supabase db push`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Browser steps (only used by real runs)

async function bookRow(admin, bookId) {
  const { data, error } = await admin.from("books").select("id, user_id, slug, ai_status, is_paid, published_at").eq("id", bookId).maybeSingle();
  if (error) throw new Error(`books select failed (${errCode(error)})`);
  return data;
}

async function readyPhotoCount(admin, bookId) {
  const { count, error } = await admin.from("photos").select("id", { count: "exact", head: true }).eq("book_id", bookId).eq("upload_state", "ready");
  if (error) throw new Error(`photos count failed (${errCode(error)})`);
  return count ?? 0;
}

// Upload's finalize already writes a rule-based fallback album, so "has pages" says nothing:
// the AI build counts as done once books.ai_status settled (failed = keep the fallback album).
const BUILD_SETTLED = ["done", "partial", "failed"];

async function createBookViaForm(page, options) {
  await page.goto("/books/new");
  await page.locator("label", { has: page.getByTestId(`occasion-${options.occasion}`) }).click();
  await page.locator("label", { has: page.getByTestId(`tone-${options.tone}`) }).click();
  await page.locator("label", { has: page.getByTestId(`lang-${options.captionLang}`) }).click();
  await page.getByTestId("book-title").fill(options.title);
  await page.getByTestId("create-book").click();
  await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload/, { timeout: 60_000 });
  return new URL(page.url()).pathname.split("/")[2];
}

async function uploadPhotos(page, bookId, photos) {
  await page.goto(`/books/${bookId}/upload`);
  // File paths (not buffers): Playwright refuses > 50 MB of in-memory files.
  await page.getByTestId("upload-input").setInputFiles(photos);
  await page.getByTestId("upload-summary").waitFor({ state: "visible", timeout: 120_000 + photos.length * 8_000 });
}

async function buildAlbum(page, bookId, photoCount) {
  await page.goto(`/books/${bookId}/build`);
  await page.waitForURL(new RegExp(`/books/${bookId}/(review|edit)`), { timeout: 600_000 + photoCount * 3_000 });
  if (/\/review/.test(page.url())) {
    await page.getByTestId("review-continue").click();
    await page.waitForURL(new RegExp(`/books/${bookId}/edit`), { timeout: 60_000 });
  }
  await page.getByTestId("editor-done").click();
  await page.waitForURL(new RegExp(`/books/${bookId}/publish`), { timeout: 60_000 });
}

/** Publishes (or publishes changes). Returns "published" | "republished" | "unchanged". */
async function publish(page, bookId) {
  if (!new RegExp(`/books/${bookId}/publish`).test(page.url())) await page.goto(`/books/${bookId}/publish`);
  const panel = page.getByTestId("publish-panel");
  await panel.waitFor({ state: "visible", timeout: 60_000 });
  const state = await panel.getAttribute("data-state");
  if (state === "unpublished" || state === "expired") {
    await page.getByTestId("publish-button").click();
    await page.getByTestId("publish-live").waitFor({ state: "visible", timeout: 60_000 });
    return "published";
  }
  const changes = page.getByTestId("publish-changes-button");
  if (await changes.isVisible().catch(() => false)) {
    await changes.click();
    await page.getByTestId("publish-changes").waitFor({ state: "hidden", timeout: 60_000 }).catch(() => {});
    return "republished";
  }
  return "unchanged";
}

/**
 * Saves the cover as rendered by the public viewer (no chrome, comped → no watermark) to
 * `outFile` as a 600 px wide JPEG. Falls back to the /b/<slug>/og card. Returns the source used.
 */
export async function exportCover(browser, app, slug, outFile) {
  const sharp = (await import("sharp")).default;
  mkdirSync(path.dirname(outFile), { recursive: true });
  const ctx = await browser.newContext({ baseURL: app, viewport: { width: 430, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try {
    const page = await ctx.newPage();
    const res = await page.goto(`/b/${slug}`);
    if (res?.status() === 200) {
      await page.getByTestId("flipbook").and(page.locator('[data-ready="true"]')).waitFor({ timeout: 45_000 });
      await page.addStyleTag({
        content:
          '[data-testid="viewer-top-bar"],[data-testid="viewer-bottom-bar"],[data-testid="made-with-footer"],[data-testid="show-controls"]{visibility:hidden!important}',
      });
      const cover = page.locator('[data-flip-index="0"]').first();
      await cover.waitFor({ state: "visible", timeout: 20_000 });
      await page
        .waitForFunction(
          () => {
            const el = document.querySelector('[data-flip-index="0"]');
            return !!el && [...el.querySelectorAll("img")].every((i) => i.complete && i.naturalWidth > 0);
          },
          undefined,
          { timeout: 30_000 },
        )
        .catch(() => {});
      await page.waitForTimeout(600); // fonts + flip settle
      const png = await cover.screenshot({ animations: "disabled" });
      writeFileSync(outFile, await sharp(png).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer());
      return "viewer";
    }
  } catch {
    /* fall back to the OG card */
  } finally {
    await ctx.close().catch(() => {});
  }
  const og = await fetch(`${app}/b/${slug}/og`);
  if (!og.ok) throw new Error(`cover export failed (og ${og.status})`);
  writeFileSync(outFile, await sharp(Buffer.from(await og.arrayBuffer())).jpeg({ quality: 82, mozjpeg: true }).toBuffer());
  return "og";
}

async function compOrThrow(admin, bookId, owner) {
  const r = await compBook(admin, { book: bookId, admin: owner, reason: COMP_REASON });
  if (r === "not_found") throw new Error("comp_book: not_found");
  return r;
}

async function seedOne({ page, browser, admin, opts, book, publicDir, log }) {
  let bookId = book.state?.bookId ?? null;
  if (bookId) {
    const row = await bookRow(admin, bookId);
    if (!row || row.user_id !== opts.owner) {
      log(`  ${book.folder}: saved book no longer exists — creating a new one`);
      bookId = null;
    }
  }
  if (!bookId) {
    bookId = await createBookViaForm(page, book.options);
    writeState(book.dir, { bookId, slug: null });
    log(`  ${book.folder}: book created`);
  }
  log(`  ${book.folder}: comp → ${await compOrThrow(admin, bookId, opts.owner)}`);

  let ready = await readyPhotoCount(admin, bookId);
  if (ready === 0) {
    log(`  ${book.folder}: uploading ${book.photos.length} photos…`);
    await uploadPhotos(page, bookId, book.photos);
    ready = await readyPhotoCount(admin, bookId);
    log(`  ${book.folder}: ${ready}/${book.photos.length} photos ready`);
    if (ready === 0) throw new Error("no photo finished uploading");
  } else log(`  ${book.folder}: ${ready} photos already uploaded (resume)`);

  const before = (await bookRow(admin, bookId)).ai_status;
  if (!BUILD_SETTLED.includes(before)) {
    log(`  ${book.folder}: building the album (server AI mode)…`);
    await buildAlbum(page, bookId, ready);
    log(`  ${book.folder}: build ${(await bookRow(admin, bookId)).ai_status ?? "unknown"}`);
  } else log(`  ${book.folder}: album already built (${before}, resume)`);
  log(`  ${book.folder}: ${await publish(page, bookId)}`);
  const row = await bookRow(admin, bookId);
  if (!row?.slug || !row.published_at) throw new Error("publish did not produce a live link");
  writeState(book.dir, { bookId, slug: row.slug });
  const source = await exportCover(browser, opts.app, row.slug, path.join(publicDir, "examples", `${row.slug}.jpg`));
  log(`  ${book.folder}: cover saved (public/examples/${row.slug}.jpg, from ${source})`);
  return { slug: row.slug, title: book.options.title };
}

// ---------------------------------------------------------------------------------------------
// Runner

/**
 * deps: { env, fetch, createAdmin(url, key), launchBrowser({ headed }), log, error, publicDir }.
 * Returns the exit code.
 */
export async function runSeed(argv, deps) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  let opts;
  try {
    opts = validateArgs(parseArgs(argv), deps.env);
  } catch (err) {
    error(err instanceof Error ? err.message : "bad arguments");
    error("usage: node scripts/seed-demo-books.mjs --owner <admin uuid> (--dir <folder> | --update <slug>) [--app URL] [--dry-run] [--headed]");
    return 2;
  }

  let scan = null;
  if (opts.dir) {
    scan = scanBooksDir(opts.dir);
    for (const w of scan.warnings) log(`warning: ${w}`);
    if (scan.errors.length) {
      for (const e of scan.errors) error(`error: ${e}`);
      return 2;
    }
  }

  const admin = await deps.createAdmin(deps.env.NEXT_PUBLIC_SUPABASE_URL.trim(), deps.env.SUPABASE_SECRET_KEY.trim());
  const problems = await preflight(opts, { fetch: deps.fetch, admin });
  if (problems.length) {
    for (const p of problems) error(`error: ${p}`);
    return 2;
  }

  if (opts.dryRun) {
    if (scan) {
      for (const b of scan.books) {
        const st = b.state?.slug ? `published (${b.state.slug}) → skipped` : b.state ? "half done → resumed" : "new";
        log(`ok: ${b.folder}: ${b.photos.length} photos, lang ${b.options.captionLang}, occasion ${b.options.occasion}, ${st}`);
      }
      log(`dry run ok: ${scan.books.length} book folder(s), env + owner + app + migration 1700 checked. Nothing was created.`);
    } else {
      const row = await admin.from("books").select("id").eq("slug", opts.update).eq("user_id", opts.owner).maybeSingle();
      if (row.error || !row.data) {
        error(`error: no book with slug ${opts.update} owned by --owner`);
        return 2;
      }
      log("dry run ok: book found; --update would republish it, re-comp (no-op) and refresh its cover.");
    }
    return 0;
  }

  const publicDir = deps.publicDir ?? path.join(REPO_ROOT, "public");
  const browser = await deps.launchBrowser({ headed: opts.headed });
  const results = [];
  let failed = 0;
  try {
    const ctx = await browser.newContext({ baseURL: opts.app, viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("dialog", (d) => void d.accept());
    await page.goto(confirmPath(await signInTokenHash(admin, opts.owner), "/dashboard"));
    await page.waitForURL(/\/dashboard/, { timeout: 60_000 });

    if (opts.update) {
      const { data, error: e } = await admin.from("books").select("id, title").eq("slug", opts.update).eq("user_id", opts.owner).maybeSingle();
      if (e || !data) throw new Error("no book with that slug owned by --owner");
      log(`  comp → ${await compOrThrow(admin, data.id, opts.owner)}`);
      log(`  ${await publish(page, data.id)}`);
      const source = await exportCover(browser, opts.app, opts.update, path.join(publicDir, "examples", `${opts.update}.jpg`));
      log(`  cover saved (public/examples/${opts.update}.jpg, from ${source})`);
      results.push({ slug: opts.update, title: data.title ?? "" });
    } else {
      for (const book of scan.books) {
        if (book.state?.slug) {
          log(`  ${book.folder}: already published — skipped (use --update ${book.state.slug} to republish)`);
          results.push({ slug: book.state.slug, title: book.options.title });
          continue;
        }
        try {
          results.push(await seedOne({ page, browser, admin, opts, book, publicDir, log }));
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : "failed";
          error(`  ${book.folder}: FAILED (${msg}) — re-run to resume`);
        }
      }
    }
    await ctx.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  log("");
  for (const r of results) log(JSON.stringify({ slug: r.slug, title: r.title }));
  if (results.length && opts.dir) {
    const snippet = examplesSnippet(results);
    writeFileSync(path.join(opts.dir, SNIPPET_FILE), snippet);
    log(`\n${snippet}(also written to ${path.join(opts.dir, SNIPPET_FILE)})`);
  } else if (results.length) {
    log(`\n${examplesSnippet(results)}`);
  }
  return failed ? 1 : 0;
}

async function main() {
  loadLocalEnv();
  const code = await runSeed(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    createAdmin: createAdminClient,
    launchBrowser: async ({ headed }) => {
      const { chromium } = await import("@playwright/test");
      return chromium.launch({ headless: !headed });
    },
  });
  process.exit(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
