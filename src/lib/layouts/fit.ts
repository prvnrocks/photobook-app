// Best layout for a fixed, ordered set of photos, per book format + design style (M10b A10).
// Pure data maths, shared by the rule-based autolayout, prunePlan (photos removed from an AI plan
// mid-run) and relayoutDoc (D-028 "Update album"). Every query stays inside the book's design:
// layoutsFor(format, style, role) — validateBookDoc rejects any other format or style.
// Default design = classic A5 portrait (the M1–M10a catalogue, in the same order → identical picks).
//
// Shape-aware fitting (M10c T10) — geometric + scrapbook only (SHAPE_AWARE_STYLES); classic and
// modern keep the M10b maths byte-identical (tests/autolayout-*-golden.test.ts):
// - a slot is judged by its VISIBLE photo area: the frame inset is removed (photoRectOf) and the
//   shape clips the rest (polygon / hexagon / diamond / circle). Its aspect is the aspect of the
//   inertia-equivalent rectangle of that area (exact for rects; 1 for circles, square diamonds and
//   regular hexagons; a diagonal cut or a notch shifts it toward the part that stays visible), so
//   a photo is matched to what is actually shown, not to the bounding box.
// - "round" slots (circle, ellipse, hexagon, diamond, convex many-point polygons such as petals)
//   only fit square-ish photos: a photo whose aspect is more than ROUND_STRETCH_MAX away from the
//   visible aspect is an orientation miss even in an "any" slot (a panorama in a circle would lose
//   most of the picture and the faces at its sides).
// - among layouts / slot assignments with the same number of misses, the lower total aspect
//   distance |ln(photo aspect / visible aspect)| wins (then catalogue order).

import { assertSupportedDesign, type BookDesign } from "@/lib/book/book-design";
import { DEFAULT_FORMAT, pageMm } from "@/lib/book/format";
import { photoRectOf, shapePoints } from "@/lib/book/slot-geometry";
import { layoutsFor } from "@/lib/book/spreads";
import type { BookFormat, DesignStyle, Layout } from "@/lib/book/types";

export type FitOrientation = "portrait" | "landscape" | "square";

const DEFAULT_DESIGN: BookDesign = { format: DEFAULT_FORMAT, designStyle: "classic" };

/** A square photo fits any slot; "any" slots fit any photo. */
export const fitsSlot = (pref: string, o: FitOrientation): boolean => pref === "any" || o === "square" || pref === o;

/** Number of slots i whose preference fits photo i. */
export function fitScore(layout: Pick<Layout, "prefers">, orients: readonly FitOrientation[]): number {
  return orients.reduce((n, o, i) => n + (fitsSlot(layout.prefers[i] ?? "any", o) ? 1 : 0), 0);
}

export interface BestLayoutOptions {
  /**
   * Only consider layouts with a caption area when at least one fits the photo count (used to
   * keep a user's caption on a re-fitted page, D-031); otherwise same as without.
   */
  preferCaption?: boolean;
  /** The book's format + design style (books.format / books.design_style). Default classic A5 portrait. */
  design?: BookDesign;
  /** "page" (default) or "spread" (two-page layouts). */
  role?: "page" | "spread";
  /**
   * Photo aspects (w/h), parallel to `orients` — used by shape-aware designs only (a missing or
   * invalid entry → the orientation's typical aspect, see typicalRatio).
   */
  ratios?: readonly number[];
  /**
   * Shape-aware designs only: a layout id not to pick (the previous page's, so consecutive pages
   * don't look cloned) when another layout fits as many photos with a total aspect cost within
   * AVOID_COST_TOLERANCE of the best. Ignored for classic / modern.
   */
  avoid?: string | null;
}

/**
 * Layout id of the book's design with exactly `orients.length` slots and the most orientation
 * matches (slot i ↔ photo i, photos are not reordered); catalogue order on ties. null = no layout
 * of that role has that many slots.
 */
