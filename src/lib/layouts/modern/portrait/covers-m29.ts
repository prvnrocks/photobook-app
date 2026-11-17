// M29 cover styles — modern A5 portrait (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "modern", format "A5_PORTRAIT", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.
//
// Modern look (T3): bold display title (font role "chapter" = Bebas / Lalezar), asymmetric, strong
// blocks. Designed in mm on the 148 × 210 mm trim (./geometry mmRect). Long titles (120 code points)
// fit at ≥ 4.5 mm (panelFontMm) — tests/golden/m29-covers-modern.test.tsx.

import type { Layout } from "@/lib/book/types";
import { cells, mmRect, PAGE_H_MM as H, PAGE_W_MM as W } from "./geometry";

/** Dark label plate (white ink) for the title, light one (dark ink) for the subtitle. */
const TITLE_PLATE = { id: "plate-label", tint: "#232326" } as const;
const SUBTITLE_PLATE = { id: "plate-label", tint: "#F7F3EA" } as const;

const bandTitle = mmRect(10, 146, 128, 178);
const bandSubtitle = mmRect(10, 181, 84, 195);
/**
 * Full-bleed photo with the title on a solid dark plate low on the spine side and the subtitle on a
 * smaller light plate under it (text only ever on the plates).
 */
export const modernCoverBand: Layout = {
  id: "m-p-cover-band",
  name: "Cover: full-bleed photo + title plate",
  role: "cover",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [mmRect(0, 0, W, H)],
  caption: mmRect(10, 146, 128, 195),
  texts: [
    { bind: "coverTitle", box: bandTitle, align: "start", font: "chapter", plate: TITLE_PLATE },
    { bind: "coverSubtitle", box: bandSubtitle, align: "start", font: "subtitle", plate: SUBTITLE_PLATE },
  ],
  autoPick: false,
};

const TILE_X0 = 56;
const TILE_Y0 = 72;
const typeTitle = mmRect(12, 18, W - 12, 50);
const typeSubtitle = mmRect(12, 52, 110, 62);
/**
 * Typographic cover: a big bold title across the top, subtitle under it, and the one photo cut into
 * a 2 × 3 grid of tiles bleeding off the right and bottom edges (slices; gaps show the page).
 */
export const modernCoverType: Layout = {
  id: "m-p-cover-type",
  name: "Cover: bold title + photo tiles",
  role: "cover",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [mmRect(TILE_X0, TILE_Y0, W, H)],
  slices: cells(TILE_Y0, H, 3).flatMap(([y0, y1]) => cells(TILE_X0, W, 2).map(([x0, x1]) => mmRect(x0, y0, x1, y1))),
  caption: mmRect(12, 18, W - 12, 62),
  texts: [
    { bind: "coverTitle", box: typeTitle, align: "start", font: "chapter" },
    { bind: "coverSubtitle", box: typeSubtitle, align: "start", font: "subtitle" },
  ],
  autoPick: false,
};

export const MODERN_PORTRAIT_COVERS = [modernCoverBand, modernCoverType] as const satisfies readonly Layout[];
