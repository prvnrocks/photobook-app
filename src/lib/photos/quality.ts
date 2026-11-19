// Photo quality scores from pixels: sharpness, exposure, composition. Pure and DOM-free.
//
// Input is the LUMA of the 512 px analysis copy (0..255). Scores are 0–100 and only comparable
// between images measured at that size. They rank photos against each other; they are never a
// reason to delete anything.
//
//   sharpness    variance of the 3×3 Laplacian (blur.ts) on a log scale. v2: the scale reaches
//                100 only at variance 20 000 (v1 saturated at 1 000, so most real phone photos
//                scored 100 and blur could not be told apart)
//   exposure     luma histogram: mean brightness, clipped shadows / highlights, tonal range
//   composition  HEURISTIC from the edge-energy map: how close the visual weight sits to the
//                centre or a rule-of-thirds point, and how much of it is pressed against the frame
//
// QUALITY_VERSION is stored with every score: bump it when a formula changes and old rows are
// recomputed (a v1 row is upgraded from its stored raw measurements without the image:
// upgradeStoredScores).
//
// "Blurry" for the storybook is decided per BOOK (bookBlurryIds): a photo is set aside only when
// it is a clear outlier against the book's own sharpness distribution AND below an absolute
// ceiling, or below the absolute floor. A Laplacian cannot tell a soft-but-sharp photo (sky, a
// plain wall) from a blurred one, so texture-free ("flat") photos are never flagged by the
// relative rule.

import { laplacianVariance } from "@/lib/image/blur";

export const QUALITY_VERSION = 2;

export const QUALITY_FLAGS = ["blurry", "soft", "underexposed", "overexposed", "low_contrast", "flat"] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export const QUALITY_THRESHOLDS = {
  /** Laplacian variance below which a 512 px image is unusably blurry (= fallback.ts EXTREME_BLUR_MAX). */
  blurryVariance: 10,
  softVariance: 40,
  /** Variance that maps to sharpness 100 (v1: 1 000 — saturated on most phone photos). */
  sharpVariance: 20000,
  darkMean: 45,
  brightMean: 215,
  clipLowShare: 0.35,
  clipHighShare: 0.25,
  lowContrastRange: 40,
  /** Mean edge energy below which there is nothing to judge composition by. */
  flatEnergy: 1.5,
} as const;

export const QUALITY_WEIGHTS = { sharpness: 0.5, exposure: 0.3, composition: 0.2 } as const;

export type QualityScores = {
  version: number;
  sharpness: number;
  exposure: number;
  composition: number;
  overall: number;
  flags: QualityFlag[];
  /** Measurements behind the scores (numbers only). */
  raw: { laplacianVariance: number; meanLuma: number; clipLow: number; clipHigh: number; tonalRange: number; edgeShare: number; weightX: number; weightY: number };
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Sharpness 0–100 from a Laplacian variance measured at 512 px (also used for photos.blur_score). */
export function sharpnessFromVariance(variance: number): number {
  if (!Number.isFinite(variance) || variance <= 0) return 0;
  return round1(clamp((100 * Math.log10(1 + variance)) / Math.log10(1 + QUALITY_THRESHOLDS.sharpVariance), 0, 100));
}

function exposureOf(gray: Float32Array, n: number) {
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = clamp(Math.round(gray[i]!), 0, 255);
    hist[v]!++;
    sum += v;
  }
  const mean = sum / n;
  const pct = (p: number) => {
    const target = n * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v]!;
      if (acc >= target) return v;
    }
    return 255;
  };
  let low = 0;
  let high = 0;
  for (let v = 0; v <= 4; v++) low += hist[v]!;
  for (let v = 251; v <= 255; v++) high += hist[v]!;
  const clipLow = low / n;
  const clipHigh = high / n;
  const range = pct(0.95) - pct(0.05);
  const score =
    100 -
    (Math.abs(mean - 118) / 118) * 40 -
    Math.min(30, clipLow * 100 * 0.8) -
    Math.min(30, clipHigh * 100 * 1.2) -
    (range < 60 ? ((60 - range) / 60) * 30 : 0);
  return { score: round1(clamp(score, 0, 100)), mean, clipLow, clipHigh, range };
}

