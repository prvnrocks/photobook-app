import { describe, expect, it } from "vitest";
import { buildBatches, DEFAULT_BATCH_SIZE, type BatchPhoto } from "@/lib/ai/batches";

const at = (min: number) => new Date(Date.UTC(2026, 4, 1, 10) + min * 60_000).toISOString();
const ph = (id: string, min: number | null, dupGroup: number | null = null): BatchPhoto => ({
  id,
  takenAt: min === null ? null : at(min),
  dupGroup,
});

/** Seeded Fisher–Yates (mulberry32) so shuffles are reproducible. */
function shuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Realistic-ish set: one photo per minute, every 7th photo starts a 2–4 photo burst group. */
function makeSet(n: number): BatchPhoto[] {
  const out: BatchPhoto[] = [];
  let group = 0;
  for (let i = 0; out.length < n; i++) {
    const id = `p${String(out.length).padStart(4, "0")}`;
    if (i % 7 === 3) {
      group++;
      const len = 2 + (group % 3);
      for (let k = 0; k < len && out.length < n; k++) {
        out.push(ph(`p${String(out.length).padStart(4, "0")}`, i, group));
      }
    } else if (i % 23 === 0) {
      out.push(ph(id, null));
    } else {
      out.push(ph(id, i));
    }
  }
  return out;
}

function checkInvariants(photos: BatchPhoto[], batches: string[][], size = DEFAULT_BATCH_SIZE) {
  const flat = batches.flat();
  // every photo exactly once
  expect(flat.length).toBe(photos.length);
  expect(new Set(flat)).toEqual(new Set(photos.map((p) => p.id)));
  for (const b of batches) {
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBeLessThanOrEqual(size);
  }
  // groups ≤ size live in exactly one batch
  const batchOf = new Map<string, number>();
  batches.forEach((b, i) => b.forEach((id) => batchOf.set(id, i)));
  const groups = new Map<number, string[]>();
  for (const p of photos) if (p.dupGroup !== null) groups.set(p.dupGroup, [...(groups.get(p.dupGroup) ?? []), p.id]);
  for (const ids of groups.values()) {
    const where = new Set(ids.map((id) => batchOf.get(id)));
    if (ids.length <= size) expect(where.size).toBe(1);
    else expect(where.size).toBe(Math.ceil(ids.length / size));
  }
}

describe("buildBatches", () => {
  it("returns [] for no photos and rejects a bad size", () => {
    expect(buildBatches([])).toEqual([]);
    expect(() => buildBatches([ph("a", 0)], 0)).toThrow(RangeError);
    expect(() => buildBatches([ph("a", 0)], 2.5)).toThrow(RangeError);
  });

  it("orders by time, undated last, ties by id", () => {
    const b = buildBatches([ph("u2", null), ph("c", 2), ph("u1", null), ph("b", 1), ph("a", 1)], 10);
    expect(b).toEqual([["a", "b", "c", "u1", "u2"]]);
  });

  it("treats unparseable dates as undated", () => {
    const b = buildBatches([{ id: "x", takenAt: "garbage", dupGroup: null }, ph("a", 5)], 10);
    expect(b).toEqual([["a", "x"]]);
  });

  it("never puts more than `size` photos in a batch and fills greedily", () => {
    const photos = Array.from({ length: 25 }, (_, i) => ph(`p${String(i).padStart(2, "0")}`, i));
    const b = buildBatches(photos);
    expect(b.map((x) => x.length)).toEqual([10, 10, 5]);
    expect(buildBatches(photos, 4).every((x) => x.length <= 4)).toBe(true);
  });

  it("keeps a dup group together, starting a new batch if it doesn't fit", () => {
    const photos = [
      ...Array.from({ length: 8 }, (_, i) => ph(`a${i}`, i)),
      ph("g1", 8, 1),
      ph("g2", 8, 1),
      ph("g3", 8, 1),
      ph("z", 9),
    ];
    const b = buildBatches(photos);
    expect(b).toEqual([["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"], ["g1", "g2", "g3", "z"]]);
  });

  it("places a group at its earliest member even when members are far apart in time", () => {
    const b = buildBatches([ph("x", 0), ph("g-late", 50, 3), ph("y", 1), ph("g-early", 0.5, 3)], 2);
    // units: [x], [g-early, g-late], [y] → group doesn't fit next to x, y doesn't fit after it
    expect(b).toEqual([["x"], ["g-early", "g-late"], ["y"]]);
  });

  it("splits an oversized group into near-equal chunks and keeps them in order", () => {
    const group = Array.from({ length: 23 }, (_, i) => ph(`g${String(i).padStart(2, "0")}`, 5 + i / 100, 9));
    const photos = [ph("before", 0), ...group, ph("after", 60)];
    const b = buildBatches(photos);
    checkInvariants(photos, b);
    // 23 → chunks 8/8/7; "before" + 8 fits, the 7-chunk shares with "after".
    expect(b.map((x) => x.length)).toEqual([9, 8, 8]);
    expect(b[0][0]).toBe("before");
    expect(b[2][b[2].length - 1]).toBe("after");
    expect(b.flat()).toEqual(["before", ...group.map((p) => p.id), "after"]);
  });

  it("treats a group of exactly `size` as one full batch", () => {
    const group = Array.from({ length: 10 }, (_, i) => ph(`g${i}`, 1, 1));
    const b = buildBatches([ph("a", 0), ...group]);
    expect(b).toEqual([["a"], group.map((p) => p.id)]);
  });

  it("is deterministic under shuffled input", () => {
    const photos = makeSet(150);
    const ref = buildBatches(photos);
    for (const seed of [1, 2, 3, 42, 1234]) {
      expect(buildBatches(shuffle(photos, seed))).toEqual(ref);
    }
  });

  it("collapses repeated ids to one entry", () => {
    const b = buildBatches([ph("a", 0), ph("a", 0), ph("b", 1)]);
    expect(b).toEqual([["a", "b"]]);
  });

  it.each([150, 500])("handles %i photos within the invariants", (n) => {
    const photos = makeSet(n);
    const start = performance.now();
    const b = buildBatches(shuffle(photos, n));
    expect(performance.now() - start).toBeLessThan(100);
    checkInvariants(photos, b);
    // next-fit with small groups stays close to optimal: at most ~15 % extra batches
    expect(b.length).toBeLessThanOrEqual(Math.ceil((n / DEFAULT_BATCH_SIZE) * 1.15));
    // chronological: undated photos come after all dated ones
    const flat = b.flat();
    const undated = new Set(photos.filter((p) => p.takenAt === null).map((p) => p.id));
    const firstUndated = flat.findIndex((id) => undated.has(id));
    expect(flat.slice(firstUndated).every((id) => undated.has(id))).toBe(true);
  });
});
