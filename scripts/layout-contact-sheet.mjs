#!/usr/bin/env node
// Layout contact sheet (M10b A5, extended M10c T7) — draws the GEOMETRY of one (style, orientation)
// set of layouts for visual review: trim, 3 mm bleed, 4 mm safe line; slots with their shape
// (slot-geometry shapePoints / polygonInPage / extendIntoBleed), rotation, frame (border band /
// polaroid card, photo area = photoRectOf), shadow hint and paint order (paintOrder, z); M10c
// decorations with the real sticker art (stickers.ts resolveStickerPaths via stickerSvg;
// "occasion-accent" → the --occasion's accent); texts[] boxes labelled with their bind (plates
// drawn with the plate art); spreads as two facing pages with the fold and its 8 mm text keep-out.
// Under each tile: id, role, photo count, twin, decoration count. Reads whatever is registered in
// src/lib/layouts (via jiti) — an empty list writes a "no layouts yet" sheet. PNG via sharp.
//
//   node scripts/layout-contact-sheet.mjs --style geometric --orientation portrait
//     → docs/design/layouts-geometric-portrait.png
//   flags: --style classic|modern|geometric|scrapbook (default modern)
//          --orientation portrait|landscape (default portrait; or --format A5_PORTRAIT|A5_LANDSCAPE)
//          --occasion wedding|travel|graduation|baby|family|other (default wedding)
//          --out <png> (default docs/design/layouts-<style>-<orientation>.png)
//          --layouts <file.ts> draw the Layout[] default/first array export of that module instead of
//            the catalogue (drafts / sheet self-check), still filtered by style + format
//
// Sheet-only lettering uses librsvg system fonts; in books, text is live text in the style fonts.

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
const orientationArg = arg("orientation", null);
if (orientationArg && orientationArg !== "portrait" && orientationArg !== "landscape") {
  console.error(`--orientation must be portrait or landscape (got ${orientationArg})`);
  process.exit(2);
}
const format = orientationArg ? (orientationArg === "landscape" ? "A5_LANDSCAPE" : "A5_PORTRAIT") : arg("format", "A5_PORTRAIT");
const style = arg("style", "modern");
const occasion = arg("occasion", "wedding");
const orientation = format === "A5_LANDSCAPE" ? "landscape" : "portrait";
const out = resolve(root, arg("out", `docs/design/layouts-${style}-${orientation}.png`));

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(root, "src") } });
const { LAYOUTS, BLEED_MM, SAFE_MM } = await jiti.import(resolve(root, "src/lib/layouts/index.ts"));
const { pageMm } = await jiti.import(resolve(root, "src/lib/book/format.ts"));
const geo = await jiti.import(resolve(root, "src/lib/book/slot-geometry.ts"));
const stickers = await jiti.import(resolve(root, "src/lib/design/stickers.ts"));
const { STICKERS, stickerSvg, resolveStickerId, plateInk } = stickers;

const FOLD_KEEP_OUT_MM = 8;
const PX = 1.6; // px per mm (same scale on both axes, so mm rotations = px rotations)
const PAD = 28; // around each card
const LABEL_H = 50; // under each card
const page = pageMm(format);
const layoutsFile = arg("layouts", null);
const source = layoutsFile
  ? Object.values(await jiti.import(resolve(process.cwd(), layoutsFile))).find(Array.isArray) ?? []
  : LAYOUTS;
const layouts = source.filter((l) => l.format === format && l.style === style);
const order = { cover: 0, page: 1, spread: 2 };
layouts.sort((a, b) => order[a.role] - order[b.role]);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n2 = (v) => Math.round(v * 100) / 100;
const BIND_LABEL = {
  chapterTitle: "CHAPTER TITLE",
  dateLabel: "date",
  pageCaption: "caption",
  coverTitle: "Cover title",
  coverSubtitle: "subtitle / year",
};
const SHADOW = { soft: { d: 0.8, a: 0.16 }, lifted: { d: 1.8, a: 0.24 } }; // mm offset, opacity

let clipSeq = 0;

