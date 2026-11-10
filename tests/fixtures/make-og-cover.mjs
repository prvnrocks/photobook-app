// Regenerates og-cover.jpg for tests/viewer-og.test.tsx (OG image size budget).
// macOS only — uses the built-in `sips`. Usage: node tests/fixtures/make-og-cover.mjs
//   og-cover.jpg  1600x1067 synthetic "photo" (gradient sky, soft blobs, fine texture + grain),
//                 sized like a `web` copy (≤1600 px JPEG). No real photo, person or place.
//   og-cover-smooth.jpg  same scene without texture/grain (an evening-sky-like, low-detail cover)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = dirname(fileURLToPath(import.meta.url));
const W = 1600;
const H = 1067;

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
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(42);
const blobs = Array.from({ length: 24 }, () => ({
  x: rnd() * W, y: rnd() * H, r: (0.03 + rnd() * 0.15) * W,
  c: [rnd() * 255, rnd() * 255, rnd() * 255],
}));
function makeCover(detail) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sky = y / H;
      const px = [90 + 120 * (1 - sky), 140 + 70 * (1 - sky), 200 - 90 * sky];
      for (const b of blobs) {
        const k = Math.exp(-(((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r)));
        for (let c = 0; c < 3; c++) px[c] += k * (b.c[c] - px[c]);
      }
      const tex = detail ? 10 * Math.sin(x * 0.21 + Math.sin(y * 0.05) * 3) * Math.cos(y * 0.17) : 0;
      const o = y * (W * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.max(0, Math.min(255, px[c] + tex + (detail ? (rnd() * 2 - 1) * 6 : 0)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const tmp = mkdtempSync(join(tmpdir(), "pb-og-cover-"));
for (const [name, detail] of [["og-cover.jpg", true], ["og-cover-smooth.jpg", false]]) {
  writeFileSync(join(tmp, "cover.png"), makeCover(detail));
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", join(tmp, "cover.png"), "--out", join(tmp, name)], { stdio: "ignore" });
  writeFileSync(join(OUT, name), readFileSync(join(tmp, name)));
  console.log(name, readFileSync(join(OUT, name)).length, "bytes");
}
