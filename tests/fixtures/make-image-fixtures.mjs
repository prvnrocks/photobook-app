// Regenerates the tiny JPEG fixtures used by tests/image-exif.test.ts.
// Usage (macOS, needs the built-in `sips`):  node tests/fixtures/make-image-fixtures.mjs
// 1. writes a 32x24 RGB gradient PNG (pure Node, zlib)
// 2. converts it to a baseline JPEG with `sips`
// 3. strips any APP1 segments sips wrote and splices in a hand-built EXIF APP1
// All metadata is FAKE (camera "FakeCam", coordinates = Abu Dhabi Corniche 24.47 N, 54.33 E).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = dirname(fileURLToPath(import.meta.url));

// ---------- PNG ----------
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
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((x / (w - 1)) * 255);
      raw[o + 1] = Math.round((y / (h - 1)) * 255);
      raw[o + 2] = 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- TIFF / EXIF ----------
const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
const ascii = (s) => ({ type: TYPE.ASCII, count: s.length + 1, bytes: Buffer.from(s + "\0", "ascii") });
const short = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return { type: TYPE.SHORT, count: 1, bytes: b }; };
const long = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return { type: TYPE.LONG, count: 1, bytes: b }; };
const bytes = (arr) => ({ type: TYPE.BYTE, count: arr.length, bytes: Buffer.from(arr) });
const rationals = (pairs) => {
  const b = Buffer.alloc(8 * pairs.length);
  pairs.forEach(([n, d], i) => { b.writeUInt32LE(n, i * 8); b.writeUInt32LE(d, i * 8 + 4); });
  return { type: TYPE.RATIONAL, count: pairs.length, bytes: b };
};
function dms(deg) {
  const d = Math.floor(deg); const mf = (deg - d) * 60; const m = Math.floor(mf);
  const s = Math.round((mf - m) * 60 * 100);
  return [[d, 1], [m, 1], [s, 100]];
}

/** Serialises one IFD at absolute TIFF offset `at`; returns bytes (entries + data area). */
function ifd(entries, at) {
  const tags = Object.keys(entries).map(Number).sort((a, b) => a - b);
  const headLen = 2 + tags.length * 12 + 4;
  const head = Buffer.alloc(headLen);
  const data = [];
  let dataOff = at + headLen;
  head.writeUInt16LE(tags.length, 0);
  tags.forEach((tag, i) => {
    const e = entries[tag]; const p = 2 + i * 12;
    head.writeUInt16LE(tag, p); head.writeUInt16LE(e.type, p + 2); head.writeUInt32LE(e.count, p + 4);
    const len = SIZE[e.type] * e.count;
    if (len <= 4) e.bytes.copy(head, p + 8);
    else {
      head.writeUInt32LE(dataOff, p + 8);
      const padded = len % 2 ? Buffer.concat([e.bytes, Buffer.alloc(1)]) : e.bytes;
      data.push(padded); dataOff += padded.length;
    }
  });
  head.writeUInt32LE(0, headLen - 4); // no next IFD
  return Buffer.concat([head, ...data]);
}

function tiff({ make, model, orientation, dateTimeOriginal, createDate, offset, gps }) {
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const exifEntries = { 0x9003: ascii(dateTimeOriginal), 0x9004: ascii(createDate ?? dateTimeOriginal) };
  if (offset) exifEntries[0x9011] = ascii(offset);
  const gpsEntries = gps && {
    0x0000: bytes([2, 3, 0, 0]),
    0x0001: ascii(gps.lat >= 0 ? "N" : "S"), 0x0002: rationals(dms(Math.abs(gps.lat))),
    0x0003: ascii(gps.lng >= 0 ? "E" : "W"), 0x0004: rationals(dms(Math.abs(gps.lng))),
  };
  // Two-pass: measure IFD0 size with dummy pointers, then write real pointers.
  const ifd0Entries = (exifPtr, gpsPtr) => {
    const e = { 0x010f: ascii(make), 0x0110: ascii(model), 0x0112: short(orientation), 0x8769: long(exifPtr) };
    if (gpsEntries) e[0x8825] = long(gpsPtr);
    return e;
  };
  const ifd0Len = ifd(ifd0Entries(0, 0), 8).length;
  const exifAt = 8 + ifd0Len;
  const exifBuf = ifd(exifEntries, exifAt);
  const gpsAt = exifAt + exifBuf.length;
  const gpsBuf = gpsEntries ? ifd(gpsEntries, gpsAt) : Buffer.alloc(0);
  return Buffer.concat([header, ifd(ifd0Entries(exifAt, gpsAt), 8), exifBuf, gpsBuf]);
}

function app1(tiffBuf) {
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiffBuf]);
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]);
}

/** Removes APP1 segments, inserts `extra` right after SOI (+APP0 if present). */
function withApp1(jpeg, extra) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  const parts = [jpeg.subarray(0, 2)];
  let p = 2; let inserted = false;
  while (p < jpeg.length) {
    if (jpeg[p] !== 0xff) throw new Error("bad marker at " + p);
    const marker = jpeg[p + 1];
    if (marker === 0xda) break; // SOS: rest is entropy-coded data
    const len = jpeg.readUInt16BE(p + 2);
    const seg = jpeg.subarray(p, p + 2 + len);
    if (marker !== 0xe0 && !inserted) { if (extra) parts.push(extra); inserted = true; }
    if (marker !== 0xe1) parts.push(seg);
    p += 2 + len;
  }
  if (!inserted && extra) parts.push(extra);
  parts.push(jpeg.subarray(p));
  return Buffer.concat(parts);
}

const tmp = mkdtempSync(join(tmpdir(), "pb-fixtures-"));
writeFileSync(join(tmp, "base.png"), png(32, 24));
execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", join(tmp, "base.png"), "--out", join(tmp, "base.jpg")], { stdio: "ignore" });
const base = readFileSync(join(tmp, "base.jpg"));

writeFileSync(join(OUT, "no-exif.jpg"), withApp1(base, null));
writeFileSync(join(OUT, "exif-gps.jpg"), withApp1(base, app1(tiff({
  make: "FakeCam", model: "FakeCam Test 1", orientation: 6,
  dateTimeOriginal: "2026:10:12 18:22:31", offset: "+04:00",
  gps: { lat: 24.47, lng: 54.33 },
}))));
writeFileSync(join(OUT, "exif-no-offset-zero-gps.jpg"), withApp1(base, app1(tiff({
  make: "FakeCam", model: "Other", orientation: 1,
  dateTimeOriginal: "2025:01:05 09:30:00",
  gps: { lat: 0, lng: 0 },
}))));
console.log("fixtures written to", OUT);
