// Shared helpers for the M9 T15 demo tooling (scripts/seed-demo-books.mjs, scripts/record-demo.mjs).
//
// Rules that every helper follows: never print emails, tokens, keys or signed URLs; errors are
// reduced to short codes. Network-touching helpers take their client / fetch as an argument so the
// unit tests can mock them.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PHOTOS_BUCKET = "photos";
export const EXPORTS_BUCKET = "exports";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PHONE_VIEWPORT = { width: 375, height: 812 };

export class UsageError extends Error {}

/** Loads REPO_ROOT/.env.local into process.env without overriding variables already set. */
export function loadLocalEnv(root = REPO_ROOT) {
  const file = path.join(root, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Names from `names` that are missing/blank in `env`. */
export function missingEnv(env, names) {
  return names.filter((n) => !(typeof env[n] === "string" && env[n].trim().length > 0));
}

/** Valid, lower-cased uuids from a raw ADMIN_USER_IDS value. */
export function parseAdminIds(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID_RE.test(s));
}

/** Normalises --app: http(s) origin (+ optional path), no trailing slash. Throws UsageError. */
export function normaliseAppUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new UsageError("--app must be a URL like http://localhost:3000");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError("--app must be http(s)");
  if (u.search || u.hash || u.username || u.password) throw new UsageError("--app must not contain a query, hash or credentials");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Short, safe error code (no messages: they can contain emails or ids). */
export function errCode(err) {
  const raw = err && typeof err === "object" ? (err.code ?? err.status ?? err.name) : undefined;
  return String(raw ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
}

/** Lazily creates a supabase-js service-role client (server-side tooling only). */
export async function createAdminClient(url, key) {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** True if GET <app>/login answers 200 (the app is up). Never throws. */
export async function appReachable(fetchFn, app) {
  try {
    const res = await fetchFn(`${app}/login`, { redirect: "manual" });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * One-time magic-link token_hash for `userId` (admin generateLink; no email is sent). The user's
 * email is looked up and used only inside this function — it is never returned or logged.
 */
export async function signInTokenHash(admin, userId) {
  const u = await admin.auth.admin.getUserById(userId);
  const email = u.data?.user?.email;
  if (u.error || !email) throw new Error(`user lookup failed (${u.error ? errCode(u.error) : "no_email"})`);
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const hash = data?.properties?.hashed_token;
  if (error || !hash) throw new Error(`generateLink failed (${error ? errCode(error) : "no_token"})`);
  return hash;
}

/** `/auth/confirm` path that signs the browser in and lands on `next`. */
export function confirmPath(tokenHash, next) {
  return `/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=${encodeURIComponent(next)}`;
}

/** Every object path under `prefix/` in `bucket` (recursive). */
export async function listObjects(admin, bucket, prefix, depth = 0) {
  if (depth > 6) return [];
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`storage list failed (${errCode(error)})`);
    for (const e of data ?? []) {
      const p = `${prefix}/${e.name}`;
      if (e.id) out.push(p);
      else out.push(...(await listObjects(admin, bucket, p, depth + 1)));
    }
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** Removes every object under `<uid>/` in the photos + exports buckets. Returns the count removed. */
export async function removeUserObjects(admin, uid) {
  let removed = 0;
  for (const bucket of [PHOTOS_BUCKET, EXPORTS_BUCKET]) {
    for (let round = 0; round < 3; round++) {
      let paths;
      try {
        paths = await listObjects(admin, bucket, uid);
      } catch {
        break; // e.g. bucket missing on an old project
      }
      if (paths.length === 0) break;
      for (let i = 0; i < paths.length; i += 100) {
        const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
        if (error) console.error(`[cleanup] storage remove failed (${errCode(error)})`);
      }
      removed += paths.length;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// ffmpeg discovery (record-demo)

function runOk(bin, args) {
  try {
    return execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15_000 });
  } catch {
    return null;
  }
}

/** Playwright's bundled ffmpeg (VP9-only build) or null. */
export function findPlaywrightFfmpeg(env = process.env) {
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter((r) => r && r !== "0" && existsSync(r));
  for (const root of roots) {
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith("ffmpeg-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const name of ["ffmpeg-mac", "ffmpeg-linux", "ffmpeg-win64.exe"]) {
        const p = path.join(root, d, name);
        if (existsSync(p) && statSync(p).isFile()) return p;
      }
    }
  }
  return null;
}

/**
 * Best available encoder: a system ffmpeg with libx264 → { bin, h264: true } (mp4 output);
 * otherwise Playwright's ffmpeg → { bin, h264: false } (re-encoded VP9 webm); otherwise null.
 */
export function findFfmpeg(env = process.env) {
  const sys = env.FFMPEG_PATH?.trim() || "ffmpeg";
  const encoders = runOk(sys, ["-hide_banner", "-encoders"]);
  if (encoders && /libx264/.test(encoders)) return { bin: sys, h264: true };
  const pw = findPlaywrightFfmpeg(env);
  if (pw && runOk(pw, ["-hide_banner", "-version"]) !== null) return { bin: pw, h264: false };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Synthetic photos (tests / a demo run without real photos)

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/**
 * Writes `n` distinct, sharp (not blurry, not duplicate) JPEG "landscapes" into `dir` with sharp.
 * Returns the absolute file paths. Portrait 900×1200 by default, every third one landscape.
 */
export async function writeSyntheticPhotos(dir, n, seed = 1) {
  const sharp = (await import("sharp")).default;
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rng((seed + i) * 7919 + 17);
    const landscape = i % 3 === 2;
    const w = landscape ? 1200 : 900;
    const h = landscape ? 900 : 1200;
    const hue = Math.floor(r() * 360);
    const horizon = Math.floor(h * (0.5 + r() * 0.2));
    const sunX = Math.floor(w * (0.2 + r() * 0.6));
    const sunY = Math.floor(horizon * (0.35 + r() * 0.4));
    const sunR = Math.floor(Math.min(w, h) * (0.06 + r() * 0.06));
    const blocks = Array.from({ length: 6 + Math.floor(r() * 8) }, () => {
      const bw = Math.floor(w * (0.05 + r() * 0.12));
      const bh = Math.floor(h * (0.08 + r() * 0.25));
      const bx = Math.floor(r() * (w - bw));
      return { x0: bx, x1: bx + bw, y0: horizon - bh, color: hsl((hue + 180 + r() * 60) % 360, 0.3, 0.12 + r() * 0.2) };
    });
    const buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      const sky = hsl((hue + (y / horizon) * 40) % 360, 0.65, 0.75 - (y / h) * 0.35);
      const ground = hsl((hue + 120) % 360, 0.35, 0.18 + ((y - horizon) / h) * 0.3);
      for (let x = 0; x < w; x++) {
        let c = y < horizon ? sky : ground;
        const dx = x - sunX;
        const dy = y - sunY;
        if (y < horizon && dx * dx + dy * dy < sunR * sunR) c = [255, 236, 190];
        for (const b of blocks) if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < horizon) c = b.color;
        const noise = Math.floor((r() - 0.5) * 36);
        const o = (y * w + x) * 3;
        buf[o] = Math.max(0, Math.min(255, c[0] + noise));
        buf[o + 1] = Math.max(0, Math.min(255, c[1] + noise));
        buf[o + 2] = Math.max(0, Math.min(255, c[2] + noise));
      }
    }
    const file = path.join(dir, `photo-${String(i + 1).padStart(2, "0")}.jpg`);
    writeFileSync(file, await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 88 }).toBuffer());
    out.push(file);
  }
  return out;
}
