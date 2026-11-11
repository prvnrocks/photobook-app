// Modern A5 LANDSCAPE cover layouts (M10b A5b). Pure data, original geometry.
//
// Rects are % of the 210×148 mm front cover. `caption` is the whole title block (the M5–M10a
// cover renderer draws title + subtitle stacked inside it); `texts` place the title and the
// subtitle/year precisely inside that block with their own font roles (styles.ts: title =
// script, year/subtitle = serif). Text stays ≥ 10 mm from the left/right trim (the spine side
// included) and ≥ 6 mm from top/bottom.

import type { Layout } from "@/lib/book/types";

/**
 * Split-strip cover (ref1 feel, original geometry): script title and serif year on a white band
 * over a wide full-bleed photo. The vertical strip cuts across the photo are drawn by the cover
 * renderer (A9); the layout carries the photo box and the text boxes.
 */
export const modernLandscapeCoverStrip: Layout = {
  id: "m-l-cover-strip",
  name: "Cover: title band + wide photo",
  role: "cover",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["landscape"],
  slots: [{ x: 0, y: 31.081, w: 100, h: 68.919 }], // 0 46 210×102 mm, bleeds left/right/bottom
  caption: { x: 4.762, y: 4.054, w: 90.476, h: 24.324 }, // 10 6 190×36 mm
  texts: [
    { bind: "coverTitle", box: { x: 4.762, y: 4.054, w: 90.476, h: 16.216 }, align: "center", font: "title" }, // 10 6 190×24 mm
    { bind: "coverSubtitle", box: { x: 4.762, y: 20.946, w: 90.476, h: 7.432 }, align: "center", font: "year" }, // 10 31 190×11 mm
  ],
};

/** Panel cover: title block in an open panel on the spine side, tall photo bleeding off the other three edges. */
export const modernLandscapeCoverPanel: Layout = {
  id: "m-l-cover-panel",
  name: "Cover: side panel + tall photo",
  role: "cover",
  style: "modern",
  format: "A5_LANDSCAPE",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 40, y: 0, w: 60, h: 100 }], // 84 0 126×148 mm
  caption: { x: 4.762, y: 29.73, w: 31.428, h: 32.432 }, // 10 44 66×48 mm
  texts: [
    { bind: "coverTitle", box: { x: 4.762, y: 29.73, w: 31.428, h: 22.973 }, align: "start", font: "title" }, // 10 44 66×34 mm
    { bind: "coverSubtitle", box: { x: 4.762, y: 54.054, w: 31.428, h: 8.108 }, align: "start", font: "subtitle" }, // 10 80 66×12 mm
  ],
};
