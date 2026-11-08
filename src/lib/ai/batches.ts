// M3 T7 (D-019): split photos into Curator batches (≤ size images per request).
// Pure + deterministic: the same set of photos always yields the same batches, whatever the
// input order, so replay fixtures and resumed runs (D-022) line up.
//
// Rules:
//  1. Order by capture time ascending; undated / unparseable times last; ties by id.
//  2. A duplicate group (same dupGroup) is one unit, placed at its earliest member, so the
//     Curator sees every candidate of a group in the same request and can pick the best.
//  3. A group larger than `size` is split into ceil(n / size) near-equal chunks (each chunk
//     still holds similar shots to compare), in time order.
//  4. Units are packed next-fit: a unit that doesn't fit in the current batch starts a new one.
//     Units are never reordered, so batches stay chronological.

export type BatchPhoto = {
  id: string;
  takenAt: string | null;
  dupGroup: number | null;
};

export const DEFAULT_BATCH_SIZE = 10;

function timeOf(iso: string | null): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : t;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Split `items` into `parts` contiguous chunks whose sizes differ by at most 1. */
function evenChunks<T>(items: T[], parts: number): T[][] {
  const out: T[][] = [];
  const base = Math.floor(items.length / parts);
  let extra = items.length % parts;
  let i = 0;
  for (let p = 0; p < parts; p++) {
    const len = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    out.push(items.slice(i, i + len));
    i += len;
  }
  return out;
}

export function buildBatches(photos: BatchPhoto[], size = DEFAULT_BATCH_SIZE): string[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("batch size must be a positive integer");

  // 1. Deterministic order; duplicate ids collapse to their first occurrence in that order.
  const sorted = photos
    .map((p) => ({ id: p.id, t: timeOf(p.takenAt), g: p.dupGroup }))
    .sort((a, b) => {
      if (a.t !== b.t) return a.t < b.t ? -1 : 1;
      const byId = cmp(a.id, b.id);
      if (byId !== 0) return byId;
      return (a.g ?? -Infinity) - (b.g ?? -Infinity);
    });
  const seen = new Set<string>();
  const unique = sorted.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  // 2. Units: one per dup group (at its earliest member), one per ungrouped photo.
  const units: string[][] = [];
  const groupUnit = new Map<number, string[]>();
  for (const p of unique) {
    if (p.g === null || !Number.isFinite(p.g)) {
      units.push([p.id]);
      continue;
    }
    const existing = groupUnit.get(p.g);
    if (existing) existing.push(p.id);
    else {
      const unit = [p.id];
      groupUnit.set(p.g, unit);
      units.push(unit);
    }
  }

  // 3 + 4. Split oversized groups, then pack next-fit.
  const batches: string[][] = [];
  let current: string[] = [];
  for (const unit of units) {
    const chunks = unit.length > size ? evenChunks(unit, Math.ceil(unit.length / size)) : [unit];
    for (const chunk of chunks) {
      if (current.length + chunk.length > size) {
        batches.push(current);
        current = [];
      }
      current.push(...chunk);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