export function bestPageLayout(orients: readonly FitOrientation[], opts: BestLayoutOptions = {}): string | null {
  const design = opts.design ?? DEFAULT_DESIGN;
  assertSupportedDesign(design); // typed UnsupportedDesignError for a style without layouts
  const sized = layoutsFor(design.format, design.designStyle, opts.role ?? "page").filter(
    (l) => l.photoCount === orients.length,
  );
  const withCaption = sized.filter((l) => l.caption !== null);
  const pool = opts.preferCaption && withCaption.length > 0 ? withCaption : sized;
  if (isShapeAware(design)) {
    const photos = orients.map((o, i) => ({ orient: o, ratio: validRatio(opts.ratios?.[i]) ?? typicalRatio(o) }));
    let bestShaped: { id: string; score: number; cost: number } | null = null;
    const scored = pool.map((l) => ({
      id: l.id,
      score: shapeFitScore(l, photos, design.format),
      cost: shapeCostOf(l, photos, design.format),
    }));
    for (const c of scored) {
      if (!bestShaped || c.score > bestShaped.score || (c.score === bestShaped.score && c.cost < bestShaped.cost - COST_EPS)) {
        bestShaped = c;
      }
    }
    if (bestShaped && opts.avoid != null && bestShaped.id === opts.avoid) {
      const top = bestShaped;
      let alt: (typeof scored)[number] | null = null;
      for (const c of scored) {
        if (c.id === top.id || c.score !== top.score || c.cost > top.cost + AVOID_COST_TOLERANCE) continue;
        if (!alt || c.cost < alt.cost - COST_EPS) alt = c;
      }
      if (alt) bestShaped = alt;
    }
    return bestShaped?.id ?? null;
  }
  let best: { id: string; score: number } | null = null;
  for (const l of pool) {
    const score = fitScore(l, orients);
    if (!best || score > best.score) best = { id: l.id, score };
  }
  return best?.id ?? null;
}

/**
 * Cover layout of the book's design for a cover photo of orientation `orient` (null = no photo):
 * among the style's one-photo covers (all covers when none has one photo), the first whose slot
 * prefers that orientation, else the first. Classic A5 portrait → "cover".
 */
export function bestCoverLayout(design: BookDesign = DEFAULT_DESIGN, orient: FitOrientation | null = null): string {
  assertSupportedDesign(design);
  const covers = layoutsFor(design.format, design.designStyle, "cover");
  const ones = covers.filter((l) => l.photoCount === 1);
  const pool = ones.length > 0 ? ones : covers;
  const hit = orient === null ? undefined : pool.find((l) => fitsSlot(l.prefers[0] ?? "any", orient));
  const pick = hit ?? pool[0];
  if (!pick) throw new Error(`no cover layout for ${design.format}/${design.designStyle}`);
  return pick.id;
}

/**
 * The design's full-page layout: the one-photo page layout without a caption area and the
 * largest slot (catalogue order on ties) — "full-page" for classic A5 portrait.
 */
export function fullPageLayout(design: BookDesign = DEFAULT_DESIGN): string {
  assertSupportedDesign(design);
  const singles = layoutsFor(design.format, design.designStyle, "page").filter((l) => l.photoCount === 1);
  const pool = singles.some((l) => l.caption === null) ? singles.filter((l) => l.caption === null) : singles;
  let best: Layout | undefined;
  for (const l of pool) {
    const area = (l.slots[0]?.w ?? 0) * (l.slots[0]?.h ?? 0);
    const bestArea = best ? (best.slots[0]?.w ?? 0) * (best.slots[0]?.h ?? 0) : -1;
    if (area > bestArea) best = l;
  }
  if (!best) throw new Error(`no full-page layout for ${design.format}/${design.designStyle}`);
  return best.id;
}

/** Slot aspect (w/h) in mm on a page of `design.format` (spread slots: x in 0..200 → same maths). */
export function slotAspectMm(design: BookDesign, slot: { w: number; h: number }): number {
  const page = pageMm(design.format);
  return (slot.w * page.w) / Math.max(1e-9, slot.h * page.h);
}

// --- Shape-aware fitting (M10c T10) ------------------------------------------------------------------

