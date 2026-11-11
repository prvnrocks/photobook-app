#!/usr/bin/env node
// Layout contact sheet (M10b A5) — draws the GEOMETRY of a format/style's layouts for visual
// sign-off before renderers exist: grey photo boxes (numbered in slot order), labelled text
// boxes, trim, 3 mm bleed, 4 mm safe line, and for spreads the fold + its 8 mm text keep-out.
// Reads the real catalogue (src/lib/layouts via jiti), writes one PNG via sharp (librsvg).
//
//   node scripts/layout-contact-sheet.mjs [--format A5_PORTRAIT] [--style modern] [--out <png>]
//     defaults: A5_PORTRAIT, modern, docs/design/layouts-<style>-<portrait|landscape>.png

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const format = arg("format", "A5_PORTRAIT");
const style = arg("style", "modern");
const orientation = format === "A5_LANDSCAPE" ? "landscape" : "portrait";
const out = resolve(root, arg("out", `docs/design/layouts-${style}-${orientation}.png`));

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(root, "src") } });
const { LAYOUTS, BLEED_MM, SAFE_MM } = await jiti.import(resolve(root, "src/lib/layouts/index.ts"));
const { pageMm } = await jiti.import(resolve(root, "src/lib/book/format.ts"));

const FOLD_KEEP_OUT_MM = 8;
const PX = 1.6; // px per mm
const PAD = 28; // around each card
const LABEL_H = 46;
const page = pageMm(format);
const layouts = LAYOUTS.filter((l) => l.format === format && l.style === style);
if (layouts.length === 0) throw new Error(`no layouts for ${format} / ${style}`);
const order = { cover: 0, page: 1, spread: 2 };
layouts.sort((a, b) => order[a.role] - order[b.role]);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const BIND_LABEL = {
  chapterTitle: "CHAPTER TITLE",
  dateLabel: "date",
  pageCaption: "caption",
  coverTitle: "Cover title (script)",
  coverSubtitle: "subtitle / year (serif)",
};

/** One layout card: returns { w, h, svg } with its own origin at 0,0. */
function card(l) {
  const pages = l.role === "spread" ? 2 : 1;
  const trimW = page.w * pages * PX;
  const trimH = page.h * PX;
  const b = BLEED_MM * PX;
  const ox = PAD + b;
  const oy = PAD + LABEL_H + b;
  const rx = (r) => ({ x: ox + (r.x / 100) * page.w * PX, y: oy + (r.y / 100) * page.h * PX, w: (r.w / 100) * page.w * PX, h: (r.h / 100) * page.h * PX });
  const parts = [];
  // bleed + trim
  parts.push(`<rect x="${ox - b}" y="${oy - b}" width="${trimW + 2 * b}" height="${trimH + 2 * b}" fill="#fdf2f4" stroke="#e8a3b1" stroke-width="1" stroke-dasharray="3 3"/>`);
  parts.push(`<rect x="${ox}" y="${oy}" width="${trimW}" height="${trimH}" fill="#ffffff"/>`);
  // photo slots (bleed-extended where they touch the trim, shown lighter)
  l.slots.forEach((s, i) => {
    const r = rx(s);
    const ext = {
      l: s.x <= 0.01 ? b : 0,
      t: s.y <= 0.01 ? b : 0,
      r: s.x + s.w >= pages * 100 - 0.01 ? b : 0,
      bt: s.y + s.h >= 99.99 ? b : 0,
    };
    if (!l.slices && (ext.l || ext.t || ext.r || ext.bt)) {
      parts.push(`<rect x="${r.x - ext.l}" y="${r.y - ext.t}" width="${r.w + ext.l + ext.r}" height="${r.h + ext.t + ext.bt}" fill="#c9c9c9"/>`);
    }
    if (l.slices) {
      // Split-strip cover (A9 slice model): ONE photo over the slot box, shown only through the slices.
      parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#9e9e9e" stroke-dasharray="4 3"/>`);
      for (const sl of l.slices) {
        const q = rx(sl);
        parts.push(`<rect x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" fill="#9e9e9e"/>`);
      }
      parts.push(`<text x="${r.x + 4}" y="${r.y - 4}" font-size="9" fill="#7a8b99">1 photo, ${l.slices.length} slices</text>`);
    } else parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#9e9e9e"/>`);
    const ar = (s.w * page.w) / (s.h * page.h);
    parts.push(`<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2}" font-size="15" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle">${i + 1}</text>`);
    parts.push(`<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 15}" font-size="9" fill="#f2f2f2" text-anchor="middle" dominant-baseline="middle">${esc(l.prefers[i])} ${ar.toFixed(2)}</text>`);
  });
  // caption area (when not also a typed panel)
  const texts = l.texts ?? [];
  const same = (a, c) => Math.abs(a.x - c.x) < 1e-6 && Math.abs(a.y - c.y) < 1e-6 && Math.abs(a.w - c.w) < 1e-6 && Math.abs(a.h - c.h) < 1e-6;
  if (l.caption && !texts.some((t) => same(t.box, l.caption))) {
    const r = rx(l.caption);
    const covering = l.role === "cover" ? "cover text area (BookCover today)" : "caption";
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#7a8b99" stroke-width="1" stroke-dasharray="2 2"/>`);
    if (l.role !== "cover") parts.push(`<text x="${r.x + 3}" y="${r.y + 10}" font-size="9" fill="#7a8b99">${covering}</text>`);
  }
  // text panels
  for (const t of texts) {
    const r = rx(t.box);
    const anchor = t.align === "start" ? "start" : t.align === "end" ? "end" : "middle";
    const tx = anchor === "start" ? r.x + 3 : anchor === "end" ? r.x + r.w - 3 : r.x + r.w / 2;
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#fff4e0" stroke="#e08a00" stroke-width="1"/>`);
    const size = Math.max(7, Math.min(13, r.h * 0.55));
    parts.push(`<text x="${tx}" y="${r.y + r.h / 2}" font-size="${size}" fill="#8a5200" text-anchor="${anchor}" dominant-baseline="middle">${esc(BIND_LABEL[t.bind] ?? t.bind)} · ${esc(t.font)}</text>`);
  }
  // safe line
  const s = SAFE_MM * PX;
  parts.push(`<rect x="${ox + s}" y="${oy + s}" width="${trimW - 2 * s}" height="${trimH - 2 * s}" fill="none" stroke="#2f7de1" stroke-width="0.8" stroke-dasharray="4 3" opacity="0.8"/>`);
  // trim outline
  parts.push(`<rect x="${ox}" y="${oy}" width="${trimW}" height="${trimH}" fill="none" stroke="#222" stroke-width="1"/>`);
  if (l.role === "spread") {
    const fx = ox + page.w * PX;
    const k = FOLD_KEEP_OUT_MM * PX;
    parts.push(`<rect x="${fx - k}" y="${oy}" width="${2 * k}" height="${trimH}" fill="#d62f2f" opacity="0.07"/>`);
    parts.push(`<line x1="${fx}" y1="${oy - b}" x2="${fx}" y2="${oy + trimH + b}" stroke="#d62f2f" stroke-width="1.2" stroke-dasharray="6 3"/>`);
  }
  // label
  const twin = l.twin ? ` · twin ${l.twin.join(" + ")}` : "";
  parts.push(`<text x="${PAD}" y="${PAD + 14}" font-size="14" font-weight="700" fill="#111">${esc(l.id)}</text>`);
  parts.push(`<text x="${PAD}" y="${PAD + 32}" font-size="11" fill="#555">${esc(l.role)} · ${l.photoCount} photo${l.photoCount === 1 ? "" : "s"}${esc(twin)}</text>`);
  const w = trimW + 2 * b + 2 * PAD;
  const h = trimH + 2 * b + 2 * PAD + LABEL_H;
  return { w, h, units: pages, svg: parts.join("\n") };
}

