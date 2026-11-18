// Test-only magazine / editorial layouts that exercise every M30 renderer primitive (blocks: fill
// roles, under / over, polygon, `when`; text ink roles, quarter turns, coverLine + chapterDescription
// bindings, masthead / body roles). Written at M30 T3 as dev demo layouts before the real catalogues
// existed; moved here from src/lib/book/dev-m30.ts at T14a. They are NOT in the catalogue
// (src/lib/layouts): tests render them through <BookPage extraLayouts> / RenderOptions.extraLayouts.

import type { Layout } from "@/lib/book/types";

/**
 * Magazine cover: full-bleed photo, white masthead across the top, accent date line, three cover
 * lines down the right edge (the middle one in the vivid accent) and a paper strip at the foot with
 * a fourth cover line. Primitives: masthead role, ink paper / accentOnDark / ink, coverLine + n,
 * `over` blocks (accent bar, paper strip) and a block with `when` (the strip goes with its line).
 */
export const demoMagazineCover: Layout = {
  id: "demo-m30-cover-masthead",
  name: "Demo: masthead cover with cover lines",
  role: "cover",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: { x: 6, y: 4, w: 88, h: 30 },
  blocks: [
    // Accent bar under the date line.
    { box: { x: 6, y: 8.2, w: 14, h: 0.5 }, fill: "accent", layer: "over" },
    // Foot strip: only when there is a fourth chapter to print on it.
    { box: { x: 0, y: 88, w: 100, h: 12 }, fill: "paper", layer: "over", when: "coverLine" },
  ],
  texts: [
    { bind: "coverSubtitle", box: { x: 6, y: 4, w: 88, h: 3.6 }, align: "start", font: "year", ink: "accentOnDark" },
    { bind: "coverTitle", box: { x: 6, y: 10, w: 88, h: 24 }, align: "start", font: "masthead", ink: "paper" },
    { bind: "coverLine", n: 1, box: { x: 52, y: 40, w: 42, h: 9 }, align: "end", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 2, box: { x: 52, y: 50, w: 42, h: 9 }, align: "end", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 3, box: { x: 52, y: 60, w: 42, h: 9 }, align: "end", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 0, box: { x: 6, y: 90, w: 88, h: 8 }, align: "start", font: "subtitle", ink: "ink" },
  ],
};

/**
 * Magazine page: a photo on the left, a dark panel column on the right with the chapter title in
 * the vivid accent, the date, the chapter description and a small second photo; the caption sits
 * under the left photo. Primitives: `under` panel block, accent rule with `when`, body role,
 * ink accentOnDark / paper / muted, a caption coloured through the pageCaption panel.
 */
export const demoMagazinePanel: Layout = {
  id: "demo-m30-panel-page",
  name: "Demo: dark panel with heading + description",
  role: "page",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["portrait", "landscape"],
  slots: [
    { x: 0, y: 0, w: 50, h: 66 },
    { x: 56, y: 68, w: 38, h: 24 },
  ],
  caption: { x: 6, y: 70, w: 38, h: 22 },
  blocks: [
    { box: { x: 50, y: 0, w: 50, h: 100 }, fill: "panel", layer: "under" },
    // The rule belongs to the description: no description → no rule.
    { box: { x: 56, y: 27.4, w: 10, h: 0.4 }, fill: "accent", layer: "under", when: "chapterDescription" },
  ],
  texts: [
    { bind: "dateLabel", box: { x: 56, y: 6, w: 38, h: 3.4 }, align: "start", font: "year", ink: "paper" },
    { bind: "chapterTitle", box: { x: 56, y: 10, w: 38, h: 16 }, align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "chapterDescription", box: { x: 56, y: 29, w: 38, h: 37 }, align: "start", font: "body", ink: "paper" },
    { bind: "pageCaption", box: { x: 6, y: 70, w: 38, h: 22 }, align: "start", font: "caption", ink: "muted" },
  ],
};

/**
 * Editorial page: white page, a diagonal-cut photo rising from the foot, a hairline parallel to the
 * cut, a paper strip over the photo carrying the date turned a quarter, a heavy sans title and the
 * description. Primitives: polygon photo slot, polygon hairline block (ink), `over` paper block,
 * rotate ±90 text, masthead role in a sentence-case style, ink accent (deepened for white pages).
 */
export const demoEditorialDiagonal: Layout = {
  id: "demo-m30-diagonal",
  name: "Demo: diagonal photo, hairline, vertical date",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [
    {
      x: 0,
      y: 46,
      w: 100,
      h: 54,
      shape: { kind: "polygon", points: [[0, 46], [100, 0], [100, 100], [0, 100]] },
    },
  ],
  caption: null,
  blocks: [
    // Hairline 0.37 mm, parallel to the photo's cut, 9 mm above it. The box is ~1 % of the page
    // taller than the line at both ends: in print the ends run on into the bleed along the line's
    // own slope, and a block only paints inside its box.
    { box: { x: 0, y: 40.7, w: 100, h: 27.1 }, fill: "ink", layer: "under", points: [[0, 95.6], [100, 3.7], [100, 4.35], [0, 96.25]] },
    { box: { x: 80, y: 56, w: 11, h: 44 }, fill: "paper", layer: "over" },
    // "ink", not "accent": the vivid accent is made for dark surfaces (editorial "ink" colourway: near-white).
    { box: { x: 8, y: 22.6, w: 9, h: 0.6 }, fill: "ink", layer: "under", when: "chapterDescription" },
  ],
  texts: [
    { bind: "chapterTitle", box: { x: 8, y: 7, w: 62, h: 14 }, align: "start", font: "masthead", ink: "ink" },
    { bind: "chapterDescription", box: { x: 8, y: 25, w: 56, h: 22 }, align: "start", font: "body", ink: "muted" },
    { bind: "dateLabel", box: { x: 82, y: 60, w: 7, h: 34 }, align: "start", font: "year", ink: "accent", rotate: -90 },
    { bind: "dateLabel", box: { x: 86, y: 7, w: 6, h: 26 }, align: "start", font: "year", ink: "muted", rotate: 90 },
  ],
};

export const M30_DEMO_LAYOUTS: readonly Layout[] = [demoMagazineCover, demoMagazinePanel, demoEditorialDiagonal];
