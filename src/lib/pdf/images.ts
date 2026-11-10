import "server-only";
// Print image copies (D-049): made in memory per export, never stored. The original (kept as
// uploaded, may carry EXIF incl. GPS — D-012) is downloaded with the admin client, rotated
// upright, flattened on white, converted to sRGB, resized to the plan's target (never enlarged)
// and re-encoded as baseline JPEG (PRINT_JPEG_OPTIONS). No withMetadata/keepExif: sharp drops
// all EXIF/GPS/XMP on output.
//
// Callers must have checked book ownership before planning — the admin client bypasses RLS.
// Errors carry a code only (no storage paths, no photo data).

import sharp from "sharp";
import { PHOTOS_BUCKET } from "@/lib/db/photos";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PrintImagePlan, PrintImageTarget } from "./image-plan";
import { createLimiter, printEncodeConcurrency, printImageInFlight } from "./prefetch";

/** Decoding limit: originals are ≤ 100 MP (upload rejects larger, lessons 2026-11-08). */
export const PRINT_INPUT_PIXEL_LIMIT = 100_000_000;
/** Originals are ≤ 20 MB as uploaded; anything far larger is not ours to decode. */
export const PRINT_ORIGINAL_MAX_BYTES = 40 * 1024 * 1024;
/**
 * Encoder (M8 headroom, measured on 2000×2667 and 4000×3000 inputs → 1819×2551 / 3000×2250 /
 * 1913×1435): mozjpeg q82 (trellis + progressive scan search) cost 115–560 ms per image; baseline
 * JPEG with mozjpeg's quant table 3 at q80 takes 23–68 ms (3–11× faster), is 11–21 % larger, and
 * has HIGHER PSNR than mozjpeg q82 in every case (+0.1–0.4 dB) — visually equivalent or better.
 * Plain libjpeg tables at q82 were +25–65 % larger, so table 3 it is. 4:2:0 chroma and optimised
 * Huffman tables are sharp's defaults.
 */
export const PRINT_JPEG_QUALITY = 80;
export const PRINT_JPEG_OPTIONS = {
  quality: PRINT_JPEG_QUALITY,
  mozjpeg: false,
  quantisationTable: 3,
  progressive: false,
  trellisQuantisation: false,
  optimiseCoding: true,
  chromaSubsampling: "4:2:0",
} as const;

/** Per-download budget (M8 T12 follow-up): a stalled Storage download must not eat the job deadline. */
export const PRINT_DOWNLOAD_TIMEOUT_MS = 30_000;
/** Download attempts per photo (first try + one retry) before download_failed. */
export const PRINT_DOWNLOAD_ATTEMPTS = 2;

/** aborted: the export's deadline signal fired (runExport records render_timeout, not this). */
export type PrintImageErrorCode = "download_failed" | "decode_failed" | "unknown_photo" | "aborted";

export class PrintImageError extends Error {
  readonly code: PrintImageErrorCode;

  constructor(code: PrintImageErrorCode) {
    super(`Print image failed (${code})`);
    this.name = "PrintImageError";
    this.code = code;
  }
}

export interface PrintPhotoSource {
  id: string;
  /** photos.original_path ({user}/{book}/{photo}-original.{ext}); null → download_failed. */
  original_path: string | null;
}

export interface DownloadOptions {
  /** The export's abort signal (deadline): stops the download and skips the retry. */
  signal?: AbortSignal;
  /** Per-attempt budget (default PRINT_DOWNLOAD_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Attempts (default PRINT_DOWNLOAD_ATTEMPTS). */
  attempts?: number;
}

async function downloadOnce(path: string, signal: AbortSignal): Promise<Buffer> {
  let data: Blob | null;
  try {
    const res = await createAdminClient().storage.from(PHOTOS_BUCKET).download(path, undefined, { signal });
    if (res.error || !res.data) throw new PrintImageError("download_failed");
    data = res.data;
  } catch {
    throw new PrintImageError("download_failed");
  }
  if (typeof data.size === "number" && data.size > PRINT_ORIGINAL_MAX_BYTES) {
    throw new PrintImageError("decode_failed");
  }
  try {
    return Buffer.from(await data.arrayBuffer());
  } catch {
    throw new PrintImageError("download_failed");
  }
}

