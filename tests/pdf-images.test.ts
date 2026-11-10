import { readFileSync } from "node:fs";
import { join } from "node:path";
import exifr from "exifr";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const download = vi.fn<(path: string) => Promise<{ data: Blob | null; error: unknown }>>();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ download: (p: string) => download(p) }) } }),
}));

import { PRINT_IMAGE_IN_FLIGHT } from "@/lib/pdf/prefetch";
import {
  createPrintImageLoader,
  encodePrintImage,
  loadPrintImage,
  PRINT_JPEG_OPTIONS,
  PrintImageError,
} from "@/lib/pdf/images";

// 400×300 stored pixels, EXIF Orientation 6 (→ displays 300×400) + FAKE GPS (tests/fixtures/README.md).
const ORIENT6 = readFileSync(join(process.cwd(), "tests", "fixtures", "photo-orient6.jpg"));
const blob = (b: Buffer) => new Blob([new Uint8Array(b)], { type: "image/jpeg" });
const u8 = (b: Buffer) => new Uint8Array(b);

beforeEach(() => {
  download.mockReset();
});

async function expectNoExif(out: Buffer) {
  const all = await exifr.parse(u8(out), { gps: true, tiff: true, exif: true, xmp: true, icc: false });
  expect(all?.latitude).toBeUndefined();
  expect(all?.GPSLatitude).toBeUndefined();
  expect(all?.Orientation).toBeUndefined();
  expect(await exifr.gps(u8(out)).catch(() => undefined)).toBeUndefined();
  const meta = await sharp(out).metadata();
  expect(meta.exif).toBeUndefined();
  expect(meta.xmp).toBeUndefined();
  expect(meta.orientation ?? 1).toBe(1);
}

describe("fixture sanity", () => {
  it("the input really carries GPS and orientation 6", async () => {
    const gps = await exifr.gps(u8(ORIENT6));
    expect(gps?.latitude).toBeCloseTo(24.47, 1);
    expect((await sharp(ORIENT6).metadata()).orientation).toBe(6);
  });
});

describe("encodePrintImage / loadPrintImage", () => {
  it("rotates upright, strips EXIF/GPS, resizes to the target", async () => {
    download.mockResolvedValue({ data: blob(ORIENT6), error: null });
    const out = await loadPrintImage({ id: "p", original_path: "u/b/p-original.jpg" }, { width: 150, height: 200 });
    expect(download).toHaveBeenCalledWith("u/b/p-original.jpg");
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([150, 200]); // portrait after rotation
    expect(meta.space).toBe("srgb");
    await expectNoExif(out);
  });

  it("orientation applied: the stored top edge (red band) ends up on the right", async () => {
    const out = await encodePrintImage(ORIENT6, { width: 300, height: 400 });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect([info.width, info.height]).toEqual([300, 400]);
    // Orientation 6 = rotate 90° clockwise to display: stored top row → displayed right column.
    const right = px(info.width - 3, 200);
    const left = px(2, 200);
    expect(right[0]).toBeGreaterThan(180);
    expect(right[0] - right[1]).toBeGreaterThan(80);
    expect(left[0] - left[1]).toBeLessThan(right[0] - right[1]);
  });

  it("never enlarges beyond the original", async () => {
    const out = await encodePrintImage(ORIENT6, { width: 600, height: 800 });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });

  it("swaps a target whose orientation disagrees with the upright photo", async () => {
    const out = await encodePrintImage(ORIENT6, { width: 200, height: 150 });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([150, 200]);
  });

  it("flattens transparency on white and outputs 3-channel JPEG", async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const out = await encodePrintImage(png, { width: 40, height: 40 });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(data[0]).toBeGreaterThan(245);
  });

  it("large original with EXIF (orientation 6 + GPS) → planned size, no metadata", async () => {
    const noise = Buffer.alloc(4000 * 3000 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const big = await sharp(noise, { raw: { width: 4000, height: 3000, channels: 3 } })
      .jpeg({ quality: 92 })
      .withMetadata({ orientation: 6 })
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "24/1 28/1 12/1", GPSLongitudeRef: "E", GPSLongitude: "54/1 19/1 48/1" } })
      .toBuffer();
    expect((await exifr.gps(u8(big)))?.latitude).toBeCloseTo(24.47, 1);
    const t0 = Date.now();
    const out = await encodePrintImage(big, { width: 1913, height: 2551 });
    const ms = Date.now() - t0;
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([1913, 2551]);
    await expectNoExif(out);
    console.info(`[print-image sample] in ${big.length} B 4000x3000(o6) → out ${out.length} B ${meta.width}x${meta.height} in ${ms} ms`);
  }, 30_000);

  it("typed errors without paths", async () => {
    download.mockResolvedValue({ data: null, error: { message: "Object not found u/b/secret-original.jpg" } });
    const e1 = await loadPrintImage({ id: "p", original_path: "u/b/secret-original.jpg" }, { width: 10, height: 10 }).catch((e) => e);
    expect(e1).toBeInstanceOf(PrintImageError);
    expect(e1.code).toBe("download_failed");
    expect(e1.message).not.toContain("secret");

    download.mockRejectedValue(new Error("network u/b/secret-original.jpg"));
    const e2 = await loadPrintImage({ id: "p", original_path: "u/b/secret-original.jpg" }, { width: 10, height: 10 }).catch((e) => e);
    expect(e2.code).toBe("download_failed");
    expect(e2.message).not.toContain("secret");

    const e3 = await loadPrintImage({ id: "p", original_path: null }, { width: 10, height: 10 }).catch((e) => e);
    expect(e3.code).toBe("download_failed");

    download.mockResolvedValue({ data: blob(Buffer.from("not an image at all")), error: null });
    const e4 = await loadPrintImage({ id: "p", original_path: "u/b/secret-original.jpg" }, { width: 10, height: 10 }).catch((e) => e);
    expect(e4.code).toBe("decode_failed");
    expect(e4.message).not.toContain("secret");
  });
});

