import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { HEADER_SCAN_BYTES } from "@/lib/image/header-size";
import { stripJpegMetadata } from "@/lib/image/jpeg-strip";
import { AI_COPY_MAX_BYTES, checkOriginal, prepareAiCopy } from "@/lib/photos/ingest-verify";
import type { IngestOutcome, IngestPhotoRow, IngestStateRow } from "@/lib/db/photo-ingest";
import { INGEST_MAX_PER_RUN, ingestBookPhotos, type IngestDb } from "@/lib/photos/ingest";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const image = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 120, b: 90 } } });

let cleanThumb: Uint8Array; // 512×384 JPEG, no metadata
let exifThumb: Uint8Array; // same pixels + EXIF (GPS, camera) + ICC
let bigJpeg: Uint8Array; // 1200×900 "original"
let rotatedJpeg: Uint8Array; // stored 1200×900 with EXIF orientation 6 → displays 900×1200
let png: Uint8Array;
let webp: Uint8Array;
let gif: Uint8Array;

beforeAll(async () => {
  cleanThumb = u8(await image(512, 384).jpeg({ quality: 80 }).toBuffer());
  exifThumb = u8(
    await image(512, 384)
      .jpeg({ quality: 80 })
      .withIccProfile("srgb")
      .withExif({
        IFD0: { Make: "TestCam", Model: "Secret Model", ImageDescription: "private note" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "24/1 28/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "54/1 22/1 0/1" },
      })
      .toBuffer(),
  );
  bigJpeg = u8(await image(1200, 900).jpeg().toBuffer());
  rotatedJpeg = u8(await image(1200, 900).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  png = u8(await image(800, 600).png().toBuffer());
  webp = u8(await image(800, 600).webp().toBuffer());
  gif = u8(await image(300, 300).gif().toBuffer());
});

const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text, "latin1"));

describe("stripJpegMetadata", () => {
  it("returns the same bytes for an already clean JPEG and reads its size", () => {
    const r = stripJpegMetadata(cleanThumb)!;
    expect(r.removed).toBe(0);
    expect(r.bytes).toBe(cleanThumb);
    expect([r.width, r.height]).toEqual([512, 384]);
  });

  it("removes EXIF (GPS, camera, description) but keeps the ICC profile and the exact pixels", async () => {
    expect(has(exifThumb, "Exif\0\0")).toBe(true);
    expect(has(exifThumb, "Secret Model")).toBe(true);
    const r = stripJpegMetadata(exifThumb)!;
    expect(r.removed).toBeGreaterThan(0);
    expect(r.bytes.length).toBeLessThan(exifThumb.length);
    for (const leak of ["Exif\0\0", "Secret Model", "TestCam", "private note"]) expect(has(r.bytes, leak), leak).toBe(false);
    const meta = await sharp(r.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeDefined();
    expect([meta.width, meta.height]).toEqual([512, 384]);
    const [a, b] = await Promise.all([sharp(exifThumb).raw().toBuffer(), sharp(r.bytes).raw().toBuffer()]);
    expect(b.equals(a)).toBe(true);
  });

  it("is idempotent", () => {
    const once = stripJpegMetadata(exifThumb)!;
    const twice = stripJpegMetadata(once.bytes)!;
    expect(twice.removed).toBe(0);
    expect(twice.bytes).toBe(once.bytes);
  });

  it("removes comments, XMP and data appended after the image", () => {
    const seg = (marker: number, payload: string) => {
      const p = Buffer.from(payload, "latin1");
      return Buffer.concat([Buffer.from([0xff, marker, (p.length + 2) >> 8, (p.length + 2) & 0xff]), p]);
    };
    const src = Buffer.from(cleanThumb);
    const dirty = Buffer.concat([
      src.subarray(0, 2),
      seg(0xfe, "taken at home, 24.4667N 54.3667E"),
      seg(0xe1, "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>creator=Someone</x:xmpmeta>"),
      seg(0xed, "Photoshop 3.0\0IPTC-caption"),
      src.subarray(2),
      Buffer.from("TRAILING-SECRET-BLOB"),
    ]);
    const r = stripJpegMetadata(u8(dirty))!;
    expect(r.removed).toBe(4);
    expect(Buffer.from(r.bytes).equals(src)).toBe(true);
  });

  it("returns null for anything that is not a complete JPEG (never throws)", () => {
    expect(stripJpegMetadata(new Uint8Array())).toBeNull();
    expect(stripJpegMetadata(png)).toBeNull();
    expect(stripJpegMetadata(webp)).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // no image data
    expect(stripJpegMetadata(cleanThumb.subarray(0, 200))).toBeNull(); // truncated before the scan
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3]))).toBeNull(); // segment longer than the file
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0, 0]))).toBeNull(); // length < 2
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(stripJpegMetadata(html)).toBeNull();
    const noEoi = cleanThumb.slice(0, cleanThumb.length - 2);
    expect(stripJpegMetadata(noEoi)).toBeNull();
  });
});

