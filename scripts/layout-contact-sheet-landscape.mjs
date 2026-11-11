#!/usr/bin/env node
// A5 LANDSCAPE layout contact sheet (M10b A5b) — draws layout GEOMETRY for user sign-off before
// the renderers exist: grey photo boxes (numbered in slot order, with orientation hint), labelled
// text boxes (caption + texts[] bindings), the 3 mm bleed, the trim, the 4 mm safe line, the
// 8 mm text keep-out next to a possible fold (both sides of a single page; the fold of a spread)
// and the fold itself. Reads the real catalogue via jiti and rasterises an SVG with sharp.
//
//   node scripts/layout-contact-sheet-landscape.mjs [--style classic|modern|all] [--out-dir docs/design]
//     writes <out-dir>/layouts-<style>-landscape.png (default: both classic and modern)

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
const styleArg = arg("style", "all");
const outDir = resolve(root, arg("out-dir", "docs/design"));

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(root, "src") } });
const { LAYOUTS, BLEED_MM, SAFE_MM } = await jiti.import(resolve(root, "src/lib/layouts/index.ts"));
const { pageMm } = await jiti.import(resolve(root, "src/lib/book/format.ts"));

const FORMAT = "A5_LANDSCAPE";
const PAGE = pageMm(FORMAT); // 210 × 148
const FOLD_MM = 8;
const PX = 1.5; // px per mm
const PAD = 24;
const HEAD = 44;
const COLS_SINGLE = 3;
const ROLE_ORDER = { cover: 0, page: 1, spread: 2 };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const TEXT_LABEL = {
  chapterTitle: "CHAPTER TITLE",
  dateLabel: "date",
  pageCaption: "caption",
  coverTitle: "Cover title",
  coverSubtitle: "subtitle / year",
};

function card(l) {
  const pages = l.role === "spread" ? 2 : 1;
  const b = BLEED_MM * PX;
  const tw = PAGE.w * pages * PX;
  const th = PAGE.h * PX;
  const ox = PAD + b;
  const oy = HEAD + b;
  const w = tw + 2 * b + 2 * PAD;
  const h = HEAD + th + 2 * b + PAD;
  const R = (r) => ({ x: ox + (r.x / 100) * PAGE.w * PX, y: oy + (r.y / 100) * PAGE.h * PX, w: (r.w / 100) * PAGE.w * PX, h: (r.h / 100) * PAGE.h * PX });
  const p = [];
  p.push(`<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="#ffffff" stroke="#d8d8d8"/>`);
  // bleed area + trim
  p.push(`<rect x="${ox - b}" y="${oy - b}" width="${tw + 2 * b}" height="${th + 2 * b}" fill="#fbeef1" stroke="#e7a1b0" stroke-dasharray="3 3"/>`);
  p.push(`<rect x="${ox}" y="${oy}" width="${tw}" height="${th}" fill="#ffffff" stroke="#222" stroke-width="1"/>`);
  // photo slots (clipped to trim+bleed; edge slots visibly run into the bleed)
  l.slots.forEach((s, i) => {
    const r = R(s);
    const ext = { l: s.x <= 0.01 ? b : 0, t: s.y <= 0.01 ? b : 0, r: s.x + s.w >= pages * 100 - 0.01 ? b : 0, bo: s.y + s.h >= 99.99 ? b : 0 };
    p.push(`<rect x="${r.x - ext.l}" y="${r.y - ext.t}" width="${r.w + ext.l + ext.r}" height="${r.h + ext.t + ext.bo}" fill="#c9c9c9" opacity="0.55"/>`);
    p.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#b4b4b4" stroke="#8a8a8a"/>`);
    const fs = Math.max(11, Math.min(22, Math.min(r.w, r.h) / 3.2));
    p.push(`<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + fs * 0.35}" font-family="Helvetica, Arial" font-size="${fs}" font-weight="700" fill="#fff" text-anchor="middle">${i + 1}</text>`);
    const hint = l.prefers[i] === "any" ? "" : l.prefers[i][0].toUpperCase();
    if (hint) p.push(`<text x="${r.x + 4}" y="${r.y + 12}" font-family="Helvetica, Arial" font-size="10" fill="#555">${hint}</text>`);
  });
  // text boxes
  const texts = [
    ...(l.caption ? [{ box: l.caption, label: l.role === "cover" ? "title block (caption rect)" : "caption", dashed: l.role === "cover" && (l.texts ?? []).length > 0 }] : []),
    ...(l.texts ?? []).map((t) => ({ box: t.box, label: `${TEXT_LABEL[t.bind] ?? t.bind} · ${t.font} · ${t.align}`, dashed: false })),
  ];
  for (const t of texts) {
    const r = R(t.box);
    p.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${t.dashed ? "none" : "#e3efff"}" stroke="#2f6fd6" ${t.dashed ? 'stroke-dasharray="5 3"' : ""}/>`);
    const fs = Math.max(9, Math.min(12, r.h * 0.45));
    // label clipped to its own box (nested svg = overflow hidden)
    const ly = t.dashed ? r.h - 4 : Math.min(r.h - 3, fs + 3);
    p.push(`<svg x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"><text x="4" y="${ly}" font-family="Helvetica, Arial" font-size="${fs}" fill="#1d4f9e">${esc(t.label)}</text></svg>`);
  }
  // safe line (4 mm inside the trim)
  const sm = SAFE_MM * PX;
  p.push(`<rect x="${ox + sm}" y="${oy + sm}" width="${tw - 2 * sm}" height="${th - 2 * sm}" fill="none" stroke="#2bb673" stroke-dasharray="2 3"/>`);
  // fold keep-out: spreads — the fold at the middle; single pages — both sides (either may be the fold)
  const fk = FOLD_MM * PX;
  const keep = (x) => p.push(`<line x1="${x}" y1="${oy}" x2="${x}" y2="${oy + th}" stroke="#f08a24" stroke-dasharray="4 3"/>`);
  if (l.role === "spread") {
    const fx = ox + PAGE.w * PX;
    keep(fx - fk);
    keep(fx + fk);
    p.push(`<line x1="${fx}" y1="${oy - b - 6}" x2="${fx}" y2="${oy + th + b + 6}" stroke="#d22" stroke-width="1.6"/>`);
    p.push(`<text x="${fx + 3}" y="${oy + th + b + 14}" font-family="Helvetica, Arial" font-size="10" fill="#d22">fold</text>`);
  } else {
    keep(ox + fk);
    keep(ox + tw - fk);
  }
  // heading
  const twin = l.twin ? ` · twin ${l.twin.join(" + ")}` : "";
  p.push(`<text x="${PAD}" y="18" font-family="Helvetica, Arial" font-size="14" font-weight="700" fill="#111">${esc(l.id)}</text>`);
  p.push(`<text x="${PAD}" y="35" font-family="Helvetica, Arial" font-size="11" fill="#555">${esc(`${l.name} · ${l.role} · ${l.photoCount} photo${l.photoCount === 1 ? "" : "s"}${twin}`)}</text>`);
  return { w, h, svg: p.join("") };
}

