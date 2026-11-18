// M29 (D-080) — structural rules every cover layout must pass, pre-M29 covers and the M29 cover
// styles alike (the M29-only naming rules apply when `m29: true`). Used by
// tests/layouts-covers.test.ts; theme builders run `npx vitest run tests/layouts-covers.test.ts`
// after adding a cover to src/lib/layouts/{theme}/{format}/covers-m29.ts.
//
// Rules (messages name the layout id + rule, never user data):
// - schema: LayoutSchema shape + layoutIssues with the real sticker catalogue (ids + kinds);
// - role "cover", exactly one photo slot (photoCount 1, one slot);
// - cover text = the `texts` boxes when present (exactly one coverTitle + one coverSubtitle, no
//   other binding), else the legacy caption rect (classic covers); M29 covers MUST have texts;
// - every text box (rotated bounds) ≥ SAFE_MM inside the trim (D-050);
// - A5 landscape: every text box ≥ LANDSCAPE_SPINE_MM from the spine (the left edge, x = 0);
// - no text box overlaps the visible photo area (slices when present, the polygon of an unrotated
//   polygon / hexagon / diamond slot, else the slot's rotated bounds) unless it sits on a plate;
// - M29 only: autoPick false, id contains "-cover-", name starts "Cover: ".
// - M30 (`m30: true`, magazine / editorial covers): text is drawn over the photo by design (ink
//   roles "paper" / "accentOnDark"), so the over-the-photo rule is off; besides the one coverTitle +
//   one coverSubtitle a cover may bind coverLine (each `n` once). Their user-chosen cover styles
//   (the *_COVERS arrays) also pass `m29: true` for the naming + autoPick rules.
// Catalogue-level rules (unique ids, format/style of each array, ≥ 1 auto cover per design) live in
// the test file.

import { DECORATION_STICKER_IDS, STICKERS } from "@/lib/design/stickers";
import { pageMm } from "@/lib/book/format";
import { LayoutSchema, layoutIssues } from "@/lib/book/schema";
import { pointInPolygon, polygonInPage, rotatedBoundsPct, shapePoints, type BoundsPct, type Point } from "@/lib/book/slot-geometry";
import type { Layout } from "@/lib/book/types";
import { SAFE_MM } from "@/lib/layouts";

/** A5 landscape covers: cover text stays at least this far from the spine edge (x = 0). */
export const LANDSCAPE_SPINE_MM = 10;
/** mm tolerance for float layout data (e.g. 4.762 % × 210 mm = 10.0002 mm). */
const MM_TOL = 0.01;
/** Layout-unit tolerance: boxes that only touch do not overlap. */
const EPS = 1e-6;

const stickerIds = new Set(DECORATION_STICKER_IDS);
const stickerKinds = new Map(Object.values(STICKERS).map((s) => [s.id, s.kind] as const));

export interface CoverText {
  label: string;
  bounds: BoundsPct;
  plated: boolean;
}

/** The boxes cover text is drawn in: `texts` when present, else the caption rect. */
export function coverTexts(l: Layout): CoverText[] {
  const page = pageMm(l.format);
  if (l.texts && l.texts.length > 0) {
    return l.texts.map((t, i) => ({
      label: `text ${i} (${t.bind})`,
      // M30: a ±90° text's box is already the final visual rect.
      bounds: rotatedBoundsPct(t.box, Math.abs(t.rotate ?? 0) === 90 ? 0 : (t.rotate ?? 0), page),
      plated: t.plate !== undefined,
    }));
  }
  return l.caption ? [{ label: "caption", bounds: rotatedBoundsPct(l.caption, 0, page), plated: false }] : [];
}

const boxOverlap = (a: BoundsPct, b: BoundsPct) => a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;

