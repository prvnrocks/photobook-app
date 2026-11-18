// Editorial A5 PORTRAIT user-chosen cover styles (M30 T6): role "cover", autoPick false. Same
// drawing rules as ./layouts (page mm through ./geometry, rules in `ink` on white, `paper` on the
// photo). Cover text keeps ≥ 12 mm from the trim.

import type { Layout } from "@/lib/book/types";
import { diagRule, hRule, poly, rect, vRule, H, W, type Pt } from "./geometry";

// --- vertical title on the photo ------------------------------------------------------------------
const V_TITLE = rect(68, 12, 114, 198);
const V_STRIP: [number, number] = [116, 136];
/** White hairline across the photo, broken by the strip. */
const vLine = (x: number): Pt => [x, 160 - (54 / W) * x];

/**
 * Full-bleed photo; the title runs up the page in huge white letters beside a white vertical strip
 * that carries the date; a white hairline crosses the photo; two cover lines bottom left.
 */
export const editorialPortraitCoverVertical: Layout = {
  id: "ed-p-cover-vertical",
  name: "Cover: vertical title on the photo",
  role: "cover",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  autoPick: false,
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: V_TITLE,
  blocks: [
    diagRule(vLine(0), vLine(V_STRIP[0]), { fill: "paper", layer: "over" }),
    diagRule(vLine(V_STRIP[1]), vLine(W), { fill: "paper", layer: "over" }),
    { box: rect(V_STRIP[0], 0, V_STRIP[1], 150), fill: "paper", layer: "over" },
  ],
  texts: [
    { bind: "coverTitle", box: V_TITLE, align: "end", font: "masthead", ink: "paper", rotate: -90 },
    { bind: "coverSubtitle", box: rect(121, 12, 131, 138), align: "start", font: "year", ink: "ink", rotate: 90 },
    { bind: "coverLine", n: 0, box: rect(12, 176, 64, 183), align: "start", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 1, box: rect(12, 186, 64, 193), align: "start", font: "chapter", ink: "paper" },
  ],
};

// --- triangle photo in the corner -----------------------------------------------------------------
/** The corner triangle's long side: from the bottom-left corner up to the right edge. */
const hyp = (x: number, off = 0): Pt => [x, H - off - (130 / W) * x];
const CORNER_TITLE = rect(52, 16, 136, 62);

/**
 * White page; the photo only fills the bottom-right triangle, with a hairline echoing its long
 * side. Title top right, the date turned a quarter top left, two cover lines under a short rule.
 */
export const editorialPortraitCoverCorner: Layout = {
  id: "ed-p-cover-corner",
  name: "Cover: photo triangle in the corner",
  role: "cover",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  autoPick: false,
  slots: [poly([hyp(W), [W, H], [0, H]])],
  caption: CORNER_TITLE,
  blocks: [diagRule(hyp(0, 10), hyp(W, 10)), hRule(12, 26, 98, { when: "coverLine", mm: 0.6 })],
  texts: [
    { bind: "coverTitle", box: CORNER_TITLE, align: "end", font: "masthead", ink: "ink" },
    { bind: "coverSubtitle", box: rect(12, 16, 20, 88), align: "end", font: "year", ink: "muted", rotate: -90 },
    { bind: "coverLine", n: 0, box: rect(12, 104, 76, 110.5), align: "start", font: "subtitle", ink: "ink" },
    { bind: "coverLine", n: 1, box: rect(12, 112, 76, 118.5), align: "start", font: "subtitle", ink: "muted" },
  ],
};

// --- centred, framed photo ------------------------------------------------------------------------
const FRAME_TITLE = rect(16, 146, 132, 180);
/** Hairline outline 4 mm outside the photo. */
const OUT = { x0: 24, y0: 24, x1: 124, y1: 138 };

/**
 * Clean centred cover: one rectangular photo inside a hairline outline, a cover line above it,
 * the title below with a short rule and the date.
 */
export const editorialPortraitCoverFrame: Layout = {
  id: "ed-p-cover-frame",
  name: "Cover: framed photo, centred title",
  role: "cover",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  autoPick: false,
  slots: [rect(OUT.x0 + 4, OUT.y0 + 4, OUT.x1 - 4, OUT.y1 - 4)],
  caption: FRAME_TITLE,
  blocks: [
    hRule(OUT.x0, OUT.x1, OUT.y0),
    hRule(OUT.x0, OUT.x1, OUT.y1 - 0.35),
    vRule(OUT.x0, OUT.y0, OUT.y1),
    vRule(OUT.x1 - 0.35, OUT.y0, OUT.y1),
    hRule(67, 81, 184, { mm: 0.6 }),
  ],
  texts: [
    { bind: "coverLine", n: 0, box: rect(16, 12, 132, 18.5), align: "center", font: "subtitle", ink: "muted" },
    { bind: "coverTitle", box: FRAME_TITLE, align: "center", font: "masthead", ink: "ink" },
    { bind: "coverSubtitle", box: rect(16, 188, 132, 195), align: "center", font: "year", ink: "muted" },
  ],
};
