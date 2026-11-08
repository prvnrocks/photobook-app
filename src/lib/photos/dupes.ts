// Milestone 2 (T7): group near-duplicate photos by perceptual hash + capture time.
// Pure module (no I/O). Complexity: O(n²) pairwise comparisons with union-find;
// 500 items = ~125k hash comparisons, well under 100 ms.

export type DupeItem = {
  id: string;
  phash: string | null;
  takenAt: string | null;
  dateSource: "exif" | "file" | null;
};

export type GroupDuplicatesOptions = {
  /** Max Hamming distance for two hashes to count as duplicates (default 10). */
  maxHamming?: number;
  /** Max minutes between two EXIF capture times (default 30). */
  maxMinutes?: number;
};

const POPCOUNT_NIBBLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * Hamming distance between two equal-length hex hash strings.
 * Returns Infinity when the lengths differ or a string isn't valid hex.
 * (Local implementation: src/lib/image/phash.ts did not export one yet.)
 */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16);
    const y = parseInt(b[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return Infinity;
    d += POPCOUNT_NIBBLE[x ^ y];
  }
  return d;
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Union-find duplicate grouping. Two photos are duplicates when:
 *  - both have EXIF dates: hamming ≤ maxHamming AND |Δt| ≤ maxMinutes, or
 *  - either date is file-based / missing: hamming ≤ maxHamming - 4 (hash only, stricter).
 * Returns photoId → group number (1..n) only for members of groups with ≥ 2 photos.
 * Group numbers are stable: ordered by the group's earliest takenAt (undated last), then smallest id.
 */
export function groupDuplicates(
  items: DupeItem[],
  opts: GroupDuplicatesOptions = {},
): Map<string, number> {
  const maxHamming = opts.maxHamming ?? 10;
  const maxMs = (opts.maxMinutes ?? 30) * 60_000;
  const strict = maxHamming - 4;

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
