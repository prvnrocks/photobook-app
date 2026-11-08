// Photo metadata (date, GPS, camera, orientation) read with exifr.
//
// IMPORTANT: call readPhotoMeta on the ORIGINAL File, before heic2any or any canvas
// re-encode — conversion strips EXIF. Photos received via WhatsApp usually carry no
// EXIF, so we fall back to a date in the filename, then to file.lastModified.
//
// Browser-safe and DOM-free: the blob is read into a Uint8Array (exifr's own Blob
// reader needs FileReader, which Node doesn't have). Never log the result — GPS and
// dates of real photos are user data.
import exifr from "exifr";

export type DateSource = "exif" | "file";

export interface PhotoMeta {
  /** Absolute instant, ISO 8601 UTC (`Date#toISOString`). */
  takenAt: string;
  /**
   * Wall-clock time where/when the photo was taken, `YYYY-MM-DDTHH:mm:ss`, no zone.
   * Use this (not takenAt) for "same day" grouping. For EXIF dates without an offset
   * and filename dates it is the literal value; for lastModified it is the
   * uploader's device-local time.
   */
  takenAtLocal: string;
  /** 'exif' = EXIF DateTimeOriginal/CreateDate; 'file' = filename date or lastModified. */
  dateSource: DateSource;
  lat: number | null;
  lng: number | null;
  /** "Make Model", trimmed, ≤120 chars. */
  camera: string | null;
  /** EXIF orientation 1–8. */
  orientation: number | null;
}

export type PhotoFileLike = Blob & { name: string; lastModified: number };

/** Bytes read from the head of the file; JPEG APP1 must be in the first 64 KiB, HEIC meta is near the start. */
const HEAD_BYTES = 1024 * 1024;
/** HEIC files with no EXIF in the head get one retry with a bigger window. */
const HEIC_RETRY_BYTES = 16 * 1024 * 1024;
const MIN_YEAR = 1990;
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
const CAMERA_MAX = 120;

const PICK = [
  "DateTimeOriginal",
  "CreateDate",
  "OffsetTimeOriginal",
  "GPSLatitude",
  "GPSLongitude",
  "GPSLatitudeRef",
  "GPSLongitudeRef",
  "Make",
  "Model",
  "Orientation",
];

const EXIFR_OPTIONS = {
  tiff: true,
  exif: true,
  gps: true,
  ifd1: false,
  interop: false,
  xmp: false,
  icc: false,
  iptc: false,
  jfif: false,
  ihdr: false,
  makerNote: false,
  userComment: false,
  pick: PICK,
  // Keep dates as raw "YYYY:MM:DD HH:mm:ss" strings (exifr would otherwise build a Date
  // in the runtime's timezone) and orientation as a number.
  reviveValues: false,
  translateValues: false,
};

interface RawExif {
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
  OffsetTimeOriginal?: unknown;
  Make?: unknown;
  Model?: unknown;
  Orientation?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

// ---------------------------------------------------------------------------
// Date helpers (pure)
// ---------------------------------------------------------------------------

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function wallClockString(c: WallClock): string {
  return `${pad(c.y, 4)}-${pad(c.mo)}-${pad(c.d)}T${pad(c.h)}:${pad(c.mi)}:${pad(c.s)}`;
}

function localWallClock(date: Date): WallClock {
  return {
    y: date.getFullYear(),
    mo: date.getMonth() + 1,
    d: date.getDate(),
    h: date.getHours(),
    mi: date.getMinutes(),
    s: date.getSeconds(),
  };
}

/** True when the components form a real calendar date/time (rejects month 13, Feb 30, 25:00). */
function isRealWallClock(c: WallClock): boolean {
  if (c.mo < 1 || c.mo > 12 || c.d < 1 || c.h > 23 || c.mi > 59 || c.s > 59) return false;
  const probe = new Date(Date.UTC(c.y, c.mo - 1, c.d));
  return probe.getUTCFullYear() === c.y && probe.getUTCMonth() === c.mo - 1 && probe.getUTCDate() === c.d;
}

function isPlausibleInstant(date: Date, now: number): boolean {
  const t = date.getTime();
  return Number.isFinite(t) && date.getFullYear() >= MIN_YEAR && t <= now + FUTURE_SLACK_MS;
}

/** Wall clock interpreted in the runtime's local zone (used when no offset is known). */
function wallClockToLocalDate(c: WallClock): Date {
  return new Date(c.y, c.mo - 1, c.d, c.h, c.mi, c.s);
}

/** Parses "+04:00" / "-0530" / "Z" into minutes east of UTC, or null. */
export function parseOffsetMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(v);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  if (Number(m[2]) > 14 || Number(m[3]) > 59) return null;
  return m[1] === "-" ? -minutes : minutes;
}

