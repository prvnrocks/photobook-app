#!/usr/bin/env node
// Generates the book background textures (M10a A5). Everything here is original: procedural
// SVG filters (feTurbulence / feColorMatrix / feComposite / feDisplacementMap) rasterised by
// sharp (librsvg). Fixed seeds → identical bytes on every run with the same sharp/libvips build.
// Released CC0 1.0 — see public/design/LICENSE.md.
//
//   node scripts/gen-textures.mjs [--out <dir>]      (default: public/design/textures)
//
// Outputs per texture:
//   tile  (paper-cream, paper-white, linen, kraft): seamless 512×512 px tile. librsvg ignores
//         stitchTiles, so the rendered noise is made to wrap by makeSeamless() (cross-fade with a
//         half-period rolled copy).
//         <id>.webp (screen) and <id>.jpg (print). Rendered at TILE_MM = 40 mm per tile in print
//         → 512 px / (40 mm / 25.4) = 325 dpi (≥ 300 dpi).
//   wash  (watercolour-blush, watercolour-sky): non-tiling full sheet, one per orientation,
//         covering the A5 sheet incl. bleed (portrait 154×216 mm, landscape 216×154 mm).
//         <id>-<orientation>.jpg (print) = 910×1276 / 1276×910 px → 150 dpi at full sheet;
//         <id>-<orientation>.webp (screen) = 1200 px on the long edge.
// Also writes manifest.json (files, pixel sizes, bytes, sha256, sharp/libvips versions).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

export const TILE_PX = 512;
export const TILE_MM = 40;
export const WASH_SHEET_MM = { portrait: [154, 216], landscape: [216, 154] };
export const WASH_PRINT_DPI = 150;
export const WASH_SCREEN_LONG_PX = 1200;

const mmToPx = (mm, dpi) => Math.ceil((mm / 25.4) * dpi);

// --- colour helpers ------------------------------------------------------------------------------

function hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) =>
    Number(v.toFixed(4)),
  );
}

/**
 * feColorMatrix row set: constant colour `hex`, alpha = gain * R + offset of the input noise.
 * Positive gain → specks where the noise is high; negative gain → where it is low.
 */
function noiseToAlpha(hex, gain, offset) {
  const [r, g, b] = hexToRgb01(hex);
  return `0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  ${gain} 0 0 0 ${offset}`;
}

// --- tiles ---------------------------------------------------------------------------------------

/**
 * A tile: base flood + stacked noise layers. Every layer is feTurbulence mapped through
 * feColorMatrix to a coloured alpha and composited "over". stitchTiles="stitch" is kept for
 * renderers that honour it; the wrap is guaranteed by makeSeamless() afterwards.
 */
