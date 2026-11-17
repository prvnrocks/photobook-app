// M29 cover styles — geometric A5 portrait (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "geometric", format "A5_PORTRAIT", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.
//
// Drawn in page mm (148 × 210, y down) through ../geometry like the M10c geometric layouts: circle /
// diamond / polygon slots, teal accents from existing stickers (photo-corner wedge, a label plate
// stretched into a thin rule). Title boxes are sized so a 120-code-point title fits at the title
// role's minimum size (tests/golden/m29-covers-geometric.test.tsx checks EN + AR).

import type { Layout } from "@/lib/book/types";
import { arc, geo, PORTRAIT_MM, type Pt } from "../geometry";

const W = PORTRAIT_MM.w;
const H = PORTRAIT_MM.h;
const g = geo(PORTRAIT_MM);
const { rect, poly } = g;

const ACCENT = "#235A5E"; // geometric palette accent (styles.ts)
/** A thin teal rule: the label plate stretches to its box (plates use preserveAspectRatio none). */
const rule = (x0: number, y0: number, x1: number, y1: number) =>
  ({ kind: "plate", id: "plate-label", box: rect(x0, y0, x1, y1), layer: "under", tint: ACCENT }) as const;
/** Teal corner wedge (photo-corner art: top-left corner, turned by `rotate`). */
const wedge = (x0: number, y0: number, size: number, rotate = 0) =>
  ({ kind: "sticker", id: "photo-corner", box: rect(x0, y0, x0 + size, y0 + size), layer: "under", tint: ACCENT, ...(rotate ? { rotate } : {}) }) as const;

// --- (a) circle photo, title below -----------------------------------------------------------------
const CIRCLE = { cx: W / 2, cy: 82, r: 56 }; // x 18..130, y 26..138

/** Big circle photo on the page; centred title + subtitle below, a short teal rule between them. */
export const geometricPortraitCoverCircle: Layout = {
  id: "g-p-cover-circle",
  name: "Cover: circle photo + title below",
  role: "cover",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [g.circle(CIRCLE.cx, CIRCLE.cy, CIRCLE.r)],
  caption: rect(14, 148, 134, 200),
  texts: [
    { bind: "coverTitle", box: rect(14, 148, 134, 182), align: "center", font: "title" },
    { bind: "coverSubtitle", box: rect(14, 187, 134, 200), align: "center", font: "year" },
  ],
  decorations: [rule(64, 184.4, 84, 185.6), wedge(8, 8, 14), wedge(126, 8, 14, 90)],
  autoPick: false,
};

// --- (b) arch doorway: photo around an arch cut-out holding the title -----------------------------
// The photo bleeds on every edge except an arch-shaped doorway rising from the bottom trim: straight
// walls x = 19 / 129 from the bottom up to y = 128, then a faceted half-decagon (5 straight facets on a
// circle of r 55, flat top at y ≈ 75.7): deliberate crisp facets read as geometric, where a 16-point
// "smooth" arc shows as a badly drawn circle.
const ARCH = { cx: W / 2, cy: 128, r: 55 };
const archPhoto: Pt[] = [
  [0, 0],
  [W, 0],
  [W, H],
  [ARCH.cx + ARCH.r, H],
  // arc from the right wall (angle 0) over the top (−π/2) to the left wall (−π)
  ...arc(ARCH.cx, ARCH.cy, ARCH.r, 0, -Math.PI, 6),
  [ARCH.cx - ARCH.r, H],
  [0, H],
];

/** Photo with an arch-shaped doorway cut out of its lower half; title + subtitle inside the arch. */
export const geometricPortraitCoverArch: Layout = {
  id: "g-p-cover-arch",
  name: "Cover: arch window + title",
  role: "cover",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [poly(archPhoto)],
  caption: rect(27, 120, 121, 194),
  texts: [
    { bind: "coverTitle", box: rect(27, 120, 121, 170), align: "center", font: "title" },
    { bind: "coverSubtitle", box: rect(27, 182, 121, 194), align: "center", font: "year" },
  ],
  decorations: [rule(62, 175.4, 86, 176.6)],
  autoPick: false,
};

// --- (c) diamond photo, title column ----------------------------------------------------------------
const DIAMOND = { cx: W / 2, cy: 76, d: 118 }; // x 15..133, y 17..135

/** Large diamond photo; left-aligned title column below, marked by a teal vertical rule. */
export const geometricPortraitCoverDiamond: Layout = {
  id: "g-p-cover-diamond",
  name: "Cover: diamond photo + title column",
  role: "cover",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [g.diamond(DIAMOND.cx, DIAMOND.cy, DIAMOND.d)],
  caption: rect(22, 148, 134, 198),
  texts: [
    { bind: "coverTitle", box: rect(22, 148, 134, 184), align: "start", font: "title" },
    { bind: "coverSubtitle", box: rect(22, 187, 134, 198), align: "start", font: "year" },
  ],
  decorations: [rule(14, 150, 15.2, 196), wedge(8, 8, 18), wedge(122, 8, 18, 90)],
  autoPick: false,
};

export const GEOMETRIC_PORTRAIT_COVERS = [
  geometricPortraitCoverCircle,
  geometricPortraitCoverArch,
  geometricPortraitCoverDiamond,
] as const satisfies readonly Layout[];
