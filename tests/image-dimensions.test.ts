import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  MAX_ORIGINAL_BYTES,
  effectiveMime,
  extForMime,
  fitWithin,
  isHeic,
  isRejectedType,
  needsReencode,
  orientationSwapsAxes,
} from "@/lib/image/dimensions";

describe("fitWithin", () => {
  it("never upscales", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1200, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it("limits the longest side (landscape and portrait)", () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 512)).toEqual({ width: 384, height: 512 });
  });

  it("limits total pixels", () => {
    const r = fitWithin(8000, 6000, 8000, MAX_CANVAS_PIXELS);
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(r.width / r.height).toBeCloseTo(8000 / 6000, 2);
  });

  it("applies both side and pixel caps (48 MP → 4096 side)", () => {
    const r = fitWithin(8064, 6048, 4096, MAX_CANVAS_PIXELS);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(4096);
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });

  it("handles a very tall panorama under the pixel cap", () => {
    const r = fitWithin(2000, 20000, 20000, MAX_CANVAS_PIXELS);
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(r.height).toBeGreaterThan(r.width);
  });

  it("keeps at least 1 px per side", () => {
    expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });

  it("throws on invalid sizes", () => {
    expect(() => fitWithin(0, 10, 100)).toThrow(RangeError);
    expect(() => fitWithin(NaN, 10, 100)).toThrow(RangeError);
    expect(() => fitWithin(10, Infinity, 100)).toThrow(RangeError);
  });
});

describe("isHeic", () => {
  it("detects by mime", () => {
    expect(isHeic({ name: "x", type: "image/heic" })).toBe(true);
    expect(isHeic({ name: "x", type: "image/heif" })).toBe(true);
    expect(isHeic({ name: "x", type: "image/heic-sequence" })).toBe(true);
  });
  it("detects by extension when mime is empty", () => {
    expect(isHeic({ name: "IMG_0001.HEIC", type: "" })).toBe(true);
    expect(isHeic({ name: "a.heif", type: "" })).toBe(true);
  });
  it("is false for other images", () => {
    expect(isHeic({ name: "a.jpg", type: "image/jpeg" })).toBe(false);
    expect(isHeic({ name: "heic.jpg", type: "" })).toBe(false);
  });
});

describe("effectiveMime / isRejectedType", () => {
  it("fills empty mimes from the extension", () => {
    expect(effectiveMime({ name: "a.JPG", type: "" })).toBe("image/jpeg");
    expect(effectiveMime({ name: "a.png", type: "" })).toBe("image/png");
    expect(effectiveMime({ name: "a", type: "" })).toBe("");
    expect(effectiveMime({ name: "a", type: "image/jpg" })).toBe("image/jpeg");
  });
  it("rejects GIF, SVG, video and non-images", () => {
    expect(isRejectedType({ name: "a.gif", type: "image/gif" })).toBe(true);
    expect(isRejectedType({ name: "a.gif", type: "" })).toBe(true);
    expect(isRejectedType({ name: "a.svg", type: "image/svg+xml" })).toBe(true);
    expect(isRejectedType({ name: "a.mov", type: "video/quicktime" })).toBe(true);
    expect(isRejectedType({ name: "a.pdf", type: "application/pdf" })).toBe(true);
  });
  it("lets photos and unknown-typed files through to the decoder", () => {
    expect(isRejectedType({ name: "a.jpg", type: "image/jpeg" })).toBe(false);
    expect(isRejectedType({ name: "a.heic", type: "" })).toBe(false);
    expect(isRejectedType({ name: "a", type: "" })).toBe(false);
    expect(isRejectedType({ name: "a", type: "application/octet-stream" })).toBe(false);
  });
});

describe("needsReencode (D-012)", () => {
  it("keeps JPEG/PNG/WebP up to 20 MB", () => {
    expect(needsReencode("image/jpeg", 5_000_000)).toBe(false);
    expect(needsReencode("image/jpg", 5_000_000)).toBe(false);
    expect(needsReencode("image/png", MAX_ORIGINAL_BYTES)).toBe(false);
    expect(needsReencode("image/webp", 1)).toBe(false);
  });
  it("re-encodes bigger files", () => {
    expect(needsReencode("image/jpeg", MAX_ORIGINAL_BYTES + 1)).toBe(true);
  });
  it("re-encodes HEIC and other types", () => {
    expect(needsReencode("image/heic", 1000)).toBe(true);
    expect(needsReencode("image/avif", 1000)).toBe(true);
    expect(needsReencode("", 1000)).toBe(true);
  });
});

describe("extForMime", () => {
  it("maps stored mimes", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/webp")).toBe("webp");
  });
  it("throws for anything else", () => {
    expect(() => extForMime("image/heic")).toThrow(RangeError);
  });
});

describe("orientationSwapsAxes", () => {
  it("is true only for 5–8", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(orientationSwapsAxes)).toEqual([false, false, false, false, true, true, true, true]);
    expect(orientationSwapsAxes(null)).toBe(false);
  });
});
