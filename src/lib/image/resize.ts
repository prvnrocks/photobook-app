// Client-side decode + resize into the three stored renditions (D-012):
//   original — the uploaded file if JPEG/PNG/WebP ≤ 20 MB, else JPEG q0.9, ≤ 4096 px, ≤ 16 MP
//   web      — JPEG q0.82, longest side ≤ 1600 px (editor / viewer)
//   thumb    — JPEG q0.8, longest side ≤ 512 px, made from the web canvas (AI, hashing)
//
// Browser only. One decode, three outputs via canvas toBlob / OffscreenCanvas.convertToBlob.
//
// Size guard (S6): the pixel size is read from the file header first (header-size.ts).
// > 100 MP → rejected without decoding; > 16 MP → decoded straight at ≤ 16 MP via
// createImageBitmap's resize options where supported, so a 48 MP photo never becomes a
// ~190 MB bitmap on a phone.
//
// heic2any (~1.3 MB incl. libheif) is imported lazily, only when the browser cannot
// decode a HEIC/HEIF file itself (Safari can; Chromium/Firefox can't).
import {
  MAX_CANVAS_PIXELS,
  MAX_SOURCE_PIXELS,
  MIN_SHORT_SIDE,
  ORIGINAL_MAX_SIDE,
  ORIGINAL_QUALITY,
  THUMB_MAX_SIDE,
  THUMB_QUALITY,
  WEB_MAX_SIDE,
  WEB_QUALITY,
  type StoredMime,
  effectiveMime,
  fitWithin,
  isHeic,
  isRejectedType,
  needsReencode,
} from "./dimensions";
import { displaySizeFromDecode, readBlobHeaderSize, reducedDecodeSize, type ReducedDecodeSize } from "./header-size";

export type PhotoRejectReason = "unsupported_type" | "decode_failed" | "too_small" | "too_large";

/** Thrown for photos we refuse. `message` never contains file names or metadata. */
export class PhotoRejectError extends Error {
  readonly reason: PhotoRejectReason;
  constructor(reason: PhotoRejectReason) {
    super(`photo rejected: ${reason}`);
    this.name = "PhotoRejectError";
    this.reason = reason;
  }
}

export type ImageSource = ImageBitmap | HTMLImageElement;
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface DecodedImage {
  source: ImageSource;
  /** Size of `source`, display-oriented (EXIF / HEIF rotation already applied). */
  width: number;
  height: number;
  /**
   * Display-oriented size of the FILE. Equals width/height unless the photo was decoded
   * at a reduced size (> 16 MP); then it's the real size, used for originals kept as-is.
   */
  fullWidth: number;
  fullHeight: number;
  release(): void;
  viaHeic2any: boolean;
}

export interface RenderedImage {
  blob: Blob;
  mime: StoredMime;
  bytes: number;
  width: number;
  height: number;
}

export interface CanvasRendition extends RenderedImage {
  /** Kept so the next smaller rendition can be drawn from it. Call releaseCanvas when done. */
  canvas: AnyCanvas;
}

// ---------- decode ----------

async function bitmapFrom(blob: Blob, resize?: ReducedDecodeSize): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(blob, {
      imageOrientation: "from-image",
      ...(resize ? { ...resize, resizeQuality: "high" as const } : {}),
    });
  } catch {
    return null;
  }
}

let resizeSupport: Promise<boolean> | null = null;
/** createImageBitmap resizeWidth/Height support (older Safari ignores unknown options). Probed once. */
function supportsResizeDecode(): Promise<boolean> {
  resizeSupport ??= (async () => {
    if (typeof createImageBitmap !== "function" || typeof ImageData === "undefined") return false;
    try {
      const b = await createImageBitmap(new ImageData(4, 2), { resizeWidth: 2, resizeHeight: 1 });
      const ok = b.width === 2 && b.height === 1;
      b.close();
      return ok;
    } catch {
      return false;
    }
  })();
  return resizeSupport;
}

interface Decoded {
  source: ImageSource;
  /** Display-oriented size of the file (≠ source size after a reduced decode). */
  full: { width: number; height: number } | null;
}

/**
 * Header check, then decode. Throws too_large for > 100 MP headers. For > 16 MP headers,
 * decodes at a reduced size when the browser supports it, else (or if that failed) fully.
 */