function compositionOf(gray: Float32Array, w: number, h: number) {
  // Edge energy |dx| + |dy| on interior pixels; its centre of mass is the "visual weight".
  let total = 0;
  let sx = 0;
  let sy = 0;
  let border = 0;
  const bx = Math.max(1, Math.round(w * 0.06));
  const by = Math.max(1, Math.round(h * 0.06));
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const e = Math.abs(gray[i + 1]! - gray[i - 1]!) + Math.abs(gray[i + w]! - gray[i - w]!);
      total += e;
      sx += e * x;
      sy += e * y;
      if (x < bx || x >= w - bx || y < by || y >= h - by) border += e;
    }
  }
  const n = Math.max(1, (w - 2) * (h - 2));
  const meanEnergy = total / n;
  if (meanEnergy < QUALITY_THRESHOLDS.flatEnergy) return { score: 50, flat: true, edgeShare: 0, weightX: 0.5, weightY: 0.5 };
  const cx = sx / total / (w - 1);
  const cy = sy / total / (h - 1);
  const anchors: [number, number][] = [
    [0.5, 0.5],
    [1 / 3, 1 / 3],
    [2 / 3, 1 / 3],
    [1 / 3, 2 / 3],
    [2 / 3, 2 / 3],
  ];
  const d = Math.min(...anchors.map(([ax, ay]) => Math.hypot(cx - ax, cy - ay)));
  const placement = 1 - clamp(d / 0.35, 0, 1);
  const edgeShare = border / total;
  // A 6 % frame covers ≈ 22 % of the area; more energy than that means detail pressed to the edges.
  const framing = 1 - clamp((edgeShare - 0.22) / 0.3, 0, 1);
  return { score: round1(100 * (0.6 * placement + 0.4 * framing)), flat: false, edgeShare, weightX: cx, weightY: cy };
}

/** Scores one image. `gray` = luma 0..255, row-major, at least w·h long. */
export function scoreImage(gray: Float32Array, w: number, h: number): QualityScores {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 8 || h < 8 || gray.length < w * h) throw new RangeError("image too small to score");
  const variance = laplacianVariance(gray, w, h);
  const sharpness = sharpnessFromVariance(variance);
  const exp = exposureOf(gray, w * h);
  const comp = compositionOf(gray, w, h);

  const flags: QualityFlag[] = [];
  if (variance < QUALITY_THRESHOLDS.blurryVariance) flags.push("blurry");
  else if (variance < QUALITY_THRESHOLDS.softVariance) flags.push("soft");
  if (exp.mean < QUALITY_THRESHOLDS.darkMean || exp.clipLow > QUALITY_THRESHOLDS.clipLowShare) flags.push("underexposed");
  if (exp.mean > QUALITY_THRESHOLDS.brightMean || exp.clipHigh > QUALITY_THRESHOLDS.clipHighShare) flags.push("overexposed");
  if (exp.range < QUALITY_THRESHOLDS.lowContrastRange) flags.push("low_contrast");
  if (comp.flat) flags.push("flat");

  const overall = round1(QUALITY_WEIGHTS.sharpness * sharpness + QUALITY_WEIGHTS.exposure * exp.score + QUALITY_WEIGHTS.composition * comp.score);
  return {
    version: QUALITY_VERSION,
    sharpness,
    exposure: exp.score,
    composition: comp.score,
    overall,
    flags,
    raw: {
      laplacianVariance: round4(variance),
      meanLuma: round4(exp.mean),
      clipLow: round4(exp.clipLow),
      clipHigh: round4(exp.clipHigh),
      tonalRange: exp.range,
      edgeShare: round4(comp.edgeShare),
      weightX: round4(comp.weightX),
      weightY: round4(comp.weightY),
    },
  };
}

/**
 * A stored score of an older version, re-derived from its raw measurements (no image needed).
 * Null when the raw numbers are missing (the photo is then measured again).
 */
