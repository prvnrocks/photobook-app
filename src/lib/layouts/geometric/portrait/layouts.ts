// Geometric A5 PORTRAIT layouts (M10c T5a). Pure data, original geometry (ref4 = ideas only:
// diagonal bands, diamonds, circles, petals, hexagons, open text blocks).
//
// Drawn in page mm (148 × 210, y down) through ./../geometry and stored as % rects + slot-relative
// polygon points. Photos are separated by one 3 mm gutter measured perpendicular to the seam, so
// neighbouring polygon slots may share bounding-box area but never pixels. Text keeps ≥ 10 mm from
// the left/right trim (either side may be the fold) and ≥ 8 mm from top/bottom; text never sits
// inside a slot's bounding box. Fonts (styles.ts geometric tokens): title Cormorant, chapter /
// date / year Bebas (Latin tracking only), captions Cormorant; Arabic → Amiri / Lalezar.
//
// The diagonal of g-p-two-diag and g-p-one-band is ONE line across a spread (y = 72 + 30x/148 mm,
// continuing on the right page), so the g-p-spread-band spread is exactly those two pages.

import type { Layout, LayoutSlotDef } from "@/lib/book/types";
import { arc, geo, GEO_GUTTER_MM, PORTRAIT_MM, verticalGap, type Pt } from "../geometry";

const W = PORTRAIT_MM.w;
const H = PORTRAIT_MM.h;
const g = geo(PORTRAIT_MM);
const { rect, poly } = g;

const ACCENT = "#235A5E"; // geometric palette accent (styles.ts)

// --- the shared spread diagonal -------------------------------------------------------------------
const SLOPE = 30 / W;
const HALF = verticalGap(GEO_GUTTER_MM / 2, SLOPE);
/** Seam height (mm) at page x on the left page (right page: x + W). */
const seam = (x: number) => 72 + SLOPE * x;

const twoDiagTop: Pt[] = [
  [0, 0],
  [W, 0],
  [W, seam(W) - HALF],
  [0, seam(0) - HALF],
];
const twoDiagBottom: Pt[] = [
  [0, seam(0) + HALF],
  [W, seam(W) + HALF],
  [W, 168],
  [0, 168],
];
const oneBandPhoto: Pt[] = [
  [0, 0],
  [W, 0],
  [W, seam(2 * W) - HALF],
  [0, seam(W) - HALF],
];

const TWO_DIAG_CAPTION = rect(10, 176, 138, 201);
const ONE_BAND_TEXTS = {
  chapter: rect(26, 142, 136, 156),
  date: rect(12, 160, 60, 168),
  caption: rect(12, 174, 136, 201),
};
/** Teal wedge before the chapter title — the page's geometric accent (photo-corner art, tinted). */
const ONE_BAND_WEDGE = rect(12, 143, 22, 153);
const DATE_PLATE = { id: "plate-label", tint: ACCENT } as const;

// --- cover ----------------------------------------------------------------------------------------

/** Cover: title block on white above a photo cut by a rising diagonal (bleeds left/right/bottom). */
export const geometricPortraitCover: Layout = {
  id: "g-p-cover",
  name: "Cover: diagonal photo + title",
  role: "cover",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [
    poly([
      [0, 88],
      [W, 58],
      [W, H],
      [0, H],
    ]),
  ],
  caption: rect(12, 16, 136, 52),
  texts: [
    { bind: "coverTitle", box: rect(12, 16, 136, 42), align: "start", font: "title" },
    { bind: "coverSubtitle", box: rect(12, 44, 136, 52), align: "start", font: "year" },
  ],
};

// --- single pages -----------------------------------------------------------------------------------

/**
 * One big photo cut by the spread diagonal (bleeds top/left/right), chapter title, date and caption
 * in the open block below; a teal corner wedge marks the text block (the geometric accent).
 */