/**
 * Parses an EXIF date ("YYYY:MM:DD HH:mm:ss", sub-seconds/zone suffix ignored).
 * With an offset the instant is exact; without one the wall clock is treated as the
 * uploader's local time (best guess — most users upload photos taken in their own zone).
 */
export function parseExifDate(
  value: unknown,
  offset: unknown = null,
  now: number = Date.now(),
): { date: Date; local: string } | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) return null;
  const c: WallClock = {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6] ?? 0),
  };
  if (!isRealWallClock(c)) return null;
  const off = parseOffsetMinutes(offset);
  const date =
    off === null
      ? wallClockToLocalDate(c)
      : new Date(Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s) - off * 60_000);
  if (!isPlausibleInstant(date, now)) return null;
  return { date, local: wallClockString(c) };
}

// Year 19xx/20xx, month, day with a consistent optional separator, then an optional time
// (separator " ", "_", "-", "T" or " at "; hour may be 1 digit + AM/PM for macOS screenshots).
const FILENAME_DATE_RE =
  /((?:19|20)\d{2})([-_.]?)(\d{2})\2(\d{2})(?:(?:\s+at\s+|[ _T-])(\d{1,2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?:[\s\u202f]?([AaPp][Mm]))?)?/g;

interface FilenameDate {
  date: Date;
  local: string;
  hasTime: boolean;
}

function parseFilenameDateDetailed(name: string, now: number): FilenameDate | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  for (const m of base.matchAll(FILENAME_DATE_RE)) {
    const hasTime = m[5] !== undefined;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // No lookbehind (older iOS Safari): the year must not continue a longer number.
    if (start > 0 && /\d/.test(base.charAt(start - 1))) continue;
    // A date-only match glued to more digits (e.g. "202610121") is some other number.
    if (!hasTime && /\d/.test(base.charAt(end))) continue;
    let h = hasTime ? Number(m[5]) : 12; // date-only: noon, so tz shifts keep the same day
    const ampm = m[8]?.toLowerCase();
    if (ampm) {
      if (h < 1 || h > 12) continue;
      h = (h % 12) + (ampm === "pm" ? 12 : 0);
    } else if (hasTime && m[5].length !== 2) {
      continue;
    }
    const c: WallClock = {
      y: Number(m[1]),
      mo: Number(m[3]),
      d: Number(m[4]),
      h,
      mi: hasTime ? Number(m[6]) : 0,
      s: hasTime ? Number(m[7]) : 0,
    };
    if (!isRealWallClock(c)) continue;
    const date = wallClockToLocalDate(c);
    if (!isPlausibleInstant(date, now)) continue;
    return { date, local: wallClockString(c), hasTime };
  }
  return null;
}

/**
 * Extracts a capture date from common camera/messenger filenames, e.g.
 * `IMG-20261012-WA0003.jpg` (WhatsApp, date only → 12:00 local),
 * `PHOTO-2026-10-12-18-22-31.jpg`, `20261012_182231.jpg`, `IMG_20261012_182231.jpg`,
 * `Screenshot 2026-10-12 at 18.22.31.png`, `Screenshot_20261012-182231.png`.
 * The wall clock is interpreted in the runtime's local zone. Rejects impossible
 * dates, years < 1990 and dates more than one day in the future.
 */
