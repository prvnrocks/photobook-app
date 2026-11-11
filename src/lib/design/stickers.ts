// Sticker catalogue (M10c T2, D-068): our own original sticker artwork as pure data — SVG path
// geometry + paints, no markup. Shared by the layout schema (decoration ids), the renderer
// (src/components/book/Decoration.tsx, editor/viewer/print alike) and the review sheet
// (scripts/sticker-sheet.mjs → docs/design/m10c-stickers.png). Client-safe, no imports at runtime.
//
// Print rules (lessons 2026-11-10): paths + flat paints only. No <filter> (Chromium rasterises the
// subtree in PDF), no <image>, no <text> (labels are live text drawn by the renderer over a
// plate's `textBox`), no gradients or external refs. Translucency (tape) = an rgba paint, which
// prints as vector transparency. tests/design-stickers.test.ts enforces all of this.
//
// Tint: a paint is either a fixed "#RRGGBB" or a tint token `{ tint: k }` — the decoration's tint
// colour (or the sticker's `defaultTint`) mixed toward white (k > 0) or black (k < 0). Stickers
// with `tintable: false` ignore the tint (photo corners are tintable, paperclips are not, ...).

import type { Occasion } from "@/lib/book/options";

// --- types ---------------------------------------------------------------------------------------

/** "#RRGGBB", or the tint mixed toward white (k > 0) / black (k < 0), |k| ≤ 1. */
export type StickerPaint = string | { tint: number };

export interface StickerPath {
  d: string;
  fill?: StickerPaint | "none";
  /** Fill opacity 0..1, folded into an rgba() fill. */
  alpha?: number;
  fillRule?: "nonzero" | "evenodd";
  stroke?: StickerPaint;
  strokeAlpha?: number;
  /** In viewBox units. */
  strokeWidth?: number;
  dash?: readonly number[];
  linecap?: "butt" | "round";
  linejoin?: "miter" | "round";
}

export type StickerGroup = "neutral" | "accent" | "seasonal";
/** Matches the layout decoration kinds (sticker | tape | plate). */
export type StickerKind = "sticker" | "tape" | "plate";

export interface StickerDef {
  id: string;
  label: string;
  group: StickerGroup;
  kind: StickerKind;
  /** [minX, minY, width, height]; the natural aspect is width / height. */
  viewBox: readonly [number, number, number, number];
  tintable: boolean;
  /** Tint used when the decoration sets none. */
  defaultTint: string;
  /** A few tints that look good (pickers, sheet). The first is `defaultTint`. */
  suggestedTints: readonly string[];
  paths: readonly StickerPath[];
  /** Plates only: where the bound live text goes, % of the viewBox. */
  textBox?: { x: number; y: number; w: number; h: number };
  /** Accent stickers: the occasion they belong to. */
  occasion?: Occasion;
}

// --- geometry helpers (run once at module load; output is plain path strings) --------------------

const r2 = (n: number) => Math.round(n * 100) / 100;
const pt = (x: number, y: number) => `${r2(x)} ${r2(y)}`;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Full circle as two arcs. */
function circle(cx: number, cy: number, r: number): string {
  return `M${pt(cx - r, cy)}A${r2(r)} ${r2(r)} 0 1 0 ${pt(cx + r, cy)}A${r2(r)} ${r2(r)} 0 1 0 ${pt(cx - r, cy)}Z`;
}

/** n-point star with softened inner corners (quadratic through the inner vertex). */
function star(cx: number, cy: number, outer: number, inner: number, n = 5, rotDeg = -90, soft = 0): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rad(rotDeg + (i * 180) / n);
    const rr = i % 2 === 0 ? outer : inner;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  if (soft <= 0) return `M${pts.map(([x, y]) => pt(x, y)).join("L")}Z`;
  // Round each outer tip: approach it to `soft` of the edge, curve through the tip.
  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let d = "";
  for (let i = 0; i < pts.length; i += 2) {
    const tip = pts[i];
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[i + 1];
    const a = lerp(tip, prev, soft);
    const b = lerp(tip, next, soft);
    d += `${i === 0 ? "M" : "L"}${pt(...a)}Q${pt(...tip)} ${pt(...b)}L${pt(...next)}`;
  }
  return `${d}Z`;
}

/** Four-point twinkle with concave sides. */
function twinkle(cx: number, cy: number, r: number, pinch = 0.12): string {
  const p = r * pinch;
  return (
    `M${pt(cx, cy - r)}Q${pt(cx + p, cy - p)} ${pt(cx + r, cy)}Q${pt(cx + p, cy + p)} ${pt(cx, cy + r)}` +
    `Q${pt(cx - p, cy + p)} ${pt(cx - r, cy)}Q${pt(cx - p, cy - p)} ${pt(cx, cy - r)}Z`
  );
}

