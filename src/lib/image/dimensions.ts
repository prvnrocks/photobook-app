// Pure size / type helpers for client-side photo processing (D-012). DOM-free so they
// can be unit-tested in node; the canvas work lives in resize.ts.

/** Longest side of the stored original when we have to re-encode (HEIC, >20 MB, other types). */
export const ORIGINAL_MAX_SIDE = 4096;
/** Longest side of the `web` rendition used by editor/viewer. */
export const WEB_MAX_SIDE = 1600;
/** Longest side of the `thumb` rendition sent to AI and used for hashing. */
export const THUMB_MAX_SIDE = 512;
/** Never allocate a canvas above this (iOS Safari limit is ~16.7 MP). */
export const MAX_CANVAS_PIXELS = 16_000_000;
/** Originals above this are re-encoded even when the type is fine. */
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
/** Reject photos whose shortest side is below this. */
export const MIN_SHORT_SIDE = 200;
/** Reject photos above 100 MP (decode would exhaust phone memory). */
export const MAX_SOURCE_PIXELS = 100_000_000;

export const ORIGINAL_QUALITY = 0.9;
export const WEB_QUALITY = 0.82;
export const THUMB_QUALITY = 0.8;

/** Mimes we keep as uploaded (if ≤ MAX_ORIGINAL_BYTES). Matches photos.original_mime. */
export const KEEP_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type StoredMime = (typeof KEEP_MIMES)[number];

export interface Size {
  width: number;
  height: number;
}

/**
 * Scales (w, h) down (never up) so the longest side ≤ maxSide and w·h ≤ maxPixels.
 * Result is integer, ≥ 1 px on each side, aspect ratio preserved within rounding.
 */
export function fitWithin(w: number, h: number, maxSide: number, maxPixels: number = Infinity): Size {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
    throw new RangeError("fitWithin: width and height must be positive finite numbers");
  }
  let scale = Math.min(1, maxSide / Math.max(w, h));
  if (w * h * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h));
  if (scale >= 1) return { width: Math.round(w), height: Math.round(h) };
  let width = Math.max(1, Math.floor(w * scale));
  let height = Math.max(1, Math.floor(h * scale));
  // Floor keeps us under both limits; guard against float edge cases anyway.
  while (width * height > maxPixels && width > 1 && height > 1) {
    width -= 1;
    height = Math.max(1, Math.floor((width * h) / w));
  }
  return { width, height };
}

interface FileTypeLike {
  name?: string;
  type?: string;
}

function extOf(name: string | undefined): string {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? "");
  return m ? m[1].toLowerCase() : "";
}

/** HEIC/HEIF by mime OR extension — iOS/Windows often hand us an empty mime. */
export function isHeic(file: FileTypeLike): boolean {
  const type = (file.type ?? "").toLowerCase();
  if (/^image\/hei[cf](-sequence)?$/.test(type)) return true;
  const ext = extOf(file.name);
  return ext === "heic" || ext === "heif";
}

/** Normalised mime: fills an empty mime from the extension for the types we care about. */
export function effectiveMime(file: FileTypeLike): string {
  const type = (file.type ?? "").toLowerCase();
  if (type) return type === "image/jpg" ? "image/jpeg" : type;
  switch (extOf(file.name)) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return "";
  }
}

/** Types we refuse before decoding: animated/vector images and anything that isn't an image. */
export function isRejectedType(file: FileTypeLike): boolean {
  const mime = effectiveMime(file);
  if (mime === "image/gif" || mime === "image/svg+xml") return true;
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return true;
  if (mime && !mime.startsWith("image/") && mime !== "application/octet-stream") return true;
  return false;
}

/** True when the original must be re-encoded to JPEG (D-012). */
export function needsReencode(mime: string, bytes: number): boolean {
  const m = mime.toLowerCase() === "image/jpg" ? "image/jpeg" : mime.toLowerCase();
  if (!(KEEP_MIMES as readonly string[]).includes(m)) return true;
  return bytes > MAX_ORIGINAL_BYTES;
}

/** Storage file extension for a stored mime. */
export function extForMime(mime: string): "jpg" | "png" | "webp" {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    default:
      throw new RangeError("extForMime: unsupported stored mime");
  }
}

/** EXIF orientations 5–8 swap width and height for display. */
export function orientationSwapsAxes(orientation: number | null | undefined): boolean {
  return orientation != null && orientation >= 5 && orientation <= 8;
}
