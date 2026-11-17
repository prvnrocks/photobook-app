// M29 cover styles — modern A5 landscape (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "modern", format "A5_LANDSCAPE", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.
//
// Modern look (T3): bold display title (font role "chapter" = Bebas / Lalezar), asymmetric, strong
// blocks. Designed in mm on the 210 × 148 mm trim; text sits ≥ 14 mm from the spine edge.

import type { Layout } from "@/lib/book/types";

const W = 210;
const H = 148;
const GUTTER = 2.5;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
/** Rect from its edges in mm (left, top, right, bottom) → % of the trim page. */
function mm(x0: number, y0: number, x1: number, y1: number) {
  const x = r4((x0 / W) * 100);
  const y = r4((y0 / H) * 100);
  return { x, y, w: r4((x1 / W) * 100 - x), h: r4((y1 / H) * 100 - y) };
}
/** Split [a, b] mm into `n` equal cells separated by GUTTER → [[start, end], …]. */
function cells(a: number, b: number, n: number): Array<[number, number]> {
  const size = (b - a - GUTTER * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => {
    const s = a + i * (size + GUTTER);
    return [s, i === n - 1 ? b : s + size] as [number, number];
  });
}

/** Dark label plate (white ink) for the title, light one (dark ink) for the subtitle. */
const TITLE_PLATE = { id: "plate-label", tint: "#232326" } as const;
const SUBTITLE_PLATE = { id: "plate-label", tint: "#F7F3EA" } as const;

/**
 * Full-bleed photo with the title on a solid dark plate low on the spine side and the subtitle on a
 * smaller light plate under it (text only ever on the plates).
 */
export const modernLandscapeCoverBand: Layout = {
  id: "m-l-cover-band",
  name: "Cover: full-bleed photo + title plate",
  role: "cover",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [mm(0, 0, W, H)],
  caption: mm(14, 92, 142, 138),
  texts: [
    { bind: "coverTitle", box: mm(14, 92, 142, 122), align: "start", font: "chapter", plate: TITLE_PLATE },
    { bind: "coverSubtitle", box: mm(14, 125, 96, 138), align: "start", font: "subtitle", plate: SUBTITLE_PLATE },
  ],
  autoPick: false,
};

const TILE_X0 = 124;
const TILE_Y0 = 22;
/**
 * Typographic cover: a big bold title on the spine side, subtitle under it, and the one photo cut
 * into a 2 × 3 grid of tiles bleeding off the right and bottom edges (slices; gaps show the page).
 */
export const modernLandscapeCoverType: Layout = {
  id: "m-l-cover-type",
  name: "Cover: bold title + photo tiles",
  role: "cover",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["any"],
  slots: [mm(TILE_X0, TILE_Y0, W, H)],
  slices: cells(TILE_Y0, H, 3).flatMap(([y0, y1]) => cells(TILE_X0, W, 2).map(([x0, x1]) => mm(x0, y0, x1, y1))),
  caption: mm(14, 30, 112, 88),
  texts: [
    { bind: "coverTitle", box: mm(14, 30, 112, 74), align: "start", font: "chapter" },
    { bind: "coverSubtitle", box: mm(14, 76, 112, 88), align: "start", font: "subtitle" },
  ],
  autoPick: false,
};

export const MODERN_LANDSCAPE_COVERS = [modernLandscapeCoverBand, modernLandscapeCoverType] as const satisfies readonly Layout[];
