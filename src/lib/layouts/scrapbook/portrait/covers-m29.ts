// M29 cover styles — scrapbook A5 portrait (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "scrapbook", format "A5_PORTRAIT", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.
//
// Designed in mm on the 148 × 210 trim with ../geometry, like the M10c scrapbook set: prints with
// tape, gentle tilts, kraft / paper plates and tags from the sticker catalogue. Title boxes are
// sized so a 120-code-point title still fits at the panel's minimum size (render.ts panelFontMm;
// tests/golden/m29-covers-scrapbook.test.tsx checks it); plates keep close to their natural aspect.

import type { CardMm } from "../geometry";
import { BORDER, POLAROID_M, scrapGeo } from "../geometry";
import type { Layout, LayoutText } from "@/lib/book/types";

const g = scrapGeo("A5_PORTRAIT");
const BASE = { role: "cover", style: "scrapbook", format: "A5_PORTRAIT", photoCount: 1, autoPick: false } as const;

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

const tapeCard: CardMm = { x: 20, y: 22, w: 108, h: 116, frame: BORDER, shadow: "soft" };

/** A straight white-bordered print taped at both top corners; title on a kraft label strip. */
export const scrapbookCoverTape: Layout = {
  ...BASE,
  id: "s-p-cover-tape",
  name: "Cover: taped print + kraft label",
  prefers: ["any"],
  slots: [g.slot(tapeCard)],
  caption: g.rect(14, 148, 120, 48),
  texts: [platedText("coverTitle", "plate-label", 14, 149, 120, 30, KRAFT, -1.5), g.text("coverSubtitle", 20, 184, 108, 10, "year", "center")],
  decorations: [
    g.tape("tape-kraft", tapeCard, -0.9, -0.94, 34, -42),
    g.tape("tape-kraft", tapeCard, 0.9, -0.94, 34, 40),
    g.deco("sticker", "occasion-accent", ...g.on(tapeCard, 0.84, 0.88), 24, { rotate: 10 }),
    g.deco("sticker", "heart-kraft", 132, 184, 11, { rotate: 12 }),
    g.deco("sticker", "sparkle", 15, 190, 9),
  ],
};

// --- (b) Paper tag title, smaller tilted polaroid -------------------------------------------------

const tagCard: CardMm = { x: 28, y: 14, w: 92, h: 112, rotate: 4, frame: POLAROID_M, shadow: "soft" };

/** A smaller tilted polaroid with washi tape; title on a big paper tag clipped on below. */
export const scrapbookCoverTag: Layout = {
  ...BASE,
  id: "s-p-cover-tag",
  name: "Cover: paper tag + tilted polaroid",
  prefers: ["any"],
  slots: [g.slot(tagCard)],
  caption: g.rect(12, 138, 124, 60),
  texts: [platedText("coverTitle", "plate-tag", 12, 140, 124, 38, KRAFT_LIGHT, -3), g.text("coverSubtitle", 20, 186, 108, 10, "year", "center")],
  decorations: [
    g.tape("tape-washi", tagCard, 0, -1, 36, -4),
    g.deco("sticker", "paperclip", 104, 141, 9, { rotate: 8 }),
    g.deco("sticker", "occasion-accent", ...g.on(tagCard, -0.92, 0.84), 24, { rotate: -10 }),
    g.deco("sticker", "star", 128, 24, 10, { rotate: 12, layer: "under" }),
    g.deco("sticker", "leaf-sprig", 18, 30, 13, { rotate: -20, layer: "under" }),
  ],
};

// --- (c) The photo on a stack of paper cards --------------------------------------------------------

const stackCard: CardMm = { x: 24, y: 22, w: 100, h: 112, rotate: -2, frame: BORDER, shadow: "soft" };

/** A print on a little stack of paper cards (tinted tag + label plates under it), title below. */
export const scrapbookCoverStack: Layout = {
  ...BASE,
  id: "s-p-cover-stack",
  name: "Cover: photo on a card stack",
  prefers: ["any"],
  slots: [g.slot(stackCard)],
  caption: g.rect(14, 150, 120, 44),
  texts: [g.text("coverTitle", 14, 152, 120, 28, "title", "center"), g.text("coverSubtitle", 18, 182, 112, 10, "year", "center")],
  decorations: [
    g.deco("plate", "plate-tag", 82, 74, 100, { h: 110, rotate: 7, layer: "under", tint: SKY }),
    g.deco("plate", "plate-label", 70, 84, 100, { h: 108, rotate: -6, layer: "under", tint: KRAFT_PAPER }),
    g.tape("tape-washi", stackCard, 0, -1, 38, 4),
    g.deco("sticker", "occasion-accent", ...g.on(stackCard, 0.9, 0.9), 24, { rotate: 8 }),
    g.deco("sticker", "heart-outline", 128, 148, 11, { rotate: 14 }),
    g.deco("sticker", "flower", 20, 140, 13, { rotate: -12 }),
  ],
};

export const SCRAPBOOK_PORTRAIT_COVERS = [scrapbookCoverTape, scrapbookCoverTag, scrapbookCoverStack] as const satisfies readonly Layout[];