/** Almond (leaf / petal) from base point, length + width, pointing at `angleDeg`. */
function almond(bx: number, by: number, len: number, width: number, angleDeg: number, bulge = 0.5): string {
  const a = rad(angleDeg);
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const tx = bx + ux * len;
  const ty = by + uy * len;
  const mx = bx + ux * len * bulge;
  const my = by + uy * len * bulge;
  const w = width; // control-point offset ≈ 2 × half-width for a quadratic
  return `M${pt(bx, by)}Q${pt(mx - uy * w, my + ux * w)} ${pt(tx, ty)}Q${pt(mx + uy * w, my - ux * w)} ${pt(bx, by)}Z`;
}

/** Centre line of an almond (leaf vein), as an open path for a stroke. */
function vein(bx: number, by: number, len: number, angleDeg: number, k = 0.78): string {
  const a = rad(angleDeg);
  return `M${pt(bx, by)}L${pt(bx + Math.cos(a) * len * k, by + Math.sin(a) * len * k)}`;
}

/** Ring sector between angles a1 → a2 (degrees, clockwise in SVG space). */
function ringSector(cx: number, cy: number, R: number, r: number, a1: number, a2: number): string {
  const p = (rr: number, a: number) => pt(cx + rr * Math.cos(rad(a)), cy + rr * Math.sin(rad(a)));
  const large = Math.abs(a2 - a1) > 180 ? 1 : 0;
  return `M${p(R, a1)}A${R} ${R} 0 ${large} 1 ${p(R, a2)}L${p(r, a2)}A${r} ${r} 0 ${large} 0 ${p(r, a1)}Z`;
}

/** Crescent = disc (cx, cy, R) minus disc (ix, iy, ri); the two circles must intersect. */
function crescent(cx: number, cy: number, R: number, ix: number, iy: number, ri: number): string {
  const dx = ix - cx;
  const dy = iy - cy;
  const d = Math.hypot(dx, dy);
  const a = (R * R - ri * ri + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, R * R - a * a));
  const mx = cx + (a * dx) / d;
  const my = cy + (a * dy) / d;
  const p1: [number, number] = [mx + (h * dy) / d, my - (h * dx) / d];
  const p2: [number, number] = [mx - (h * dy) / d, my + (h * dx) / d];
  // Outer arc the long way round (away from the inner disc), inner arc back.
  return `M${pt(...p1)}A${r2(R)} ${r2(R)} 0 1 0 ${pt(...p2)}A${r2(ri)} ${r2(ri)} 0 0 1 ${pt(...p1)}Z`;
}

/** Heart in a 100 × 90 box, offset + scaled. Slightly asymmetric so it reads hand-cut. */
function heart(ox: number, oy: number, s: number): string {
  const P = (x: number, y: number) => pt(ox + x * s, oy + y * s);
  return (
    `M${P(50, 86)}C${P(22, 66)} ${P(3, 47)} ${P(4, 27)}C${P(5, 11)} ${P(19, 2)} ${P(32, 3)}` +
    `C${P(42, 4)} ${P(48, 11)} ${P(50, 19)}C${P(53, 10)} ${P(60, 3)} ${P(70, 3)}` +
    `C${P(83, 3)} ${P(96, 12)} ${P(96, 28)}C${P(96, 48)} ${P(78, 66)} ${P(50, 86)}Z`
  );
}

