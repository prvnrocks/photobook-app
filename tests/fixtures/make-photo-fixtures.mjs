// Regenerates the larger photo fixtures used by browser checks of processPhoto
// (src/lib/image/process-photo.ts). macOS only — uses the built-in `sips`.
// Usage: node tests/fixtures/make-photo-fixtures.mjs   (after make-image-fixtures.mjs)
//   photo-orient6.jpg   400x300 stored pixels, EXIF copied from exif-gps.jpg (Orientation 6,
//                       fake date/GPS) → displays as 300x400
//   screenshot.png      390x844 flat UI-like PNG, no EXIF
//   photo-orient6.heic  sips HEIC conversion of photo-orient6.jpg
// All content is synthetic; metadata is the same FAKE metadata as exif-gps.jpg.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const [r, g, b] = pixel(x, y);
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Returns the first APP1 (EXIF) segment of a JPEG. */
function app1Of(jpeg) {
  let p = 2;
  while (p < jpeg.length && jpeg[p] === 0xff) {
    const marker = jpeg[p + 1];
    const len = jpeg.readUInt16BE(p + 2);
    if (marker === 0xe1) return jpeg.subarray(p, p + 2 + len);
    if (marker === 0xda) break;
    p += 2 + len;
  }
  throw new Error("no APP1");
}
/** Drops existing APP1 segments and inserts `app1` after SOI/APP0. */
function withApp1(jpeg, app1) {
  const parts = [jpeg.subarray(0, 2)];
  let p = 2; let inserted = false;
  while (p < jpeg.length) {
    const marker = jpeg[p + 1];
    if (marker === 0xda) break;
    const len = jpeg.readUInt16BE(p + 2);
    if (marker !== 0xe0 && !inserted) { parts.push(app1); inserted = true; }
    if (marker !== 0xe1) parts.push(jpeg.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  if (!inserted) parts.push(app1);
  parts.push(jpeg.subarray(p));
  return Buffer.concat(parts);
}

const tmp = mkdtempSync(join(tmpdir(), "pb-photo-fixtures-"));
const sips = (...args) => execFileSync("sips", args, { stdio: "ignore" });

// Photo-like: diagonal gradient + checker texture (non-zero blur score), "top" band red so
// orientation is visible: stored top edge is red.
writeFileSync(join(tmp, "photo.png"), png(400, 300, (x, y) => {
  if (y < 30) return [220, 30, 30];
  const check = ((x >> 3) + (y >> 3)) & 1 ? 40 : 0;
  return [Math.round((x / 399) * 200) + check, Math.round((y / 299) * 200) + check, 120];
}));
sips("-s", "format", "jpeg", "-s", "formatOptions", "70", join(tmp, "photo.png"), "--out", join(tmp, "photo.jpg"));
const exif = app1Of(readFileSync(join(OUT, "exif-gps.jpg")));
writeFileSync(join(OUT, "photo-orient6.jpg"), withApp1(readFileSync(join(tmp, "photo.jpg")), exif));

// Screenshot-like PNG: flat bars on white.
writeFileSync(join(tmp, "screenshot.png"), png(390, 844, (x, y) => {
  if (y < 90) return [0, 122, 255];
  if (y % 120 > 100) return [230, 230, 235];
  if (x > 20 && x < 300 && y % 120 > 30 && y % 120 < 50) return [30, 30, 30];
  return [255, 255, 255];
}));
sips("-s", "format", "png", join(tmp, "screenshot.png"), "--out", join(OUT, "screenshot.png"));

sips("-s", "format", "heic", "-s", "formatOptions", "60", join(OUT, "photo-orient6.jpg"), "--out", join(OUT, "photo-orient6.heic"));
console.log("photo fixtures written to", OUT);
