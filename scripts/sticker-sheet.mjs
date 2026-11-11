#!/usr/bin/env node
// Sticker sheet (M10c T2, D-068) — renders every sticker of src/lib/design/stickers.ts for the
// user's sign-off (gate G0): on white paper, on the kraft texture and on the blush watercolour
// (public/design/textures), plus each sticker in its suggested tints, plus an "in use" strip
// (tape, corners, plates, hearts on photo stand-ins). Uses the real catalogue (jiti) and the same
// stickerSvg() markup the renderer draws; rasterised by sharp (librsvg).
//
//   node scripts/sticker-sheet.mjs [--out docs/design/m10c-stickers.png]
//
// Sheet-only lettering (names, plate sample text) is drawn with librsvg system fonts; in books the
// plate text is live text in the style's fonts (see /dev-fonts → M10c specimen).

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const out = resolve(root, arg("out", "docs/design/m10c-stickers.png"));

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(root, "src") } });
const { STICKER_IDS, STICKERS, stickerSvg, plateInk } = await jiti.import(resolve(root, "src/lib/design/stickers.ts"));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

/** A sticker as a nested <svg> fitted (contain) into box (x, y, w, h), optionally rotated. */
function place(id, x, y, w, h, { tint, rotate = 0 } = {}) {
  const [, , vw, vh] = STICKERS[id].viewBox;
  const s = Math.min(w / vw, h / vh);
  const dw = vw * s;
  const dh = vh * s;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  const inner = stickerSvg(id, { tint, width: dw, height: dh }).replace("<svg ", `<svg x="${dx}" y="${dy}" `);
  if (!rotate) return inner;
  return `<g transform="rotate(${rotate} ${x + w / 2} ${y + h / 2})">${inner}</g>`;
}

const COLS = 7;
const CELL_W = 190;
const CELL_H = 190;
const PANEL_PAD = 36;
const HEAD_H = 64;
const PANEL_W = COLS * CELL_W + PANEL_PAD * 2;

const GROUP_LABEL = { neutral: "neutral", accent: "occasion accent", seasonal: "Eid / Ramadan" };

function catalogueGrid(ink, sub) {
  const parts = [];
  STICKER_IDS.forEach((id, i) => {
    const def = STICKERS[id];
    const cx = PANEL_PAD + (i % COLS) * CELL_W;
    const cy = HEAD_H + Math.floor(i / COLS) * CELL_H;
    const box = def.kind === "tape" || def.kind === "plate" ? { w: 160, h: 70 } : { w: 118, h: 118 };
    parts.push(place(id, cx + (CELL_W - box.w) / 2, cy + 14 + (124 - box.h) / 2, box.w, box.h));
    parts.push(`<text x="${cx + CELL_W / 2}" y="${cy + 158}" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="600" fill="${ink}">${esc(id)}</text>`);
    const tag = def.occasion ? `${def.occasion}` : GROUP_LABEL[def.group];
    parts.push(`<text x="${cx + CELL_W / 2}" y="${cy + 176}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${sub}">${esc(tag)}</text>`);
  });
  return parts.join("");
}

const rows = Math.ceil(STICKER_IDS.length / COLS);
const GRID_H = HEAD_H + rows * CELL_H + 20;

function heading(text, note, ink, sub) {
  return (
    `<text x="${PANEL_PAD}" y="40" font-family="${FONT}" font-size="22" font-weight="700" fill="${ink}">${esc(text)}</text>` +
    `<text x="${PANEL_W - PANEL_PAD}" y="40" text-anchor="end" font-family="${FONT}" font-size="13" fill="${sub}">${esc(note)}</text>`
  );
}

async function texturePanel(file, w, h, { tile }) {
  const src = resolve(root, "public/design/textures", file);
  if (tile) {
    // 512 px tile = 40 mm in print; show it at ~0.75 scale so the grain reads at sheet size
    const side = Math.min(384, w, h);
    const t = await sharp(src).resize(side, side).png().toBuffer();
    return sharp({ create: { width: w, height: h, channels: 4, background: "#fff" } }).composite([{ input: t, tile: true, left: 0, top: 0 }]).png().toBuffer();
  }
  return sharp(src).resize(w, h, { fit: "cover" }).png().toBuffer();
}

async function panel(bg, svgBody, h) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${h}">${svgBody}</svg>`);
  const base = bg.kind === "color"
    ? sharp({ create: { width: PANEL_W, height: h, channels: 4, background: bg.hex } })
    : sharp(await texturePanel(bg.file, PANEL_W, h, bg));
  return base.composite([{ input: svg }]).png().toBuffer();
}

