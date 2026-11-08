import { describe, expect, it } from "vitest";
import { groupDuplicates, hammingHex, type DupeItem } from "@/lib/photos/dupes";

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
  });
});

describe("groupDuplicates", () => {
  const t = "2026-05-01T10:00:00Z";
  const t5 = "2026-05-01T10:05:00Z";

  it("groups identical and near hashes, not different ones", () => {
    const g = groupDuplicates([
      exif("a", H0, t),
      exif("b", H0, t5),
      exif("c", flip(9), t5),
      exif("d", "ffffffffffffffff", t5),
    ]);
    expect(g.get("a")).toBe(1);
    expect(g.get("b")).toBe(1);
    expect(g.get("c")).toBe(1);
    expect(g.has("d")).toBe(false);
  });

  it("respects the exif time window", () => {
    const g = groupDuplicates([exif("a", H0, t), exif("b", H0, "2026-05-01T10:31:00Z")]);
    expect(g.size).toBe(0);
    const g2 = groupDuplicates([exif("a", H0, t), exif("b", H0, "2026-05-01T10:31:00Z")], {
      maxMinutes: 60,
    });
    expect(g2.size).toBe(2);
  });

  it("uses a stricter hash-only threshold when a date is file-based or missing", () => {
    const fileB = (phash: string): DupeItem => ({
      id: "b",
      phash,
      takenAt: "2020-01-01T00:00:00Z",
      dateSource: "file",
    });
    // 6 ≤ 10-4 → dup regardless of time difference
    expect(groupDuplicates([exif("a", H0, t), fileB(flip(6))]).size).toBe(2);
    // 7 > 6 → not a dup
    expect(groupDuplicates([exif("a", H0, t), fileB(flip(7))]).size).toBe(0);
    const missing: DupeItem = { id: "m", phash: flip(3), takenAt: null, dateSource: null };
    expect(groupDuplicates([exif("a", H0, t), missing]).get("m")).toBe(1);
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
