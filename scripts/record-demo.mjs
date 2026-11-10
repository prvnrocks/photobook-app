#!/usr/bin/env node
// Record the landing-page demo video (M9 T15): a 375×812 phone run of the real flow —
// landing → login screen → (signed in) new book → upload → AI build → review → editor → publish →
// public flipbook, flipping a few pages. Output in public/demo/:
//   demo.mp4   when a system ffmpeg with libx264 exists (brew install ffmpeg) — best: plays everywhere
//   demo.webm  otherwise (VP9, re-encoded with Playwright's bundled ffmpeg)
//   poster.jpg the first meaningful frame (landing page loaded)
// The landing page picks up whichever exists (src/lib/marketing/demo.ts, mp4 preferred) at the next
// build/deploy. Target size < 3 MB: the encoder quality is stepped down until it fits.
//
// Uses ONE throwaway user (demo-rec-<random>@example.com, display name "Sara", signed in with an
// admin generateLink token — no email is sent) and always deletes it afterwards together with its
// storage objects (books/photos cascade). Never prints emails, tokens or keys.
//
// Run the app with replay AI so the recording costs nothing and is repeatable, e.g.
//   AI_MODE=replay npm run dev            (another terminal)
//   node scripts/record-demo.mjs [--photos ~/demo-photos] [--app http://localhost:3000] [--draft] [--headed]
// --photos: a folder with 6–30 nice photos (default: generated sample pictures — fine for a test,
//           use real ones for the published video). --draft writes demo.draft.* / poster.draft.jpg
//           (git-ignored) instead of the real files.
//
// Env (process env first, then .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY — the
// same Supabase project the --app server uses. Optional FFMPEG_PATH.
// Exit codes: 0 ok, 1 recording failed, 2 bad arguments / env.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHONE_VIEWPORT,
  REPO_ROOT,
  UsageError,
  appReachable,
  confirmPath,
  createAdminClient,
  errCode,
  findFfmpeg,
  loadLocalEnv,
  missingEnv,
  normaliseAppUrl,
  removeUserObjects,
  signInTokenHash,
  writeSyntheticPhotos,
} from "./lib/demo-common.mjs";

export const TARGET_BYTES = 3 * 1024 * 1024;
export const MAX_PHOTOS = 30;
const PHOTO_EXT = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"];
const BOOK_TITLE = "Weekend in Abu Dhabi";
const FAKE_UUID = "00000000-0000-4000-8000-000000000000";

export function parseArgs(argv) {
  const out = { draft: false, headed: false };
  const valued = { "--app": "app", "--photos": "photos", "--out": "out" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--draft") out.draft = true;
    else if (a === "--headed") out.headed = true;
    else if (a in valued) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`missing value for ${a}`);
      out[valued[a]] = v;
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  return out;
}

/** Output file names for a given container. */
export function outputNames(outDir, ext, draft) {
  const tag = draft ? ".draft" : "";
  return { video: path.join(outDir, `demo${tag}.${ext}`), poster: path.join(outDir, `poster${tag}.jpg`), otherExt: ext === "mp4" ? "webm" : "mp4" };
}