export const geometricPortraitOneBand: Layout = {
  id: "g-p-one-band",
  name: "1 photo, diagonal cut + text block",
  role: "page",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [poly(oneBandPhoto)],
  caption: ONE_BAND_TEXTS.caption,
  texts: [
    { bind: "chapterTitle", box: ONE_BAND_TEXTS.chapter, align: "start", font: "chapter" },
    { bind: "dateLabel", box: ONE_BAND_TEXTS.date, align: "center", font: "subtitle", plate: DATE_PLATE },
    { bind: "pageCaption", box: ONE_BAND_TEXTS.caption, align: "start", font: "caption" },
  ],
  decorations: [{ kind: "sticker", id: "photo-corner", box: ONE_BAND_WEDGE, layer: "over", tint: ACCENT }],
};

/** Two photos split by a diagonal band (bleed top/left/right), caption below. Left half of g-p-spread-band. */
export const geometricPortraitTwoDiag: Layout = {
  id: "g-p-two-diag",
  name: "2 photos, diagonal split",
  role: "page",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["landscape", "landscape"],
  slots: [poly(twoDiagTop), poly(twoDiagBottom)],
  caption: TWO_DIAG_CAPTION,
  texts: [{ bind: "pageCaption", box: TWO_DIAG_CAPTION, align: "center", font: "caption" }],
};

// Circle nested in a concave notch of the top photo (3 mm ring of page between them).
const CIRCLE = { cx: 102, cy: 148, r: 34 };
const NOTCH_R = CIRCLE.r + GEO_GUTTER_MM;
const TOP_BOTTOM = 128; // bottom edge of the top photo (mm)
const notchA = Math.asin((TOP_BOTTOM - CIRCLE.cy) / NOTCH_R); // < 0 (above the centre)
const twoCircleTop: Pt[] = [
  [0, 0],
  [W, 0],
  [W, TOP_BOTTOM],
  // 12 points: the notch arc from its right end, over the top, to its left end
  ...arc(CIRCLE.cx, CIRCLE.cy, NOTCH_R, 2 * Math.PI + notchA, Math.PI - notchA, 12),
  [0, TOP_BOTTOM],
];
const TWO_CIRCLE_TEXT = {
  chapter: rect(12, 138, 62, 152),
  date: rect(12, 154, 62, 161),
  caption: rect(12, 167, 62, 201),
};

/** Wide photo (bleeds top/left/right) with a round bite holding a circle photo; text block beside it. */
export const geometricPortraitTwoCircle: Layout = {
  id: "g-p-two-circle",
  name: "1 photo + circle, text block",
  role: "page",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["landscape", "any"],
  slots: [poly(twoCircleTop), g.circle(CIRCLE.cx, CIRCLE.cy, CIRCLE.r)],
  caption: TWO_CIRCLE_TEXT.caption,
  texts: [
    { bind: "chapterTitle", box: TWO_CIRCLE_TEXT.chapter, align: "start", font: "chapter" },
    { bind: "dateLabel", box: TWO_CIRCLE_TEXT.date, align: "start", font: "subtitle" },
    { bind: "pageCaption", box: TWO_CIRCLE_TEXT.caption, align: "start", font: "caption" },
  ],
};

// Three diamonds in a falling chain, 3 mm between facing edges.
const D = 64;
const STEP = (GEO_GUTTER_MM + D / Math.SQRT2) / Math.SQRT2;
const D0 = { x: 42, y: 52 };

/** Three diamonds stepping down the page; date top-right, chapter title + caption bottom-left. */
export const geometricPortraitThreeDiamond: Layout = {
  id: "g-p-three-diamond",
  name: "3 diamonds",
  role: "page",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["any", "any", "any"],
  slots: [0, 1, 2].map((i) => g.diamond(D0.x + i * STEP, D0.y + i * STEP, D)),
  caption: rect(12, 172, 76, 201),
  texts: [
    { bind: "dateLabel", box: rect(86, 18, 136, 26), align: "end", font: "subtitle" },
    { bind: "chapterTitle", box: rect(12, 155, 76, 169), align: "start", font: "chapter" },
    { bind: "pageCaption", box: rect(12, 172, 76, 201), align: "start", font: "caption" },
  ],
};

// Clover: 2 × 2 petals, outer corners rounded, inner corners meeting at the centre.
const PET = { x0: 10, x1: 138, y0: 12, y1: 158 };
const pmx = (PET.x0 + PET.x1) / 2;
const pmy = (PET.y0 + PET.y1) / 2;
const pg = GEO_GUTTER_MM / 2;
const PR = 50;
const pr = 5;
const FOUR_CAPTION = rect(12, 182, 136, 201);