async function sheet(style) {
  const layouts = LAYOUTS.filter((l) => l.format === FORMAT && l.style === style).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  if (layouts.length === 0) throw new Error(`no ${FORMAT} layouts for style ${style}`);
  const cards = layouts.map((l) => ({ l, ...card(l) }));
  const singleW = Math.max(...cards.filter((c) => c.l.role !== "spread").map((c) => c.w), 0);
  const GAP = 16;
  const TITLE = 82;
  let x = GAP;
  let y = TITLE;
  let rowH = 0;
  let col = 0;
  const placed = [];
  for (const c of cards) {
    const isSpread = c.l.role === "spread";
    const span = isSpread ? 2 : 1;
    if (col + span > COLS_SINGLE || (isSpread && col > 0 && placed.at(-1)?.l.role !== "spread")) {
      x = GAP;
      y += rowH + GAP;
      rowH = 0;
      col = 0;
    }
    placed.push({ ...c, x, y });
    x += (isSpread ? c.w : singleW) + GAP;
    rowH = Math.max(rowH, c.h);
    col += span;
  }
  const W = GAP + COLS_SINGLE * (singleW + GAP);
  const H = y + rowH + GAP + 40;
  const legend1 = "grey = photo slot (number = slot order, P/L = prefers portrait/landscape; light grey = bleed extension) · blue = text box (label: binding · font role · align)";
  const legend2 = "pink dashed = 3 mm bleed · black = trim · green dotted = 4 mm safe line · orange dashed = 8 mm fold keep-out (both sides of a single page) · red = fold";
  const body = placed.map((c) => `<g transform="translate(${c.x},${c.y})">${c.svg}</g>`).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="#f3f3f1"/>` +
    `<text x="${GAP}" y="30" font-family="Helvetica, Arial" font-size="22" font-weight="700" fill="#111">${esc(`${style[0].toUpperCase()}${style.slice(1)} — A5 landscape ${PAGE.w}×${PAGE.h} mm (${layouts.length} layouts)`)}</text>` +
    `<text x="${GAP}" y="50" font-family="Helvetica, Arial" font-size="11" fill="#444">${esc(legend1)}</text>` +
    `<text x="${GAP}" y="65" font-family="Helvetica, Arial" font-size="11" fill="#444">${esc(legend2)}</text>` +
    body +
    `</svg>`;
  const out = resolve(outDir, `layouts-${style}-landscape.png`);
  mkdirSync(dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  console.log(`${out}  ${W}×${H}px  ${layouts.length} layouts`);
}

for (const style of styleArg === "all" ? ["classic", "modern"] : [styleArg]) await sheet(style);
