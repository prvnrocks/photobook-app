// One photo → metadata, fingerprint, hashes and the three renditions to upload.
// Browser only. Process ONE photo at a time: a decoded 12 MP bitmap is ~48 MB and phones
// kill tabs quickly. Never log the result (dates, GPS, camera are user data).
import type { PhotoMeta } from "./exif";
import { laplacianVariance } from "./blur";
import { extForMime, isRejectedType, type StoredMime } from "./dimensions";
import { fingerprint } from "./fingerprint";
import { dhash, toGrayscale } from "./phash";
import {
  PhotoRejectError,
  decodeImage,
  makeOriginal,
  makeThumb,
  makeWeb,
  readPixels,
  releaseCanvas,
  type CanvasRendition,
} from "./resize";

export { PhotoRejectError, type PhotoRejectReason } from "./resize";

export interface ProcessedPhoto {
  meta: PhotoMeta;
  /** "s1:…" content fingerprint of the ORIGINAL file as selected (D-013). */
  fingerprint: string;
  /** Display-oriented size of the original as stored. */
  width: number;
  height: number;
  /** dHash, 16 hex chars, from the thumb. */
  phash: string;
  /** Laplacian variance of the thumb; low = blurry. */
  blurScore: number;
  original: { blob: Blob; mime: StoredMime; bytes: number; ext: "jpg" | "png" | "webp" };
  web: { blob: Blob; ext: "jpg"; width: number; height: number };
  thumb: { blob: Blob; ext: "jpg"; width: number; height: number };
}

// exif.ts pulls the full exifr bundle (~75 KB) — load it on first use only.
let exifModule: Promise<typeof import("./exif")> | null = null;
function loadExif() {
  exifModule ??= import("./exif");
  return exifModule;
}

/** Throws PhotoRejectError for unsupported/undecodable/too small/too large photos. */
export async function processPhoto(file: File): Promise<ProcessedPhoto> {
  if (isRejectedType(file)) throw new PhotoRejectError("unsupported_type");

  // 1. Metadata + fingerprint from the untouched original (conversion strips EXIF).
  const { readPhotoMeta } = await loadExif();
  const [meta, fp] = await Promise.all([readPhotoMeta(file), fingerprint(file)]);

  // 2. Decode once (display-oriented).
  const decoded = await decodeImage(file);
  let web: CanvasRendition | null = null;
  let thumb: CanvasRendition | null = null;
  try {
    // 3. Renditions: original (largest) first, then web, then thumb from the web canvas.
    const original = await makeOriginal(file, decoded);
    web = await makeWeb(decoded);
    decoded.release();
    thumb = await makeThumb(web.canvas);
    releaseCanvas(web.canvas);

    // 4. Hashes from the thumb pixels.
    const gray = toGrayscale(readPixels(thumb.canvas), thumb.width, thumb.height);
    const phash = dhash(gray, thumb.width, thumb.height);
    const blurScore = laplacianVariance(gray, thumb.width, thumb.height);

    return {
      meta,
      fingerprint: fp,
      width: original.width,
      height: original.height,
      phash,
      blurScore,
      original: { blob: original.blob, mime: original.mime, bytes: original.bytes, ext: extForMime(original.mime) },
      web: { blob: web.blob, ext: "jpg", width: web.width, height: web.height },
      thumb: { blob: thumb.blob, ext: "jpg", width: thumb.width, height: thumb.height },
    };
  } finally {
    decoded.release();
    if (web) releaseCanvas(web.canvas);
    if (thumb) releaseCanvas(thumb.canvas);
  }
}
