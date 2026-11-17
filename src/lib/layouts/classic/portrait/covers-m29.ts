// M29 cover styles — classic A5 portrait (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "classic", format "A5_PORTRAIT", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.
//
// Geometry is written in mm on the 148 × 210 mm page (comments) and stored as % of the page.
// `caption` = the whole title block (the editor's cover-text tap target); `texts` place title and
// subtitle inside it (classic faces: Playfair 600 / 400, Cairo for Arabic). Title boxes are tall
// enough that a 120-code-point title still fits above the panel minimum size (panelFontMm).

import type { Layout } from "@/lib/book/types";

const W = 148;
const H = 210;
/** mm rect on the portrait page → % rect (3 decimals). */
const mm = (x: number, y: number, w: number, h: number) => ({
  x: Math.round((x / W) * 100000) / 1000,
  y: Math.round((y / H) * 100000) / 1000,
  w: Math.round((w / W) * 100000) / 1000,
  h: Math.round((h / H) * 100000) / 1000,
});

/** Fine rule round the window photo: a hairline in warm graphite, readable on light and dark boards. */
const FINE_RULE = { kind: "border", mm: 0.4, hex: "#7A6F63" } as const;

/** Framed window: photo in a fine-ruled frame with even 16 mm margins, title + subtitle centred below. */
export const classicPortraitCoverWindow: Layout = {
  id: "c-p-cover-window",
  name: "Cover: framed window",
  role: "cover",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  autoPick: false,
  slots: [{ ...mm(16, 16, 116, 124), frame: FINE_RULE }], // 16 16 116×124 mm
  caption: mm(16, 145, 116, 50), // 16 145 116×50 mm
  texts: [
    { bind: "coverTitle", box: mm(16, 145, 116, 36), align: "center", font: "title" }, // 16 145 116×36 mm
    { bind: "coverSubtitle", box: mm(16, 182, 116, 13), align: "center", font: "subtitle" }, // 16 182 116×13 mm
  ],
};

/** Title first: title + subtitle at the top in generous margins, photo below bleeding off the sides and foot. */
export const classicPortraitCoverTitleFirst: Layout = {
  id: "c-p-cover-title-first",
  name: "Cover: title first",
  role: "cover",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  autoPick: false,
  slots: [mm(0, 68, 148, 142)], // 0 68 148×142 mm, bleeds left/right/bottom
  caption: mm(16, 12, 116, 50), // 16 12 116×50 mm
  texts: [
    { bind: "coverTitle", box: mm(16, 12, 116, 36), align: "center", font: "title" }, // 16 12 116×36 mm
    { bind: "coverSubtitle", box: mm(16, 49, 116, 13), align: "center", font: "subtitle" }, // 16 49 116×13 mm
  ],
};

/** Split: tall photo bleeding off the outer (right) half, title centred in the open half on the book background. */
export const classicPortraitCoverSplit: Layout = {
  id: "c-p-cover-split",
  name: "Cover: split",
  role: "cover",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  autoPick: false,
  slots: [mm(80, 0, 68, 210)], // 80 0 68×210 mm, bleeds top/right/bottom
  caption: mm(10, 62, 60, 66), // 10 62 60×66 mm — 10 mm from the spine, 10 mm short of the photo
  texts: [
    { bind: "coverTitle", box: mm(10, 62, 60, 48), align: "center", font: "title", fit: 0.75 }, // 10 62 60×48 mm
    { bind: "coverSubtitle", box: mm(10, 112, 60, 18), align: "center", font: "subtitle" }, // 10 112 60×18 mm
  ],
};

export const CLASSIC_PORTRAIT_COVERS = [
  classicPortraitCoverWindow,
  classicPortraitCoverTitleFirst,
  classicPortraitCoverSplit,
] as const satisfies readonly Layout[];