function tileSvg({ base, layers }) {
  const S = TILE_PX;
  const prims = [`<feFlood flood-color="${base}" result="l0"/>`];
  layers.forEach((l, i) => {
    prims.push(
      `<feTurbulence type="${l.type ?? "fractalNoise"}" baseFrequency="${l.freq}" numOctaves="${l.octaves}" seed="${l.seed}" stitchTiles="stitch" result="n${i}"/>`,
      `<feColorMatrix in="n${i}" type="matrix" values="${noiseToAlpha(l.color, l.gain, l.offset)}" result="a${i}"/>`,
      `<feComposite in="a${i}" in2="l${i}" operator="over" result="l${i + 1}"/>`,
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<filter id="f" x="0" y="0" width="${S}" height="${S}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
${prims.join("\n")}
</filter>
<rect x="0" y="0" width="${S}" height="${S}" filter="url(#f)"/>
</svg>`;
}

// Paper grain shared by both papers: low-frequency mottling + fine fibre grain, light and dark.
const paperLayers = (seed, dark, light) => [
  { freq: "0.008", octaves: 3, seed, color: dark, gain: 0.45, offset: -0.2 },
  { freq: "0.02", octaves: 2, seed: seed + 1, color: light, gain: -0.7, offset: 0.38 },
  { freq: "0.7", octaves: 3, seed: seed + 2, color: dark, gain: 1.6, offset: -0.78 },
  { freq: "0.7", octaves: 3, seed: seed + 3, color: light, gain: -1.8, offset: 0.82 },
];

const TILES = {
  "paper-cream": {
    base: "#F4ECDB",
    layers: paperLayers(101, "#B59F78", "#FFFDF6"),
  },
  "paper-white": {
    base: "#FAF9F6",
    layers: paperLayers(201, "#A8A39A", "#FFFFFF"),
  },
  linen: {
    base: "#E6DCCB",
    layers: [
      // Horizontal threads (slow along x, fast along y), then vertical threads.
      { freq: "0.012 0.42", octaves: 2, seed: 301, color: "#9C8B70", gain: 1.4, offset: -0.6 },
      { freq: "0.42 0.012", octaves: 2, seed: 302, color: "#9C8B70", gain: 1.4, offset: -0.6 },
      { freq: "0.012 0.42", octaves: 2, seed: 303, color: "#FBF6EC", gain: -1.3, offset: 0.62 },
      { freq: "0.42 0.012", octaves: 2, seed: 304, color: "#FBF6EC", gain: -1.3, offset: 0.62 },
      { freq: "0.01", octaves: 2, seed: 305, color: "#8E7D63", gain: 0.35, offset: -0.16 },
    ],
  },
  kraft: {
    base: "#C29A6B",
    layers: [
      { freq: "0.01", octaves: 3, seed: 401, color: "#8A6440", gain: 1.0, offset: -0.42 },
      { freq: "0.03", octaves: 2, seed: 402, color: "#D9B98F", gain: -1.1, offset: 0.55 },
      // Fibres: short streaks in both directions, then dark/light flecks.
      { freq: "0.05 0.5", octaves: 2, seed: 403, color: "#7A5634", gain: 2.2, offset: -1.2 },
      { freq: "0.5 0.05", octaves: 2, seed: 404, color: "#E2C49C", gain: -2.2, offset: 1.0 },
      { freq: "0.9", octaves: 2, seed: 405, color: "#5E4128", gain: 3.0, offset: -1.75 },
      { freq: "0.9", octaves: 2, seed: 406, color: "#EBD3AE", gain: -3.0, offset: 1.3 },
    ],
  },
};

// --- washes --------------------------------------------------------------------------------------

/**
 * A watercolour wash over paper: an elliptical gradient (light centre, stronger pigment towards
 * the edges with a faint tide line) whose outline is warped by feDisplacementMap for soft
 * organic edges, then modulated by a granulation noise. Paper grain on top.
 *
 * librsvg clips the source graphic to the canvas, so displacement near the canvas edge samples
 * transparency. The SVG canvas is therefore the sheet plus a 30 % margin on every side (the
 * gradient rect fills it all); `washCrop` cuts the sheet back out after rasterising.
 */
const WASH_MARGIN = 0.3;

function washCrop(w, h) {
  return { left: Math.round(w * WASH_MARGIN), top: Math.round(h * WASH_MARGIN), width: w, height: h };
}

function washSvg({ w, h, paper, pigment, seed }) {
  const min = Math.min(w, h);
  const px = (v) => Math.round(v);
  const c = washCrop(w, h);
  const cw = w + 2 * c.left;
  const ch = h + 2 * c.top;
  const vb = `${-c.left} ${-c.top} ${cw} ${ch}`;
  // Gradient geometry in sheet terms: centre (50 %, 47.5 %), radius 0.72 × sheet size.
  const cx = ((0.5 * w + c.left) / cw) * 100;
  const cy = ((0.475 * h + c.top) / ch) * 100;
  const r = ((0.72 * w) / cw) * 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="${vb}">
<defs>
<radialGradient id="g" cx="${cx.toFixed(3)}%" cy="${cy.toFixed(3)}%" r="${r.toFixed(3)}%">
  <stop offset="0" stop-color="${pigment}" stop-opacity="0.03"/>
  <stop offset="0.5" stop-color="${pigment}" stop-opacity="0.07"/>
  <stop offset="0.66" stop-color="${pigment}" stop-opacity="0.16"/>
  <stop offset="0.70" stop-color="${pigment}" stop-opacity="0.34"/>
  <stop offset="0.76" stop-color="${pigment}" stop-opacity="0.26"/>
  <stop offset="1" stop-color="${pigment}" stop-opacity="0.46"/>
</radialGradient>
<filter id="w" x="${-c.left}" y="${-c.top}" width="${cw}" height="${ch}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="${(2.2 / min).toFixed(5)}" numOctaves="4" seed="${seed}" result="warp"/>
  <feDisplacementMap in="SourceGraphic" in2="warp" scale="${px(min * 0.22)}" xChannelSelector="R" yChannelSelector="G" result="shape"/>
  <feTurbulence type="fractalNoise" baseFrequency="${(14 / min).toFixed(5)}" numOctaves="3" seed="${seed + 1}" result="gran"/>
  <feColorMatrix in="gran" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.4 0 0 0 0.2" result="granA"/>
  <feComposite in="shape" in2="granA" operator="in"/>
</filter>
<filter id="p" x="${-c.left}" y="${-c.top}" width="${cw}" height="${ch}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="${seed + 2}" result="n"/>
  <feColorMatrix in="n" type="matrix" values="${noiseToAlpha("#8C8478", 1.0, -0.55)}"/>
</filter>
</defs>
<rect x="${-c.left}" y="${-c.top}" width="${cw}" height="${ch}" fill="${paper}"/>
<rect x="${-c.left}" y="${-c.top}" width="${cw}" height="${ch}" fill="url(#g)" filter="url(#w)"/>
<rect x="${-c.left}" y="${-c.top}" width="${cw}" height="${ch}" filter="url(#p)"/>
</svg>`;
}

const WASHES = {
  "watercolour-blush": { paper: "#FBF7F1", pigment: "#E39A93", seed: 501 },
  "watercolour-sky": { paper: "#F8F9F7", pigment: "#7FAAD6", seed: 601 },
};

// --- encoding ------------------------------------------------------------------------------------

const JPEG_OPTS = { quality: 86, mozjpeg: false, quantisationTable: 3, chromaSubsampling: "4:4:4" };
const WASH_JPEG_OPTS = { quality: 84, mozjpeg: false, quantisationTable: 3 };
const WEBP_OPTS = { quality: 80, effort: 6, smartSubsample: true };

async function rasterise(svg, crop) {
  // Render once to raw RGB, then encode each output from the same pixels.
  let img = sharp(Buffer.from(svg), { density: 72 }).removeAlpha();
  if (crop) img = img.extract(crop);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, info: { width: info.width, height: info.height, channels: info.channels } };
}

/**
 * Makes a square raw RGB image wrap seamlessly. librsvg ignores stitchTiles, so the noise does
 * not wrap by itself. Separable cross-fade with a half-period rolled copy: pass 1 along x,
 * pass 2 along y. Weight g(t) = sin²(π t / S) is 0 at the border (only the rolled copy, which
 * is continuous across the wrap) and 1 in the middle (only the original, whose seam the
 * rolled copy hides). The deviation from the channel mean is divided by sqrt(g² + (1−g)²) so
 * the blend zone keeps the original contrast.
 */
export function makeSeamless({ data, info }) {
  const { width: S, height, channels: C } = info;
  if (S !== height) throw new Error("makeSeamless needs a square tile");
  const g = Float64Array.from({ length: S }, (_, t) => Math.sin((Math.PI * t) / S) ** 2);
  const mean = new Float64Array(C);
  for (let i = 0; i < data.length; i++) mean[i % C] += data[i];
  for (let c = 0; c < C; c++) mean[c] /= S * S;
  let src = Float64Array.from(data);
  for (const axis of ["x", "y"]) {
    const out = new Float64Array(src.length);
    const half = S / 2;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const t = axis === "x" ? x : y;
        const rx = axis === "x" ? (x + half) % S : x;
        const ry = axis === "y" ? (y + half) % S : y;
        const w = g[t];
        const norm = Math.sqrt(w * w + (1 - w) * (1 - w));
        const i = (y * S + x) * C;
        const j = (ry * S + rx) * C;
        for (let c = 0; c < C; c++) {
          const a = src[i + c] - mean[c];
          const b = src[j + c] - mean[c];
          out[i + c] = mean[c] + (a * w + b * (1 - w)) / norm;
        }
      }
    }
    src = out;
  }
  const buf = Buffer.alloc(data.length);
  for (let i = 0; i < src.length; i++) buf[i] = Math.max(0, Math.min(255, Math.round(src[i])));
  return { data: buf, info };
}