describe("createPrintImageLoader", () => {
  const plan = new Map([
    ["a", { width: 30, height: 40 }],
    ["b", { width: 30, height: 40 }],
    ["c", { width: 30, height: 40 }],
    ["d", { width: 30, height: 40 }],
  ]);
  const photos = ["a", "b", "c", "d"].map((id) => ({ id, original_path: `u/b/${id}-original.jpg` }));

  it("memoises per photo and limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    download.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { data: blob(ORIENT6), error: null };
    });
    const loader = createPrintImageLoader(plan, photos, { concurrency: 2 });
    const first = loader.get("a");
    expect(loader.get("a")).toBe(first);
    const outs = await Promise.all(["a", "b", "c", "d", "a"].map((id) => loader.get(id)));
    expect(download).toHaveBeenCalledTimes(4);
    expect(peak).toBeLessThanOrEqual(2);
    expect((await sharp(outs[0]).metadata()).width).toBe(30);
  });

  it("unknown photo → unknown_photo; failures are not cached", async () => {
    const loader = createPrintImageLoader(plan, photos);
    await expect(loader.get("zzz")).rejects.toMatchObject({ code: "unknown_photo" });
    download.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    await expect(loader.get("a")).rejects.toMatchObject({ code: "download_failed" });
    download.mockResolvedValueOnce({ data: blob(ORIENT6), error: null });
    expect((await sharp(await loader.get("a")).metadata()).height).toBe(40);
  });

  it("prefetch starts loads in call order without awaiting; get() then hits the same promise", async () => {
    const order: string[] = [];
    download.mockImplementation(async (path: string) => {
      order.push(path.split("/")[2]);
      return { data: blob(ORIENT6), error: null };
    });
    const loader = createPrintImageLoader(plan, photos, { concurrency: 1 });
    loader.prefetch(["c", "a", "zzz"]); // unknown ids are ignored (no unhandled rejection)
    const a = loader.get("a");
    expect(loader.get("a")).toBe(a);
    await Promise.all([a, loader.get("c")]);
    expect(order).toEqual(["c-original.jpg", "a-original.jpg"]);
    expect(download).toHaveBeenCalledTimes(2);
    const st = loader.stats();
    expect(st.produced).toBe(2);
    expect(st.failed).toBe(0);
    expect(st.heldBytes).toBeGreaterThan(0);
    expect(st.peakHeldBytes).toBe(st.heldBytes);
    expect(st.downloadMs).toBeGreaterThanOrEqual(0);
    expect(st.encodeMs).toBeGreaterThanOrEqual(0);
  });

  it("release forgets copies (held bytes drop, peak kept); a later get() reloads", async () => {
    download.mockResolvedValue({ data: blob(ORIENT6), error: null });
    const loader = createPrintImageLoader(plan, photos, { concurrency: 2 });
    loader.prefetch(["a", "b"]);
    await Promise.all([loader.get("a"), loader.get("b")]);
    const peak = loader.stats().peakHeldBytes;
    loader.release(["a", "unknown"]);
    const st = loader.stats();
    expect(st.heldBytes).toBeLessThan(peak);
    expect(st.heldBytes).toBeGreaterThan(0);
    expect(st.peakHeldBytes).toBe(peak);
    loader.release(["b"]);
    expect(loader.stats().heldBytes).toBe(0);
    await loader.get("a");
    expect(download).toHaveBeenCalledTimes(3);
  });

  it("releasing an in-flight copy never counts it as held", async () => {
    let resolve!: (v: { data: Blob; error: null }) => void;
    download.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const loader = createPrintImageLoader(plan, photos);
    const p = loader.get("a");
    loader.release(["a"]);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    resolve({ data: blob(ORIENT6), error: null });
    await p;
    expect(loader.stats()).toMatchObject({ produced: 1, heldBytes: 0, peakHeldBytes: 0 });
  });

  it("a failed prefetch is counted, not cached, and retried by the next get()", async () => {
    download.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    download.mockResolvedValueOnce({ data: blob(ORIENT6), error: null });
    const loader = createPrintImageLoader(plan, photos);
    loader.prefetch(["a"]);
    await vi.waitFor(() => expect(loader.stats().failed).toBe(1));
    expect((await sharp(await loader.get("a")).metadata()).width).toBe(30);
    expect(loader.stats()).toMatchObject({ produced: 1, failed: 1 });
  });

  it("default: up to PRINT_IMAGE_IN_FLIGHT downloads at once", async () => {
    let active = 0;
    let peak = 0;
    download.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { data: blob(ORIENT6), error: null };
    });
    const many = new Map(Array.from({ length: 16 }, (_, i) => [`x${i}`, { width: 30, height: 40 }]));
    const loader = createPrintImageLoader(many, [...many.keys()].map((id) => ({ id, original_path: `u/b/${id}-original.jpg` })));
    loader.prefetch(many.keys());
    await Promise.all([...many.keys()].map((id) => loader.get(id)));
    expect(peak).toBe(PRINT_IMAGE_IN_FLIGHT);
  });

  it("encodes are limited separately from downloads", async () => {
    download.mockResolvedValue({ data: blob(ORIENT6), error: null });
    const many = new Map(Array.from({ length: 6 }, (_, i) => [`y${i}`, { width: 30, height: 40 }]));
    const loader = createPrintImageLoader(many, [...many.keys()].map((id) => ({ id, original_path: `u/b/${id}-original.jpg` })), {
      concurrency: 6,
      encodeConcurrency: 1,
    });
    const outs = await Promise.all([...many.keys()].map((id) => loader.get(id)));
    expect(outs).toHaveLength(6);
    expect(loader.stats().produced).toBe(6);
  });
});

