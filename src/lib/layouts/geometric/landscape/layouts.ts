// Geometric A5 LANDSCAPE layouts (M10c T5b). Pure data, original geometry designed for the wide
// page (text in a side column or a bottom band, not a stretched portrait design).
//
// Drawn in page mm (210 × 148, y down) through ./../geometry and stored as % rects + slot-relative
// polygon points. Photos are separated by one 3 mm gutter measured perpendicular to the seam, so
// neighbouring polygon slots may share bounding-box area but never pixels. Text keeps ≥ 10 mm from
// the left/right trim (either side may be the fold) and ≥ 6 mm from top/bottom; text never sits
// inside a slot's bounding box. Fonts: geometric tokens (styles.ts) — title Cormorant, chapter /
// date / year Bebas, captions Cormorant; Arabic → Amiri / Lalezar.
//
// The seams of g-l-two-diag and the cut edge of g-l-one-band share one slope (20 mm across the
// 124 mm photo band), so the g-l-spread-band spread is exactly those two pages side by side.

import type { Layout, LayoutSlotDef } from "@/lib/book/types";
import { arc, geo, GEO_GUTTER_MM, LANDSCAPE_MM, verticalGap, type Pt } from "../geometry";

const W = LANDSCAPE_MM.w;
const H = LANDSCAPE_MM.h;
const g = geo(LANDSCAPE_MM);
const { rect, poly } = g;

const ACCENT = "#235A5E"; // geometric palette accent (styles.ts)
const DATE_PLATE = { id: "plate-label", tint: ACCENT } as const;

// --- the shared slope ------------------------------------------------------------------------------
const BAND = 124; // bottom of the photo band on captioned diagonal pages (mm)
const SLOPE = 20 / BAND; // horizontal mm per vertical mm
const HALF = verticalGap(GEO_GUTTER_MM / 2, SLOPE); // horizontal half-gutter across the seam
/** Seam x (mm) at height y on g-l-two-diag. */
const seam = (y: number) => 118 - SLOPE * y;

const twoDiagLeft: Pt[] = [
  [0, 0],
  [seam(0) - HALF, 0],
  [seam(BAND) - HALF, BAND],
  [0, BAND],
];
const twoDiagRight: Pt[] = [
  [seam(0) + HALF, 0],
  [W, 0],
  [W, BAND],
  [seam(BAND) + HALF, BAND],
];
/** g-l-one-band photo: bleeds top/left/bottom, right edge parallel to the two-diag seam. */
const oneBandPhoto: Pt[] = [
  [0, 0],
  [140, 0],
  [140 - SLOPE * H, H],
  [0, H],
];

const TWO_DIAG_CAPTION = rect(12, 130, 198, 142);
const ONE_BAND = {
  wedge: rect(150, 34, 160, 44),
  chapter: rect(150, 48, 198, 62),
  date: rect(150, 66, 192, 74),
  caption: rect(150, 80, 198, 124),
};

// --- cover ----------------------------------------------------------------------------------------

/** Cover: title column on white, photo cut by a slanted edge (bleeds top/right/bottom). */
export const geometricLandscapeCover: Layout = {
  id: "g-l-cover",
  name: "Cover: slanted photo + title column",
  role: "cover",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [
    poly([
      [104, 0],
      [W, 0],
      [W, H],
      [80, H],
    ]),
  ],
  caption: rect(12, 44, 72, 100),
  texts: [
    { bind: "coverTitle", box: rect(12, 44, 72, 88), align: "start", font: "title" },
    { bind: "coverSubtitle", box: rect(12, 90, 72, 100), align: "start", font: "year" },
  ],
};

// --- single pages -----------------------------------------------------------------------------------

/**
 * One big photo with a slanted right edge (bleeds top/left/bottom); chapter title, date plate and
 * caption in the column beside it, marked by a teal corner wedge (the geometric accent).
 */