// --- panel 4: tints --------------------------------------------------------------------------------
function tintsBody() {
  const parts = [heading("Tints", "each sticker in its suggested tints (first = default); paperclip/plates too", "#1f1f1f", "#6b6b6b")];
  const perRow = 3; // stickers per row
  const slotW = (PANEL_W - PANEL_PAD * 2) / perRow;
  STICKER_IDS.forEach((id, i) => {
    const def = STICKERS[id];
    const x0 = PANEL_PAD + (i % perRow) * slotW;
    const y0 = HEAD_H + Math.floor(i / perRow) * 112;
    parts.push(`<text x="${x0}" y="${y0 + 14}" font-family="${FONT}" font-size="12" font-weight="600" fill="#444">${esc(id)}</text>`);
    const n = def.suggestedTints.length;
    const each = Math.min(96, (slotW - 20) / n);
    parts.push(`<rect x="${x0 - 6}" y="${y0 + 18}" width="${slotW - 16}" height="${80}" rx="8" fill="#ECE9E3"/>`);
    def.suggestedTints.forEach((t, k) => {
      parts.push(place(id, x0 + k * each, y0 + 24, each - 8, 66, { tint: t }));
      parts.push(`<text x="${x0 + k * each + (each - 8) / 2}" y="${y0 + 106}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#888">${t}</text>`);
    });
  });
  return { body: parts.join(""), h: HEAD_H + Math.ceil(STICKER_IDS.length / perRow) * 112 + 24 };
}

// --- panel 5: in use -------------------------------------------------------------------------------
/** A soft photo stand-in (flat bands, no gradients needed). */
function photo(x, y, w, h, [sky, mid, ground], { frame = 0, rotate = 0, frameHex = "#FFFFFF" } = {}) {
  const fx = x - frame;
  const fy = y - frame;
  const fw = w + frame * 2;
  const fh = h + frame * 2 + (frame ? frame * 2.4 : 0);
  const g = [
    frame ? `<rect x="${fx + 3}" y="${fy + 5}" width="${fw}" height="${fh}" fill="#000" fill-opacity="0.12" rx="1"/>` : "",
    frame ? `<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="${frameHex}"/>` : "",
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sky}"/>`,
    `<path d="M${x} ${y + h * 0.62}Q${x + w * 0.3} ${y + h * 0.48} ${x + w * 0.55} ${y + h * 0.6}T${x + w} ${y + h * 0.55}V${y + h}H${x}Z" fill="${mid}"/>`,
    `<path d="M${x} ${y + h * 0.8}Q${x + w * 0.4} ${y + h * 0.7} ${x + w} ${y + h * 0.82}V${y + h}H${x}Z" fill="${ground}"/>`,
    `<circle cx="${x + w * 0.72}" cy="${y + h * 0.26}" r="${Math.min(w, h) * 0.08}" fill="#fff" fill-opacity="0.6"/>`,
  ].join("");
  return rotate ? `<g transform="rotate(${rotate} ${x + w / 2} ${y + h / 2})">${g}</g>` : g;
}

/** Plate with sheet-only sample text in its textBox. */
function plate(id, x, y, w, text, { tint, rotate = 0, size = 15, font = FONT, ls = 1.6, dir = "ltr" } = {}) {
  const [, , vw, vh] = STICKERS[id].viewBox;
  const h = (w * vh) / vw;
  const tb = STICKERS[id].textBox;
  const tx = x + ((tb.x + tb.w / 2) / 100) * w;
  const ty = y + ((tb.y + tb.h / 2) / 100) * h + size * 0.36;
  const ink = plateInk(id, tint) === "light" ? "#FFFFFF" : "#262626";
  const g =
    place(id, x, y, w, h, { tint }) +
    `<text x="${tx}" y="${ty}" text-anchor="middle" direction="${dir}" font-family="${font}" font-size="${size}" font-weight="700" letter-spacing="${ls}" fill="${ink}">${esc(text)}</text>`;
  return rotate ? `<g transform="rotate(${rotate} ${x + w / 2} ${y + h / 2})">${g}</g>` : g;
}