/** Four petals (clover), chapter title + caption below. */
export const geometricPortraitFourPetals: Layout = {
  id: "g-p-four-petals",
  name: "4 petals",
  role: "page",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 4,
  prefers: ["portrait", "portrait", "portrait", "portrait"],
  slots: [
    g.petal(PET.x0, PET.y0, pmx - pg, pmy - pg, "tl", PR, pr),
    g.petal(pmx + pg, PET.y0, PET.x1, pmy - pg, "tr", PR, pr),
    g.petal(PET.x0, pmy + pg, pmx - pg, PET.y1, "bl", PR, pr),
    g.petal(pmx + pg, pmy + pg, PET.x1, PET.y1, "br", PR, pr),
  ],
  caption: FOUR_CAPTION,
  texts: [
    { bind: "chapterTitle", box: rect(12, 166, 136, 180), align: "center", font: "chapter" },
    { bind: "pageCaption", box: FOUR_CAPTION, align: "center", font: "caption" },
  ],
};

// Honeycomb 2 + 1 + 2 of regular flat-top hexagons, 3 mm between facing edges.
const HW = 52;
const HH = (HW * Math.sqrt(3)) / 2;
const HDX = 0.75 * HW + GEO_GUTTER_MM * (Math.sqrt(3) / 2);
const HDY = HH / 2 + GEO_GUTTER_MM / 2;
const HCX = W / 2 - HDX;
const HCY = 84;
const hexes: LayoutSlotDef[] = [
  g.hexagon(HCX, HCY, HW),
  g.hexagon(HCX, HCY + 2 * HDY, HW),
  g.hexagon(HCX + HDX, HCY + HDY, HW),
  g.hexagon(HCX + 2 * HDX, HCY, HW),
  g.hexagon(HCX + 2 * HDX, HCY + 2 * HDY, HW),
];
const FIVE_CAPTION = rect(12, 166, 136, 198);

/** Five hexagons in a honeycomb, chapter title + date above, caption below. */
export const geometricPortraitFiveHex: Layout = {
  id: "g-p-five-hex",
  name: "5 hexagons",
  role: "page",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 5,
  prefers: ["landscape", "landscape", "landscape", "landscape", "landscape"],
  slots: hexes,
  caption: FIVE_CAPTION,
  texts: [
    { bind: "chapterTitle", box: rect(12, 22, 136, 36), align: "center", font: "chapter" },
    { bind: "dateLabel", box: rect(12, 38, 136, 45), align: "center", font: "subtitle" },
    { bind: "pageCaption", box: FIVE_CAPTION, align: "center", font: "caption" },
  ],
};

// --- spread -----------------------------------------------------------------------------------------

/**
 * One diagonal across both pages: two photos split by it on the left page, one big photo above it
 * on the right, caption under the left page, chapter title + date under the right
 * (= g-p-two-diag + g-p-one-band; no shape crosses the fold).
 */
export const geometricPortraitSpreadBand: Layout = {
  id: "g-p-spread-band",
  name: "Diagonal across both pages",
  role: "spread",
  style: "geometric",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["landscape", "landscape", "landscape"],
  slots: [poly(twoDiagTop), poly(twoDiagBottom), g.shift(poly(oneBandPhoto))],
  caption: TWO_DIAG_CAPTION,
  twin: ["g-p-two-diag", "g-p-one-band"],
  texts: [
    { bind: "pageCaption", box: TWO_DIAG_CAPTION, align: "center", font: "caption" },
    { bind: "chapterTitle", box: g.shift(ONE_BAND_TEXTS.chapter), align: "start", font: "chapter" },
    { bind: "dateLabel", box: g.shift(ONE_BAND_TEXTS.date), align: "center", font: "subtitle", plate: DATE_PLATE },
  ],
  decorations: [{ kind: "sticker", id: "photo-corner", box: g.shift(ONE_BAND_WEDGE), layer: "over", tint: ACCENT }],
};
