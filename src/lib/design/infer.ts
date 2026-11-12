// Setup inference for the photos-first start (M13 T3, D-070). Pure, isomorphic, no I/O.
//
// The draft book is created before the user answers anything; these helpers pick the defaults the
// setup card shows (the user can change every one of them until the first AI build starts):
//   - suggestFormat: page shape from the photos' orientation counts;
//   - suggestCaptionLang: caption language from the user's memory, else the device locale;
//   - toneForOccasion: the feel for an occasion (a remembered tone wins, D-032).
// Nothing here reads photo content — only counts and a locale string.

import { CAPTION_LANGS, DEFAULT_TONE, TONES, type CaptionLang, type Occasion, type Tone } from "@/lib/book/options";
import type { BookFormat } from "@/lib/book/types";

// --- Format ------------------------------------------------------------------------------------

export type PhotoOrientation = "landscape" | "portrait" | "square" | "unknown";

/** Counts per orientation. Missing keys count as 0. */
export type OrientationCounts = Partial<Record<PhotoOrientation, number>>;

/** Landscape book only from this many photos (a handful of landscape shots isn't a signal). */
export const LANDSCAPE_MIN_PHOTOS = 5;
/** Landscape book when at least this share of ALL photos is landscape. */
export const LANDSCAPE_MIN_SHARE = 0.6;
/** width / height within [1/r, r] counts as square. */
export const SQUARE_RATIO_TOLERANCE = 1.05;

/**
 * Orientation as displayed. `exifOrientation` 5–8 means the stored pixels are rotated 90° (swap
 * width / height); absent / 1–4 / anything else (e.g. WhatsApp photos without EXIF) → the pixel
 * dimensions as stored. Non-positive or non-finite dimensions → "unknown".
 */
export function orientationOf(width: unknown, height: unknown, exifOrientation?: unknown): PhotoOrientation {
  if (!isPositive(width) || !isPositive(height)) return "unknown";
  const rotated = typeof exifOrientation === "number" && exifOrientation >= 5 && exifOrientation <= 8;
  const w = rotated ? height : width;
  const h = rotated ? width : height;
  const ratio = w / h;
  if (ratio >= SQUARE_RATIO_TOLERANCE) return "landscape";
  if (ratio <= 1 / SQUARE_RATIO_TOLERANCE) return "portrait";
  return "square";
}

/** Tally of orientationOf over a list of photo sizes. */
export function countOrientations(
  photos: readonly { width?: unknown; height?: unknown; exifOrientation?: unknown }[],
): Required<OrientationCounts> {
  const counts = { landscape: 0, portrait: 0, square: 0, unknown: 0 };
  for (const p of photos) counts[orientationOf(p.width, p.height, p.exifOrientation)]++;
  return counts;
}

/**
 * A5 landscape when there are at least LANDSCAPE_MIN_PHOTOS photos and at least 60% of ALL of them
 * (portrait, square and unknown included — unknown never helps landscape) are landscape; otherwise
 * A5 portrait (the default shape). Negative / non-finite counts are treated as 0.
 */
export function suggestFormat(counts: OrientationCounts): BookFormat {
  const landscape = safeCount(counts.landscape);
  const total = landscape + safeCount(counts.portrait) + safeCount(counts.square) + safeCount(counts.unknown);
  if (total < LANDSCAPE_MIN_PHOTOS) return "A5_PORTRAIT";
  return landscape / total >= LANDSCAPE_MIN_SHARE ? "A5_LANDSCAPE" : "A5_PORTRAIT";
}

// --- Caption language --------------------------------------------------------------------------

/**
 * Caption language for a new book: the remembered language (user memory, D-032) wins; otherwise
 * the device's preferred language — `locale` is an Accept-Language header ("ar-AE,ar;q=0.9,en;q=0.8")
 * or a single tag ("ar-AE", "ar_AE", navigator.language). Arabic ("ar" primary subtag, any region)
 * as the most preferred language → "ar"; anything else, empty or unparsable → "en".
 */
export function suggestCaptionLang(locale: string | null | undefined, memory?: CaptionLang | null): CaptionLang {
  if (isCaptionLang(memory)) return memory;
  const primary = preferredLanguage(locale);
  return primary === "ar" ? "ar" : "en";
}

/** Max header length we parse (Accept-Language is short; ignore garbage). */
const MAX_LOCALE_LENGTH = 1024;

/**
 * Primary subtag (lower case) of the most preferred language in an Accept-Language value or a
 * single locale tag; null when none. Highest q wins; ties keep header order; q=0 and "*" are skipped.
 */
export function preferredLanguage(locale: string | null | undefined): string | null {
  if (typeof locale !== "string" || locale.length === 0 || locale.length > MAX_LOCALE_LENGTH) return null;
  let best: { lang: string; q: number } | null = null;
  for (const part of locale.split(",")) {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag.trim();
    if (!tag || tag === "*") continue;
    const primary = tag.split(/[-_]/)[0].toLowerCase();
    if (!/^[a-z]{2,8}$/.test(primary)) continue;
    let q = 1;
    for (const p of params) {
      const [key, value = ""] = p.split("=");
      if (key.trim().toLowerCase() !== "q") continue;
      // Malformed weight ("q=abc", "q=") → NaN → the tag is skipped below.
      q = /^\s*[0-9.]+\s*$/.test(value) ? Number(value) : Number.NaN;
    }
    if (!Number.isFinite(q) || q <= 0 || q > 1) continue;
    if (best === null || q > best.q) best = { lang: primary, q };
  }
  return best?.lang ?? null;
}

// --- Tone --------------------------------------------------------------------------------------

/**
 * The feel for `occasion`: a remembered tone (user memory, D-032 — it is only learned when it
 * differs from an occasion default, so it is a real preference) wins; otherwise the occasion's
 * default (DEFAULT_TONE). Unknown occasion → the "other" default.
 */
export function toneForOccasion(occasion: Occasion | null | undefined, memoryTone?: Tone | null): Tone {
  if (isTone(memoryTone)) return memoryTone;
  return (occasion && DEFAULT_TONE[occasion]) || DEFAULT_TONE.other;
}

// --- helpers -----------------------------------------------------------------------------------

function isPositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function safeCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function isCaptionLang(v: unknown): v is CaptionLang {
  return typeof v === "string" && (CAPTION_LANGS as readonly string[]).includes(v);
}

function isTone(v: unknown): v is Tone {
  return typeof v === "string" && (TONES as readonly string[]).includes(v);
}
