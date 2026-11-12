// Cheap photo dimensions for the photos-first start (M13 T5, D-070): the page-shape hint passed to
// startBookAction. Reads only the first bytes of each file (JPEG SOF + EXIF orientation, PNG IHDR) —
// no decoding, no exifr / heic2any download, nothing sent anywhere. Anything else (HEIC, WebP, a
// truncated header) is "unknown", which never pushes the book to landscape (suggestFormat).
// Isomorphic and pure apart from Blob reads, so it is unit-tested in node.

import type { BookFormat } from "@/lib/book/types";
import { countOrientations, suggestFormat } from "@/lib/design/infer";

export type ImageSize = { width: number; height: number; exifOrientation?: number };

/** Bytes read per file: covers EXIF (incl. its thumbnail) and the SOF marker of phone JPEGs. */
export const HEADER_BYTES = 256 * 1024;
/** Files probed at most (a sample is enough for a 60 % rule). */
export const PROBE_MAX_FILES = 40;
/** Total time the start may wait for the probe; after it the hint is skipped (portrait default). */
export const PROBE_TIMEOUT_MS = 400;

/** Dimensions from a file header, or null when the format isn't JPEG/PNG or the header is cut. */
export function readImageSizeFromBytes(bytes: Uint8Array): ImageSize | null {
  if (bytes.length >= 24 && isPng(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = dv.getUint32(16);
    const height = dv.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  return null;
}

export async function readImageSize(file: Blob): Promise<ImageSize | null> {
  try {
    const buf = await file.slice(0, HEADER_BYTES).arrayBuffer();
    return readImageSizeFromBytes(new Uint8Array(buf));
  } catch {
    return null;
  }
}

/**
 * Page-shape hint for the picked files: suggestFormat over the readable sample; undefined when no
 * file could be read in time (the server then uses its default, A5 portrait).
 */
export async function probeFormat(
  files: readonly Blob[],
  opts: { timeoutMs?: number; maxFiles?: number } = {},
): Promise<BookFormat | undefined> {
  const sample = files.slice(0, opts.maxFiles ?? PROBE_MAX_FILES);
  if (sample.length === 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  });
  try {
    const sizes = await Promise.race([Promise.all(sample.map(readImageSize)), timeout]);
    if (!sizes || sizes.every((s) => s === null)) return undefined;
    return suggestFormat(countOrientations(sizes.map((s) => s ?? {})));
  } finally {
    clearTimeout(timer);
  }
}

// --- JPEG --------------------------------------------------------------------------------------

function isPng(b: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return sig.every((v, i) => b[i] === v) && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52;
}

/** SOF markers carrying the frame size (C0–CF except DHT C4, JPG C8, DAC CC). */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpeg(b: Uint8Array): ImageSize | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let orientation: number | undefined;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end / scan before a frame header
    const len = dv.getUint16(i + 2);
    if (len < 2) return null;
    const start = i + 4;
    if (marker === 0xe1 && orientation === undefined && start + Math.min(len - 2, 14) <= b.length) {
      orientation = exifOrientation(b, dv, start, Math.min(start + len - 2, b.length));
    }
    if (isSof(marker)) {
      if (start + 5 > b.length) return null;
      const height = dv.getUint16(start + 1);
      const width = dv.getUint16(start + 3);
      if (width === 0 || height === 0) return null;
      return orientation === undefined ? { width, height } : { width, height, exifOrientation: orientation };
    }
    i = start + len - 2;
  }
  return null;
}

/** EXIF orientation (IFD0 tag 0x0112) from an APP1 segment [start, end), or undefined. */
function exifOrientation(b: Uint8Array, dv: DataView, start: number, end: number): number | undefined {
  // "Exif\0\0"
  if (end - start < 14) return undefined;
  if (b[start] !== 0x45 || b[start + 1] !== 0x78 || b[start + 2] !== 0x69 || b[start + 3] !== 0x66) return undefined;
  if (b[start + 4] !== 0 || b[start + 5] !== 0) return undefined;
  const tiff = start + 6;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const big = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!little && !big) return undefined;
  const u16 = (o: number) => dv.getUint16(o, little);
  const u32 = (o: number) => dv.getUint32(o, little);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return undefined;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return undefined;
    if (u16(entry) === 0x0112) {
      const v = u16(entry + 8);
      return v >= 1 && v <= 8 ? v : undefined;
    }
  }
  return undefined;
}
