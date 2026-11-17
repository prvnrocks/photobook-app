// M29 cover styles — geometric A5 landscape (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "geometric", format "A5_LANDSCAPE", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.
//
// Drawn in page mm (210 × 148, y down) through ../geometry like the M10c geometric layouts: circle /
// hexagon / polygon slots, teal accents from existing stickers (photo-corner wedge, a label plate
// stretched into a thin rule). Text starts ≥ 14 mm from the spine. Title boxes are sized so a
// 120-code-point title fits at the title role's minimum size (tests/golden/m29-covers-geometric.test.tsx).

import type { Layout } from "@/lib/book/types";
import { arc, geo, LANDSCAPE_MM, type Pt } from "../geometry";

const W = LANDSCAPE_MM.w;
const H = LANDSCAPE_MM.h;
const g = geo(LANDSCAPE_MM);
const { rect, poly } = g;

const ACCENT = "#235A5E"; // geometric palette accent (styles.ts)
/** A thin teal rule: the label plate stretches to its box (plates use preserveAspectRatio none). */
const rule = (x0: number, y0: number, x1: number, y1: number) =>
  ({ kind: "plate", id: "plate-label", box: rect(x0, y0, x1, y1), layer: "under", tint: ACCENT }) as const;
/** Teal corner wedge (photo-corner art: top-left corner, turned by `rotate`). */
const wedge = (x0: number, y0: number, size: number, rotate = 0) =>
  ({ kind: "sticker", id: "photo-corner", box: rect(x0, y0, x0 + size, y0 + size), layer: "under", tint: ACCENT, ...(rotate ? { rotate } : {}) }) as const;

// --- (a) circle photo, title below -----------------------------------------------------------------
const CIRCLE = { cx: 112, cy: 52, r: 42 }; // x 70..154, y 10..94

/** Circle photo centred over a wide title band (centred on the circle, clear of the spine); short teal rule above the subtitle. */
export const geometricLandscapeCoverCircle: Layout = {
  id: "g-l-cover-circle",
  name: "Cover: circle photo + title below",
  role: "cover",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["any"],
  slots: [g.circle(CIRCLE.cx, CIRCLE.cy, CIRCLE.r)],
  caption: rect(24, 99, 200, 143),
  texts: [
    { bind: "coverTitle", box: rect(24, 99, 200, 128), align: "center", font: "title" },
    { bind: "coverSubtitle", box: rect(24, 134, 200, 143), align: "center", font: "year" },
  ],
  decorations: [rule(102, 130.4, 122, 131.6), wedge(14, 8, 14), wedge(188, 8, 14, 90)],
  autoPick: false,
};

// --- (b) arch: half-moon photo on the right, title column on the left ------------------------------
// The photo bleeds top/right/bottom; its left edge is an arc of a circle centred off the page
// (r 140 around (230, 74)), bulging towards the spine: x = 90 at mid-height, ≈ 111 at the trims.
const ARC = { cx: 230, cy: 74, r: 140 };
const a0 = Math.asin((0 - ARC.cy) / ARC.r); // top trim crossing (< 0)
const archPhoto: Pt[] = [
  [W, 0],
  [W, H],
  // 14 arc points from the bottom trim crossing, through the leftmost point, to the top trim crossing
  ...arc(ARC.cx, ARC.cy, ARC.r, Math.PI + a0, Math.PI - a0, 14),
];

/** Photo with an arched left edge (bleeds top/right/bottom); title column in the open space beside it. */
export const geometricLandscapeCoverArch: Layout = {
  id: "g-l-cover-arch",
  name: "Cover: arch photo + title column",
  role: "cover",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [poly(archPhoto)],
  caption: rect(14, 30, 84, 116),
  texts: [
    { bind: "coverTitle", box: rect(14, 30, 84, 96), align: "start", font: "title", fit: 0.85 },
    { bind: "coverSubtitle", box: rect(14, 102, 84, 116), align: "start", font: "year" },
  ],
  decorations: [rule(14, 98.4, 38, 99.6), wedge(14, 14, 12)],
  autoPick: false,
};

// --- (c) hexagon photo, title column ----------------------------------------------------------------
const HEX = { cx: 143, cy: 74, w: 120 }; // regular flat-top: x 83..203, y ≈ 22..126

/** Regular hexagon photo on the right; title column on the left marked by a teal vertical rule. */
export const geometricLandscapeCoverHex: Layout = {
  id: "g-l-cover-hex",
  name: "Cover: hexagon photo + title column",
  role: "cover",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [g.hexagon(HEX.cx, HEX.cy, HEX.w)],
  caption: rect(20, 34, 76, 114),
  texts: [
    { bind: "coverTitle", box: rect(20, 34, 76, 98), align: "start", font: "title" },
    { bind: "coverSubtitle", box: rect(20, 100, 78, 116), align: "start", font: "year" },
  ],
  decorations: [rule(14, 36, 15.2, 114), wedge(194, 4, 12, 90), wedge(194, 132, 12, 180)],
  autoPick: false,
};

export const GEOMETRIC_LANDSCAPE_COVERS = [
  geometricLandscapeCoverCircle,
  geometricLandscapeCoverArch,
  geometricLandscapeCoverHex,
] as const satisfies readonly Layout[];