/** Styles whose slots have shapes / frames / tilt: fitting uses the visible photo area. */
export const SHAPE_AWARE_STYLES = ["geometric", "scrapbook"] as const satisfies readonly DesignStyle[];

export function isShapeAware(design: Pick<BookDesign, "designStyle">): boolean {
  return (SHAPE_AWARE_STYLES as readonly string[]).includes(design.designStyle);
}

/**
 * A round slot fits a photo whose aspect is within this factor of the slot's visible aspect
 * (1.6 → for a circle: 3:4 and 4:3 fit, 9:16, 16:9 and panoramas don't).
 */
export const ROUND_STRETCH_MAX = 1.6;
/** Polygons with at least this many points that are convex count as round (petals, arcs). */
const ROUND_POLYGON_POINTS = 8;
/** Cost ties closer than this keep catalogue order (float noise). */
const COST_EPS = 1e-9;
/** bestPageLayout `avoid`: how much more total aspect cost (Σ |ln(photo / slot aspect)|) an alternative may have. */
export const AVOID_COST_TOLERANCE = 0.25;

/** Typical aspect of a photo of orientation `o` when its real size is unknown (4:3 camera). */
export function typicalRatio(o: FitOrientation): number {
  return o === "portrait" ? 3 / 4 : o === "landscape" ? 4 / 3 : 1;
}

const validRatio = (r: number | undefined): number | null => (typeof r === "number" && Number.isFinite(r) && r > 0 ? r : null);

/** What a slot shows of its photo (see header). */
export interface SlotFit {
  /** Aspect (w/h, mm) of the visible photo area's inertia-equivalent rectangle. */
  aspect: number;
  /** Visible area / photo rect area (1 = nothing clipped; circle π/4). */
  fill: number;
  /** Only square-ish photos fit (circle, ellipse, hexagon, diamond, convex many-point polygon). */
  round: boolean;
}

const slotFitCache = new WeakMap<Layout, Map<string, SlotFit>>();

