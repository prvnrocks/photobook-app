// Server-side checks of what the browser uploaded. Pure (no I/O), so every rule is unit-tested.
//
// The browser does the heavy work (decode, HEIC → JPEG, resize, EXIF, hashes — src/lib/image) and
// writes the photo row; these functions make sure the stored BYTES really are what the row says
// before the server relies on them (AI analysis, print). Rejection codes are short constants —
// never file names, paths, ids or metadata.

import { MAX_ORIGINAL_BYTES, MAX_SOURCE_PIXELS, MIN_SHORT_SIDE, THUMB_MAX_SIDE, type StoredMime } from "@/lib/image/dimensions";
import { readHeaderSize } from "@/lib/image/header-size";
import { stripJpegMetadata } from "@/lib/image/jpeg-strip";

export const INGEST_REJECT_REASONS = [
  "original_missing",
  "original_too_large",
  "original_not_image",
  "original_type_mismatch",
  "original_size_mismatch",
  "original_bad_dimensions",
  "original_dimension_mismatch",
  "ai_copy_missing",
  "ai_copy_too_large",
  "ai_copy_not_jpeg",
  "ai_copy_bad_dimensions",
] as const;
export type IngestRejectReason = (typeof INGEST_REJECT_REASONS)[number];

/** AI copies are ≤ 512 px JPEGs (≈ 30–150 KB). */
export const AI_COPY_MAX_BYTES = 1024 * 1024;
/** DB limit of photos.width / height (0500). */
const MAX_SIDE = 20000;

const FORMAT_MIME: Record<string, StoredMime | undefined> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export type OriginalClaim = {
  /** photos.original_mime */
  mime: string | null;
  /** photos.original_bytes */
  bytes: number | null;
  /** photos.width / height (display-oriented) */
  width: number | null;
  height: number | null;
};

export type OriginalCheck =
  | { ok: true; format: "jpeg" | "png" | "webp"; bytes: number; storedWidth: number; storedHeight: number }
  | { ok: false; reason: IngestRejectReason };

/**
 * Checks the first bytes of the stored original against the photo row.
 * `head` = the first HEADER_SCAN_BYTES of the object, `totalBytes` = the object's real size.
 */
export function checkOriginal(head: Uint8Array, totalBytes: number, claim: OriginalClaim): OriginalCheck {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || head.length === 0) return { ok: false, reason: "original_missing" };
  if (totalBytes > MAX_ORIGINAL_BYTES) return { ok: false, reason: "original_too_large" };
  const header = readHeaderSize(head);
  // HEIF never reaches storage (converted in the browser, D-012); anything unreadable is not an image we accept.
  if (!header || header.format === "heif") return { ok: false, reason: "original_not_image" };
  if (FORMAT_MIME[header.format] !== claim.mime) return { ok: false, reason: "original_type_mismatch" };
  if (claim.bytes !== totalBytes) return { ok: false, reason: "original_size_mismatch" };
  const { width, height } = header;
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_SOURCE_PIXELS || Math.min(width, height) < MIN_SHORT_SIDE) {
    return { ok: false, reason: "original_bad_dimensions" };
  }
  // The row holds the DISPLAY size: equal to the stored size, or swapped when EXIF rotates by 90°.
  const same = claim.width === width && claim.height === height;
  const swapped = claim.width === height && claim.height === width;
  if (!(same || (swapped && header.swapsAxes !== false))) return { ok: false, reason: "original_dimension_mismatch" };
  return { ok: true, format: header.format, bytes: totalBytes, storedWidth: width, storedHeight: height };
}

export type AiCopy =
  | { ok: true; bytes: Uint8Array; width: number; height: number; sanitized: boolean }
  | { ok: false; reason: IngestRejectReason };

/**
 * Validates the AI analysis copy and removes its metadata. The result is the only form in which
 * photo pixels may be sent to the model: a baseline/progressive JPEG, ≤ 512 px, ≤ 1 MB, without
 * EXIF / GPS / XMP / IPTC / comments.
 */
export function prepareAiCopy(bytes: Uint8Array | null | undefined): AiCopy {
  if (!bytes || bytes.length === 0) return { ok: false, reason: "ai_copy_missing" };
  if (bytes.length > AI_COPY_MAX_BYTES) return { ok: false, reason: "ai_copy_too_large" };
  const stripped = stripJpegMetadata(bytes);
  if (!stripped) return { ok: false, reason: "ai_copy_not_jpeg" };
  if (stripped.width > THUMB_MAX_SIDE || stripped.height > THUMB_MAX_SIDE || stripped.width < 1 || stripped.height < 1) {
    return { ok: false, reason: "ai_copy_bad_dimensions" };
  }
  return { ok: true, bytes: stripped.bytes, width: stripped.width, height: stripped.height, sanitized: stripped.removed > 0 };
}
