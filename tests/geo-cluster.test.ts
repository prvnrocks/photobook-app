import { describe, expect, it } from "vitest";
import { clusterPoints, haversineKm } from "@/lib/photos/geo-cluster";

describe("haversineKm", () => {
  it("computes known distances", () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
    // Abu Dhabi → Dubai ≈ 125 km
    const d = haversineKm({ lat: 24.4539, lng: 54.3773 }, { lat: 25.2048, lng: 55.2708 });
    expect(d).toBeGreaterThan(115);
    expect(d).toBeLessThan(135);
  });
});

describe("clusterPoints", () => {
  // ~0.0036° lat ≈ 400 m
  const base = { lat: 24.4539, lng: 54.3773 };

  it("returns [] for empty input", () => {
    expect(clusterPoints([])).toEqual([]);
  });

  it("puts 3 points within 800 m into one cluster", () => {
    const c = clusterPoints([
      { id: "c", ...base },
      { id: "a", lat: base.lat + 0.0036, lng: base.lng },
      { id: "b", lat: base.lat, lng: base.lng + 0.0036 },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].ids).toEqual(["a", "b", "c"]);
    expect(c[0].centroid.lat).toBeCloseTo(base.lat + 0.0012, 6);
  });

  it("splits points more than 2 km apart", () => {
    const c = clusterPoints([
      { id: "x", ...base },
      { id: "y", lat: base.lat + 0.02, lng: base.lng }, // ~2.2 km
    ]);
    expect(c.map((k) => k.ids)).toEqual([["x"], ["y"]]);
  });

  it("chains points via single linkage", () => {
    // each step ~0.8 km, ends ~3.2 km apart
    const pts = [0, 1, 2, 3, 4].map((i) => ({ id: `p${i}`, lat: base.lat + i * 0.0072, lng: base.lng }));
    expect(haversineKm(pts[0], pts[4])).toBeGreaterThan(3);
    const c = clusterPoints(pts);
    expect(c).toHaveLength(1);
    expect(c[0].ids).toHaveLength(5);
  });

  it("is deterministic regardless of input order and skips invalid coords", () => {
    const pts = [
      { id: "b", ...base },
      { id: "a", lat: 48.8566, lng: 2.3522 },
      { id: "bad", lat: Number.NaN, lng: 0 },
      { id: "c", lat: base.lat + 0.001, lng: base.lng },
    ];
    const c1 = clusterPoints(pts);
    const c2 = clusterPoints([...pts].reverse());
    expect(c1).toEqual(c2);
    expect(c1.map((k) => k.ids)).toEqual([["a"], ["b", "c"]]);
  });
});