/** A sticker's art fitted into px box r (stretched for plates — a plate fills its panel — else contain). */
function stickerArt(id, r, { tint, stretch } = {}) {
  const inner = stickerSvg(id, { tint, width: n2(r.w), height: n2(r.h) });
  return inner.replace("<svg ", `<svg x="${n2(r.x)}" y="${n2(r.y)}" preserveAspectRatio="${stretch ? "none" : "xMidYMid meet"}" `);
}

const rotAttr = (deg, r) => (deg ? ` transform="rotate(${deg} ${n2(r.x + r.w / 2)} ${n2(r.y + r.h / 2)})"` : "");

/** One layout card: returns { w, h, units, svg } with its own origin at 0,0. */
function card(l) {
  const pages = l.role === "spread" ? 2 : 1;
  const trimW = page.w * pages * PX;
  const trimH = page.h * PX;
  const b = BLEED_MM * PX;
  const ox = PAD + b;
  const oy = PAD + b;
  // layout units (% of one page; spreads x 0..200) → px
  const px = (x) => ox + (x / 100) * page.w * PX;
  const py = (y) => oy + (y / 100) * page.h * PX;
  const rx = (r) => ({ x: px(r.x), y: py(r.y), w: (r.w / 100) * page.w * PX, h: (r.h / 100) * page.h * PX });
  const bleedPct = { x: (BLEED_MM / page.w) * 100, y: (BLEED_MM / page.h) * 100 };
  const parts = [];

  // bleed + trim paper
  parts.push(`<rect x="${ox - b}" y="${oy - b}" width="${trimW + 2 * b}" height="${trimH + 2 * b}" fill="#fdf2f4" stroke="#e8a3b1" stroke-width="1" stroke-dasharray="3 3"/>`);
  parts.push(`<rect x="${ox}" y="${oy}" width="${trimW}" height="${trimH}" fill="#ffffff"/>`);
  if (pages === 2) parts.push(`<rect x="${px(100)}" y="${oy}" width="${page.w * PX}" height="${trimH}" fill="#fafaf8"/>`);

  // decorations
  const decos = (l.decorations ?? []).map((d, i) => {
    const r = rx(d.box);
    const sid = resolveStickerId(d.id, occasion);
    let art;
    if (sid) art = stickerArt(sid, r, { tint: d.tint, stretch: d.kind === "plate" });
    else art = `<rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.w)}" height="${n2(r.h)}" fill="none" stroke="#d62f2f" stroke-dasharray="3 2"/><text x="${n2(r.x + 2)}" y="${n2(r.y + 10)}" font-size="8" fill="#d62f2f">? ${esc(d.id)}</text>`;
    return { layer: d.layer, i, svg: `<g${rotAttr(d.rotate ?? 0, r)}>${art}</g>` };
  });
  for (const d of decos) if (d.layer === "under") parts.push(d.svg);

  // slots in paint order
  const orderIdx = geo.paintOrder(l);
  const zMarks = l.slots.some((s) => s.z !== undefined);
  for (const i of orderIdx) {
    const s = l.slots[i];
    const r = rx(s);
    const deg = s.rotate ?? 0;
    const shape = s.shape;
    const kind = shape?.kind ?? "rect";
    const framed = (s.frame?.kind ?? "none") !== "none";
    // bleed-extended render box for plain slots touching the trim (validation keeps framed/rotated/rounded off it)
    const touches = {
      l: s.x <= 0.01,
      t: s.y <= 0.01,
      r: s.x + s.w >= pages * 100 - 0.01,
      b: s.y + s.h >= 99.99,
    };
    const bleeds = !l.slices && !framed && !deg && (touches.l || touches.t || touches.r || touches.b);
    const render = bleeds
      ? {
          x: s.x - (touches.l ? bleedPct.x : 0),
          y: s.y - (touches.t ? bleedPct.y : 0),
          w: s.w + (touches.l ? bleedPct.x : 0) + (touches.r ? bleedPct.x : 0),
          h: s.h + (touches.t ? bleedPct.y : 0) + (touches.b ? bleedPct.y : 0),
        }
      : s;

    /** The slot's shape as an SVG element (px), drawn over the slot rect; polygons carried into the bleed box. */
    const shapeEl = (attrs, withBleed) => {
      const pts = geo.shapePoints(shape);
      if (pts) {
        let poly = geo.polygonInPage(pts, s);
        if (withBleed && bleeds) poly = geo.extendIntoBleed(poly, s, render);
        return `<polygon points="${poly.map((p) => `${n2(px(p.x))},${n2(py(p.y))}`).join(" ")}" ${attrs}/>`;
      }
      if (kind === "circle" || kind === "ellipse") {
        return `<ellipse cx="${n2(r.x + r.w / 2)}" cy="${n2(r.y + r.h / 2)}" rx="${n2(r.w / 2)}" ry="${n2(r.h / 2)}" ${attrs}/>`;
      }
      const rr = withBleed && bleeds ? rx(render) : r;
      const rad = kind === "rounded" ? Math.min(shape.r * PX, r.w / 2, r.h / 2) : 0;
      return `<rect x="${n2(rr.x)}" y="${n2(rr.y)}" width="${n2(rr.w)}" height="${n2(rr.h)}"${rad ? ` rx="${n2(rad)}" ry="${n2(rad)}"` : ""} ${attrs}/>`;
    };

    const g = [];
    const sh = SHADOW[s.shadow ?? "none"];
    if (sh) g.push(`<g transform="translate(${n2(sh.d * PX * 0.6)} ${n2(sh.d * PX)})">${shapeEl(`fill="#000" fill-opacity="${sh.a}"`, false)}</g>`);
    if (l.slices) {
      // Split-strip cover (A9): ONE photo over the slot box, shown only through the slices.
      g.push(`<rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.w)}" height="${n2(r.h)}" fill="none" stroke="#9e9e9e" stroke-dasharray="4 3"/>`);
      for (const sl of l.slices) {
        const q = rx(sl);
        g.push(`<rect x="${n2(q.x)}" y="${n2(q.y)}" width="${n2(q.w)}" height="${n2(q.h)}" fill="#9e9e9e"/>`);
      }
      g.push(`<text x="${n2(r.x + 4)}" y="${n2(r.y - 4)}" font-size="9" fill="#7a8b99">1 photo, ${l.slices.length} slices</text>`);
    } else {
      const id = `c${++clipSeq}`;
      parts.push(`<clipPath id="${id}">${shapeEl("", true)}</clipPath>`);
      if (bleeds) {
        const rb = rx(render);
        g.push(`<rect x="${n2(rb.x)}" y="${n2(rb.y)}" width="${n2(rb.w)}" height="${n2(rb.h)}" fill="#c9c9c9" clip-path="url(#${id})"/>`);
      }
      const inner = [];
      if (framed) {
        const fill = s.frame.kind === "polaroid" ? "#ffffff" : s.frame.hex;
        inner.push(`<rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.w)}" height="${n2(r.h)}" fill="${fill}"/>`);
      }
      const pr = rx(geo.photoRectOf(l, i, format) ?? s);
      inner.push(`<rect x="${n2(pr.x)}" y="${n2(pr.y)}" width="${n2(pr.w)}" height="${n2(pr.h)}" fill="#9e9e9e"/>`);
      g.push(`<g clip-path="url(#${id})">${inner.join("")}</g>`);
      if (kind !== "rect" || framed) g.push(shapeEl(`fill="none" stroke="${framed ? "#b8b8b8" : "#6f6f6f"}" stroke-width="0.8"`, false));
      // photo-area label at the photo rect centre
      const ar = (pr.w / pr.h).toFixed(2);
      const tag = [l.prefers[i] ?? "", ar, kind !== "rect" ? kind : "", deg ? `${deg}°` : "", zMarks ? `z${s.z ?? 0}` : ""].filter(Boolean).join(" ");
      g.push(`<text x="${n2(pr.x + pr.w / 2)}" y="${n2(pr.y + pr.h / 2)}" font-size="15" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle">${i + 1}</text>`);
      g.push(`<text x="${n2(pr.x + pr.w / 2)}" y="${n2(pr.y + pr.h / 2 + 15)}" font-size="9" fill="#f2f2f2" text-anchor="middle" dominant-baseline="middle">${esc(tag)}</text>`);
    }
    parts.push(`<g${rotAttr(deg, r)}>${g.join("")}</g>`);
  }

  for (const d of decos) if (d.layer === "over") parts.push(d.svg);

  // caption area (when not also a typed panel)
  const texts = l.texts ?? [];
  const same = (a, c) => Math.abs(a.x - c.x) < 1e-6 && Math.abs(a.y - c.y) < 1e-6 && Math.abs(a.w - c.w) < 1e-6 && Math.abs(a.h - c.h) < 1e-6;
  if (l.caption && !texts.some((t) => same(t.box, l.caption))) {
    const r = rx(l.caption);
    parts.push(`<rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.w)}" height="${n2(r.h)}" fill="none" stroke="#7a8b99" stroke-width="1" stroke-dasharray="2 2"/>`);
    if (l.role !== "cover") parts.push(`<text x="${n2(r.x + 3)}" y="${n2(r.y + 10)}" font-size="9" fill="#7a8b99">caption</text>`);
  }
  // text panels (plates with their art; label inside the plate's textBox)
  for (const t of texts) {
    const r = rx(t.box);
    const g = [];
    let tb = r;
    let ink = "#8a5200";
    const plateId = t.plate ? resolveStickerId(t.plate.id, occasion) : undefined;
    if (plateId) {
      g.push(stickerArt(plateId, r, { tint: t.plate.tint, stretch: true }));
      const box = STICKERS[plateId].textBox;
      if (box) tb = { x: r.x + (box.x / 100) * r.w, y: r.y + (box.y / 100) * r.h, w: (box.w / 100) * r.w, h: (box.h / 100) * r.h };
      ink = plateInk(plateId, t.plate.tint) === "light" ? "#ffffff" : "#262626";
      g.push(`<rect x="${n2(tb.x)}" y="${n2(tb.y)}" width="${n2(tb.w)}" height="${n2(tb.h)}" fill="none" stroke="${ink}" stroke-opacity="0.35" stroke-width="0.6" stroke-dasharray="2 2"/>`);
    } else {
      if (t.plate) g.push(`<text x="${n2(r.x)}" y="${n2(r.y - 3)}" font-size="8" fill="#d62f2f">? plate ${esc(t.plate.id)}</text>`);
      g.push(`<rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.w)}" height="${n2(r.h)}" fill="#fff4e0" fill-opacity="0.85" stroke="#e08a00" stroke-width="1"/>`);
    }
    const anchor = t.align === "start" ? "start" : t.align === "end" ? "end" : "middle";
    const tx = anchor === "start" ? tb.x + 3 : anchor === "end" ? tb.x + tb.w - 3 : tb.x + tb.w / 2;
    const size = Math.max(7, Math.min(13, tb.h * 0.55));
    g.push(`<text x="${n2(tx)}" y="${n2(tb.y + tb.h / 2)}" font-size="${n2(size)}" fill="${ink}" text-anchor="${anchor}" dominant-baseline="middle">${esc(BIND_LABEL[t.bind] ?? t.bind)} · ${esc(t.font)}</text>`);
    parts.push(`<g${rotAttr(t.rotate ?? 0, r)}>${g.join("")}</g>`);
  }
  // safe line (per page)
  const sf = SAFE_MM * PX;
  for (let p = 0; p < pages; p++) {
    const x0 = ox + p * page.w * PX;
    parts.push(`<rect x="${n2(x0 + sf)}" y="${n2(oy + sf)}" width="${n2(page.w * PX - 2 * sf)}" height="${n2(trimH - 2 * sf)}" fill="none" stroke="#2f7de1" stroke-width="0.8" stroke-dasharray="4 3" opacity="0.7"/>`);
  }
  // trim outline
  parts.push(`<rect x="${ox}" y="${oy}" width="${trimW}" height="${trimH}" fill="none" stroke="#222" stroke-width="1"/>`);
  if (l.role === "spread") {
    const fx = px(100);
    const k = FOLD_KEEP_OUT_MM * PX;
    parts.push(`<rect x="${n2(fx - k)}" y="${oy}" width="${n2(2 * k)}" height="${trimH}" fill="#d62f2f" opacity="0.07"/>`);
    parts.push(`<line x1="${n2(fx)}" y1="${n2(oy - b)}" x2="${n2(fx)}" y2="${n2(oy + trimH + b)}" stroke="#d62f2f" stroke-width="1.2" stroke-dasharray="6 3"/>`);
  }
  // label under the tile
  const ly = oy + trimH + b + 18;
  const extras = [l.twin ? `twin ${l.twin.join(" + ")}` : "", l.decorations?.length ? `${l.decorations.length} deco` : ""].filter(Boolean).join(" · ");
  parts.push(`<text x="${PAD}" y="${n2(ly)}" font-size="14" font-weight="700" fill="#111">${esc(l.id)}</text>`);
  parts.push(`<text x="${PAD}" y="${n2(ly + 18)}" font-size="11" fill="#555">${esc(l.role)} · ${l.photoCount} photo${l.photoCount === 1 ? "" : "s"}${extras ? ` · ${esc(extras)}` : ""}</text>`);
  const w = trimW + 2 * b + 2 * PAD;
  const h = trimH + 2 * b + 2 * PAD + LABEL_H;
  return { w, h, units: pages, svg: parts.join("\n") };
}

