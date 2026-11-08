import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_CANVAS_PIXELS, MAX_SOURCE_PIXELS } from "@/lib/image/dimensions";
import {
  HEADER_SCAN_BYTES,
  displaySizeFromDecode,
  readBlobHeaderSize,
  readHeaderSize,
  reducedDecodeSize,
} from "@/lib/image/header-size";

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "fixtures", name)));

// ---------- synthetic headers (no pixel data needed) ----------

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

function jpeg(width: number, height: number, opts: { sof?: number; orientation?: number; padApp?: number } = {}) {
  const parts: number[][] = [[0xff, 0xd8], [0xff, 0xe0, ...be16(16), ...str("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]];
  if (opts.orientation !== undefined) {
    // APP1 "Exif\0\0" + big-endian TIFF with a single IFD0 entry (Orientation).
    const tiff = [...str("MM"), ...be16(42), ...be32(8), ...be16(1), ...be16(0x0112), ...be16(3), ...be32(1), ...be16(opts.orientation), 0, 0, ...be32(0)];
    const payload = [...str("Exif"), 0, 0, ...tiff];
    parts.push([0xff, 0xe1, ...be16(payload.length + 2), ...payload]);
  }
  if (opts.padApp) {
    const pad = new Array<number>(opts.padApp).fill(0);
    parts.push([0xff, 0xe2, ...be16(pad.length + 2), ...pad]);
  }
  // DQT + DHT (must be skipped), then SOF.
  parts.push([0xff, 0xdb, ...be16(4), 0, 0]);
  parts.push([0xff, 0xc4, ...be16(4), 0, 0]);
  parts.push([0xff, opts.sof ?? 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  parts.push([0xff, 0xda, ...be16(12)]);
  return bytes(...parts);
}

function png(width: number, height: number, exif = false) {
  const chunk = (type: string, data: number[]) => [...be32(data.length), ...str(type), ...data, 0, 0, 0, 0];
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk("IHDR", [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
    exif ? chunk("eXIf", [1, 2, 3]) : [],
    chunk("IDAT", [0]),
  );
}

function riff(chunk: string, data: number[]) {
  const body = [...str("WEBP"), ...str(chunk), ...le32(data.length), ...data];
  return bytes(str("RIFF"), le32(body.length), body);
}
const webpVp8 = (w: number, h: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
const webpVp8l = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff("VP8L", [0x2f, ...le32(bits >>> 0), 0, 0, 0, 0, 0]);
};
const webpVp8x = (w: number, h: number, exif = false) => riff("VP8X", [exif ? 0x08 : 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);

function box(type: string, ...payload: number[][]) {
  const p = payload.flat();
  return [...be32(p.length + 8), ...str(type), ...p];
}
function heif(sizes: [number, number][], irot?: number) {
  const ispe = sizes.map(([w, h]) => box("ispe", [0, 0, 0, 0], be32(w), be32(h)));
  const props = [...ispe, ...(irot !== undefined ? [box("irot", [irot])] : [])];
  return bytes(
    box("ftyp", str("heic"), be32(0), str("mif1"), str("heic")),
    box("meta", [0, 0, 0, 0], box("hdlr", [0, 0, 0, 0], be32(0), str("pict"), new Array<number>(13).fill(0)), box("iprp", box("ipco", ...props))),
  );
}

describe("readHeaderSize — fixtures", () => {
  it("JPEG: stored size + EXIF orientation", () => {
    expect(readHeaderSize(fixture("photo-orient6.jpg"))).toEqual({ format: "jpeg", width: 400, height: 300, swapsAxes: true });
    expect(readHeaderSize(fixture("exif-gps.jpg"))).toEqual({ format: "jpeg", width: 32, height: 24, swapsAxes: true });
    expect(readHeaderSize(fixture("exif-no-offset-zero-gps.jpg"))).toEqual({ format: "jpeg", width: 32, height: 24, swapsAxes: false });
    expect(readHeaderSize(fixture("no-exif.jpg"))).toEqual({ format: "jpeg", width: 32, height: 24, swapsAxes: false });
  });

  it("PNG: IHDR (sips wrote an eXIf chunk → orientation unknown)", () => {
    expect(readHeaderSize(fixture("screenshot.png"))).toEqual({ format: "png", width: 390, height: 844, swapsAxes: null });
  });

  it("HEIC: largest ispe; irot makes the orientation unknown", () => {
    expect(readHeaderSize(fixture("photo-orient6.heic"))).toMatchObject({ format: "heif", width: 400, height: 300, swapsAxes: null });
  });

  it("reads from a Blob using only the first 256 KB", async () => {
    const big = new Uint8Array(HEADER_SCAN_BYTES * 3);
    big.set(fixture("photo-orient6.jpg"));
    expect(await readBlobHeaderSize(new Blob([big]))).toMatchObject({ width: 400, height: 300 });
    expect(await readBlobHeaderSize(new Blob([new Uint8Array(10)]))).toBeNull();
  });
});

describe("readHeaderSize — synthetic huge headers", () => {
  it("JPEG SOF0 / SOF1 / SOF2 and progressive 120 MP", () => {
    for (const sof of [0xc0, 0xc1, 0xc2]) {
      expect(readHeaderSize(jpeg(12000, 10000, { sof }))).toEqual({ format: "jpeg", width: 12000, height: 10000, swapsAxes: false });
    }
  });

  it("JPEG: skips large APP segments, reads orientation 8 / 3", () => {
    expect(readHeaderSize(jpeg(8000, 6000, { orientation: 8, padApp: 60000 }))).toMatchObject({ width: 8000, height: 6000, swapsAxes: true });
    expect(readHeaderSize(jpeg(8000, 6000, { orientation: 3 }))).toMatchObject({ swapsAxes: false });
  });

  it("JPEG: SOF beyond the scanned bytes / truncated → null", () => {
    const j = jpeg(8000, 6000, { padApp: 60000 });
    expect(readHeaderSize(j.subarray(0, 1000))).toBeNull();
  });

  it("PNG 20000×10000, eXIf → orientation unknown", () => {
    expect(readHeaderSize(png(20000, 10000))).toEqual({ format: "png", width: 20000, height: 10000, swapsAxes: false });
    expect(readHeaderSize(png(20000, 10000, true))).toMatchObject({ swapsAxes: null });
  });

  it("WebP VP8 / VP8L / VP8X", () => {
    expect(readHeaderSize(webpVp8(16383, 16383))).toEqual({ format: "webp", width: 16383, height: 16383, swapsAxes: false });
    expect(readHeaderSize(webpVp8l(10000, 9000))).toEqual({ format: "webp", width: 10000, height: 9000, swapsAxes: false });
    expect(readHeaderSize(webpVp8x(16000, 12000))).toEqual({ format: "webp", width: 16000, height: 12000, swapsAxes: false });
    expect(readHeaderSize(webpVp8x(16000, 12000, true))).toMatchObject({ swapsAxes: null });
  });

  it("HEIF: picks the primary (largest) ispe among tiles / thumbnails", () => {
    const h = heif([[512, 512], [16000, 12000], [320, 240]]);
    expect(readHeaderSize(h)).toEqual({ format: "heif", width: 16000, height: 12000, swapsAxes: false });
    expect(readHeaderSize(heif([[8064, 6048]], 1))).toMatchObject({ width: 8064, height: 6048, swapsAxes: null });
    expect(readHeaderSize(heif([[8064, 6048]], 2))).toMatchObject({ swapsAxes: false });
  });

  it("unknown / garbage → null, never throws", () => {
    expect(readHeaderSize(new Uint8Array(0))).toBeNull();
    expect(readHeaderSize(bytes(str("GIF89a"), [1, 0, 1, 0]))).toBeNull();
    expect(readHeaderSize(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 1]))).toBeNull();
    expect(readHeaderSize(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBeNull();
    const rnd = new Uint8Array(4096).map((_, i) => (i * 7919) & 0xff);
    expect(() => readHeaderSize(rnd)).not.toThrow();
  });

  it("> 100 MP is detectable from the header alone", () => {
    const h = readHeaderSize(jpeg(12000, 10000))!;
    expect(h.width * h.height).toBeGreaterThan(MAX_SOURCE_PIXELS);
  });
});

describe("reducedDecodeSize", () => {
  it("null when it already fits", () => {
    expect(reducedDecodeSize({ width: 4032, height: 3024, swapsAxes: false }, MAX_CANVAS_PIXELS)).toBeNull();
  });

  it("known orientation: both dims, ≤ budget, aspect kept, as large as possible", () => {
    const r = reducedDecodeSize({ width: 8064, height: 6048, swapsAxes: false }, MAX_CANVAS_PIXELS)!;
    expect(r.resizeHeight).toBeDefined();
    expect(r.resizeWidth * r.resizeHeight!).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(r.resizeWidth * r.resizeHeight!).toBeGreaterThan(MAX_CANVAS_PIXELS * 0.99);
    expect(r.resizeWidth / r.resizeHeight!).toBeCloseTo(8064 / 6048, 2);
  });

  it("rotated / unknown: width only (short side), fits the budget whichever axis the browser uses", () => {
    for (const swapsAxes of [true, null]) {
      const r = reducedDecodeSize({ width: 8064, height: 6048, swapsAxes }, MAX_CANVAS_PIXELS)!;
      expect(r.resizeHeight).toBeUndefined();
      for (const [w, h] of [[8064, 6048], [6048, 8064]]) {
        const outH = Math.ceil((h * r.resizeWidth) / w); // browsers round up
        expect(r.resizeWidth * outH).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
      }
    }
  });
});

describe("displaySizeFromDecode", () => {
  it("swaps the stored size when the decode came out rotated", () => {
    expect(displaySizeFromDecode({ width: 8064, height: 6048 }, { width: 3464, height: 4618 })).toEqual({ width: 6048, height: 8064 });
    expect(displaySizeFromDecode({ width: 8064, height: 6048 }, { width: 4618, height: 3464 })).toEqual({ width: 8064, height: 6048 });
  });
});
