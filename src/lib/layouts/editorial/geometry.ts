// Geometry of the editorial layouts (M30, D-090: minimal Swiss, ref docs/design/refs/mg-covers.jpg).
// Pure, no runtime imports beyond the shared mm helpers — layouts stay plain data. Both formats of
// the style import from here; nothing else in the app does.
//
// Colour (G0): rules, hairlines and short bars on white are `accentOnLight` — the colourway's
// accent deepened for paper, which is the page ink (#111) in the default `ink` colourway, so the
// default book stays black on white and every other colourway visibly colours the page.

import type { LayoutBlock, TextBinding } from "@/lib/book/types";
import { pageMm, relative, type Pt } from "../page-mm";

export type { Pt } from "../page-mm";

/** A5 portrait page in mm (148 × 210; spreads run on to x = 296, fold at 148). */
export const PORTRAIT = pageMm(148, 210);
/** A5 landscape page in mm (210 × 148; spreads run on to x = 420, fold at 210). */
export const LANDSCAPE = pageMm(210, 148);

type Fill = LayoutBlock["fill"];
type Layer = LayoutBlock["layer"];

/** Hairline weight (mm) of the style: rules, outlines and the diagonal echo lines (prints clean, ≥ 0.3 mm). */
export const HAIR = 0.35;
/** Short heavy rule that opens a text block (mm). */
export const RULE = { len: 12, t: 1 } as const;
/** Slim accent bar above the title of the auto covers (mm): the colourway's mark on the cover. */
export const BAR = { len: 24, t: 2 } as const;
/** Fill of rules and hairlines on white paper. */
export const LINE: Fill = "accentOnLight";

// --- portrait ---------------------------------------------------------------------------------------

interface RuleOpts {
  fill?: Fill;
  layer?: Layer;
  when?: TextBinding;
  mm?: number;
}
const P = PORTRAIT;

/** Portrait: horizontal rule from x0 to x1 (mm), its top edge at y. */
export function hRule(x0: number, x1: number, y: number, o: RuleOpts = {}): LayoutBlock {
  return P.block(x0, y, x1, y + (o.mm ?? HAIR), o.fill ?? LINE, o.layer, o.when);
}

/** Portrait: vertical rule from y0 to y1 (mm), its left edge at x. */
export function vRule(x: number, y0: number, y1: number, o: RuleOpts = {}): LayoutBlock {
  return P.block(x, y0, x + (o.mm ?? HAIR), y1, o.fill ?? LINE, o.layer, o.when);
}

/**
 * Portrait: diagonal hairline from a to b (mm, a left of b), `mm` thick measured across the line.
 * The box is ~1 % of the page taller than the line at both ends (clamped to the page): where an
 * end sits on the trim the print bleed carries the line on along its own slope, and a block only
 * paints inside its box.
 */
export function diagRule(a: Pt, b: Pt, o: RuleOpts = {}): LayoutBlock {
  const slope = (b[1] - a[1]) / (b[0] - a[0]);
  const half = ((o.mm ?? HAIR) * Math.sqrt(1 + slope * slope)) / 2;
  const slack = P.H / 100;
  const y0 = Math.max(0, Math.min(a[1], b[1]) - half - slack);
  const y1 = Math.min(P.H, Math.max(a[1], b[1]) + half + slack);
  const pts: Pt[] = [
    [a[0], a[1] - half],
    [b[0], b[1] - half],
    [b[0], b[1] + half],
    [a[0], a[1] + half],
  ];
  return {
    box: P.rect(a[0], y0, b[0], y1),
    fill: o.fill ?? LINE,
    layer: o.layer ?? "under",
    points: relative(pts, a[0], y0, b[0], y1),
    ...(o.when ? { when: o.when } : {}),
  };
}

// --- landscape --------------------------------------------------------------------------------------

const L = LANDSCAPE;
/** Slack around a diagonal line's box, so its ends can run on into the bleed along their own slope. */
const SLACK = 2.4;

/**
 * Landscape: diagonal hairline from a to b (mm), `t` mm thick, as a thin polygon block. `maxX` =
 * right end of the area the box may use (a page: 210; the right page of a spread: 420).
 */
export function hairline(a: Pt, b: Pt, opts: { fill?: Fill; layer?: Layer; t?: number; minX?: number; maxX?: number; when?: TextBinding } = {}): LayoutBlock {
  const { fill = LINE, layer = "under", t = HAIR, minX = 0, maxX = L.W, when } = opts;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const nx = (-dy / len) * (t / 2);
  const ny = (dx / len) * (t / 2);
  const pts: Pt[] = [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ];
  const x0 = Math.max(minX, Math.min(a[0], b[0]) - SLACK);
  const x1 = Math.min(maxX, Math.max(a[0], b[0]) + SLACK);
  const y0 = Math.max(0, Math.min(a[1], b[1]) - SLACK);
  const y1 = Math.min(L.H, Math.max(a[1], b[1]) + SLACK);
  return { box: L.rect(x0, y0, x1, y1), fill, layer, points: relative(pts, x0, y0, x1, y1), ...(when ? { when } : {}) };
}

/** Landscape: short heavy rule starting at (x, y); goes with `when`'s text. */
export function rule(x: number, y: number, when?: TextBinding, len: number = RULE.len): LayoutBlock {
  return L.block(x, y, x + len, y + RULE.t, LINE, "under", when);
}