// Flow layout: rows of up to COLS single-page units (spreads take 2); new row per role.
const COLS = orientation === "portrait" ? 4 : 3;
const singleW = page.w * PX + 2 * BLEED_MM * PX + 2 * PAD;
const cards = layouts.map((l) => ({ ...card(l), role: l.role }));
const rows = [];
let row = [];
let used = 0;
for (const c of cards) {
  const prevRole = row.length ? row[row.length - 1].role : null;
  if (used + c.units > COLS || (prevRole && prevRole !== c.role)) {
    rows.push(row);
    row = [];
    used = 0;
  }
  row.push(c);
  used += c.units;
}
if (row.length) rows.push(row);

const HEADER = 100;
const width = Math.ceil(singleW * COLS);
let y = HEADER;
const body = [];
for (const r of rows) {
  let x = 0;
  for (const c of r) {
    body.push(`<g transform="translate(${n2(x)},${n2(y)})">${c.svg}</g>`);
    x += singleW * c.units;
  }
  y += Math.max(...r.map((c) => c.h));
}
if (layouts.length === 0) {
  body.push(`<text x="24" y="${HEADER + 40}" font-size="18" fill="#888">No ${esc(style)} ${esc(orientation)} layouts registered yet.</text>`);
  y += 70;
}
const height = Math.ceil(y + 12);
const legend = [
  ["#9e9e9e", "photo area (n = slot order · prefers · aspect · shape · tilt · z)"],
  ["#c9c9c9", "3 mm bleed extension"],
  ["#fff4e0", "text panel (bind · font role)"],
].map(([c, t], i) => `<rect x="${24 + i * 420}" y="56" width="14" height="14" fill="${c}" stroke="#999"/><text x="${44 + i * 420}" y="67" font-size="12" fill="#333">${esc(t)}</text>`);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Helvetica, Arial, sans-serif">
<rect width="100%" height="100%" fill="#f4f4f2"/>
<text x="24" y="36" font-size="22" font-weight="700" fill="#111">${esc(style)} · ${esc(format)} (${page.w}×${page.h} mm) — ${layouts.length} layouts · accent = ${esc(occasion)}</text>
${legend.join("\n")}
<text x="24" y="91" font-size="12" fill="#333">blue dashed = ${SAFE_MM} mm safe · red dashed = fold (shaded ±${FOLD_KEEP_OUT_MM} mm, no text) · grey offset = shadow · white card = polaroid · stickers/plates = real art</text>
${body.join("\n")}
</svg>`;

mkdirSync(dirname(out), { recursive: true });
await sharp(Buffer.from(svg), { density: 144 }).png({ compressionLevel: 9 }).toFile(out);
console.log(`wrote ${out} (${layouts.length} layouts, ${width}×${height} @2x)`);