export function parseDateFromFilename(name: string, now: number = Date.now()): Date | null {
  return parseFilenameDateDetailed(name, now)?.date ?? null;
}

// ---------------------------------------------------------------------------
// Other field helpers (pure)
// ---------------------------------------------------------------------------

/** Valid finite coordinates in range; (0,0) — "null island", a common bogus default — becomes null. */
export function normalizeGps(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return null;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { lat: round(lat), lng: round(lng) };
}

function cleanText(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** "Make Model" without repeating the make (e.g. "Canon" + "Canon EOS R5" → "Canon EOS R5"). */
export function formatCamera(make: unknown, model: unknown): string | null {
  const mk = cleanText(make);
  const md = cleanText(model);
  let out: string;
  if (mk && md) out = md.toLowerCase().startsWith(mk.toLowerCase()) ? md : `${mk} ${md}`;
  else out = mk || md;
  if (!out) return null;
  return out.length > CAMERA_MAX ? out.slice(0, CAMERA_MAX).trimEnd() : out;
}

function normalizeOrientation(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 8 ? v : null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function looksLikeHeic(file: PhotoFileLike): boolean {
  return /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

async function parseExif(file: PhotoFileLike, bytes: number): Promise<RawExif | null> {
  try {
    const buf = new Uint8Array(await file.slice(0, bytes).arrayBuffer());
    if (buf.length === 0) return null;
    const out = (await exifr.parse(buf, EXIFR_OPTIONS)) as RawExif | undefined;
    return out ?? null;
  } catch {
    // Unsupported format (GIF, …) or corrupt metadata: behave as "no EXIF".
    return null;
  }
}

async function readRawExif(file: PhotoFileLike): Promise<RawExif | null> {
  const head = await parseExif(file, HEAD_BYTES);
  if (head || file.size <= HEAD_BYTES || !looksLikeHeic(file)) return head;
  return parseExif(file, HEIC_RETRY_BYTES);
}

/**
 * Reads date, GPS, camera and orientation from the ORIGINAL file (before HEIC conversion).
 * Date order: EXIF DateTimeOriginal → EXIF CreateDate → filename pattern → file.lastModified.
 * Never throws for bad/missing metadata.
 */
export async function readPhotoMeta(file: PhotoFileLike, now: number = Date.now()): Promise<PhotoMeta> {
  const raw = await readRawExif(file);
  const gps = normalizeGps(raw?.latitude, raw?.longitude);
  const base = {
    lat: gps?.lat ?? null,
    lng: gps?.lng ?? null,
    camera: formatCamera(raw?.Make, raw?.Model),
    orientation: normalizeOrientation(raw?.Orientation),
  };

  // OffsetTimeOriginal belongs to DateTimeOriginal; CreateDate has its own (unpicked) offset.
  const exifDate =
    parseExifDate(raw?.DateTimeOriginal, raw?.OffsetTimeOriginal, now) ?? parseExifDate(raw?.CreateDate, null, now);
  if (exifDate) {
    return { ...base, takenAt: exifDate.date.toISOString(), takenAtLocal: exifDate.local, dateSource: "exif" };
  }

  const modified = new Date(Number.isFinite(file.lastModified) ? file.lastModified : now);
  const fromName = parseFilenameDateDetailed(file.name, now);
  if (fromName) {
    // Date-only name (WhatsApp) + lastModified on the same local day → keep the precise time.
    const sameDay = !fromName.hasTime && wallClockString(localWallClock(modified)).slice(0, 10) === fromName.local.slice(0, 10);
    const date = sameDay ? modified : fromName.date;
    return {
      ...base,
      takenAt: date.toISOString(),
      takenAtLocal: sameDay ? wallClockString(localWallClock(modified)) : fromName.local,
      dateSource: "file",
    };
  }

  return {
    ...base,
    takenAt: modified.toISOString(),
    takenAtLocal: wallClockString(localWallClock(modified)),
    dateSource: "file",
  };
}
