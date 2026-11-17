// M29 cover styles — scrapbook A5 landscape (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "scrapbook", format "A5_LANDSCAPE", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.
//
// Designed in mm on the 210 × 148 trim with ../geometry, like the M10c scrapbook set: prints with
// tape, gentle tilts, kraft / paper plates and tags from the sticker catalogue. Title boxes are
// sized so a 120-code-point title still fits at the panel's minimum size (render.ts panelFontMm;
// tests/golden/m29-covers-scrapbook.test.tsx checks it); plates keep close to their natural aspect.

import type { CardMm } from "../geometry";
import { BORDER, POLAROID_M, scrapGeo } from "../geometry";
import type { Layout, LayoutText } from "@/lib/book/types";

const g = scrapGeo("A5_LANDSCAPE");
const BASE = { role: "cover", style: "scrapbook", format: "A5_LANDSCAPE", photoCount: 1, autoPick: false } as const;

/** Kraft-paper tints from the catalogue's suggested lists (plate-label / plate-tag / tape-kraft). */
const KRAFT = "#C9A578";
const KRAFT_LIGHT = "#E8D3B0";
const KRAFT_PAPER = "#D8C7A8";
const SKY = "#DCE6EE";

/** A cover text on a label plate (geometry's plate() only binds chapter / date texts). */
function platedText(
  bind: LayoutText["bind"],
  id: "plate-label" | "plate-tag",
  x: number,
  y: number,
  w: number,
  h: number,
  tint: string,
  rotate?: number,
): LayoutText {
  return { bind, box: g.rect(x, y, w, h), align: "center", font: "title", plate: { id, tint }, ...(rotate ? { rotate } : {}) };
}

// --- (a) Straight print held by two tapes, kraft label title -----------------------------------

const tapeCard: CardMm = { x: 22, y: 12, w: 166, h: 94, frame: BORDER, shadow: "soft" };

/** A wide straight print taped at both top corners; a kraft label strip stuck over its lower edge. */
export const scrapbookLandscapeCoverTape: Layout = {
  ...BASE,
  id: "s-l-cover-tape",
  name: "Cover: taped print + kraft label",
  prefers: ["any"],
  slots: [g.slot(tapeCard)],
  caption: g.rect(30, 99, 150, 43),
  texts: [platedText("coverTitle", "plate-label", 38, 100, 134, 28, KRAFT, -1.5), g.text("coverSubtitle", 30, 132, 150, 9, "year", "center")],
  decorations: [
    g.tape("tape-kraft", tapeCard, -0.94, -0.9, 34, -40),
    g.tape("tape-kraft", tapeCard, 0.94, -0.9, 34, 38),
    g.deco("sticker", "occasion-accent", ...g.on(tapeCard, 0.93, 0.7), 22, { rotate: 10 }),
    g.deco("sticker", "heart-kraft", 24, 122, 12, { rotate: -12 }),
    g.deco("sticker", "sparkle", 188, 126, 10),
  ],
};

// --- (b) Paper tag title, smaller tilted polaroid -------------------------------------------------

const tagCard: CardMm = { x: 118, y: 18, w: 78, h: 106, rotate: 5, frame: POLAROID_M, shadow: "soft" };

/** A paper-tag title (clipped) on the left, a smaller tilted polaroid with washi tape on the right. */
export const scrapbookLandscapeCoverTag: Layout = {
  ...BASE,
  id: "s-l-cover-tag",
  name: "Cover: paper tag + tilted polaroid",
  prefers: ["any"],
  slots: [g.slot(tagCard)],
  caption: g.rect(14, 46, 96, 62),
  texts: [platedText("coverTitle", "plate-tag", 14, 50, 96, 36, KRAFT_LIGHT, -4), g.text("coverSubtitle", 18, 96, 90, 10, "year", "center")],
  decorations: [
    g.tape("tape-washi", tagCard, 0, -1, 34, -4),
    g.deco("sticker", "paperclip", 94, 51, 9, { rotate: 8 }),
    g.deco("sticker", "occasion-accent", ...g.on(tagCard, -0.92, 0.86), 24, { rotate: -10 }),
    g.deco("sticker", "star", 26, 30, 10, { rotate: -12 }),
    g.deco("sticker", "leaf-sprig", 72, 124, 13, { rotate: 20 }),
  ],
};

// --- (c) The photo on a stack of paper cards --------------------------------------------------------

const stackCard: CardMm = { x: 100, y: 18, w: 96, h: 106, rotate: 2, frame: BORDER, shadow: "soft" };

/** A print on a little stack of paper cards (tinted tag + label plates under it); title on the left. */
export const scrapbookLandscapeCoverStack: Layout = {
  ...BASE,
  id: "s-l-cover-stack",
  name: "Cover: photo on a card stack",
  prefers: ["any"],
  slots: [g.slot(stackCard)],
  caption: g.rect(14, 42, 74, 56),
  texts: [g.text("coverTitle", 14, 42, 74, 40, "title", "center"), g.text("coverSubtitle", 16, 86, 70, 12, "year", "center")],
  decorations: [
    g.deco("plate", "plate-tag", 150, 64, 96, { h: 104, rotate: 7, layer: "under", tint: SKY }),
    g.deco("plate", "plate-label", 144, 80, 96, { h: 104, rotate: -6, layer: "under", tint: KRAFT_PAPER }),
    g.tape("tape-washi", stackCard, 0, -1, 36, -4),
    g.deco("sticker", "occasion-accent", ...g.on(stackCard, -0.9, 0.9), 24, { rotate: -8 }),
    g.deco("sticker", "heart-outline", 30, 116, 11, { rotate: -14 }),
    g.deco("sticker", "flower", 70, 118, 13, { rotate: 12 }),
  ],
};

export const SCRAPBOOK_LANDSCAPE_COVERS = [
  scrapbookLandscapeCoverTape,
  scrapbookLandscapeCoverTag,
  scrapbookLandscapeCoverStack,
] as const satisfies readonly Layout[];
