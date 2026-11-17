// M29 cover styles — classic A5 landscape (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "classic", format "A5_LANDSCAPE", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.
//
// Geometry is written in mm on the 210 × 148 mm page (comments) and stored as % of the page.
// `caption` = the whole title block (the editor's cover-text tap target); `texts` place title and
// subtitle inside it (classic faces: Playfair 600 / 400, Cairo for Arabic). Title boxes are tall
// enough that a 120-code-point title still fits above the panel minimum size (panelFontMm).

import type { Layout } from "@/lib/book/types";

const W = 210;
const H = 148;
/** mm rect on the landscape page → % rect (3 decimals). */
const mm = (x: number, y: number, w: number, h: number) => ({
  x: Math.round((x / W) * 100000) / 1000,
  y: Math.round((y / H) * 100000) / 1000,
  w: Math.round((w / W) * 100000) / 1000,
  h: Math.round((h / H) * 100000) / 1000,
});

/** Fine rule round the window photo: a hairline in warm graphite, readable on light and dark boards. */
const FINE_RULE = { kind: "border", mm: 0.4, hex: "#7A6F63" } as const;

/** Framed window: centred photo in a fine-ruled frame with even margins, title + subtitle centred below. */
export const classicLandscapeCoverWindow: Layout = {
  id: "c-l-cover-window",
  name: "Cover: framed window",
  role: "cover",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  autoPick: false,
  slots: [{ ...mm(43, 12, 124, 80), frame: FINE_RULE }], // 43 12 124×80 mm
  caption: mm(20, 96, 170, 43), // 20 96 170×43 mm
  texts: [
    { bind: "coverTitle", box: mm(20, 96, 170, 32), align: "center", font: "title" }, // 20 96 170×32 mm
    { bind: "coverSubtitle", box: mm(20, 129, 170, 10), align: "center", font: "subtitle" }, // 20 129 170×10 mm
  ],
};

/** Title first: title + subtitle at the top, wide photo below bleeding off the sides and foot. */
export const classicLandscapeCoverTitleFirst: Layout = {
  id: "c-l-cover-title-first",
  name: "Cover: title first",
  role: "cover",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  autoPick: false,
  slots: [mm(0, 56, 210, 92)], // 0 56 210×92 mm, bleeds left/right/bottom
  caption: mm(20, 8, 170, 43), // 20 8 170×43 mm
  texts: [
    { bind: "coverTitle", box: mm(20, 8, 170, 32), align: "center", font: "title" }, // 20 8 170×32 mm
    { bind: "coverSubtitle", box: mm(20, 41, 170, 10), align: "center", font: "subtitle" }, // 20 41 170×10 mm
  ],
};

/** Split: photo bleeding off the outer (right) half, title centred in the open half next to the spine. */
export const classicLandscapeCoverSplit: Layout = {
  id: "c-l-cover-split",
  name: "Cover: split",
  role: "cover",
  style: "classic",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["portrait"],
  autoPick: false,
  slots: [mm(105, 0, 105, 148)], // 105 0 105×148 mm, bleeds top/right/bottom
  caption: mm(14, 46, 77, 52), // 14 46 77×52 mm — 14 mm from the spine, 14 mm short of the photo
  texts: [
    { bind: "coverTitle", box: mm(14, 46, 77, 36), align: "center", font: "title" }, // 14 46 77×36 mm
    { bind: "coverSubtitle", box: mm(14, 84, 77, 14), align: "center", font: "subtitle" }, // 14 84 77×14 mm
  ],
};

export const CLASSIC_LANDSCAPE_COVERS = [
  classicLandscapeCoverWindow,
  classicLandscapeCoverTitleFirst,
  classicLandscapeCoverSplit,
] as const satisfies readonly Layout[];
