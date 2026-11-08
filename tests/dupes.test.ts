import { describe, expect, it } from "vitest";
import { DUPE_DEFAULTS, groupDuplicates, hammingHex, type DupeItem } from "@/lib/photos/dupes";

const H0 = "0000000000000000";
const flip = (bits: number) => {
  // set the lowest `bits` bits of a 64-bit hex hash
  let hex = "";
  let remaining = bits;
  for (let i = 15; i >= 0; i--) {
    const n = Math.min(4, Math.max(0, remaining));
    remaining -= n;
    hex = ((1 << n) - 1).toString(16) + hex;
  }
  return hex;
};

const exif = (id: string, phash: string | null, takenAt: string): DupeItem => ({
  id,
  phash,
  takenAt,
  dateSource: "exif",
});

describe("hammingHex", () => {
  it("counts differing bits", () => {
    expect(hammingHex(H0, H0)).toBe(0);
    expect(hammingHex(H0, flip(7))).toBe(7);
    expect(hammingHex("ff", "00")).toBe(8);
    expect(hammingHex("ab", "abc")).toBe(Infinity);
    expect(hammingHex("zz", "00")).toBe(Infinity);
    expect(hammingHex("", "")).toBe(Infinity);
    expect(hammingHex("FF", "ff")).toBe(0);
  });
});

describe("groupDuplicates", () => {
  const t = "2026-05-01T10:00:00Z";
  const t5 = "2026-05-01T10:05:00Z";

  it("exposes the tuned defaults (D-019)", () => {
    expect(DUPE_DEFAULTS).toEqual({ maxHamming: 6, maxMinutes: 3, maxHammingNoTime: 3 });
  });

  it("groups identical and near hashes (≤6), not same-scene shots (≥7) or different ones", () => {
    const g = groupDuplicates([
      exif("a", H0, t),
      exif("b", H0, "2026-05-01T10:00:02Z"),
      exif("c", flip(6), "2026-05-01T10:01:00Z"),
      exif("d", "ffffffffffffffff", t),
    ]);
    expect(g.get("a")).toBe(1);
    expect(g.get("b")).toBe(1);
    expect(g.get("c")).toBe(1);
    expect(g.has("d")).toBe(false);
    // hamming 7 = similar-but-different shot of the same scene → kept apart
    expect(groupDuplicates([exif("a", H0, t), exif("b", flip(7), t)]).size).toBe(0);
    // the old default (10) is still available as an option
    expect(groupDuplicates([exif("a", H0, t), exif("b", flip(9), t)], { maxHamming: 10 }).size).toBe(2);
  });

  it("respects the exif time window (3 min by default)", () => {
    expect(groupDuplicates([exif("a", H0, t), exif("b", H0, "2026-05-01T10:03:00Z")]).size).toBe(2);
    expect(groupDuplicates([exif("a", H0, t), exif("b", H0, "2026-05-01T10:03:01Z")]).size).toBe(0);
    expect(groupDuplicates([exif("a", H0, t), exif("b", H0, t5)]).size).toBe(0);
    const g2 = groupDuplicates([exif("a", H0, t), exif("b", H0, "2026-05-01T10:31:00Z")], {
      maxMinutes: 60,
    });
    expect(g2.size).toBe(2);
  });

  it("does not chain two bursts of the same scene minutes apart", () => {
    // Shape seen on real photos: two tight bursts ~6 min apart with near-equal hashes.
    const g = groupDuplicates([
      exif("a1", H0, "2026-05-01T10:00:00Z"),
      exif("a2", flip(2), "2026-05-01T10:00:01Z"),
      exif("b1", flip(4), "2026-05-01T10:06:00Z"),
      exif("b2", flip(5), "2026-05-01T10:06:13Z"),
    ]);
    expect(g.get("a1")).toBe(1);
    expect(g.get("a2")).toBe(1);
    expect(g.get("b1")).toBe(2);
    expect(g.get("b2")).toBe(2);
  });

  it("uses a stricter hash-only threshold when a date is file-based or missing", () => {
    const fileB = (phash: string): DupeItem => ({
      id: "b",
      phash,
      takenAt: "2020-01-01T00:00:00Z",
      dateSource: "file",
    });
    // ≤3 → dup regardless of time difference
    expect(groupDuplicates([exif("a", H0, t), fileB(flip(3))]).size).toBe(2);
    // 4 > 3 → not a dup
    expect(groupDuplicates([exif("a", H0, t), fileB(flip(4))]).size).toBe(0);
    expect(groupDuplicates([exif("a", H0, t), fileB(flip(4))], { maxHammingNoTime: 4 }).size).toBe(2);
    const missing: DupeItem = { id: "m", phash: flip(3), takenAt: null, dateSource: null };
    expect(groupDuplicates([exif("a", H0, t), missing]).get("m")).toBe(1);
    // an exif item whose date doesn't parse is treated as undated
    const bad: DupeItem = { id: "x", phash: flip(4), takenAt: "not a date", dateSource: "exif" };
    expect(groupDuplicates([exif("a", H0, t), bad]).size).toBe(0);
  });

  it("ignores items without a hash and singleton groups", () => {
    const g = groupDuplicates([
      exif("a", null, t),
      exif("b", null, t),
      exif("c", H0, t),
    ]);
    expect(g.size).toBe(0);
  });

  it("numbers groups stably by earliest takenAt then id", () => {
    const items = [
      exif("z1", "ffffffffffffffff", "2026-05-01T09:00:00Z"),
      exif("z2", "ffffffffffffffff", "2026-05-01T09:01:00Z"),
      exif("a1", H0, "2026-05-01T12:00:00Z"),
      exif("a2", H0, "2026-05-01T12:01:00Z"),
      exif("m1", "00000000ffffffff", "2026-05-01T12:00:00Z"),
      exif("m2", "00000000ffffffff", "2026-05-01T12:02:00Z"),
    ];
    const g = groupDuplicates(items);
    expect(g.get("z1")).toBe(1);
    expect(g.get("z2")).toBe(1);
    expect(g.get("a1")).toBe(2); // same minT as m*, "a1" < "m1"
    expect(g.get("m2")).toBe(3);
    expect(groupDuplicates([...items].reverse())).toEqual(g);
  });

  it("handles 500 items in under 500 ms", () => {
    const items: DupeItem[] = Array.from({ length: 500 }, (_, i) => ({
      id: `p${String(i).padStart(3, "0")}`,
      phash: ((i * 2654435761) >>> 0).toString(16).padStart(8, "0").repeat(2),
      takenAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      dateSource: i % 3 === 0 ? "file" : "exif",
    }));
    const start = performance.now();
    groupDuplicates(items);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
