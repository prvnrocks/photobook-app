import { describe, expect, it } from "vitest";
import { dhash, hamming, resizeGray, toGrayscale } from "@/lib/image/phash";
import { adjust, checkerboard, scene } from "./helpers/synthetic-images";

const W = 256;
const H = 192;
const hashOf = (rgba: Uint8ClampedArray, w = W, h = H) => dhash(toGrayscale(rgba, w, h), w, h);

describe("toGrayscale", () => {
  it("uses Rec.601 luma and composites transparency over white", () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 10, 20, 30, 255]);
    const g = toGrayscale(px, 3, 1);
    expect(g[0]).toBeCloseTo(76.245, 2);
    expect(g[1]).toBe(255);
    expect(g[2]).toBeCloseTo(0.299 * 10 + 0.587 * 20 + 0.114 * 30, 3);
  });

  it("rejects short buffers", () => {
    expect(() => toGrayscale(new Uint8ClampedArray(4), 2, 1)).toThrow(RangeError);
  });
});

describe("resizeGray", () => {
  it("area-averages exact 2x2 blocks", () => {
    const g = Float32Array.from([0, 10, 20, 30, 40, 50, 60, 70]); // 4x2
    expect(Array.from(resizeGray(g, 4, 2, 2, 1))).toEqual([25, 45]);
  });

  it("preserves the mean for non-integer ratios", () => {
    const g = checkerboard(37, 23, 3);
    const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
    const r = resizeGray(g, 37, 23, 9, 8);
    expect(r.length).toBe(72);
    // Each output pixel is a weighted mean, so values stay within the source range.
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...r)).toBeLessThanOrEqual(255);
    expect(Math.abs(mean(resizeGray(g, 37, 23, 37, 23)) - mean(g))).toBeLessThan(1e-3);
  });
});

describe("dhash", () => {
  it("is 16 hex chars and deterministic", () => {
    const img = scene(1);
    const a = hashOf(img);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf(new Uint8ClampedArray(img))).toBe(a);
  });

  it("is stable under brightening and mild noise (<= 10 bits)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const img = scene(seed);
      const base = hashOf(img);
      expect(hamming(base, hashOf(adjust(img, 25, 0)))).toBeLessThanOrEqual(10);
      expect(hamming(base, hashOf(adjust(img, 0, 8, seed)))).toBeLessThanOrEqual(10);
      expect(hamming(base, hashOf(adjust(img, -15, 6, seed + 100)))).toBeLessThanOrEqual(10);
    }
  });

  it("is stable across sizes (same scene rendered at 512 vs 256 wide)", () => {
    // Downscale a 512x384 render to 256x192 by area averaging via the grayscale path.
    const big = scene(9, 512, 384);
    const small = scene(9, 256, 192);
    expect(hamming(hashOf(big, 512, 384), hashOf(small))).toBeLessThanOrEqual(6);
  });

  it("separates different images (> 20 bits)", () => {
    // Unrelated photos average ~32 bits apart; a few chance pairs land lower, so check the
    // distribution over 20 random scenes plus clear-cut pairs.
    const hashes = Array.from({ length: 20 }, (_, i) => hashOf(scene(100 + i)));
    const d: number[] = [];
    for (let i = 0; i < hashes.length; i++)
      for (let j = i + 1; j < hashes.length; j++) d.push(hamming(hashes[i], hashes[j]));
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    expect(mean).toBeGreaterThan(26);
    expect(d.filter((x) => x > 20).length / d.length).toBeGreaterThan(0.9);
    expect(Math.min(...d)).toBeGreaterThan(10);

    const img = scene(3);
    const mirrored = new Uint8ClampedArray(img.length);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        mirrored.set(img.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * W + (W - 1 - x)) * 4);
    expect(hamming(hashOf(img), hashOf(mirrored))).toBeGreaterThan(20);

    const board = checkerboard(W, H, 21);
    expect(hamming(hashOf(img), dhash(board, W, H))).toBeGreaterThan(20);
  });
});

describe("hamming", () => {
  it("counts differing bits", () => {
    expect(hamming("0000000000000000", "0000000000000000")).toBe(0);
    expect(hamming("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(hamming("0f00000000000001", "0000000000000000")).toBe(5);
  });

  it("rejects mismatched or non-hex input", () => {
    expect(() => hamming("00", "000")).toThrow(RangeError);
    expect(() => hamming("zz", "00")).toThrow(RangeError);
  });
});