describe("prepareAiCopy", () => {
  it("accepts a clean 512 px JPEG unchanged and strips a dirty one", () => {
    const clean = prepareAiCopy(cleanThumb);
    expect(clean).toMatchObject({ ok: true, sanitized: false, width: 512, height: 384 });
    const dirty = prepareAiCopy(exifThumb);
    expect(dirty).toMatchObject({ ok: true, sanitized: true });
    expect(dirty.ok && has(dirty.bytes, "Secret Model")).toBe(false);
  });

  it("rejects missing, oversized, non-JPEG and too-large-in-pixels copies", async () => {
    expect(prepareAiCopy(null)).toEqual({ ok: false, reason: "ai_copy_missing" });
    expect(prepareAiCopy(new Uint8Array())).toEqual({ ok: false, reason: "ai_copy_missing" });
    expect(prepareAiCopy(new Uint8Array(AI_COPY_MAX_BYTES + 1))).toEqual({ ok: false, reason: "ai_copy_too_large" });
    expect(prepareAiCopy(png)).toEqual({ ok: false, reason: "ai_copy_not_jpeg" });
    expect(prepareAiCopy(webp)).toEqual({ ok: false, reason: "ai_copy_not_jpeg" });
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("<svg onload=alert(1)>")]);
    expect(prepareAiCopy(fakeJpeg)).toEqual({ ok: false, reason: "ai_copy_not_jpeg" });
    expect(prepareAiCopy(bigJpeg)).toEqual({ ok: false, reason: "ai_copy_bad_dimensions" }); // an original posing as the thumb
    const edge = u8(await image(513, 100).jpeg().toBuffer());
    expect(prepareAiCopy(edge)).toEqual({ ok: false, reason: "ai_copy_bad_dimensions" });
  });
});