const fromRaw = ({ data, info }) => sharp(data, { raw: info });

export async function generate(outDir) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  const write = async (name, buf) => {
    writeFileSync(join(outDir, name), buf);
    const meta = await sharp(buf).metadata();
    files.push({
      name,
      width: meta.width,
      height: meta.height,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
    });
  };

  for (const [id, spec] of Object.entries(TILES)) {
    const raw = makeSeamless(await rasterise(tileSvg(spec)));
    await write(`${id}.webp`, await fromRaw(raw).webp(WEBP_OPTS).toBuffer());
    await write(`${id}.jpg`, await fromRaw(raw).jpeg(JPEG_OPTS).toBuffer());
  }

  for (const [id, spec] of Object.entries(WASHES)) {
    for (const [orientation, [wMm, hMm]] of Object.entries(WASH_SHEET_MM)) {
      const w = mmToPx(wMm, WASH_PRINT_DPI);
      const h = mmToPx(hMm, WASH_PRINT_DPI);
      const raw = await rasterise(washSvg({ w, h, ...spec }), washCrop(w, h));
      await write(`${id}-${orientation}.jpg`, await fromRaw(raw).jpeg(WASH_JPEG_OPTS).toBuffer());
      const scale = WASH_SCREEN_LONG_PX / Math.max(w, h);
      const sw = Math.round(w * scale);
      const sh = Math.round(h * scale);
      await write(
        `${id}-${orientation}.webp`,
        await fromRaw(raw).resize(sw, sh, { kernel: "lanczos3" }).webp(WEBP_OPTS).toBuffer(),
      );
    }
  }

  const manifest = {
    generator: "scripts/gen-textures.mjs",
    license: "CC0-1.0",
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
    tilePx: TILE_PX,
    tileMm: TILE_MM,
    washPrintDpi: WASH_PRINT_DPI,
    files,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const i = process.argv.indexOf("--out");
  const out = resolve(i > 0 ? process.argv[i + 1] : "public/design/textures");
  const t0 = Date.now();
  const m = await generate(out);
  const total = m.files.reduce((s, f) => s + f.bytes, 0);
  for (const f of m.files) console.log(`${f.name.padEnd(36)} ${f.width}x${f.height}  ${(f.bytes / 1024).toFixed(1)} KB`);
  console.log(`total ${(total / 1024).toFixed(1)} KB in ${Date.now() - t0} ms → ${out}`);
}