/** Rounded rectangle. */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${pt(x + r, y)}H${r2(x + w - r)}A${r} ${r} 0 0 1 ${pt(x + w, y + r)}V${r2(y + h - r)}` +
    `A${r} ${r} 0 0 1 ${pt(x + w - r, y + h)}H${r2(x + r)}A${r} ${r} 0 0 1 ${pt(x, y + h - r)}` +
    `V${r2(y + r)}A${r} ${r} 0 0 1 ${pt(x + r, y)}Z`
  );
}

/** Deterministic jitter (no Math.random: the catalogue must be identical on every load). */
function jitter(i: number, amp: number): number {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 2 * amp;
}

/** Tape strip w × h with torn (zig-zag) ends. */
function tornTape(w: number, h: number, tooth: number, depth: number, seed: number): string {
  const n = Math.max(3, Math.round(h / tooth));
  let d = `M${pt(depth, 0)}`;
  // top edge: a gentle wobble
  for (let i = 1; i <= 6; i++) d += `L${pt(depth + ((w - 2 * depth) * i) / 6, jitter(seed + i, 0.5) + 0.5)}`;
  // right end, top → bottom
  for (let i = 1; i <= n; i++) d += `L${pt(w - depth + (i % 2 ? depth : 0) + jitter(seed + 20 + i, depth * 0.3) - (i % 2 ? depth * 0.3 : 0), (h * i) / n)}`;
  // bottom edge
  for (let i = 5; i >= 0; i--) d += `L${pt(depth + ((w - 2 * depth) * i) / 6, h - 0.5 + jitter(seed + 40 + i, 0.5))}`;
  // left end, bottom → top
  for (let i = n - 1; i >= 0; i--) d += `L${pt((i % 2 ? 0 : depth) + jitter(seed + 60 + i, depth * 0.3) + (i % 2 ? depth * 0.3 : 0), (h * i) / n)}`;
  return `${d}Z`;
}

// --- catalogue -----------------------------------------------------------------------------------

const T = (k = 0): { tint: number } => ({ tint: k });

const KRAFT = "#B98A5E";
const GOLD = "#C9A24B";
const INK = "#2A2A2E";

const STICKER_LIST = [
  // ---- neutral: tapes --------------------------------------------------------------------------
  {
    id: "tape-washi",
    label: "Washi tape",
    group: "neutral",
    kind: "tape",
    viewBox: [0, 0, 120, 30],
    tintable: true,
    defaultTint: "#E9D9B6",
    suggestedTints: ["#E9D9B6", "#E8B9B4", "#BFD3C6", "#C7D6E8"],
    paths: [
      { d: tornTape(120, 30, 4, 2.6, 1), fill: T(0), alpha: 0.72 },
      // fibre sheen + a darker lower edge give the paper body
      { d: "M4 3.2H116V8.5H4Z", fill: "#FFFFFF", alpha: 0.22 },
      { d: "M4 25H116V27H4Z", fill: T(-0.25), alpha: 0.18 },
    ],
  },
  {
    id: "tape-striped",
    label: "Striped tape",
    group: "neutral",
    kind: "tape",
    viewBox: [0, 0, 120, 30],
    tintable: true,
    defaultTint: "#E3A9A6",
    suggestedTints: ["#E3A9A6", "#9DB8CF", "#A9C0A0", "#D9B87A"],
    paths: [
      { d: "M6 0H120L114 30H0Z", fill: "#FBF7F0", alpha: 0.7 },
      ...[12, 30, 48, 66, 84, 102].map((x) => ({ d: `M${x + 4} 0H${x + 12}L${x + 6} 30H${x - 2}Z`, fill: T(0), alpha: 0.62 })),
      { d: "M5.2 3H118.6L118 5.6H4.6Z", fill: "#FFFFFF", alpha: 0.3 },
    ],
  },
  {
    id: "tape-kraft",
    label: "Kraft tape",
    group: "neutral",
    kind: "tape",
    viewBox: [0, 0, 90, 28],
    tintable: true,
    defaultTint: "#C9A578",
    suggestedTints: ["#C9A578", "#D8C7A8", "#A88B6C"],
    paths: [
      { d: tornTape(90, 28, 2.6, 2.2, 7), fill: T(0), alpha: 0.82 },
      // paper fibres
      ...[
        [10, 7, 34],
        [18, 15, 52],
        [40, 9, 28],
        [56, 20, 22],
        [64, 12, 18],
      ].map(([x, y, w]) => ({ d: `M${x} ${y}h${w}`, stroke: T(-0.22), strokeAlpha: 0.35, strokeWidth: 0.6, linecap: "round" as const })),
    ],
  },
  // ---- neutral: hearts -------------------------------------------------------------------------
  {
    id: "heart-kraft",
    label: "Kraft heart",
    group: "neutral",
    kind: "sticker",
    viewBox: [0, 0, 100, 90],
    tintable: true,
    defaultTint: KRAFT,
    suggestedTints: [KRAFT, "#C76B6B", "#D9A3A0", "#8F9E7A"],
    paths: [
      { d: heart(0, 0, 1), fill: T(0) },
      // a running stitch just inside the edge, a soft shine on the left lobe
      { d: heart(8, 8.5, 0.84), fill: "none", stroke: T(0.55), strokeWidth: 1.6, dash: [4, 3], linecap: "round" },
      { d: "M17 30C17 22 22 17 29 16", fill: "none", stroke: "#FFFFFF", strokeAlpha: 0.45, strokeWidth: 3.2, linecap: "round" },
    ],
  },
  {
    id: "heart-outline",
    label: "Cut-out heart",
    group: "neutral",
    kind: "sticker",
    viewBox: [0, 0, 100, 90],
    tintable: true,
    defaultTint: "#B65A4E",
    suggestedTints: ["#B65A4E", KRAFT, "#2A2A2E", "#D49A93"],
    paths: [
      // hand-cut ring: the inner heart is off-centre so the border thickness varies
      { d: `${heart(0, 0, 1)}${heart(13, 13.5, 0.75)}`, fill: T(0), fillRule: "evenodd" },
      { d: "M14 14C22 8 32 8 38 13", fill: "none", stroke: T(0.45), strokeAlpha: 0.7, strokeWidth: 1.4, linecap: "round" },
    ],
  },
  // ---- neutral: star, sparkle, leaf, flower ----------------------------------------------------
  {
    id: "star",
    label: "Star",
    group: "neutral",
    kind: "sticker",
    viewBox: [0, 0, 100, 96],
    tintable: true,
    defaultTint: "#D9A84E",
    suggestedTints: ["#D9A84E", "#E3A9A6", "#9DB8CF", "#FFFFFF"],
    paths: [
      { d: star(50, 52, 48, 21, 5, -90, 0.16), fill: T(0) },
      // one bevelled half reads like folded paper
      { d: `M50 52L${pt(50, 4)}L${pt(50 + 21 * Math.cos(rad(-54)), 52 + 21 * Math.sin(rad(-54)))}L${pt(50 + 48 * Math.cos(rad(-18)), 52 + 48 * Math.sin(rad(-18)))}Z`, fill: T(0.3), alpha: 0.6 },
    ],
  },
  {
    id: "sparkle",
    label: "Sparkle",
    group: "neutral",
    kind: "sticker",
    viewBox: [0, 0, 100, 100],
    tintable: true,
    defaultTint: "#D9A84E",
    suggestedTints: ["#D9A84E", "#FFFFFF", "#2A2A2E", "#B65A4E"],
    paths: [
      { d: twinkle(42, 56, 40), fill: T(0) },
      { d: twinkle(80, 18, 14), fill: T(0.15) },
      { d: circle(84, 52, 3.4), fill: T(0) },
    ],
  },
  {
    id: "leaf-sprig",
    label: "Leaf sprig",
    group: "neutral",
    kind: "sticker",
    viewBox: [0, 0, 70, 120],
    tintable: true,
    defaultTint: "#7E9A6E",
    suggestedTints: ["#7E9A6E", "#A9BFA0", KRAFT, "#5B7A73"],
    paths: [
      { d: "M33 118C31 92 32 60 38 30C41 18 44 10 47 4", fill: "none", stroke: T(-0.25), strokeWidth: 2.2, linecap: "round" },
      ...(
        [
          [33.2, 100, 26, 9, 200],
          [33.4, 92, 27, 9.5, -20],
          [34, 78, 26, 9, 205],
          [35, 68, 25, 9, -25],
          [36.6, 54, 23, 8.5, 210],
          [38.4, 44, 22, 8, -30],
          [41, 30, 19, 7, 220],
          [43.5, 20, 17, 6.5, -35],
        ] as const
      ).flatMap(([x, y, len, w, a], i) => [
        { d: almond(x, y, len, w, a, 0.45), fill: T(i % 2 ? 0.12 : 0) },
        { d: vein(x, y, len, a), fill: "none" as const, stroke: T(-0.28), strokeAlpha: 0.7, strokeWidth: 0.9, linecap: "round" as const },
      ]),
      { d: almond(47, 4, 14, 5, -70, 0.45), fill: T(0.2) },
    ],
  },
  {
    id: "flower",
    label: "Flower",
    group: "neutral",
    kind: "sticker",
    viewBox: [0, 0, 100, 100],
    tintable: true,
    defaultTint: "#E3A39A",
    suggestedTints: ["#E3A39A", "#F2EBDD", "#C7B8DE", "#E8C46B"],
    paths: [
      ...[0, 72, 144, 216, 288].map((a) => ({ d: almond(50, 50, 46, 30, a - 90, 0.6), fill: T(0) })),
      ...[36, 108, 180, 252, 324].map((a) => ({ d: almond(50, 50, 30, 12, a - 90, 0.55), fill: T(0.4), alpha: 0.7 })),
      ...[0, 72, 144, 216, 288].map((a) => ({ d: vein(50, 50, 40, a - 90, 0.7), fill: "none" as const, stroke: T(-0.2), strokeAlpha: 0.45, strokeWidth: 1, linecap: "round" as const })),
      { d: circle(50, 50, 11), fill: "#E2B04A" },
      { d: circle(47, 47, 3.6), fill: "#F3D58A" },
      ...[0, 60, 120, 180, 240, 300].map((a) => ({ d: circle(50 + 6.5 * Math.cos(rad(a)), 50 + 6.5 * Math.sin(rad(a)), 1.3), fill: "#A8742C" })),
    ],
  },
  // ---- neutral: paperclip, photo corner --------------------------------------------------------
  {
    id: "paperclip",
    label: "Paperclip",
    group: "neutral",
    kind: "sticker",
    viewBox: [0, 0, 32, 96],
    tintable: true,
    defaultTint: "#9AA0A8",
    suggestedTints: ["#9AA0A8", GOLD, "#C8746B", "#2A2A2E"],
    paths: [
      { d: "M11 34V74A5 5 0 0 0 21 74V16A8 8 0 0 0 5 16V78A11 11 0 0 0 27 78V30", fill: "none", stroke: T(-0.15), strokeWidth: 3.2, linecap: "round", linejoin: "round" },
      { d: "M11 34V74A5 5 0 0 0 21 74V16A8 8 0 0 0 5 16V78A11 11 0 0 0 27 78V30", fill: "none", stroke: T(0.5), strokeAlpha: 0.8, strokeWidth: 1, linecap: "round", linejoin: "round" },
    ],
  },
  {
    id: "photo-corner",
    label: "Photo corner",
    group: "neutral",
    kind: "sticker",
    // Top-left corner; layouts place four, rotated 0 / 90 / 180 / 270°.
    viewBox: [0, 0, 40, 40],
    tintable: true,
    defaultTint: INK,
    suggestedTints: [INK, KRAFT, "#F4EEE2", GOLD],
    paths: [
      { d: "M0 2A2 2 0 0 1 2 0H40L0 40Z", fill: T(0) },
      { d: "M36 2.6L2.6 36", fill: "none", stroke: T(0.5), strokeAlpha: 0.55, strokeWidth: 1, linecap: "round" },
      { d: "M6 0.8H34", fill: "none", stroke: "#FFFFFF", strokeAlpha: 0.18, strokeWidth: 1.2, linecap: "round" },
    ],
  },
  // ---- neutral: label plates (text drawn live by the renderer inside textBox) ------------------
  {
    id: "plate-label",
    label: "Label strip",
    group: "neutral",
    kind: "plate",
    viewBox: [0, 0, 140, 30],
    tintable: true,
    defaultTint: "#232326",
    suggestedTints: ["#232326", "#F7F3EA", "#6A2333", "#235A5E"],
    paths: [
      { d: roundRect(0, 0, 140, 30, 5), fill: T(0) },
      { d: roundRect(3, 3, 134, 24, 3.4), fill: "none", stroke: T(0.22), strokeAlpha: 0.9, strokeWidth: 0.7 },
      { d: `${circle(8.5, 15, 2)}${circle(131.5, 15, 2)}`, fill: T(0.35) },
      { d: `${circle(8.1, 14.6, 0.8)}${circle(131.1, 14.6, 0.8)}`, fill: "#FFFFFF", alpha: 0.5 },
    ],
    textBox: { x: 11, y: 12, w: 78, h: 76 },
  },
  {
    id: "plate-tag",
    label: "Paper tag",
    group: "neutral",
    kind: "plate",
    viewBox: [0, 0, 140, 40],
    tintable: true,
    defaultTint: "#F4ECDC",
    suggestedTints: ["#F4ECDC", "#FFFFFF", "#E8D3B0", "#DCE6EE"],
    paths: [
      // tag with a clipped point on the left and an eyelet
      { d: "M18 0H136A4 4 0 0 1 140 4V36A4 4 0 0 1 136 40H18L0 20Z", fill: T(0) },
      { d: "M19.6 3.5H134.5A2 2 0 0 1 136.5 5.5V34.5A2 2 0 0 1 134.5 36.5H19.6L4.6 20Z", fill: "none", stroke: T(-0.28), strokeWidth: 0.8, dash: [3, 2.4] },
      { d: circle(15, 20, 4.4), fill: T(-0.18) },
      { d: circle(15, 20, 2.6), fill: "#FFFFFF", alpha: 0.85 },
    ],
    textBox: { x: 22, y: 14, w: 72, h: 72 },
  },
  // ---- accents (one per occasion, picked from doc.occasion) ------------------------------------
  {
    id: "accent-rings",
    label: "Rings",
    group: "accent",
    occasion: "wedding",
    kind: "sticker",
    viewBox: [0, 0, 110, 90],
    tintable: true,
    defaultTint: GOLD,
    suggestedTints: [GOLD, "#C9CDD3", "#D8A79A"],
    paths: [
      { d: `${circle(40, 56, 28)}${circle(40, 56, 22.5)}`, fill: T(0), fillRule: "evenodd" },
      { d: `${circle(70, 56, 28)}${circle(70, 56, 22.5)}`, fill: T(-0.12), fillRule: "evenodd" },
      // ring A passes over ring B at the bottom crossing: interlocked
      { d: ringSector(40, 56, 28, 22.5, 20, 52), fill: T(0) },
      { d: ringSector(40, 56, 26.5, 24.6, 200, 300), fill: T(0.5), alpha: 0.7 },
      { d: ringSector(70, 56, 26.5, 24.6, 210, 290), fill: T(0.4), alpha: 0.6 },
      // a small stone on ring A
      { d: "M40 20L48 26L40 34L32 26Z", fill: "#EAF1F6" },
      { d: "M40 20L48 26H32Z", fill: "#FFFFFF" },
      { d: "M40 34L48 26H40Z", fill: "#BFD0DC" },
      { d: "M35.5 27.5L32 26L40 34Z", fill: "#D5E1EA" },
      { d: twinkle(88, 18, 7), fill: T(0.25) },
    ],
  },
  {
    id: "accent-plane",
    label: "Paper plane",
    group: "accent",
    occasion: "travel",
    kind: "sticker",
    viewBox: [0, 0, 120, 70],
    tintable: true,
    defaultTint: "#4F7FA6",
    suggestedTints: ["#4F7FA6", "#B65A4E", "#2A2A2E", KRAFT],
    paths: [
      { d: "M4 64C16 64 22 54 32 52C42 50 44 58 52 52C58 47 62 38 74 32", fill: "none", stroke: T(0), strokeAlpha: 0.75, strokeWidth: 1.6, dash: [4, 4], linecap: "round" },
      { d: "M118 4L70 26L84 34Z", fill: T(0.55) },
      { d: "M118 4L84 34L92 52Z", fill: T(0) },
      { d: "M84 34L92 52L88 38Z", fill: T(-0.3) },
      { d: "M118 4L70 26L78 28Z", fill: T(0.2) },
    ],
  },
  {
    id: "accent-cap",
    label: "Graduation cap",
    group: "accent",
    occasion: "graduation",
    kind: "sticker",
    viewBox: [0, 0, 110, 90],
    tintable: true,
    defaultTint: "#25304A",
    suggestedTints: ["#25304A", INK, "#6A2333", "#235A5E"],
    paths: [
      { d: "M28 40V58C28 66 82 66 82 58V40Z", fill: T(-0.15) },
      { d: "M28 52C40 58 70 58 82 52V58C82 66 28 66 28 58Z", fill: T(-0.32) },
      { d: "M55 14L106 34L55 54L4 34Z", fill: T(0) },
      { d: "M55 14L106 34L55 24L4 34Z", fill: T(0.22) },
      { d: circle(55, 33, 3), fill: "#D9A84E" },
      { d: "M55 33C70 36 82 40 88 44V66", fill: "none", stroke: "#D9A84E", strokeWidth: 1.8, linecap: "round", linejoin: "round" },
      { d: "M84.5 64H91.5L93 82C90 85 86 85 83 82Z", fill: "#D9A84E" },
      { d: "M86 68V81M88 68V82M90 68V81", fill: "none", stroke: "#B48633", strokeWidth: 0.7 },
      { d: roundRect(84, 62, 8, 4, 1.5), fill: "#B48633" },
    ],
  },
  {
    id: "accent-moon",
    label: "Moon and star",
    group: "accent",
    occasion: "baby",
    kind: "sticker",
    viewBox: [0, 0, 100, 100],
    tintable: true,
    defaultTint: "#F0CF7A",
    suggestedTints: ["#F0CF7A", "#C7D6E8", "#E8B9B4", "#FFFFFF"],
    paths: [
      // plump crescent, a star hanging on a thread, a cloud puff
      { d: crescent(42, 46, 34, 60, 34, 28), fill: T(0) },
      { d: crescent(42, 46, 30, 58, 36, 27), fill: T(0.35), alpha: 0.6 },
      { d: "M78 4V40", fill: "none", stroke: "#B9A27A", strokeWidth: 0.9 },
      { d: star(78, 48, 10, 4.6, 5, -90, 0.2), fill: T(-0.08) },
      {
        d: "M30 92C22 92 18 86 22 81C22 74 32 72 36 77C39 70 52 70 54 78C61 76 68 82 63 88C62 91 58 92 55 92Z",
        fill: "#FFFFFF",
      },
      {
        d: "M30 92C22 92 18 86 22 81C22 74 32 72 36 77C39 70 52 70 54 78C61 76 68 82 63 88C62 91 58 92 55 92Z",
        fill: "none",
        stroke: "#C7D6E8",
        strokeWidth: 1.4,
      },
      { d: twinkle(88, 76, 5), fill: T(-0.05) },
    ],
  },
  {
    id: "accent-house",
    label: "Home",
    group: "accent",
    occasion: "family",
    kind: "sticker",
    viewBox: [0, 0, 100, 96],
    tintable: true,
    defaultTint: "#C17A5B",
    suggestedTints: ["#C17A5B", "#7E9A6E", "#4F7FA6", KRAFT],
    paths: [
      { d: "M66 14H76V34L66 26Z", fill: T(-0.3) },
      { d: "M14 46V90A4 4 0 0 0 18 94H82A4 4 0 0 0 86 90V46L50 18Z", fill: "#F6EEE2" },
      { d: "M14 46V90A4 4 0 0 0 18 94H82A4 4 0 0 0 86 90V46L50 18Z", fill: "none", stroke: T(-0.2), strokeWidth: 2 },
      { d: "M4 46L50 8L96 46L90 52L50 20L10 52Z", fill: T(0) },
      { d: "M4 46L50 8L56 13L10 52Z", fill: T(0.2) },
      // door with a heart window
      { d: "M40 94V66A10 10 0 0 1 60 66V94Z", fill: T(-0.08) },
      { d: heart(43.5, 64, 0.13), fill: "#F6EEE2" },
      { d: circle(56, 81, 1.4), fill: "#F6EEE2" },
      { d: roundRect(22, 56, 12, 12, 1.5), fill: "#BFD3DF" },
      { d: roundRect(66, 56, 12, 12, 1.5), fill: "#BFD3DF" },
      { d: "M28 56V68M22 62H34M72 56V68M66 62H78", fill: "none", stroke: "#F6EEE2", strokeWidth: 1.4 },
    ],
  },
  {
    id: "accent-sparkles",
    label: "Sparkles",
    group: "accent",
    occasion: "other",
    kind: "sticker",
    viewBox: [0, 0, 100, 100],
    tintable: true,
    defaultTint: "#D9A84E",
    suggestedTints: ["#D9A84E", "#B65A4E", "#4F7FA6", INK],
    paths: [
      { d: twinkle(36, 62, 32, 0.1), fill: T(0) },
      { d: twinkle(76, 30, 20, 0.1), fill: T(0.2) },
      { d: twinkle(78, 80, 11, 0.1), fill: T(-0.1) },
      { d: `${circle(18, 18, 3)}${circle(56, 10, 2)}${circle(92, 56, 2.4)}`, fill: T(0) },
    ],
  },
  // ---- seasonal: Eid / Ramadan ----------------------------------------------------------------
  {
    id: "crescent-star",
    label: "Crescent and star",
    group: "seasonal",
    kind: "sticker",
    viewBox: [0, 0, 100, 100],
    tintable: true,
    defaultTint: GOLD,
    suggestedTints: [GOLD, "#235A5E", "#FFFFFF", "#1E2A47"],
    paths: [
      { d: crescent(44, 52, 40, 60, 40, 34), fill: T(0) },
      { d: crescent(44, 52, 36.5, 58.6, 41.4, 32.6), fill: T(0.32), alpha: 0.55 },
      { d: star(78, 30, 14, 6, 5, -72, 0.12), fill: T(0) },
    ],
  },
  {
    id: "lantern",
    label: "Lantern",
    group: "seasonal",
    kind: "sticker",
    viewBox: [0, 0, 64, 120],
    tintable: true,
    defaultTint: GOLD,
    suggestedTints: [GOLD, "#235A5E", "#6A2333", "#B65A4E"],
    paths: [
      { d: `${circle(32, 7, 6)}${circle(32, 7, 3.6)}`, fill: T(-0.2), fillRule: "evenodd" },
      { d: "M26 13H38L40 20H24Z", fill: T(-0.2) },
      { d: "M14 34C14 24 22 20 32 20C42 20 50 24 50 34Z", fill: T(0) },
      { d: "M18 34H46V38H18Z", fill: T(-0.25) },
      // glass body: warm glow behind a frame with arched windows
      { d: "M16 38H48L52 82H12Z", fill: "#F7DD94" },
      {
        d: "M16 38H48L52 82H12Z M21 76V46Q21 41 26 41Q29.5 41 29.5 46V76Z M34.5 76V46Q34.5 41 38 41Q43 41 43 46V76Z",
        fill: T(0),
        fillRule: "evenodd",
      },
      { d: "M12 82H52L46 92H18Z", fill: T(-0.15) },
      { d: "M20 92H44L38 102H26Z", fill: T(0) },
      { d: "M29 102H35L33.6 114H30.4Z", fill: T(-0.2) },
      { d: circle(32, 116, 3), fill: T(-0.2) },
      { d: `${circle(25.3, 60, 1.5)}${circle(38.7, 60, 1.5)}`, fill: "#FFFFFF", alpha: 0.75 },
    ],
  },
] as const satisfies readonly StickerDef[];

export type StickerId = (typeof STICKER_LIST)[number]["id"];

/** Every sticker id, in catalogue order (the layout schema validates decoration ids against it). */
export const STICKER_IDS = STICKER_LIST.map((s) => s.id) as readonly StickerId[];

export const STICKERS: Readonly<Record<StickerId, StickerDef>> = Object.fromEntries(
  STICKER_LIST.map((s): [StickerId, StickerDef] => [s.id, s]),
) as unknown as Record<StickerId, StickerDef>;

/**
 * Layout decorations may name this placeholder instead of a sticker id: the renderer swaps in the
 * book's occasion accent (accentStickerFor). Valid decoration ids = DECORATION_STICKER_IDS.
 */
export const OCCASION_ACCENT = "occasion-accent" as const;
export const DECORATION_STICKER_IDS: readonly string[] = [...STICKER_IDS, OCCASION_ACCENT];

export const ACCENT_STICKER_BY_OCCASION: Readonly<Record<Occasion, StickerId>> = {
  wedding: "accent-rings",
  travel: "accent-plane",
  graduation: "accent-cap",
  baby: "accent-moon",
  family: "accent-house",
  other: "accent-sparkles",
};

export function isStickerId(v: unknown): v is StickerId {
  return typeof v === "string" && (STICKER_IDS as readonly string[]).includes(v);
}

export function stickerById(id: string): StickerDef | undefined {
  return isStickerId(id) ? STICKERS[id] : undefined;
}

/** The occasion's accent sticker; unknown/missing occasions use "other". */
export function accentStickerFor(occasion: string | null | undefined): StickerId {
  return ACCENT_STICKER_BY_OCCASION[(occasion ?? "other") as Occasion] ?? ACCENT_STICKER_BY_OCCASION.other;
}

/** A decoration id → the concrete sticker id (resolves OCCASION_ACCENT); undefined if unknown. */
export function resolveStickerId(id: string, occasion: string | null | undefined): StickerId | undefined {
  if (id === OCCASION_ACCENT) return accentStickerFor(occasion);
  return isStickerId(id) ? id : undefined;
}

/** Natural width / height. */
export function stickerAspect(id: StickerId): number {
  const [, , w, h] = STICKERS[id].viewBox;
  return w / h;
}

// --- paint resolution ----------------------------------------------------------------------------

const HEX6 = /^#[0-9A-Fa-f]{6}$/;

function hexRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function rgbHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** `hex` mixed toward white (k > 0) or black (k < 0) by |k|. */
export function shadeHex(hex: string, k: number): string {
  const rgb = hexRgb(hex);
  const t = Math.max(-1, Math.min(1, k));
  return rgbHex(rgb.map((c) => (t >= 0 ? c + (255 - c) * t : c * (1 + t))) as [number, number, number]);
}

/** The tint actually used: the decoration's tint for tintable stickers when it is a valid hex. */
export function effectiveTint(def: StickerDef, tint?: string | null): string {
  return def.tintable && tint && HEX6.test(tint) ? tint.toUpperCase() : def.defaultTint;
}

/** Paint → CSS colour ("#RRGGBB" or "rgba(r, g, b, a)" when alpha < 1). */
export function resolvePaint(paint: StickerPaint, tint: string, alpha = 1): string {
  const hex = typeof paint === "string" ? paint : shadeHex(tint, paint.tint);
  if (alpha >= 1) return hex.toUpperCase();
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(Math.max(0, alpha) * 1000) / 1000})`;
}