async function decodeChecked(blob: Blob): Promise<Decoded | null> {
  const header = await readBlobHeaderSize(blob);
  if (header && header.width * header.height > MAX_SOURCE_PIXELS) throw new PhotoRejectError("too_large");
  const reduce = header ? reducedDecodeSize(header, MAX_CANVAS_PIXELS) : null;
  if (header && reduce && (await supportsResizeDecode())) {
    const bmp = await bitmapFrom(blob, reduce);
    if (bmp && bmp.width > 0 && bmp.height > 0) {
      return { source: bmp, full: displaySizeFromDecode(header, { width: bmp.width, height: bmp.height }) };
    }
    bmp?.close();
  }
  const source = await decodeBlob(blob);
  return source ? { source, full: null } : null;
}

/** Fallback for browsers without createImageBitmap(Blob). <img> applies EXIF orientation. */
async function imageElementFrom(blob: Blob): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img.naturalWidth > 0 ? img : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeBlob(blob: Blob): Promise<ImageSource | null> {
  return (await bitmapFrom(blob)) ?? (await imageElementFrom(blob));
}

/**
 * heic2any decodes with libheif, which applies the HEIF `irot`/`imir` transforms, and
 * writes a JPEG without EXIF — so its pixels are already display-oriented and must
 * not be rotated again (verified in Chromium with a rotated sips-made HEIC).
 */
async function heicToJpeg(file: Blob): Promise<Blob | null> {
  try {
    const { default: heic2any } = await import("heic2any");
    const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    const first = Array.isArray(out) ? out[0] : out;
    return first ?? null;
  } catch {
    return null;
  }
}

function sourceSize(source: ImageSource): { width: number; height: number } {
  if ("naturalWidth" in source) return { width: source.naturalWidth, height: source.naturalHeight };
  return { width: source.width, height: source.height };
}

function releaseSource(source: ImageSource): void {
  if ("close" in source) source.close();
  else source.src = "";
}

export async function decodeImage(file: File): Promise<DecodedImage> {
  if (isRejectedType(file)) throw new PhotoRejectError("unsupported_type");

  let viaHeic2any = false;
  let decoded = await decodeChecked(file);
  if (!decoded && isHeic(file)) {
    // heic2any itself decodes at full size (libheif has no scaled decode), but the
    // header check above already refused > 100 MP; its JPEG is then decoded reduced.
    const jpeg = await heicToJpeg(file);
    if (jpeg) {
      decoded = await decodeChecked(jpeg);
      viaHeic2any = decoded != null;
    }
  }
  if (!decoded) {
    throw new PhotoRejectError(effectiveMime(file).startsWith("image/") || isHeic(file) ? "decode_failed" : "unsupported_type");
  }

  const { source } = decoded;
  const { width, height } = sourceSize(source);
  const full = decoded.full ?? { width, height };
  const reject = (reason: PhotoRejectReason): never => {
    releaseSource(source);
    throw new PhotoRejectError(reason);
  };
  if (!(width > 0 && height > 0)) reject("decode_failed");
  // Still checked after decode: headers we couldn't read (or that lied).
  if (full.width * full.height > MAX_SOURCE_PIXELS) reject("too_large");
  if (Math.min(full.width, full.height) < MIN_SHORT_SIDE) reject("too_small");

  let released = false;
  return {
    source,
    width,
    height,
    fullWidth: full.width,
    fullHeight: full.height,
    viaHeic2any,
    release() {
      if (released) return;
      released = true;
      releaseSource(source);
    },
  };
}

// ---------- canvas ----------

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function context2d(canvas: AnyCanvas, readBack = false) {
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: readBack }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new PhotoRejectError("decode_failed");
  return ctx;
}

/** Frees the canvas backing store now instead of waiting for GC (matters on iOS). */
export function releaseCanvas(canvas: AnyCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}

function sizeOf(src: ImageSource | AnyCanvas): { width: number; height: number } {
  if ("naturalWidth" in src) return sourceSize(src);
  return { width: src.width, height: src.height };
}