export function upgradeStoredScores(q: Pick<QualityScores, "version" | "exposure" | "composition" | "flags" | "raw">): QualityScores | null {
  if (q.version === QUALITY_VERSION) return null;
  const variance = Number(q.raw?.laplacianVariance);
  if (!Number.isFinite(variance) || variance < 0) return null;
  const sharpness = sharpnessFromVariance(variance);
  const flags: QualityFlag[] = q.flags.filter((f) => f !== "blurry" && f !== "soft");
  if (variance < QUALITY_THRESHOLDS.blurryVariance) flags.unshift("blurry");
  else if (variance < QUALITY_THRESHOLDS.softVariance) flags.unshift("soft");
  const overall = round1(QUALITY_WEIGHTS.sharpness * sharpness + QUALITY_WEIGHTS.exposure * q.exposure + QUALITY_WEIGHTS.composition * q.composition);
  return { version: QUALITY_VERSION, sharpness, exposure: q.exposure, composition: q.composition, overall, flags, raw: { ...q.raw } };
}

export const BOOK_BLUR = {
  /** Fewer scored photos than this: only the absolute floor applies (no distribution to compare with). */
  minPhotos: 6,
  /** A photo must have at least 10× less Laplacian energy than the book's median (log10 units)… */
  minDropLog: 1,
  /** …or 3 robust standard deviations below it when the book itself varies a lot. */
  madFactor: 3,
  /** …and stay below this absolute variance (a book of very detailed photos never flags a merely calm one). */
  ceilingVariance: 250,
  /** With the vision model's own "blurred / out of focus" note, half the relative drop is enough. */
  visionDropLog: 0.5,
} as const;

export type BlurInput = {
  id: string;
  /** Laplacian variance of the 512 px copy, null when unmeasured. */
  variance: number | null;
  /** Texture-free photo ("flat"): nothing to judge sharpness by. */
  flat: boolean;
  /** The photo description says the picture is blurred / out of focus. */
  visionBlurry?: boolean;
};

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Words in a photo description that say the picture itself is blurred. */
export const VISION_BLUR_RE = /\b(?:blurry|blurred|out[\s-]of[\s-]focus|motion blur|unfocused|smeared)\b/i;

/**
 * Photos of one book that are clearly blurry (ids). Pure and deterministic.
 *   - variance below the absolute floor (QUALITY_THRESHOLDS.blurryVariance) → blurry, always;
 *   - book-relative (≥ BOOK_BLUR.minPhotos measured): log10(1 + variance) at least
 *     max(minDropLog, madFactor × 1.4826 × MAD) below the book's median AND variance below
 *     ceilingVariance, never for a flat photo;
 *   - the vision note "blurred / out of focus" lowers the relative drop to visionDropLog (same ceiling).
 */
export function bookBlurryIds(items: readonly BlurInput[]): Set<string> {
  const out = new Set<string>();
  const measured = items.filter((i): i is BlurInput & { variance: number } => typeof i.variance === "number" && Number.isFinite(i.variance) && i.variance >= 0);
  for (const i of measured) if (i.variance < QUALITY_THRESHOLDS.blurryVariance) out.add(i.id);
  if (measured.length < BOOK_BLUR.minPhotos) return out;
  const logs = measured.map((i) => Math.log10(1 + i.variance));
  const med = median(logs);
  const mad = median(logs.map((l) => Math.abs(l - med)));
  const drop = Math.max(BOOK_BLUR.minDropLog, BOOK_BLUR.madFactor * 1.4826 * mad);
  measured.forEach((i, k) => {
    if (i.flat || i.variance >= BOOK_BLUR.ceilingVariance) return;
    const below = med - logs[k]!;
    if (below >= drop || (i.visionBlurry && below >= BOOK_BLUR.visionDropLog)) out.add(i.id);
  });
  return out;
}

/** RGB(A) bytes → luma (Rec. 601), the input of scoreImage. */
export function lumaOf(pixels: Uint8Array | Uint8ClampedArray, w: number, h: number, channels: 1 | 3 | 4): Float32Array {
  const out = new Float32Array(w * h);
  if (channels === 1) {
    for (let i = 0; i < out.length; i++) out[i] = pixels[i]!;
    return out;
  }
  for (let i = 0, p = 0; i < out.length; i++, p += channels) out[i] = 0.299 * pixels[p]! + 0.587 * pixels[p + 1]! + 0.114 * pixels[p + 2]!;
  return out;
}
