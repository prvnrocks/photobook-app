import { describe, expect, it } from "vitest";
import { clusterPoints, haversineKm, MAX_CLUSTER_SPAN_KM } from "@/lib/photos/geo-cluster";

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

  const spanKm = (pts: { lat: number; lng: number }[]) => {
    let m = 0;
    for (const a of pts) for (const b of pts) m = Math.max(m, haversineKm(a, b));
    return m;
  };

  it("splits a chain wider than MAX_CLUSTER_SPAN_KM (road trip) into ≤2 km pieces", () => {
    expect(MAX_CLUSTER_SPAN_KM).toBe(5);
    // 60 points every ~0.8 km (each linked to the next) → ~47 km single-linkage chain.
    const pts = Array.from({ length: 60 }, (_, i) => ({
      id: `p${String(i).padStart(2, "0")}`,
      lat: base.lat + i * 0.0072,
      lng: base.lng,
    }));
    const c = clusterPoints(pts);
    expect(c.length).toBeGreaterThan(9);
    const byId = new Map(pts.map((p) => [p.id, p]));
    for (const k of c) {
      expect(spanKm(k.ids.map((id) => byId.get(id)!))).toBeLessThanOrEqual(2);
    }
    // every point exactly once
    expect(c.flatMap((k) => k.ids).sort()).toEqual(pts.map((p) => p.id).sort());
    // ordered by smallest id, ids sorted inside
    const firsts = c.map((k) => k.ids[0]);
    expect([...firsts].sort()).toEqual(firsts);
    for (const k of c) expect([...k.ids].sort()).toEqual(k.ids);
  });

  it("span split is deterministic regardless of input order", () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({
      id: `q${String((i * 7) % 40).padStart(2, "0")}`,
      lat: base.lat + i * 0.006,
      lng: base.lng + (i % 3) * 0.002,
    }));
    expect(clusterPoints(pts)).toEqual(clusterPoints([...pts].reverse()));
  });

  it("keeps a dense 4 km-wide area as one cluster (under the span cap)", () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, lat: base.lat + i * 0.0018, lng: base.lng }));
    expect(spanKm(pts)).toBeLessThan(MAX_CLUSTER_SPAN_KM);
    expect(clusterPoints(pts)).toHaveLength(1);
  });

  it("500 points finish quickly", () => {
    const pts = Array.from({ length: 500 }, (_, i) => ({
      id: `z${String(i).padStart(3, "0")}`,
      lat: base.lat + (i % 50) * 0.003,
      lng: base.lng + Math.floor(i / 50) * 0.003,
    }));
    const t0 = performance.now();
    const c = clusterPoints(pts);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(c.flatMap((k) => k.ids)).toHaveLength(500);
  });
});