/** ffmpeg argument lists to try in order (each smaller than the last). */
export function encodePlans(h264, startS, durationS) {
  const head = ["-y", "-hide_banner", "-loglevel", "error", "-i"];
  const cut = ["-ss", startS.toFixed(2), "-t", durationS.toFixed(2), "-an"];
  if (h264) {
    return [26, 30, 34, 38].map((crf) => ({
      ext: "mp4",
      args: (input, output) => [...head, input, ...cut, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", output],
    }));
  }
  return [36, 42, 48, 54].map((crf) => ({
    ext: "webm",
    args: (input, output) => [...head, input, ...cut, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", output],
  }));
}

function listPhotos(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UsageError(`--photos is not a folder: ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => !f.startsWith(".") && PHOTO_EXT.includes(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(dir, f));
  if (files.length < 1) throw new UsageError("--photos has no photos");
  return files.slice(0, MAX_PHOTOS);
}

const pause = (page, ms) => page.waitForTimeout(ms);

async function smoothScroll(page, dy, steps = 12) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps);
    await page.waitForTimeout(40);
  }
}

/** Compiles the dev routes once (unrecorded) so the video has no first-compile pauses. */
async function warmUp(browser, app, tokenHash) {
  const ctx = await browser.newContext({ baseURL: app, viewport: PHONE_VIEWPORT });
  try {
    const page = await ctx.newPage();
    await page.goto("/");
    await page.goto("/login");
    await page.goto(confirmPath(tokenHash, "/books/new"));
    await page.waitForURL(/\/books\/new/, { timeout: 120_000 });
    for (const p of ["upload", "build", "review", "edit", "publish"]) await page.request.get(`/books/${FAKE_UUID}/${p}`, { timeout: 180_000 }).catch(() => {});
    await page.request.get("/b/abcdefghij", { timeout: 180_000 }).catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function recordFlow({ browser, app, admin, uid, photos, videoDir, posterFile }) {
  const sharp = (await import("sharp")).default;
  const ctx = await browser.newContext({
    baseURL: app,
    viewport: PHONE_VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    recordVideo: { dir: videoDir, size: PHONE_VIEWPORT },
  });
  // Hide the Next dev-tools badge when recording against `next dev`.
  await ctx.addInitScript(() => {
    const add = () => {
      const s = document.createElement("style");
      s.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(s);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
  });
  const t0 = Date.now();
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  let startS = 0;
  let endS = 0;
  try {
    await page.goto("/");
    await page.getByTestId("hero-heading").waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready);
    await pause(page, 300);
    startS = (Date.now() - t0) / 1000;
    writeFileSync(posterFile, await sharp(await page.screenshot()).resize({ width: 750 }).jpeg({ quality: 78, mozjpeg: true }).toBuffer());
    await pause(page, 1600);
    await smoothScroll(page, 500);
    await pause(page, 900);
    await smoothScroll(page, -500);
    await pause(page, 500);
    await page.getByTestId("cta-create").click();
    await page.waitForURL(/\/login/);
    await page.getByTestId("login-email").pressSequentially("sara@example.com", { delay: 45 });
    await pause(page, 700);

    // "Check your email" is skipped: sign in with an admin token instead.
    await page.goto(confirmPath(await signInTokenHash(admin, uid), "/books/new"));
    await page.waitForURL(/\/books\/new/, { timeout: 60_000 });
    await pause(page, 600);
    await page.locator("label", { has: page.getByTestId("occasion-travel") }).click();
    await pause(page, 400);
    await page.getByTestId("book-title").pressSequentially(BOOK_TITLE, { delay: 40 });
    await pause(page, 500);
    await page.getByTestId("create-book").click();
    await page.waitForURL(/\/books\/[0-9a-f-]{36}\/upload/, { timeout: 60_000 });
    const bookId = new URL(page.url()).pathname.split("/")[2];
    await pause(page, 700);

    await page.getByTestId("upload-input").setInputFiles(photos);
    await page.getByTestId("upload-summary").waitFor({ state: "visible", timeout: 300_000 });
    await pause(page, 1200);
    await page.getByTestId("build-album").click();
    await page.waitForURL(new RegExp(`/books/${bookId}/(review|edit)`), { timeout: 420_000 });
    if (/\/review/.test(page.url())) {
      await pause(page, 1200);
      await smoothScroll(page, 700, 16);
      await pause(page, 800);
      await smoothScroll(page, -700, 10);
      await pause(page, 400);
      await page.getByTestId("review-continue").click();
      await page.waitForURL(new RegExp(`/books/${bookId}/edit`), { timeout: 60_000 });
    }
    await page.getByTestId("editor-shell").waitFor({ state: "visible", timeout: 60_000 });
    await pause(page, 1800);
    await page.getByTestId("editor-done").click();
    await page.waitForURL(new RegExp(`/books/${bookId}/publish`), { timeout: 60_000 });
    await pause(page, 800);
    await page.getByTestId("publish-button").click();
    await page.getByTestId("publish-live").waitFor({ state: "visible", timeout: 60_000 });
    await pause(page, 1500);
    const url = await page.getByTestId("publish-url").inputValue();
    const slug = new URL(url).pathname.split("/").pop();

    await page.goto(`/b/${slug}`);
    await page.getByTestId("flipbook").and(page.locator('[data-ready="true"]')).waitFor({ timeout: 60_000 });
    await pause(page, 1500);
    for (let i = 0; i < 4; i++) {
      await page.getByTestId("next-page").click();
      await pause(page, 1400);
    }
    await pause(page, 600);
    endS = (Date.now() - t0) / 1000;
  } finally {
    await ctx.close();
  }
  const raw = await page.video()?.path();
  if (!raw || !existsSync(raw)) throw new Error("no video was recorded");
  return { raw, startS, endS };
}

function encode(raw, ff, startS, endS, outDir, draft) {
  const duration = Math.max(1, endS - startS);
  if (!ff) {
    const { video } = outputNames(outDir, "webm", draft);
    copyFileSync(raw, video);
    return { file: video, ext: "webm", encoder: "none (raw Playwright webm, untrimmed)", duration: endS };
  }
  let last = null;
  for (const plan of encodePlans(ff.h264, startS, duration)) {
    const { video } = outputNames(outDir, plan.ext, draft);
    execFileSync(ff.bin, plan.args(raw, video), { stdio: ["ignore", "ignore", "pipe"], timeout: 600_000 });
    last = { file: video, ext: plan.ext, encoder: ff.h264 ? "libx264" : "libvpx-vp9 (Playwright ffmpeg)", duration };
    if (statSync(video).size <= TARGET_BYTES) break;
  }
  return last;
}

export async function runRecord(argv, deps) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  let args;
  try {
    args = parseArgs(argv);
    args.app = normaliseAppUrl(args.app ?? "http://localhost:3000");
    const missing = missingEnv(deps.env, ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
    if (missing.length) throw new UsageError(`missing env: ${missing.join(", ")} (process env or .env.local)`);
    if (args.photos) args.photoList = listPhotos(path.resolve(args.photos.replace(/^~(?=$|\/)/, os.homedir())));
  } catch (err) {
    error(err instanceof Error ? err.message : "bad arguments");
    error("usage: node scripts/record-demo.mjs [--photos <folder>] [--app URL] [--out public/demo] [--draft] [--headed]");
    return 2;
  }
  if (!(await appReachable(deps.fetch, args.app))) {
    error(`app not reachable at ${args.app}/login — start it with AI_MODE=replay npm run dev`);
    return 2;
  }
  const outDir = path.resolve(args.out ?? path.join(REPO_ROOT, "public", "demo"));
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(path.join(os.tmpdir(), "record-demo-"));
  const admin = await deps.createAdmin(deps.env.NEXT_PUBLIC_SUPABASE_URL.trim(), deps.env.SUPABASE_SECRET_KEY.trim());
  let uid = "";
  let browser = null;
  let code = 0;
  try {
    const photos = args.photoList ?? (await writeSyntheticPhotos(path.join(work, "photos"), 8, 11));
    log(`photos: ${photos.length}${args.photoList ? "" : " (generated samples)"}`);
    const email = `demo-rec-${randomBytes(6).toString("hex")}@example.com`;
    const created = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name: "Sara" } });
    if (created.error || !created.data.user) throw new Error(`createUser failed (${errCode(created.error)})`);
    uid = created.data.user.id;

    browser = await deps.launchBrowser({ headed: args.headed });
    log("warming up routes…");
    await warmUp(browser, args.app, await signInTokenHash(admin, uid));
    log("recording…");
    const posterTmp = path.join(work, "poster.jpg");
    const { raw, startS, endS } = await recordFlow({ browser, app: args.app, admin, uid, photos, videoDir: path.join(work, "video"), posterFile: posterTmp });
    const ff = findFfmpeg(deps.env);
    const out = encode(raw, ff, startS, endS, outDir, args.draft);
    const names = outputNames(outDir, out.ext, args.draft);
    copyFileSync(posterTmp, names.poster);
    if (!args.draft) {
      // A stale file of the other format would shadow (mp4) or linger next to the new one.
      const other = path.join(outDir, `demo.${names.otherExt}`);
      if (existsSync(other)) {
        rmSync(other);
        log(`removed old ${path.relative(REPO_ROOT, other)}`);
      }
    }
    const size = statSync(out.file).size;
    log(`video: ${path.relative(REPO_ROOT, out.file)} ${(size / 1048576).toFixed(2)} MB, ${out.duration.toFixed(1)} s, ${out.encoder}`);
    log(`poster: ${path.relative(REPO_ROOT, names.poster)} ${(statSync(names.poster).size / 1024).toFixed(0)} KB`);
    if (size > TARGET_BYTES) log("warning: still larger than 3 MB — use fewer photos or shorten the flow");
    if (!ff) log("note: no ffmpeg found — kept the raw webm. Install ffmpeg (brew install ffmpeg) for a small mp4.");
    else if (!ff.h264) log("note: webm (VP9) written; for the widest phone support install ffmpeg (brew install ffmpeg) and re-run to get demo.mp4.");
  } catch (err) {
    code = 1;
    error(`recording failed (${err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : "unknown"})`);
  } finally {
    await browser?.close().catch(() => {});
    if (uid) {
      const removed = await removeUserObjects(admin, uid).catch(() => -1);
      const del = await admin.auth.admin.deleteUser(uid);
      const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
      log(`cleanup: objects removed=${removed} userDeleted=${!del.error} booksLeft=${books.count ?? "?"}`);
      if (del.error) {
        code = 1;
        error(`cleanup: deleteUser failed (${errCode(del.error)}) — delete the demo-rec-* user in Supabase Auth by hand`);
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
  return code;
}

async function main() {
  loadLocalEnv();
  const code = await runRecord(process.argv.slice(2), {
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