// Flow layout: rows of up to COLS single-page units (spreads take 2).
const COLS = orientation === "portrait" ? 4 : 3;
const cards = layouts.map(card);
const unitW = Math.max(...cards.filter((c) => c.units === 1).map((c) => c.w), cards[0].w / cards[0].units);
const rows = [];
let row = [];
let used = 0;
for (const c of cards) {
  const prevRole = row.length ? layouts[cards.indexOf(row[row.length - 1])].role : null;
  const role = layouts[cards.indexOf(c)].role;
  if (used + c.units > COLS || (prevRole && prevRole !== role)) {
    rows.push(row);
    row = [];
    used = 0;
  }
  row.push(c);
  used += c.units;
}
if (row.length) rows.push(row);

const HEADER = 100;
const width = Math.ceil(unitW * COLS);
let y = HEADER;
const body = [];
for (const r of rows) {
  let x = 0;
  for (const c of r) {
    body.push(`<g transform="translate(${x},${y})">${c.svg}</g>`);
    x += c.units === 2 ? unitW * 2 : unitW;
  }
  y += Math.max(...r.map((c) => c.h));
}
const height = Math.ceil(y + 12);
const legend = [
  ["#9e9e9e", "photo slot (n = slot order, preference + aspect w/h)"],
  ["#c9c9c9", "3 mm bleed extension"],
  ["#fff4e0", "text panel (binding · font role)"],
].map(([c, t], i) => `<rect x="${24 + i * 330}" y="56" width="14" height="14" fill="${c}" stroke="#999"/><text x="${44 + i * 330}" y="67" font-size="12" fill="#333">${esc(t)}</text>`);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Helvetica, Arial, sans-serif">
<rect width="100%" height="100%" fill="#f4f4f2"/>
<text x="24" y="36" font-size="22" font-weight="700" fill="#111">${esc(style)} · ${esc(format)} (${page.w}×${page.h} mm) — ${layouts.length} layouts</text>
${legend.join("\n")}
<text x="24" y="91" font-size="12" fill="#333">blue dashed = ${SAFE_MM} mm safe · red dashed = fold (shaded ±${FOLD_KEEP_OUT_MM} mm, no text)</text>
${body.join("\n")}
</svg>`;

mkdirSync(dirname(out), { recursive: true });
await sharp(Buffer.from(svg), { density: 144 }).png({ compressionLevel: 9 }).toFile(out);
console.log(`wrote ${out} (${layouts.length} layouts, ${width}×${height} @2x)`);