function segmentsCross(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const d = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(q1, q2, p1);
  const d2 = d(q1, q2, p2);
  const d3 = d(p1, p2, q1);
  const d4 = d(p1, p2, q2);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** True when the box's interior meets the polygon's interior. */
function boxMeetsPolygon(b: BoundsPct, poly: readonly Point[]): boolean {
  const inner = { x0: b.x0 + EPS, y0: b.y0 + EPS, x1: b.x1 - EPS, y1: b.y1 - EPS };
  const corners: Point[] = [
    { x: inner.x0, y: inner.y0 },
    { x: inner.x1, y: inner.y0 },
    { x: inner.x1, y: inner.y1 },
    { x: inner.x0, y: inner.y1 },
  ];
  if (corners.some((c) => pointInPolygon(c, poly))) return true;
  if (poly.some((p) => p.x > inner.x0 && p.x < inner.x1 && p.y > inner.y0 && p.y < inner.y1)) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const z = poly[(i + 1) % poly.length];
    for (let k = 0; k < 4; k++) if (segmentsCross(a, z, corners[k], corners[(k + 1) % 4])) return true;
  }
  return false;
}

/** True when `b` overlaps the area where the cover photo shows. */
export function overlapsPhoto(l: Layout, b: BoundsPct): boolean {
  const page = pageMm(l.format);
  if (l.slices) return l.slices.some((r) => boxOverlap(b, rotatedBoundsPct(r, 0, page)));
  return l.slots.some((s) => {
    const pts = (s.rotate ?? 0) === 0 ? shapePoints(s.shape) : null;
    const framed = s.frame !== undefined && s.frame.kind !== "none";
    if (pts && !framed) return boxMeetsPolygon(b, polygonInPage(pts, s));
    return boxOverlap(b, rotatedBoundsPct(s, s.rotate ?? 0, page));
  });
}

/** Every rule this cover breaks ([] = OK). `m29` adds the M29-only rules. */
export function coverRuleIssues(l: Layout, opts: { m29: boolean; m30?: boolean }): string[] {
  const out: string[] = [];
  const at = (msg: string) => out.push(`${l.id}: ${msg}`);
  const parsed = LayoutSchema.safeParse(l);
  if (!parsed.success) at(`schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  for (const m of layoutIssues(l, { stickerIds, stickerKinds })) at(m);

  if (l.role !== "cover") at(`role is ${l.role}, not cover`);
  if (l.photoCount !== 1 || l.slots.length !== 1) at("needs exactly one photo slot");

  if (l.texts && l.texts.length > 0) {
    const binds = l.texts.map((t) => t.bind);
    if (binds.filter((b) => b === "coverTitle").length !== 1) at("needs exactly one coverTitle text");
    if (binds.filter((b) => b === "coverSubtitle").length !== 1) at("needs exactly one coverSubtitle text");
    const other = binds.filter((b) => b !== "coverTitle" && b !== "coverSubtitle" && !(opts.m30 && b === "coverLine"));
    if (other.length) at(`cover texts may only bind coverTitle/coverSubtitle (got ${other.join(", ")})`);
    const lines = l.texts.filter((t) => t.bind === "coverLine").map((t) => t.n ?? 0);
    if (new Set(lines).size !== lines.length) at("each coverLine n may be used once");
  } else if (opts.m29) {
    at("M29 covers need coverTitle + coverSubtitle text boxes");
  } else if (!l.caption) {
    at("no text area (neither texts nor caption)");
  }

  const page = pageMm(l.format);
  for (const t of coverTexts(l)) {
    const left = (t.bounds.x0 / 100) * page.w;
    const top = (t.bounds.y0 / 100) * page.h;
    const right = ((100 - t.bounds.x1) / 100) * page.w;
    const bottom = ((100 - t.bounds.y1) / 100) * page.h;
    if (Math.min(left, top, right, bottom) < SAFE_MM - MM_TOL) at(`${t.label} is less than ${SAFE_MM} mm inside the trim`);
    if (l.format === "A5_LANDSCAPE" && left < LANDSCAPE_SPINE_MM - MM_TOL) {
      at(`${t.label} is less than ${LANDSCAPE_SPINE_MM} mm from the spine edge`);
    }
    if (!opts.m30 && !t.plated && overlapsPhoto(l, t.bounds)) at(`${t.label} overlaps the photo (only plated text may)`);
  }

  if (opts.m29) {
    if (l.autoPick !== false) at("M29 covers must set autoPick: false");
    if (!l.id.includes("-cover-")) at('id must contain "-cover-"');
    if (!l.name.startsWith("Cover: ")) at('name must start with "Cover: "');
  }
  return out;
}