/** Visible-area fit data of slot `i` (memoised per layout object). null for a missing slot. */
export function slotFit(layout: Layout, i: number, format: BookFormat = layout.format): SlotFit | null {
  let byKey = slotFitCache.get(layout);
  if (!byKey) {
    byKey = new Map();
    slotFitCache.set(layout, byKey);
  }
  const key = `${i}:${format}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const fit = computeSlotFit(layout, i, format);
  if (fit) byKey.set(key, fit);
  return fit;
}

function computeSlotFit(layout: Layout, i: number, format: BookFormat): SlotFit | null {
  const slot = layout.slots[i];
  const rect = photoRectOf(layout, i, format);
  if (!slot || !rect) return null;
  const page = pageMm(format);
  const w = Math.max(1e-9, (rect.w / 100) * page.w);
  const h = Math.max(1e-9, (rect.h / 100) * page.h);
  const framed = slot.frame !== undefined && slot.frame.kind !== "none";
  const shape = framed ? undefined : slot.shape;
  switch (shape?.kind) {
    case undefined:
    case "rect":
      return { aspect: w / h, fill: 1, round: false };
    case "rounded": {
      const r = Math.min(shape.r, w / 2, h / 2);
      return { aspect: w / h, fill: 1 - ((4 - Math.PI) * r * r) / (w * h), round: false };
    }
    case "circle":
    case "ellipse":
      return { aspect: w / h, fill: Math.PI / 4, round: true };
    default: {
      const pts = shapePoints(shape);
      if (!pts) return { aspect: w / h, fill: 1, round: false };
      const poly = pts.map(([u, v]) => ({ x: (u / 100) * w, y: (v / 100) * h }));
      const m = polygonMoments(poly);
      if (!m) return { aspect: w / h, fill: 1, round: false };
      const round = shape?.kind === "hexagon" || shape?.kind === "diamond" || (poly.length >= ROUND_POLYGON_POINTS && isConvex(poly));
      return { aspect: Math.sqrt(m.varX / m.varY), fill: Math.min(1, m.area / (w * h)), round };
    }
  }
}

/** Area and central second moments (per unit area) of a simple polygon. null when degenerate. */
export function polygonMoments(poly: readonly { x: number; y: number }[]): { area: number; varX: number; varY: number } | null {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  let ixx = 0;
  let iyy = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
    ixx += (p.x * p.x + p.x * q.x + q.x * q.x) * cross;
    iyy += (p.y * p.y + p.y * q.y + q.y * q.y) * cross;
  }
  if (Math.abs(a2) < 1e-9) return null;
  const area = a2 / 2;
  const mx = cx / (3 * a2);
  const my = cy / (3 * a2);
  const varX = ixx / 12 / area - mx * mx;
  const varY = iyy / 12 / area - my * my;
  if (!(varX > 0) || !(varY > 0)) return null;
  return { area: Math.abs(area), varX, varY };
}

function isConvex(poly: readonly { x: number; y: number }[]): boolean {
  let sign = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const c = poly[(k + 2) % poly.length];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) continue;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface FitPhoto {
  orient: FitOrientation;
  /** w / h. */
  ratio: number;
}

/** |ln(photo aspect / visible aspect)| of slot `i` — 0 = the photo shows exactly as framed. */
export function shapeCost(layout: Layout, i: number, photo: FitPhoto, format: BookFormat = layout.format): number {
  const f = slotFit(layout, i, format);
  if (!f) return 0;
  return Math.abs(Math.log(photo.ratio / f.aspect));
}

/** True when `photo` does not fit slot `i`: its orientation preference, or a round slot's stretch limit. */
export function shapeMiss(layout: Layout, i: number, photo: FitPhoto, format: BookFormat = layout.format): boolean {
  if (!fitsSlot(layout.prefers[i] ?? "any", photo.orient)) return true;
  const f = slotFit(layout, i, format);
  return f !== null && f.round && Math.abs(Math.log(photo.ratio / f.aspect)) > Math.log(ROUND_STRETCH_MAX) + COST_EPS;
}

/** Shape-aware fitScore: slots i whose photo i fits (slot i ↔ photo i). */
export function shapeFitScore(layout: Layout, photos: readonly FitPhoto[], format: BookFormat = layout.format): number {
  return photos.reduce((n, p, i) => n + (shapeMiss(layout, i, p, format) ? 0 : 1), 0);
}

/** Total shapeCost of slot i ↔ photo i. */
export function shapeCostOf(layout: Layout, photos: readonly FitPhoto[], format: BookFormat = layout.format): number {
  return photos.reduce((n, p, i) => n + shapeCost(layout, i, p, format), 0);
}

/**
 * Number of slots i whose photo i fits, per design: fitScore (orientation only) for classic /
 * modern, shapeFitScore for shape-aware styles (`ratios` as in BestLayoutOptions).
 */
export function designFitScore(
  layout: Layout,
  orients: readonly FitOrientation[],
  design: BookDesign,
  ratios?: readonly number[],
): number {
  if (!isShapeAware(design)) return fitScore(layout, orients);
  const photos = orients.map((o, i) => ({ orient: o, ratio: validRatio(ratios?.[i]) ?? typicalRatio(o) }));
  return shapeFitScore(layout, photos, design.format);
}

/**
 * Orientation the design's cover photo should have: the cover slot's preference, else (an "any"
 * slot) the orientation of its visible area, else the format's — shape-aware styles only;
 * null = no opinion (the caller keeps its own rule).
 */
export function coverPhotoOrientation(design: BookDesign): "portrait" | "landscape" | null {
  if (!isShapeAware(design)) return null;
  const covers = layoutsFor(design.format, design.designStyle, "cover");
  const cover = covers.find((l) => l.photoCount === 1) ?? covers[0];
  if (!cover) return null;
  const pref = cover.prefers[0] ?? "any";
  if (pref === "portrait" || pref === "landscape") return pref;
  const f = slotFit(cover, 0, design.format);
  if (!f) return null;
  if (f.aspect >= 1.1) return "landscape";
  if (f.aspect <= 1 / 1.1) return "portrait";
  return null;
}