/**
 * Draws `source` scaled so the longest side ≤ maxSide (and ≤ 16 MP). When shrinking
 * by more than 2×, steps down by halves for area-like quality (single-pass bilinear
 * aliases). Every intermediate canvas is also ≤ 16 MP. JPEG targets are opaque, so the
 * canvas is filled white first (transparent PNG areas become white, not black).
 */
export function renderScaled(source: ImageSource | AnyCanvas, maxSide: number, readBack = false): AnyCanvas {
  const { width: sw, height: sh } = sizeOf(source);
  const target = fitWithin(sw, sh, maxSide, MAX_CANVAS_PIXELS);

  let current: ImageSource | AnyCanvas = source;
  let cw = sw;
  let ch = sh;
  for (;;) {
    let next = { width: target.width, height: target.height };
    if (cw / target.width > 2) {
      // Halve, but never exceed the canvas pixel budget (a 48 MP source → first step ≤ 16 MP).
      next = fitWithin(cw, ch, Math.ceil(Math.max(cw, ch) / 2), MAX_CANVAS_PIXELS);
      if (next.width <= target.width) next = { width: target.width, height: target.height };
    }
    const isFinal = next.width === target.width && next.height === target.height;
    const canvas = createCanvas(next.width, next.height);
    const ctx = context2d(canvas, isFinal && readBack);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, next.width, next.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current as CanvasImageSource, 0, 0, next.width, next.height);
    if (current !== source) releaseCanvas(current as AnyCanvas);
    current = canvas;
    cw = next.width;
    ch = next.height;
    if (isFinal) return canvas;
  }
}

async function canvasToJpeg(canvas: AnyCanvas, quality: number): Promise<Blob> {
  let blob: Blob | null;
  if ("convertToBlob" in canvas) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  } else {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }
  if (!blob || blob.size === 0) throw new PhotoRejectError("decode_failed");
  return blob;
}

async function jpegRendition(source: ImageSource | AnyCanvas, maxSide: number, quality: number, readBack = false): Promise<CanvasRendition> {
  const canvas = renderScaled(source, maxSide, readBack);
  try {
    const blob = await canvasToJpeg(canvas, quality);
    return { blob, mime: "image/jpeg", bytes: blob.size, width: canvas.width, height: canvas.height, canvas };
  } catch (err) {
    releaseCanvas(canvas);
    throw err;
  }
}

// ---------- renditions ----------

/**
 * D-012: JPEG/PNG/WebP ≤ 20 MB are stored unchanged (EXIF incl. orientation kept; width/
 * height reported display-oriented, at full resolution even if we decoded reduced).
 * Everything else → JPEG q0.9, ≤ 4096 px, ≤ 16 MP, drawn from the decoded source (which
 * after a reduced decode is ≤ 16 MP already — enough for that target).
 * If the browser gave an empty mime, the returned blob is re-typed (same bytes).
 */
export async function makeOriginal(file: File, decoded: DecodedImage): Promise<RenderedImage> {
  const mime = effectiveMime(file);
  if (!needsReencode(mime, file.size)) {
    const blob = file.type === mime ? file : new Blob([file], { type: mime });
    return { blob, mime: mime as StoredMime, bytes: file.size, width: decoded.fullWidth, height: decoded.fullHeight };
  }
  const r = await jpegRendition(decoded.source, ORIGINAL_MAX_SIDE, ORIGINAL_QUALITY);
  releaseCanvas(r.canvas);
  return { blob: r.blob, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height };
}

/** JPEG q0.82, ≤ 1600 px. Returns the canvas for makeThumb; release it afterwards. */
export function makeWeb(decoded: DecodedImage): Promise<CanvasRendition> {
  return jpegRendition(decoded.source, WEB_MAX_SIDE, WEB_QUALITY);
}

/** JPEG q0.8, ≤ 512 px, drawn from the web canvas. Canvas is readable (getImageData). */
export function makeThumb(webCanvas: AnyCanvas): Promise<CanvasRendition> {
  return jpegRendition(webCanvas, THUMB_MAX_SIDE, THUMB_QUALITY, true);
}

/** RGBA pixels of a canvas made by makeThumb. */
export function readPixels(canvas: AnyCanvas): Uint8ClampedArray {
  return context2d(canvas, true).getImageData(0, 0, canvas.width, canvas.height).data;
}