export const geometricLandscapeOneBand: Layout = {
  id: "g-l-one-band",
  name: "1 photo, slanted cut + text column",
  role: "page",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [poly(oneBandPhoto)],
  caption: ONE_BAND.caption,
  texts: [
    { bind: "chapterTitle", box: ONE_BAND.chapter, align: "start", font: "chapter" },
    { bind: "dateLabel", box: ONE_BAND.date, align: "center", font: "subtitle", plate: DATE_PLATE },
    { bind: "pageCaption", box: ONE_BAND.caption, align: "start", font: "caption" },
  ],
  decorations: [{ kind: "sticker", id: "photo-corner", box: ONE_BAND.wedge, layer: "over", tint: ACCENT }],
};

/** Two tall photos split by a slanted seam (bleed top/left/right), caption band below. Left half of g-l-spread-band. */
export const geometricLandscapeTwoDiag: Layout = {
  id: "g-l-two-diag",
  name: "2 photos, slanted split",
  role: "page",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 2,
  prefers: ["portrait", "portrait"],
  slots: [poly(twoDiagLeft), poly(twoDiagRight)],
  caption: TWO_DIAG_CAPTION,
  texts: [{ bind: "pageCaption", box: TWO_DIAG_CAPTION, align: "center", font: "caption" }],
};

// Circle nested in a concave notch of the left photo's right edge (3 mm ring of page between them).
const CIRCLE = { cx: 156, cy: 96, r: 32 };
const NOTCH_R = CIRCLE.r + GEO_GUTTER_MM;
const PHOTO_RIGHT = 132;
const notchA = Math.acos((PHOTO_RIGHT - CIRCLE.cx) / NOTCH_R); // angle of the upper/lower crossing (> π/2)
const twoCircleLeft: Pt[] = [
  [0, 0],
  [PHOTO_RIGHT, 0],
  // 10 points: the notch arc from its upper end, round the left of the circle, to its lower end
  ...arc(CIRCLE.cx, CIRCLE.cy, NOTCH_R, 2 * Math.PI - notchA, notchA, 10),
  [PHOTO_RIGHT, H],
  [0, H],
];

/** Tall photo (bleeds top/left/bottom) with a round bite holding a circle photo; text top right. */
export const geometricLandscapeTwoCircle: Layout = {
  id: "g-l-two-circle",
  name: "1 photo + circle, text top right",
  role: "page",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 2,
  prefers: ["portrait", "any"],
  slots: [poly(twoCircleLeft), g.circle(CIRCLE.cx, CIRCLE.cy, CIRCLE.r)],
  caption: rect(140, 40, 198, 58),
  texts: [
    { bind: "chapterTitle", box: rect(140, 12, 198, 26), align: "start", font: "chapter" },
    { bind: "dateLabel", box: rect(140, 28, 198, 35), align: "start", font: "subtitle" },
    { bind: "pageCaption", box: rect(140, 40, 198, 58), align: "start", font: "caption" },
  ],
};

// Three diamonds in a V, 3 mm between facing edges.
const D = 68;
const STEP = (GEO_GUTTER_MM + D / Math.SQRT2) / Math.SQRT2;
const D0 = { x: 10 + D / 2, y: 22 + D / 2 };

/** Three diamonds in a V; text column on the right. */
export const geometricLandscapeThreeDiamond: Layout = {
  id: "g-l-three-diamond",
  name: "3 diamonds",
  role: "page",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 3,
  prefers: ["any", "any", "any"],
  slots: [
    g.diamond(D0.x, D0.y, D),
    g.diamond(D0.x + STEP, D0.y + STEP, D),
    g.diamond(D0.x + 2 * STEP, D0.y, D),
  ],
  caption: rect(160, 72, 198, 124),
  texts: [
    { bind: "chapterTitle", box: rect(160, 40, 198, 54), align: "start", font: "chapter" },
    { bind: "dateLabel", box: rect(160, 57, 198, 64), align: "start", font: "subtitle" },
    { bind: "pageCaption", box: rect(160, 72, 198, 124), align: "start", font: "caption" },
  ],
};

// Clover: 2 × 2 petals on the left, outer corners rounded, inner corners meeting at the centre.
const PET = { x0: 12, x1: 132, y0: 10, y1: 138 };
const pmx = (PET.x0 + PET.x1) / 2;
const pmy = (PET.y0 + PET.y1) / 2;
const pg = GEO_GUTTER_MM / 2;
const PR = 46;
const pr = 5;