describe("checkOriginal", () => {
  const claim = (bytes: Uint8Array, mime: string, width: number, height: number) => ({ mime, bytes: bytes.length, width, height });
  const head = (b: Uint8Array) => b.subarray(0, HEADER_SCAN_BYTES);

  it("accepts JPEG, PNG and WebP whose bytes match the row", () => {
    expect(checkOriginal(head(bigJpeg), bigJpeg.length, claim(bigJpeg, "image/jpeg", 1200, 900))).toMatchObject({ ok: true, format: "jpeg", storedWidth: 1200, storedHeight: 900 });
    expect(checkOriginal(head(png), png.length, claim(png, "image/png", 800, 600))).toMatchObject({ ok: true, format: "png" });
    expect(checkOriginal(head(webp), webp.length, claim(webp, "image/webp", 800, 600))).toMatchObject({ ok: true, format: "webp" });
  });

  it("accepts the swapped display size only when EXIF really rotates the photo", () => {
    expect(checkOriginal(head(rotatedJpeg), rotatedJpeg.length, claim(rotatedJpeg, "image/jpeg", 900, 1200))).toMatchObject({ ok: true });
    expect(checkOriginal(head(bigJpeg), bigJpeg.length, claim(bigJpeg, "image/jpeg", 900, 1200))).toEqual({ ok: false, reason: "original_dimension_mismatch" });
  });

  it("rejects a file whose content is not the claimed type (extension / mime spoofing)", () => {
    expect(checkOriginal(head(png), png.length, claim(png, "image/jpeg", 800, 600))).toEqual({ ok: false, reason: "original_type_mismatch" });
    expect(checkOriginal(head(gif), gif.length, claim(gif, "image/jpeg", 300, 300))).toEqual({ ok: false, reason: "original_not_image" });
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>".repeat(20));
    expect(checkOriginal(html, html.length, claim(html, "image/jpeg", 800, 600))).toEqual({ ok: false, reason: "original_not_image" });
    const heic = new Uint8Array(64);
    heic.set(new TextEncoder().encode("ftypheic"), 4);
    expect(checkOriginal(heic, heic.length, { mime: "image/jpeg", bytes: 64, width: 800, height: 600 })).toEqual({ ok: false, reason: "original_not_image" });
  });

  it("rejects wrong size, wrong dimensions, missing and oversized objects", async () => {
    expect(checkOriginal(head(bigJpeg), bigJpeg.length, { ...claim(bigJpeg, "image/jpeg", 1200, 900), bytes: bigJpeg.length + 1 })).toEqual({ ok: false, reason: "original_size_mismatch" });
    expect(checkOriginal(head(bigJpeg), bigJpeg.length, claim(bigJpeg, "image/jpeg", 4000, 3000))).toEqual({ ok: false, reason: "original_dimension_mismatch" });
    expect(checkOriginal(head(bigJpeg), bigJpeg.length, { mime: "image/jpeg", bytes: null, width: null, height: null })).toEqual({ ok: false, reason: "original_size_mismatch" });
    expect(checkOriginal(new Uint8Array(), 0, claim(bigJpeg, "image/jpeg", 1200, 900))).toEqual({ ok: false, reason: "original_missing" });
    expect(checkOriginal(head(bigJpeg), 21 * 1024 * 1024, claim(bigJpeg, "image/jpeg", 1200, 900))).toEqual({ ok: false, reason: "original_too_large" });
    const tiny = u8(await image(150, 150).jpeg().toBuffer());
    expect(checkOriginal(tiny, tiny.length, claim(tiny, "image/jpeg", 150, 150))).toEqual({ ok: false, reason: "original_bad_dimensions" });
  });
});

