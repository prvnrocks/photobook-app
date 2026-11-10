import "server-only";
// Print image copies (D-049): made in memory per export, never stored. The original (kept as
// uploaded, may carry EXIF incl. GPS — D-012) is downloaded with the admin client, rotated
// upright, flattened on white, converted to sRGB, resized to the plan's target (never enlarged)
// and re-encoded as JPEG q82. No withMetadata/keepExif: sharp drops all EXIF/GPS/XMP on output.
//
// Callers must have checked book ownership before planning — the admin client bypasses RLS.
// Errors carry a code only (no storage paths, no photo data).

import sharp from "sharp";
import { PHOTOS_BUCKET } from "@/lib/db/photos";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PrintImagePlan, PrintImageTarget } from "./image-plan";

/** Decoding limit: originals are ≤ 100 MP (upload rejects larger, lessons 2026-11-08). */
export const PRINT_INPUT_PIXEL_LIMIT = 100_000_000;
/** Originals are ≤ 20 MB as uploaded; anything far larger is not ours to decode. */
export const PRINT_ORIGINAL_MAX_BYTES = 40 * 1024 * 1024;
export const PRINT_JPEG_QUALITY = 82;

export type PrintImageErrorCode = "download_failed" | "decode_failed" | "unknown_photo";

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

async function downloadOriginal(path: string | null): Promise<Buffer> {
  if (!path) throw new PrintImageError("download_failed");
  let data: Blob | null;
  try {
    const res = await createAdminClient().storage.from(PHOTOS_BUCKET).download(path);
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
 * Original bytes → print JPEG fitting inside `target` (display-oriented). If the decoded upright
 * orientation disagrees with the target's (stale/wrong stored dims), the target box is swapped so
 * a portrait photo is never squeezed into a landscape box.
 */
export async function encodePrintImage(input: Buffer, target: PrintImageTarget): Promise<Buffer> {
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
      .jpeg({ quality: PRINT_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new PrintImageError("decode_failed");
  }
}

/** Download + encode one photo's print copy. */
export async function loadPrintImage(photo: PrintPhotoSource, target: PrintImageTarget): Promise<Buffer> {
  const input = await downloadOriginal(photo.original_path);
  return encodePrintImage(input, target);
}

export interface PrintImageLoader {
  /** Promise-memoised print copy; rejects with PrintImageError. Failures are not cached. */
  get(photoId: string): Promise<Buffer>;
}

/**
 * Loader over a plan: at most `concurrency` downloads/encodes at once (memory: each holds an
 * original of ≤ 20 MB plus decoded pixels), each photo processed once per export.
 */
export function createPrintImageLoader(
  plan: PrintImagePlan,
  photos: Iterable<PrintPhotoSource>,
  opts: { concurrency?: number } = {},
): PrintImageLoader {
  const sources = new Map<string, PrintPhotoSource>();
  for (const p of photos) sources.set(p.id, p);
  const c = opts.concurrency;
  const limit = typeof c === "number" && Number.isFinite(c) ? Math.max(1, Math.floor(c)) : 4;
  const cache = new Map<string, Promise<Buffer>>();
  let active = 0;
  const waiting: (() => void)[] = [];

  // A released slot is handed straight to the next waiter, so `active` never exceeds `limit`.
  const acquire = async () => {
    if (active < limit) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return {
    get(photoId: string) {
      const hit = cache.get(photoId);
      if (hit) return hit;
      const target = plan.get(photoId);
      const source = sources.get(photoId);
      if (!target || !source) return Promise.reject(new PrintImageError("unknown_photo"));
      const p = (async () => {
        await acquire();
        try {
          return await loadPrintImage(source, target);
        } finally {
          release();
        }
      })();
      cache.set(photoId, p);
      p.catch(() => {
        if (cache.get(photoId) === p) cache.delete(photoId);
      });
      return p;
    },
  };
}