function inUseBody() {
  const parts = [heading("In use", "stand-in photos · plate text here is a system font; books use live Bebas / Lalezar text", "#1f1f1f", "#6b6b6b")];
  const Y = HEAD_H + 10;
  // 1. polaroid with washi tape across the top + a kraft heart
  parts.push(photo(70, Y + 40, 200, 150, ["#c9d6dc", "#8fb0bd", "#e8dcc6"], { frame: 12, rotate: -4 }));
  parts.push(place("tape-washi", 110, Y + 12, 120, 34, { rotate: -7 }));
  parts.push(place("heart-kraft", 240, Y + 180, 60, 56, { rotate: 12 }));
  parts.push(plate("plate-label", 60, Y + 238, 170, "SUNNY DAYS", { rotate: -3 }));
  // 2. photo with four corners
  const px = 380;
  const py = Y + 40;
  parts.push(photo(px, py, 190, 150, ["#e9d8c2", "#c9a27e", "#5e4a3c"]));
  const c = 34;
  parts.push(place("photo-corner", px - 8, py - 8, c, c));
  parts.push(place("photo-corner", px + 190 - c + 8, py - 8, c, c, { rotate: 90 }));
  parts.push(place("photo-corner", px + 190 - c + 8, py + 150 - c + 8, c, c, { rotate: 180 }));
  parts.push(place("photo-corner", px - 8, py + 150 - c + 8, c, c, { rotate: 270 }));
  parts.push(plate("plate-tag", px + 10, py + 172, 170, "June 2026", { size: 15, ls: 0.4 }));
  parts.push(place("leaf-sprig", px + 176, py + 92, 52, 92, { rotate: 18 }));
  // 3. overlapping prints with striped tape + paperclip + sparkle
  const qx = 660;
  parts.push(photo(qx, Y + 50, 150, 190, ["#dfe5df", "#9fb3a0", "#566b5c"], { frame: 10, rotate: 5 }));
  parts.push(photo(qx + 110, Y + 30, 170, 130, ["#f0e3d0", "#d6b48f", "#a65a3f"], { frame: 10, rotate: -6 }));
  parts.push(place("tape-striped", qx + 150, Y + 6, 110, 30, { rotate: 8 }));
  parts.push(place("paperclip", qx + 10, Y + 30, 24, 72, { rotate: -8 }));
  parts.push(place("sparkle", qx + 230, Y + 180, 56, 56));
  parts.push(plate("plate-label", qx + 120, Y + 238, 150, "مغامرة", { tint: "#6A2333", size: 17, ls: 0, dir: "rtl" }));
  // 4. accent + Eid
  const ex = 1010;
  parts.push(photo(ex, Y + 40, 160, 200, ["#2f3b55", "#8a6f7d", "#e2b48f"], { frame: 10, frameHex: "#FBF7EE" }));
  parts.push(place("tape-kraft", ex + 40, Y + 18, 90, 28, { rotate: -4 }));
  parts.push(place("lantern", ex + 170, Y + 30, 60, 112, { rotate: 4 }));
  parts.push(place("crescent-star", ex + 168, Y + 160, 74, 74));
  parts.push(place("flower", ex - 24, Y + 206, 58, 58));
  return { body: parts.join(""), h: Y + 300 };
}

const panels = [];
const intro =
  `<text x="${PANEL_PAD}" y="46" font-family="${FONT}" font-size="30" font-weight="700" fill="#1f1f1f">M10c stickers — original set (${STICKER_IDS.length})</text>` +
  `<text x="${PANEL_PAD}" y="76" font-family="${FONT}" font-size="15" fill="#555">Pure SVG paths (no filters, images, text or external refs) · tape = translucent rgba fill · tintable · ` +
  `src/lib/design/stickers.ts</text>`;
panels.push(await panel({ kind: "color", hex: "#FFFFFF" }, intro, 100));
panels.push(await panel({ kind: "color", hex: "#FFFFFF" }, heading("On white paper", "default tints", "#1f1f1f", "#6b6b6b") + catalogueGrid("#1f1f1f", "#777"), GRID_H));
panels.push(await panel({ kind: "texture", file: "kraft.jpg", tile: true }, heading("On kraft (texture)", "public/design/textures/kraft", "#2b2118", "#4a3a2a") + catalogueGrid("#2b2118", "#4a3a2a"), GRID_H));
panels.push(
  await panel({ kind: "texture", file: "watercolour-blush-landscape.jpg", tile: false }, heading("On blush watercolour", "watercolour-blush", "#1f1f1f", "#6b6b6b") + catalogueGrid("#1f1f1f", "#6b6b6b"), GRID_H),
);
const tints = tintsBody();
panels.push(await panel({ kind: "color", hex: "#FFFFFF" }, tints.body, tints.h));
const use = inUseBody();
panels.push(await panel({ kind: "texture", file: "paper-cream.jpg", tile: true }, use.body, use.h));

const heights = await Promise.all(panels.map(async (b) => (await sharp(b).metadata()).height));
const GAP = 14;
const total = heights.reduce((a, b) => a + b, 0) + GAP * (panels.length + 1);
let top = GAP;
const comps = panels.map((input, i) => {
  const c = { input, left: GAP, top };
  top += heights[i] + GAP;
  return c;
});
mkdirSync(dirname(out), { recursive: true });
await sharp({ create: { width: PANEL_W + GAP * 2, height: total, channels: 4, background: "#D9D6D0" } })
  .composite(comps)
  .png({ compressionLevel: 9 })
  .toFile(out);
// keep readFileSync import used for a quick size report
console.log(`wrote ${out} (${Math.round(readFileSync(out).length / 1024)} KB, ${STICKER_IDS.length} stickers)`);