describe("encoder settings", () => {
  it("baseline JPEG, quant table 3, q80, 4:2:0 — no mozjpeg trellis/progressive", async () => {
    expect(PRINT_JPEG_OPTIONS).toMatchObject({
      quality: 80,
      mozjpeg: false,
      quantisationTable: 3,
      progressive: false,
      trellisQuantisation: false,
      chromaSubsampling: "4:2:0",
    });
    const out = await encodePrintImage(ORIENT6, { width: 300, height: 400 });
    const meta = await sharp(out).metadata();
    expect(meta.isProgressive).toBe(false);
    expect(meta.chromaSubsampling).toBe("4:2:0");
  });

  it("quality stays at least that of mozjpeg q82 on a photo-like image (PSNR vs the resized source)", async () => {
    const w = 1200;
    const h = 900;
    const raw = Buffer.alloc(w * h * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const n = (rnd() - 0.5) * 10;
        raw[i] = (x / w) * 200 + n;
        raw[i + 1] = (y / h) * 180 + n;
        raw[i + 2] = 120 + 60 * Math.sin(x / 40) * Math.cos(y / 55) + n;
      }
    }
    const input = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).blur(1.2).jpeg({ quality: 92 }).toBuffer();
    const target = { width: 800, height: 600 };
    const ref = await sharp(input).resize(target).raw().toBuffer();
    const psnr = async (jpeg: Buffer) => {
      const px = await sharp(jpeg).raw().toBuffer();
      let se = 0;
      for (let i = 0; i < px.length; i++) se += (px[i] - ref[i]) ** 2;
      return 10 * Math.log10((255 * 255) / (se / px.length));
    };
    const ours = await encodePrintImage(input, target);
    const moz = await sharp(input).resize(target).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    expect(await psnr(ours)).toBeGreaterThanOrEqual((await psnr(moz)) - 0.05);
    // size grows by well under the 25 % budget on photo-like content
    expect(ours.length / moz.length).toBeLessThan(1.3);
  });
});