describe("ingestBookPhotos", () => {
  type Saved = { key: { photoId: string; bookId: string; userId: string; fingerprint: string; attempts: number }; outcome: IngestOutcome };

  function world(over: Partial<{ photos: IngestPhotoRow[]; states: IngestStateRow[] | null; objects: Map<string, Uint8Array> }> = {}) {
    const row = (n: number, o: Partial<IngestPhotoRow> = {}): IngestPhotoRow => ({
      id: pid(n),
      fingerprint: `s1:${"0".repeat(60)}${String(n).padStart(4, "0")}`,
      original_path: `${USER}/${BOOK}/${pid(n)}-original.jpg`,
      thumb_path: `${USER}/${BOOK}/${pid(n)}-thumb.jpg`,
      original_mime: "image/jpeg",
      original_bytes: bigJpeg.length,
      width: 1200,
      height: 900,
      ...o,
    });
    const photos = over.photos ?? [row(1), row(2)];
    const objects = over.objects ?? new Map<string, Uint8Array>();
    if (!over.objects) for (const p of photos) {
      if (p.original_path) objects.set(p.original_path, bigJpeg);
      if (p.thumb_path) objects.set(p.thumb_path, cleanThumb);
    }
    const saved: Saved[] = [];
    const states: IngestStateRow[] | null = over.states === undefined ? [] : over.states;
    const calls = { head: [] as string[], download: [] as string[], replace: [] as string[] };
    const db: IngestDb = {
      listPhotos: async () => photos,
      listStates: async () => states,
      readOriginalHead: async (path) => {
        calls.head.push(path);
        const b = objects.get(path);
        return b ? { head: b.subarray(0, HEADER_SCAN_BYTES), totalBytes: b.length } : null;
      },
      downloadAiCopy: async (path) => {
        calls.download.push(path);
        const b = objects.get(path);
        if (!b) return null;
        return b.length > AI_COPY_MAX_BYTES ? "too_large" : b;
      },
      replaceAiCopy: async (path, bytes) => {
        calls.replace.push(path);
        objects.set(path, bytes);
      },
      save: async (key, outcome) => {
        saved.push({ key, outcome });
        const i = states!.findIndex((s) => s.photo_id === key.photoId);
        const next = { photo_id: key.photoId, state: outcome.state, fingerprint: key.fingerprint, attempts: key.attempts };
        if (i === -1) states!.push(next);
        else states![i] = next;
      },
    };
    return { db, photos, objects, saved, calls, row };
  }

  it("verifies clean uploads, records the AI copy hash, and never rewrites anything", async () => {
    const w = world();
    const r = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r).toEqual({ photos: 2, verified: 2, rejected: 0, skipped: 0, pending: 0, sanitized: 0, available: true });
    expect(w.calls.replace).toEqual([]);
    expect(w.saved[0]!.outcome).toEqual({
      state: "verified",
      originalFormat: "jpeg",
      originalBytes: bigJpeg.length,
      aiCopySha256: createHash("sha256").update(cleanThumb).digest("hex"),
      aiCopyBytes: cleanThumb.length,
      aiCopySanitized: false,
    });
    expect(w.saved[0]!.key).toMatchObject({ bookId: BOOK, userId: USER, attempts: 1 });
  });

  it("is idempotent: a second run downloads nothing and writes nothing", async () => {
    const w = world();
    await ingestBookPhotos(BOOK, USER, { db: w.db });
    const before = { head: w.calls.head.length, download: w.calls.download.length, saved: w.saved.length };
    const r = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r).toMatchObject({ verified: 0, rejected: 0, skipped: 2, pending: 0 });
    expect({ head: w.calls.head.length, download: w.calls.download.length, saved: w.saved.length }).toEqual(before);
  });

  it("re-checks a photo whose fingerprint changed (a different file under the same row)", async () => {
    const w = world();
    await ingestBookPhotos(BOOK, USER, { db: w.db });
    w.photos[0] = { ...w.photos[0]!, fingerprint: `s1:${"f".repeat(64)}` };
    const r = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r).toMatchObject({ verified: 1, skipped: 1 });
    expect(w.saved.at(-1)!.key.attempts).toBe(2);
  });

  it("strips metadata from a dirty AI copy, stores the clean copy, and leaves the original bytes untouched", async () => {
    const w = world();
    const thumb = w.photos[0]!.thumb_path!;
    const original = w.photos[0]!.original_path!;
    w.objects.set(thumb, exifThumb);
    const r = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r).toMatchObject({ verified: 2, sanitized: 1 });
    expect(w.calls.replace).toEqual([thumb]);
    expect(has(w.objects.get(thumb)!, "Secret Model")).toBe(false);
    expect(w.objects.get(original)).toBe(bigJpeg);
    expect(w.calls.replace.some((p) => p.includes("-original."))).toBe(false);
    const first = w.saved.find((s) => s.key.photoId === pid(1))!.outcome;
    expect(first).toMatchObject({ state: "verified", aiCopySanitized: true });
  });

  it("rejects spoofed and broken uploads with a reason code and keeps going", async () => {
    const w = world();
    const three = [w.row(1), w.row(2), w.row(3), w.row(4)];
    const objects = new Map<string, Uint8Array>();
    objects.set(three[0]!.original_path!, png); // PNG bytes claimed as JPEG
    objects.set(three[0]!.thumb_path!, cleanThumb);
    objects.set(three[1]!.original_path!, bigJpeg);
    objects.set(three[1]!.thumb_path!, png); // AI copy is not a JPEG
    objects.set(three[2]!.thumb_path!, cleanThumb); // original missing
    objects.set(three[3]!.original_path!, bigJpeg);
    objects.set(three[3]!.thumb_path!, cleanThumb);
    const w2 = world({ photos: three, objects });
    const r = await ingestBookPhotos(BOOK, USER, { db: w2.db });
    expect(r).toMatchObject({ verified: 1, rejected: 3, pending: 0 });
    const reasons = Object.fromEntries(w2.saved.map((s) => [s.key.photoId, s.outcome.state === "rejected" ? s.outcome.reason : "ok"]));
    expect(reasons).toEqual({ [pid(1)]: "original_type_mismatch", [pid(2)]: "ai_copy_not_jpeg", [pid(3)]: "original_missing", [pid(4)]: "ok" });
  });

  it("never reads a path outside the caller's own {user}/{book}/{photo} prefix", async () => {
    const w = world();
    const evil = [
      w.row(1, { original_path: `${OTHER}/${BOOK}/${pid(1)}-original.jpg` }),
      w.row(2, { thumb_path: `${USER}/${BOOK}/${pid(9)}-thumb.jpg` }),
      w.row(3, { original_path: `${USER}/${BOOK}/${pid(3)}-original.jpg/../../${OTHER}/x.jpg` }),
      w.row(4, { original_path: null }),
    ];
    const w2 = world({ photos: evil, objects: new Map() });
    const r = await ingestBookPhotos(BOOK, USER, { db: w2.db });
    expect(r.rejected).toBe(4);
    expect(w2.calls.head).toEqual([]);
    expect(w2.calls.download).toEqual([]);
  });

  it("a transient failure writes no row, so the next run retries; other photos are unaffected", async () => {
    const w = world();
    let fail = true;
    const realHead = w.db.readOriginalHead;
    w.db.readOriginalHead = async (path) => {
      if (fail && path.includes(pid(1))) throw new Error("SUPABASE_TIMEOUT");
      return realHead(path);
    };
    const r1 = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r1).toMatchObject({ verified: 1, rejected: 0, pending: 1 });
    expect(w.saved.map((s) => s.key.photoId)).toEqual([pid(2)]);
    fail = false;
    const r2 = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r2).toMatchObject({ verified: 1, skipped: 1, pending: 0 });
  });

  it("is bounded per run and by the time budget; the rest stays pending", async () => {
    const many = Array.from({ length: INGEST_MAX_PER_RUN + 5 }, (_, i) => world().row(i + 1));
    const w = world({ photos: many });
    const r = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r).toMatchObject({ verified: INGEST_MAX_PER_RUN, pending: 5 });

    const w2 = world();
    let t = 0;
    const r2 = await ingestBookPhotos(BOOK, USER, { db: w2.db, now: () => (t += 10_000), budgetMs: 5_000 });
    expect(r2).toMatchObject({ verified: 0, pending: 2 });
    expect(w2.saved).toEqual([]);
  });

  it("does nothing while migration 2300 is missing (uploads keep working)", async () => {
    const w = world({ states: null });
    const r = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r).toEqual({ photos: 2, verified: 0, rejected: 0, skipped: 0, pending: 2, sanitized: 0, available: false });
    expect(w.calls.head).toEqual([]);
    expect(w.saved).toEqual([]);
  });

  it("an oversized AI copy is rejected without being buffered into the model path", async () => {
    const w = world();
    w.objects.set(w.photos[0]!.thumb_path!, new Uint8Array(AI_COPY_MAX_BYTES + 10));
    const r = await ingestBookPhotos(BOOK, USER, { db: w.db });
    expect(r).toMatchObject({ verified: 1, rejected: 1 });
    expect(w.saved.find((s) => s.key.photoId === pid(1))!.outcome).toEqual({ state: "rejected", reason: "ai_copy_too_large" });
  });
});