/** A path with every paint resolved to a CSS colour: what a renderer draws. */
export interface ResolvedStickerPath {
  d: string;
  fill: string;
  fillRule?: "nonzero" | "evenodd";
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  strokeLinecap?: "butt" | "round";
  strokeLinejoin?: "miter" | "round";
}

export function resolveStickerPaths(id: StickerId, tint?: string | null): ResolvedStickerPath[] {
  const def = STICKERS[id];
  const t = effectiveTint(def, tint);
  return def.paths
    .map((p) => {
      const out: ResolvedStickerPath = { d: p.d, fill: !p.fill || p.fill === "none" ? "none" : resolvePaint(p.fill, t, p.alpha) };
      if (p.fillRule) out.fillRule = p.fillRule;
      if (p.stroke) {
        out.stroke = resolvePaint(p.stroke, t, p.strokeAlpha);
        out.strokeWidth = p.strokeWidth ?? 1;
        if (p.dash) out.strokeDasharray = p.dash.join(" ");
        if (p.linecap) out.strokeLinecap = p.linecap;
        if (p.linejoin) out.strokeLinejoin = p.linejoin;
      }
      return out;
    });
}

/** Relative luminance of a hex colour (WCAG). */
function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text ink for live text on a plate of this tint (the higher-contrast of dark / light). */
export function plateInk(id: StickerId, tint?: string | null): "dark" | "light" {
  const L = luminance(effectiveTint(STICKERS[id], tint));
  const onWhite = 1.05 / (L + 0.05);
  const onDark = (L + 0.05) / (luminance("#262626") + 0.05);
  return onWhite > onDark ? "light" : "dark";
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Standalone SVG markup for a sticker (sheet script, tests, data-URL previews). The renderer
 * builds the same elements from resolveStickerPaths() as React nodes.
 */
export function stickerSvg(id: StickerId, opts: { tint?: string | null; width?: number; height?: number } = {}): string {
  const def = STICKERS[id];
  const [x, y, w, h] = def.viewBox;
  const size = `${opts.width ? ` width="${opts.width}"` : ""}${opts.height ? ` height="${opts.height}"` : ""}`;
  const body = resolveStickerPaths(id, opts.tint)
    .map((p) => {
      const a = [`d="${escAttr(p.d)}"`, `fill="${p.fill}"`];
      if (p.fillRule) a.push(`fill-rule="${p.fillRule}"`);
      if (p.stroke) {
        a.push(`stroke="${p.stroke}"`, `stroke-width="${p.strokeWidth}"`);
        if (p.strokeDasharray) a.push(`stroke-dasharray="${p.strokeDasharray}"`);
        if (p.strokeLinecap) a.push(`stroke-linecap="${p.strokeLinecap}"`);
        if (p.strokeLinejoin) a.push(`stroke-linejoin="${p.strokeLinejoin}"`);
      }
      return `<path ${a.join(" ")}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}"${size}>${body}</svg>`;
}
