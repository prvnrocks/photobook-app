// Editorial A5 PORTRAIT user-chosen cover styles (M30 T6): role "cover", autoPick false. Same
// drawing rules as ./layouts (page mm through ../geometry, rules in `ink` on white, `paper` on the
// photo). Cover text keeps ≥ 12 mm from the trim.

import type { Layout, LayoutBlock } from "@/lib/book/types";
import { diagRule, hRule, PORTRAIT, RULE, vRule, type Pt } from "../geometry";

const { W, H, rect, poly, text, block } = PORTRAIT;
const COVER = { role: "cover", style: "editorial", format: "A5_PORTRAIT" } as const;

// --- vertical title on the photo ------------------------------------------------------------------
const V_TITLE = rect(68, 12, 114, 198);
const V_STRIP: [number, number] = [116, 136];
/** Left edge of the scrim column behind the title (it runs to the strip). */
const V_BAND = 62;
/** White hairline across the photo, broken by the strip. */
const vLine = (x: number): Pt => [x, 160 - (54 / W) * x];

/** The two cover lines: white labels flush with the left trim, each only with its line. */
const vLabel = (n: number, y: number): LayoutBlock => ({ box: rect(0, y, V_BAND, y + 11), fill: "paper", layer: "over", when: "coverLine", n });

/**
 * Full-bleed photo; the title runs up the page in huge white letters on a flat scrim column
 * (legible on snow and sky) beside a white vertical strip that carries the date; a white hairline
 * crosses the photo; two cover lines on white labels bottom left.
 */
export const editorialPortraitCoverVertical: Layout = {
  id: "ed-p-cover-vertical",
  name: "Cover: vertical title on the photo",
  ...COVER,
  photoCount: 1,
  prefers: ["portrait"],
  autoPick: false,
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: V_TITLE,
  blocks: [
    block(V_BAND, 0, V_STRIP[0], H, "scrim", "over"),
    diagRule(vLine(0), vLine(V_STRIP[0]), { fill: "paper", layer: "over" }),
    diagRule(vLine(V_STRIP[1]), vLine(W), { fill: "paper", layer: "over" }),
    block(V_STRIP[0], 0, V_STRIP[1], 150, "paper", "over"),
    vLabel(0, 174),
    vLabel(1, 185),
  ],
  texts: [
    text("coverTitle", V_TITLE, "masthead", "paper", { align: "end", rotate: -90 }),
    text("coverSubtitle", [121, 12, 131, 138], "year", "accent", { rotate: 90 }),
    text("coverLine", [12, 176, 58, 183], "chapter", "accent", { n: 0 }),
    text("coverLine", [12, 187, 58, 194], "chapter", "ink", { n: 1 }),
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
  ...COVER,
  photoCount: 1,
  prefers: ["any"],
  autoPick: false,
  slots: [poly([hyp(W), [W, H], [0, H]])],
  caption: CORNER_TITLE,
  blocks: [diagRule(hyp(0, 10), hyp(W, 10)), hRule(12, 26, 98, { when: "coverLine", mm: RULE.t })],
  texts: [
    text("coverTitle", CORNER_TITLE, "masthead", "ink", { align: "end" }),
    text("coverSubtitle", [12, 16, 20, 88], "year", "accent", { align: "end", rotate: -90 }),
    text("coverLine", [12, 104, 76, 110.5], "subtitle", "accent", { n: 0 }),
    text("coverLine", [12, 112, 76, 118.5], "subtitle", "muted", { n: 1 }),
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
  ...COVER,
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
    hRule(67, 81, 184, { mm: RULE.t }),
  ],
  texts: [
    text("coverLine", [16, 12, 132, 18.5], "subtitle", "accent", { n: 0, align: "center" }),
    text("coverTitle", FRAME_TITLE, "masthead", "ink", { align: "center" }),
    text("coverSubtitle", [16, 188, 132, 195], "year", "accent", { align: "center" }),
  ],
};
