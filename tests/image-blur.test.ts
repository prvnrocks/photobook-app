import { describe, expect, it } from "vitest";
import { laplacianVariance } from "@/lib/image/blur";
import { resizeGray, toGrayscale } from "@/lib/image/phash";
import { boxBlur, checkerboard, noiseGray, scene } from "./helpers/synthetic-images";

describe("laplacianVariance", () => {
  it("is 0 for flat images and tiny images", () => {
    expect(laplacianVariance(new Float32Array(64).fill(100), 8, 8)).toBe(0);
    expect(laplacianVariance(new Float32Array(4), 2, 2)).toBe(0);
  });

  it("is 0 for a linear gradient (Laplacian of a plane)", () => {
    const g = Float32Array.from({ length: 100 }, (_, i) => (i % 10) * 20);
    expect(laplacianVariance(g, 10, 10)).toBeCloseTo(0, 6);
  });

  it.each([
    ["checkerboard", checkerboard(128, 96, 4)],
    ["noise", noiseGray(128, 96, 3)],
    ["scene", toGrayscale(scene(4, 128, 96), 128, 96)],
  ])("%s: sharp > blurred, and more blur scores lower", (_name, sharp) => {
    const s = laplacianVariance(sharp, 128, 96);
    const b1 = laplacianVariance(boxBlur(sharp, 128, 96, 1), 128, 96);
    const b3 = laplacianVariance(boxBlur(sharp, 128, 96, 3), 128, 96);
    expect(s).toBeGreaterThan(b1);
    expect(b1).toBeGreaterThan(b3);
  });

  it("a blurred-then-downscaled photo still scores below the sharp one at the same size", () => {
    const sharp = noiseGray(512, 384, 5);
    const blurred = boxBlur(sharp, 512, 384, 4);
    const s = laplacianVariance(resizeGray(sharp, 512, 384, 256, 192), 256, 192);
    const b = laplacianVariance(resizeGray(blurred, 512, 384, 256, 192), 256, 192);
    expect(s).toBeGreaterThan(b * 3);
  });
});
