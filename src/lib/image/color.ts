// M10c T4: muted dominant colour of a photo → "#rrggbb" (lowercase), for photos.color.
// Pure and deterministic: the browser runs it on the 512 px thumb canvas pixels (process-photo),
// the server on the same thumb decoded with sharp (Curator backfill for older photos), so both
// give the same answer for the same pixels. No DOM, no Node APIs.
//
// Method:
//   1. Sample pixels on a fixed grid (≤ MAX_SAMPLES), skip transparent ones.
//   2. Skip near-white (blown sky, paper, borders) and near-black (shadows, letterbox bars)
//      extremes — unless they are almost the whole photo, then they ARE its colour.
//   3. Histogram in 4-bit-per-channel buckets; the most populated bucket wins (ties → lowest
//      bucket index). Its colour is the mean of the pixels that fell in it.
//   4. Mute it for use as a page background swatch: saturation ≤ MAX_SATURATION, lightness
//      clamped to [MIN_LIGHTNESS, MAX_LIGHTNESS] (HSL).
// Colour is user data derived from a photo: never log it together with a photo id.

/** Matches the server check in the finalize route (and the DB check, lowercase only). */
export const PHOTO_COLOR_RE = /^#[0-9a-f]{6}$/;

/** Pixel grid samples per photo (a 512×384 thumb has ~197k pixels; ~16k is plenty). */
export const MAX_SAMPLES = 16_384;
/** Luma (0–255) at or above which a pixel counts as near-white. */
export const WHITE_LUMA = 240;
/** Luma (0–255) at or below which a pixel counts as near-black. */
export const BLACK_LUMA = 18;
/** Minimum share of samples that must be mid-tone to ignore the extremes. */
export const MIN_MIDTONE_SHARE = 0.05;
export const MAX_SATURATION = 0.45;
export const MIN_LIGHTNESS = 0.22;
export const MAX_LIGHTNESS = 0.86;

const ALPHA_MIN = 128;

export type PixelBuffer = Uint8ClampedArray | Uint8Array;

/**
 * Muted dominant colour of an image, or null when there are no usable pixels.
 * `channels` = 4 for canvas RGBA (getImageData), 3 for raw RGB (sharp .removeAlpha().raw()).
 */
export function dominantColor(
  pixels: PixelBuffer,
  width: number,
  height: number,
  channels: 3 | 4 = 4,
): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const n = width * height;
  if (pixels.length < n * channels) return null;

  const step = Math.max(1, Math.ceil(Math.sqrt(n / MAX_SAMPLES)));
  const mid = new Bins();
  const extreme = new Bins();
  for (let y = Math.floor(step / 2); y < height; y += step) {
    for (let x = Math.floor(step / 2); x < width; x += step) {
      const p = (y * width + x) * channels;
      if (channels === 4 && pixels[p + 3] < ALPHA_MIN) continue;
      const r = pixels[p];
      const g = pixels[p + 1];
      const b = pixels[p + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      (luma >= WHITE_LUMA || luma <= BLACK_LUMA ? extreme : mid).add(r, g, b);
    }
  }
  const total = mid.total + extreme.total;
  if (total === 0) return null;
  // Mostly white / black photo (snow, night sky, a document): use the extremes after all.
  const bins = mid.total >= total * MIN_MIDTONE_SHARE ? mid : extreme;
  const rgb = bins.dominant();
  return rgb ? toHex(mute(rgb)) : null;
}

/** 4 bits per channel → 4096 buckets; sums per bucket for the mean colour. */
class Bins {
  readonly count = new Uint32Array(4096);
  readonly sum = new Float64Array(4096 * 3);
  total = 0;

  add(r: number, g: number, b: number): void {
    const i = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    this.count[i]++;
    this.sum[i * 3] += r;
    this.sum[i * 3 + 1] += g;
    this.sum[i * 3 + 2] += b;
    this.total++;
  }

  dominant(): [number, number, number] | null {
    let best = -1;
    let bestCount = 0;
    for (let i = 0; i < 4096; i++) {
      if (this.count[i] > bestCount) {
        best = i;
        bestCount = this.count[i];
      }
    }
    if (best < 0) return null;
    return [this.sum[best * 3] / bestCount, this.sum[best * 3 + 1] / bestCount, this.sum[best * 3 + 2] / bestCount];
  }
}

/** RGB 0–255 → HSL (h 0–1, s 0–1, l 0–1) → clamp s / l → RGB 0–255. */
export function mute([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  const s2 = Math.min(s, MAX_SATURATION);
  const l2 = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, l));
  return hslToRgb(h, s2, l2);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function isPhotoColor(v: unknown): v is string {
  return typeof v === "string" && PHOTO_COLOR_RE.test(v);
}
