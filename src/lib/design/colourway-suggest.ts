// Accent colourway suggestion for magazine + editorial books (M30 T9b, D-090). Pure and
// deterministic: no I/O, no AI — the same photos always give the same colourway.
//
// Input is the per-photo colour the upload pipeline stores (photos.color: the muted dominant colour
// "#rrggbb", null = unknown — the same data background-suggest.ts reads). Photo colours are user
// data: nothing here logs them.
//
// Rule (suggestColourway):
// 1. Every known colour is read in CIELAB. Near-grey colours (chroma < NEUTRAL_CHROMA) say nothing
//    about hue; they only count against a lean. The cover photo counts COVER_WEIGHT times (the
//    accent sits on the cover first).
// 2. The photos' hue lean is the weighted mean direction of the coloured ones. It is "clear" when
//    there are ≥ MIN_COLOURED_PHOTOS known colours, the coloured weight is ≥ MIN_COLOURED_SHARE of
//    the known weight, and the hues agree (mean resultant length ≥ MIN_HUE_AGREEMENT).
// 3. Clear lean → the colourway whose `accent` hue is nearest (picker order on ties), if within
//    MAX_ACCENT_HUE_GAP; a colourway with a near-grey accent (editorial "ink") is never a hue match.
//    Anything else → defaultColourway(style).
// The four older styles have no colourways → null.
//
// Stamping (withSuggestedColourway): the album builders (rule build AND the AI path's planToDoc)
// write style.colourway = { id, source: "ai" } on a magazine / editorial doc when it has none or an
// "ai" one. A "user" colourway is never replaced — neither the doc's own nor, on a rebuild, the one
// of the doc being replaced (`previous`). Older styles are returned untouched (a colourway there is
// a validation error and would make a classic doc v2). Update album and the photo-delete strip
// keep doc.style as it is, so they keep any colourway.

import type { BookDoc, DesignStyle } from "@/lib/book/types";
import { colourMaths, NEUTRAL_CHROMA } from "./background-suggest";
import { colourwaysFor, defaultColourway, type Colourway, type ColourwayId } from "./colourways";

/** How many times the cover photo's colour counts. */
export const COVER_WEIGHT = 3;
/** Fewer known colours than this (cover included, counted once) → the default colourway. */
export const MIN_COLOURED_PHOTOS = 3;
/** Share of the known weight that must be coloured (not near-grey) for a lean. */
export const MIN_COLOURED_SHARE = 0.4;
/** Mean resultant length of the coloured hues (0 = all directions, 1 = one hue) needed for a lean. */
export const MIN_HUE_AGREEMENT = 0.5;
/** The lean must be within this many degrees (CIELAB hue) of the chosen accent. */
export const MAX_ACCENT_HUE_GAP = 50;

type Colour = string | null | undefined;

const RAD = Math.PI / 180;

/**
 * The colourway for a `style` book from its photos' colours. `photoColours` = the kept photos
 * WITHOUT the cover photo; `coverPhotoColour` = the cover photo's colour (weighted ×COVER_WEIGHT).
 * null / invalid colours are unknown and ignored. Returns null for styles without colourways.
 */
export function suggestColourway(
  style: DesignStyle | null | undefined,
  photoColours: readonly Colour[],
  coverPhotoColour?: Colour,
): Colourway | null {
  const fallback = defaultColourway(style);
  if (!fallback) return null;

  let known = 0;
  let knownWeight = 0;
  let colouredWeight = 0;
  let x = 0;
  let y = 0;
  const add = (c: Colour, weight: number) => {
    const lab = typeof c === "string" ? colourMaths.toLab(c) : null;
    if (!lab) return;
    known++;
    knownWeight += weight;
    if (colourMaths.chroma(lab) < NEUTRAL_CHROMA) return;
    const h = colourMaths.hue(lab) * RAD;
    colouredWeight += weight;
    x += weight * Math.cos(h);
    y += weight * Math.sin(h);
  };
  add(coverPhotoColour, COVER_WEIGHT);
  for (const c of photoColours) add(c, 1);

  if (known < MIN_COLOURED_PHOTOS || colouredWeight < MIN_COLOURED_SHARE * knownWeight) return fallback;
  if (Math.hypot(x, y) / colouredWeight < MIN_HUE_AGREEMENT) return fallback;
  const lean = ((Math.atan2(y, x) / RAD) + 360) % 360;

  let best: { cw: Colourway; gap: number } | null = null;
  for (const cw of colourwaysFor(style)) {
    const lab = colourMaths.toLab(cw.accent);
    if (!lab || colourMaths.chroma(lab) < NEUTRAL_CHROMA) continue;
    const gap = colourMaths.hueGap(lean, colourMaths.hue(lab));
    if (gap <= MAX_ACCENT_HUE_GAP && (!best || gap < best.gap - 1e-9)) best = { cw, gap };
  }
  return best?.cw ?? fallback;
}

/** A photo as the colourway rule sees it (same rows as background-suggest's SuggestPhoto). */
export interface ColourwayPhoto {
  id: string;
  status: "kept" | "dropped";
  /** photos.color ("#rrggbb"); null/undefined = unknown. */
  color?: string | null;
}

/**
 * The valid "user" colourway a stored doc (raw jsonb, any shape) carries for `style`, or null.
 * Reads the raw value so an old / unparsable doc never throws.
 */
export function userColourwayOf(doc: unknown, style: DesignStyle | null | undefined): { id: ColourwayId; source: "user" } | null {
  if (typeof doc !== "object" || doc === null) return null;
  const st = (doc as { style?: unknown }).style;
  if (typeof st !== "object" || st === null) return null;
  const cw = (st as { colourway?: unknown }).colourway;
  if (typeof cw !== "object" || cw === null) return null;
  const { id, source } = cw as { id?: unknown; source?: unknown };
  if (source !== "user") return null;
  const hit = colourwaysFor(style).find((c) => c.id === id);
  return hit ? { id: hit.id, source: "user" } : null;
}

/**
 * `doc` with its accent colourway stamped (file header "Stamping"). Magazine / editorial only —
 * any other style returns the SAME object. `photos` = the book's photos (kept ones vote; the
 * doc's cover photo is weighted); `previous` = the stored doc this build replaces, if any.
 * Returns the same object when nothing changes.
 */
export function withSuggestedColourway(doc: BookDoc, photos: readonly ColourwayPhoto[], previous?: unknown): BookDoc {
  const style = doc.style.designStyle ?? "classic";
  if (!defaultColourway(style)) return doc;
  if (doc.style.colourway?.source === "user") return doc;
  const carried = userColourwayOf(previous, style);
  let next: { id: ColourwayId; source: "ai" | "user" };
  if (carried) next = carried;
  else {
    const coverId = doc.cover.photoId;
    let cover: Colour = null;
    const rest: Colour[] = [];
    const seen = new Set<string>();
    for (const p of photos) {
      if (p.status !== "kept" || seen.has(p.id)) continue;
      seen.add(p.id);
      if (p.id === coverId) cover = p.color ?? null;
      else rest.push(p.color ?? null);
    }
    const cw = suggestColourway(style, rest, cover) as Colourway; // non-null: the style has colourways
    next = { id: cw.id, source: "ai" };
  }
  const cur = doc.style.colourway;
  if (cur && cur.id === next.id && cur.source === next.source) return doc;
  return { ...doc, style: { ...doc.style, colourway: next } };
}