/**
 * Downloads an original with a per-attempt timeout (AbortSignal: fetch + body) and one retry.
 * decode_failed (oversized object) is not retried; an aborted export → 'aborted', no retry.
 */
export async function downloadOriginal(path: string | null, opts: DownloadOptions = {}): Promise<Buffer> {
  if (!path) throw new PrintImageError("download_failed");
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : PRINT_DOWNLOAD_TIMEOUT_MS;
  const attempts = Math.max(1, Math.floor(opts.attempts ?? PRINT_DOWNLOAD_ATTEMPTS));
  let last: PrintImageError = new PrintImageError("download_failed");
  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) throw new PrintImageError("aborted");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      return await downloadOnce(path, signal);
    } catch (e) {
      last = e instanceof PrintImageError ? e : new PrintImageError("download_failed");
      if (opts.signal?.aborted) throw new PrintImageError("aborted");
      if (last.code !== "download_failed") throw last;
    }
  }
  throw last;
}

/**
 * Original bytes → print JPEG fitting inside `target` (display-oriented). If the decoded upright
 * orientation disagrees with the target's (stale/wrong stored dims), the target box is swapped so
 * a portrait photo is never squeezed into a landscape box.
 */
export async function encodePrintImage(
  input: Buffer,
  target: PrintImageTarget,
  quality: number = PRINT_JPEG_QUALITY,
): Promise<Buffer> {
  try {
    const meta = await sharp(input, { limitInputPixels: PRINT_INPUT_PIXEL_LIMIT, failOn: "error" }).metadata();
    const upright = meta.autoOrient ?? { width: meta.width, height: meta.height };
    let { width, height } = target;
    if (upright.width && upright.height && (upright.width > upright.height) !== (width > height) && width !== height) {
      [width, height] = [height, width];
    }
    return await sharp(input, { limitInputPixels: PRINT_INPUT_PIXEL_LIMIT, failOn: "error" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width, height, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .jpeg(quality === PRINT_JPEG_QUALITY ? PRINT_JPEG_OPTIONS : { ...PRINT_JPEG_OPTIONS, quality })
      .toBuffer();
  } catch {
    throw new PrintImageError("decode_failed");
  }
}

type Limit = <T>(fn: () => Promise<T>) => Promise<T>;
const unlimited: Limit = (fn) => fn();

export interface LoadPrintImageOptions {
  timing?: PrintImageTiming;
  encodeLimit?: Limit;
  /** The export's abort signal: no new download / encode starts once it fired. */
  signal?: AbortSignal;
  /** JPEG quality (default PRINT_JPEG_QUALITY; the size fallback uses less). */
  quality?: number;
  /** Per-download options (timeout / attempts) — tests. */
  download?: Omit<DownloadOptions, "signal">;
}

/** Download + encode one photo's print copy (the encode optionally behind a CPU limiter). */
export async function loadPrintImage(
  photo: PrintPhotoSource,
  target: PrintImageTarget,
  opts: LoadPrintImageOptions = {},
): Promise<Buffer> {
  const { timing, encodeLimit = unlimited, signal } = opts;
  if (signal?.aborted) throw new PrintImageError("aborted");
  const t0 = Date.now();
  const input = await downloadOriginal(photo.original_path, { ...opts.download, signal });
  if (timing) timing.downloadMs += Date.now() - t0;
  return encodeLimit(async () => {
    if (signal?.aborted) throw new PrintImageError("aborted");
    const t1 = Date.now();
    try {
      return await encodePrintImage(input, target, opts.quality);
    } finally {
      if (timing) timing.encodeMs += Date.now() - t1; // excludes waiting for an encode slot
    }
  });
}

interface PrintImageTiming {
  downloadMs: number;
  encodeMs: number;
}

/** Counters for logs — numbers only (no ids). */
export interface PrintImageStats {
  /** Print copies produced (successful loads). */
  produced: number;
  failed: number;
  /** Bytes of produced copies still referenced by the loader (not yet released). */
  heldBytes: number;
  peakHeldBytes: number;
  /** Summed per-image times (overlapping, so may exceed wall time). */
  downloadMs: number;
  encodeMs: number;
}

export interface PrintImageLoader {
  /** Promise-memoised print copy; rejects with PrintImageError. Failures are not cached. */
  get(photoId: string): Promise<Buffer>;
  /** Starts producing these copies (queue order = call order); errors surface on a later get(). */
  prefetch?(photoIds: Iterable<string>): void;
  /** Forgets these copies (once rendered) so their buffers can be collected; a later get() reloads. */
  release?(photoIds: Iterable<string>): void;
  stats?(): PrintImageStats;
}

/**
 * Loader over a plan: at most `concurrency` photos in flight (download → encode; default
 * printImageInFlight(): 12, or 8 on a ≤ 2 GB function — memory: each holds its original of ≤ 20 MB until encoded) and at most
 * `encodeConcurrency` sharp encodes among them (default printEncodeConcurrency(), CPU-bound).
 * Each photo is processed once per export unless released.
 */
export interface PrintImageLoaderOptions {
  concurrency?: number;
  encodeConcurrency?: number;
  /** The export's abort signal: once fired, get() rejects ('aborted') and queued loads never start. */
  signal?: AbortSignal;
  /** JPEG quality for every copy (default PRINT_JPEG_QUALITY). */
  quality?: number;
  /** Per-download options (timeout / attempts) — tests. */
  download?: Omit<DownloadOptions, "signal">;
}

export function createPrintImageLoader(
  plan: PrintImagePlan,
  photos: Iterable<PrintPhotoSource>,
  opts: PrintImageLoaderOptions = {},
): Required<PrintImageLoader> {
  const sources = new Map<string, PrintPhotoSource>();
  for (const p of photos) sources.set(p.id, p);
  const pos = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1;
  const inFlight = createLimiter(pos(opts.concurrency) ? opts.concurrency : printImageInFlight());
  const encodeLimit = createLimiter(pos(opts.encodeConcurrency) ? opts.encodeConcurrency : printEncodeConcurrency());
  const cache = new Map<string, Promise<Buffer>>();
  /** Fulfilled, unreleased copies: photoId → byte size. */
  const held = new Map<string, number>();
  const timing: PrintImageTiming = { downloadMs: 0, encodeMs: 0 };
  let heldBytes = 0;
  let peakHeldBytes = 0;
  let produced = 0;
  let failed = 0;
  const forget = (photoId: string) => {
    cache.delete(photoId);
    const bytes = held.get(photoId);
    if (bytes !== undefined) {
      held.delete(photoId);
      heldBytes -= bytes;
    }
  };

  const get = (photoId: string): Promise<Buffer> => {
    const hit = cache.get(photoId);
    if (hit) return hit;
    const target = plan.get(photoId);
    const source = sources.get(photoId);
    if (opts.signal?.aborted) return Promise.reject(new PrintImageError("aborted"));
    if (!target || !source) return Promise.reject(new PrintImageError("unknown_photo"));
    const p = inFlight(() =>
      loadPrintImage(source, target, {
        timing,
        encodeLimit,
        signal: opts.signal,
        quality: opts.quality,
        download: opts.download,
      }),
    );
    cache.set(photoId, p);
    p.then(
      (buf) => {
        produced++;
        if (cache.get(photoId) !== p) return; // released while loading
        held.set(photoId, buf.byteLength);
        heldBytes += buf.byteLength;
        peakHeldBytes = Math.max(peakHeldBytes, heldBytes);
      },
      () => {
        failed++;
        if (cache.get(photoId) === p) cache.delete(photoId);
      },
    );
    return p;
  };

  return {
    get,
    prefetch(photoIds) {
      for (const id of photoIds) get(id).catch(() => undefined);
    },
    release(photoIds) {
      for (const id of photoIds) forget(id);
    },
    stats: () => ({ produced, failed, heldBytes, peakHeldBytes, downloadMs: timing.downloadMs, encodeMs: timing.encodeMs }),
  };
}