/** Four petals (clover) on the left; text column on the right. */
export const geometricLandscapeFourPetals: Layout = {
  id: "g-l-four-petals",
  name: "4 petals",
  role: "page",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 4,
  prefers: ["portrait", "portrait", "portrait", "portrait"],
  slots: [
    g.petal(PET.x0, PET.y0, pmx - pg, pmy - pg, "tl", PR, pr),
    g.petal(pmx + pg, PET.y0, PET.x1, pmy - pg, "tr", PR, pr),
    g.petal(PET.x0, pmy + pg, pmx - pg, PET.y1, "bl", PR, pr),
    g.petal(pmx + pg, pmy + pg, PET.x1, PET.y1, "br", PR, pr),
  ],
  caption: rect(144, 78, 198, 124),
  texts: [
    { bind: "chapterTitle", box: rect(144, 46, 198, 60), align: "start", font: "chapter" },
    { bind: "dateLabel", box: rect(144, 63, 198, 70), align: "start", font: "subtitle" },
    { bind: "pageCaption", box: rect(144, 78, 198, 124), align: "start", font: "caption" },
  ],
};

// Honeycomb 2 + 1 + 2 of regular flat-top hexagons, 3 mm between facing edges.
const HW = 54;
const HH = (HW * Math.sqrt(3)) / 2;
const HDX = 0.75 * HW + GEO_GUTTER_MM * (Math.sqrt(3) / 2);
const HDY = HH / 2 + GEO_GUTTER_MM / 2;
const HCX = 10 + HW / 2;
const HCY = (H - (2 * HDY + HH)) / 2 + HH / 2;
const hexes: LayoutSlotDef[] = [
  g.hexagon(HCX, HCY, HW),
  g.hexagon(HCX, HCY + 2 * HDY, HW),
  g.hexagon(HCX + HDX, HCY + HDY, HW),
  g.hexagon(HCX + 2 * HDX, HCY, HW),
  g.hexagon(HCX + 2 * HDX, HCY + 2 * HDY, HW),
];

/** Five hexagons in a honeycomb; text column on the right. */
export const geometricLandscapeFiveHex: Layout = {
  id: "g-l-five-hex",
  name: "5 hexagons",
  role: "page",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 5,
  prefers: ["landscape", "landscape", "landscape", "landscape", "landscape"],
  slots: hexes,
  caption: rect(160, 78, 198, 124),
  texts: [
    { bind: "chapterTitle", box: rect(160, 46, 198, 60), align: "start", font: "chapter" },
    { bind: "dateLabel", box: rect(160, 63, 198, 70), align: "start", font: "subtitle" },
    { bind: "pageCaption", box: rect(160, 78, 198, 124), align: "start", font: "caption" },
  ],
};

// --- spread -----------------------------------------------------------------------------------------

/**
 * Parallel slants across both pages: two photos split by a slanted seam on the left page, one big
 * photo with the same slant on the right, caption band under the left page, chapter title + date in
 * the right page's column (= g-l-two-diag + g-l-one-band; no shape crosses the fold).
 */
export const geometricLandscapeSpreadBand: Layout = {
  id: "g-l-spread-band",
  name: "Parallel slants across both pages",
  role: "spread",
  style: "geometric",
  format: "A5_LANDSCAPE",
  photoCount: 3,
  prefers: ["portrait", "portrait", "portrait"],
  slots: [poly(twoDiagLeft), poly(twoDiagRight), g.shift(poly(oneBandPhoto))],
  caption: TWO_DIAG_CAPTION,
  twin: ["g-l-two-diag", "g-l-one-band"],
  texts: [
    { bind: "pageCaption", box: TWO_DIAG_CAPTION, align: "center", font: "caption" },
    { bind: "chapterTitle", box: g.shift(ONE_BAND.chapter), align: "start", font: "chapter" },
    { bind: "dateLabel", box: g.shift(ONE_BAND.date), align: "center", font: "subtitle", plate: DATE_PLATE },
  ],
  decorations: [{ kind: "sticker", id: "photo-corner", box: g.shift(ONE_BAND.wedge), layer: "over", tint: ACCENT }],
};
