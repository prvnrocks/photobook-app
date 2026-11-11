// Seeded photo sets for the per-design autolayout / relayout property tests (M10b A10) and the
// classic portrait golden (tests/fixtures/autolayout-classic-portrait.golden.json).
// Changing this generator changes the golden — regenerate with GOLDEN_UPDATE=1 only when the
// classic output is meant to change.

import type { AutoPhoto } from "@/lib/autolayout";

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZES: readonly { w: number; h: number; weight: number }[] = [
  { w: 3000, h: 4000, weight: 40 }, // portrait
  { w: 4000, h: 3000, weight: 35 }, // landscape
  { w: 3000, h: 3000, weight: 10 }, // square
  { w: 1080, h: 1920, weight: 7 }, // tall portrait
  { w: 6000, h: 2400, weight: 8 }, // panorama (2.5)
];

function pickSize(r: () => number): { w: number; h: number } {
  const total = SIZES.reduce((a, s) => a + s.weight, 0);
  let x = r() * total;
  for (const s of SIZES) {
    x -= s.weight;
    if (x < 0) return s;
  }
  return SIZES[0];
}

const PLACES = ["Abu Dhabi", "Dubai", "Al Ain", "Liwa", null, null];

/**
 * `n` photos in a few "moments" (bursts on different days, one place each), mixed orientations
 * (incl. squares and panoramas), a few undated / dropped / duplicate-group photos.
 */
export function momentSet(n: number, seed: number): AutoPhoto[] {
  const r = rng(seed);
  const moments = Math.max(1, Math.min(8, Math.round(1 + r() * Math.sqrt(n))));
  const start = Date.parse("2026-10-10T08:00:00+04:00");
  // Moment weights so some moments are large.
  const weights = Array.from({ length: moments }, () => 0.2 + r() * r() * 4);
  const wSum = weights.reduce((a, b) => a + b, 0);
  const out: AutoPhoto[] = [];
  for (let i = 0; i < n; i++) {
    let x = r() * wSum;
    let m = 0;
    for (; m < moments - 1; m++) {
      x -= weights[m];
      if (x < 0) break;
    }
    const size = pickSize(r);
    const t = start + m * 26 * 3600_000 + Math.floor(r() * 3 * 3600_000);
    out.push({
      id: `s${seed}-${String(i).padStart(4, "0")}`,
      width: size.w,
      height: size.h,
      takenAt: r() < 0.04 ? null : new Date(t).toISOString(),
      dateSource: "exif",
      place: PLACES[(m + seed) % PLACES.length],
      status: r() < 0.05 ? "dropped" : "kept",
      dupGroup: r() < 0.06 ? Math.floor(r() * 5) : null,
      blurScore: Math.round(r() * 800),
    });
  }
  return out;
}

/** Photo counts used by the property tests: 1–150 incl. edges. */
export const SET_SIZES: readonly number[] = [1, 2, 3, 5, 7, 9, 12, 14, 19, 25, 33, 48, 64, 90, 120, 150];
