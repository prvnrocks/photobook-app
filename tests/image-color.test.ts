import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

import {
  dominantColor,
  isPhotoColor,
  MAX_LIGHTNESS,
  MAX_SATURATION,
  MIN_LIGHTNESS,
  mute,
  PHOTO_COLOR_RE,
} from "@/lib/image/color";
import { colorFromThumbBase64 } from "@/lib/image/color-server";

type RGB = [number, number, number];

/** RGBA image: `fill(x, y)` → colour; alpha 255 unless `alpha` given. */
function rgba(w: number, h: number, fill: (x: number, y: number) => RGB, alpha?: (x: number, y: number) => number) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const [r, g, b] = fill(x, y);
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = alpha ? alpha(x, y) : 255;
    }
  }
  return out;
}

function toRgb(px: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array((px.length / 4) * 3);
  for (let i = 0, o = 0; i < px.length; i += 4, o += 3) {
    out[o] = px[i];
    out[o + 1] = px[i + 1];
    out[o + 2] = px[i + 2];
  }
  return out;
}

function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

const SKY: RGB = [70, 130, 180]; // steel blue
const SAND: RGB = [200, 170, 120];

describe("dominantColor", () => {
  it("returns lowercase #rrggbb, the majority hue, muted", () => {
    // 70 % sky, 30 % sand
    const px = rgba(100, 100, (_x, y) => (y < 70 ? SKY : SAND));
    const hex = dominantColor(px, 100, 100)!;
    expect(hex).toMatch(PHOTO_COLOR_RE);
    const c = hsl(hex);
    expect(c.h).toBeGreaterThan(190);
    expect(c.h).toBeLessThan(225);
    expect(c.s).toBeLessThanOrEqual(MAX_SATURATION + 0.01);
  });

  it("is deterministic and the same for RGBA and RGB input", () => {
    const px = rgba(257, 191, (x, y) => [(x * 7) % 256, (y * 3) % 256, (x + y) % 256]);
    const a = dominantColor(px, 257, 191, 4);
    expect(dominantColor(px, 257, 191, 4)).toBe(a);
    expect(dominantColor(toRgb(px), 257, 191, 3)).toBe(a);
  });

  it("ignores near-white and near-black extremes (blown sky, letterbox bars)", () => {
    // 45 % white, 20 % black, 35 % sand → sand-ish
    const px = rgba(100, 100, (_x, y) => (y < 45 ? [255, 255, 255] : y < 65 ? [5, 5, 5] : SAND));
    const c = hsl(dominantColor(px, 100, 100)!);
    expect(c.h).toBeGreaterThan(25);
    expect(c.h).toBeLessThan(50);
  });

  it("an almost all-white photo (snow, a document) gets a light neutral, not null", () => {
    const px = rgba(64, 64, (x, y) => (x === 0 && y === 0 ? SKY : [250, 250, 248]));
    const hex = dominantColor(px, 64, 64)!;
    expect(hex).toMatch(PHOTO_COLOR_RE);
    const c = hsl(hex);
    expect(c.l).toBeLessThanOrEqual(MAX_LIGHTNESS + 0.01);
    expect(c.l).toBeGreaterThan(0.8);
  });

  it("an all-black photo is lifted to the minimum lightness", () => {
    const px = rgba(32, 32, () => [0, 0, 0]);
    const c = hsl(dominantColor(px, 32, 32)!);
    expect(c.l).toBeGreaterThanOrEqual(MIN_LIGHTNESS - 0.01);
  });

  it("clamps saturation of a vivid photo", () => {
    const px = rgba(40, 40, () => [255, 0, 0]);
    const c = hsl(dominantColor(px, 40, 40)!);
    expect(c.s).toBeLessThanOrEqual(MAX_SATURATION + 0.01);
    expect(c.h < 10 || c.h > 350).toBe(true);
  });

  it("skips transparent pixels; fully transparent → null", () => {
    const px = rgba(50, 50, (x) => (x < 40 ? [255, 0, 255] : SAND), (x) => (x < 40 ? 0 : 255));
    const c = hsl(dominantColor(px, 50, 50)!);
    expect(c.h).toBeGreaterThan(25);
    expect(c.h).toBeLessThan(50);
    expect(dominantColor(rgba(8, 8, () => SKY, () => 0), 8, 8)).toBeNull();
  });

  it("rejects bad dimensions / short buffers", () => {
    expect(dominantColor(new Uint8ClampedArray(16), 0, 4)).toBeNull();
    expect(dominantColor(new Uint8ClampedArray(16), 4, 4)).toBeNull();
    expect(dominantColor(new Uint8ClampedArray(16), 1.5, 2)).toBeNull();
  });

  it("mute keeps greys grey and hex check is lowercase only", () => {
    const [r, g, b] = mute([128, 128, 128]);
    expect(r).toBeCloseTo(g, 6);
    expect(g).toBeCloseTo(b, 6);
    expect(isPhotoColor("#a1b2c3")).toBe(true);
    expect(isPhotoColor("#A1B2C3")).toBe(false);
    expect(isPhotoColor("a1b2c3")).toBe(false);
  });
});

describe("colorFromThumbBase64 (server, sharp)", () => {
  it("decodes a JPEG thumb and agrees with the browser function on its pixels", async () => {
    const w = 512;
    const h = 384;
    const px = rgba(w, h, (_x, y) => (y < 260 ? SKY : SAND));
    const jpeg = await sharp(Buffer.from(toRgb(px)), { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 85 })
      .toBuffer();
    const server = await colorFromThumbBase64(jpeg.toString("base64"));
    expect(server).toMatch(PHOTO_COLOR_RE);
    // Same pure function on the decoded pixels → identical.
    const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(server).toBe(dominantColor(new Uint8Array(data), info.width, info.height, 3));
    expect(hsl(server!).h).toBeGreaterThan(190);
  });

  it("returns null for garbage, never throws", async () => {
    expect(await colorFromThumbBase64("")).toBeNull();
    expect(await colorFromThumbBase64(Buffer.from("not an image").toString("base64"))).toBeNull();
  });
});
