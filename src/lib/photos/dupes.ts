// Group near-duplicate photos by perceptual hash (dHash, 64 bit) + capture time.
// Pure module (no I/O). Complexity: O(n²) pairwise comparisons with union-find;
// 500 items = ~125k hash comparisons, well under 100 ms.
//
// Thresholds (M3 T7, D-019) were tuned on the aggregate pair statistics of a real 110-photo
// iPhone set (5995 pairs, all EXIF-dated; metadata only, no per-photo data kept):
//  - Hamming: 16 pairs at ≤6, then a jump to 11 pairs at exactly 7 and ~8 per step up to 12.
//    The 7–12 band is "same scene, different shot" (pose/framing changed) — those must stay
//    separate. Old default 10 → 17 groups / 48 photos (5-photo chains with intra-group hamming 15).
//  - Time: the 16 pairs with hamming ≤6 are either ≤98 s apart (13, real bursts/retakes) or
//    ≥325 s apart (3). The latter chain two scenes into one 5-photo group spanning 12.5 min,
//    so the window sits in that gap: 3 min.
//  - Result with 6 / 3 min: 10 groups / 23 photos, largest group 3, every group spans ≤98 s.
//  - Hash-only (file-dated or undated, e.g. WhatsApp forwards): no time guard, so only
//    near-identical hashes (≤3) count; on the real set all ≤3 pairs were true bursts.

import { hamming } from "@/lib/image/phash";

export type DupeItem = {
  id: string;
  phash: string | null;
  takenAt: string | null;
  dateSource: "exif" | "file" | null;
};

export const DUPE_DEFAULTS = {
  /** Max Hamming distance when both photos have EXIF capture times. */
  maxHamming: 6,
  /** Max minutes between two EXIF capture times. */
  maxMinutes: 3,
  /** Max Hamming distance when either date is file-based or missing (hash only). */
  maxHammingNoTime: 3,
} as const;

export type GroupDuplicatesOptions = {
  /** Max Hamming distance for two EXIF-dated hashes to count as duplicates (default 6). */
  maxHamming?: number;
  /** Max minutes between two EXIF capture times (default 3). */
  maxMinutes?: number;
  /** Max Hamming distance when either date is file-based or missing (default 3). */
  maxHammingNoTime?: number;
};

/**
 * Hamming distance between two equal-length hex hash strings (wraps phash.hamming).
 * Returns Infinity instead of throwing when the lengths differ or a string isn't valid hex.
 */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  try {
    return hamming(a, b);
  } catch {
    return Infinity;
  }
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Union-find duplicate grouping. Two photos are duplicates when:
 *  - both have EXIF dates: hamming ≤ maxHamming AND |Δt| ≤ maxMinutes, or
 *  - either date is file-based / missing: hamming ≤ maxHammingNoTime (hash only, stricter).
 * Note: union-find is single-linkage, so a group can contain pairs further apart than the
 * thresholds (bursts chain); the tight defaults keep such chains within one burst.
 * Returns photoId → group number (1..n) only for members of groups with ≥ 2 photos.
 * Group numbers are stable: ordered by the group's earliest takenAt (undated last), then smallest id.
 */
export function groupDuplicates(
  items: DupeItem[],
  opts: GroupDuplicatesOptions = {},
): Map<string, number> {
  const maxHamming = opts.maxHamming ?? DUPE_DEFAULTS.maxHamming;
  const maxMs = (opts.maxMinutes ?? DUPE_DEFAULTS.maxMinutes) * 60_000;
  const strict = opts.maxHammingNoTime ?? DUPE_DEFAULTS.maxHammingNoTime;

  const list = items
    .filter((it): it is DupeItem & { phash: string } => !!it.phash)
    .map((it) => ({
      id: it.id,
      hash: it.phash.toLowerCase(),
      t: toMs(it.takenAt),
      exif: it.dateSource === "exif",
    }));
  const n = list.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < n; i++) {
    const a = list[i];
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      const bothExif = a.exif && b.exif && a.t !== null && b.t !== null;
      const limit = bothExif ? maxHamming : strict;
      if (limit < 0) continue;
      if (bothExif && Math.abs((a.t as number) - (b.t as number)) > maxMs) continue;
      if (hammingHex(a.hash, b.hash) > limit) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[rb] = ra;
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  const sorted = [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      let minT = Infinity;
      let minId = list[g[0]].id;
      for (const i of g) {
        const t = list[i].t;
        if (t !== null && t < minT) minT = t;
        if (list[i].id < minId) minId = list[i].id;
      }
      return { members: g, minT, minId };
    })
    .sort((x, y) => (x.minT !== y.minT ? x.minT - y.minT : x.minId < y.minId ? -1 : x.minId > y.minId ? 1 : 0));

  const out = new Map<string, number>();
  sorted.forEach((g, idx) => {
    for (const i of g.members) out.set(list[i].id, idx + 1);
  });
  return out;
}
