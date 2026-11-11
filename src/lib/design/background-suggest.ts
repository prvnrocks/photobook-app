// Rule-based background suggestions (M10c T11, D-068) — the AI-independent fallback. The
// Storyteller (T12) picks catalogue ids; this module validates those picks and fills every gap with
// the rules below. Pure and deterministic: no I/O, safe on client and server.
//
// Scope (D-068 / D3): Modern, Geometric and Scrapbook get suggestions. Classic stays white and is
// never touched (classic docs stay v1, byte-identical).
//
// Rules:
// 1. Catalogue only. A suggestion is always a catalogue swatch (src/lib/design/backgrounds.ts),
//    a catalogue texture without tint, or (Scrapbook only) a faded photo with the catalogue veil —
//    never an arbitrary hex. Per style the allowed ids are AI_BACKGROUND_CATALOGUE[style].
// 2. Book background (style.background) is written only when style.backgroundSource is absent or
//    "ai", and then marked backgroundSource "ai". It is the style default (STYLE_DEFAULT_BACKGROUND:
//    Modern/Geometric white, Scrapbook cream paper texture) unless the kept photos' colours
//    (photos.color, muted dominant colour; null = unknown) clearly lean to one hue: then the
//    style's colour-matched candidate for that hue (pale swatches for Modern/Geometric, watercolour
//    or paper textures for Scrapbook). See suggestBookBackground for the vote.
// 3. Page backgrounds: a page background with source "user" is never changed or removed. Every
//    page background with source "ai" is recomputed (removed, then re-suggested), so applying the
//    suggestions twice gives the same doc.
// 4. Faded photo (Scrapbook only, D7): at most one per chapter, on the chapter's first page, using
//    a KEPT photo (D-062 privacy: AI never makes a dropped photo public) that sits on another page
//    of the same chapter — never a photo shown in a slot of that first page (a faded copy of a photo
//    right behind itself looks like a printing fault). Skipped when the first page is a spread half
//    (a faded photo on one half of a spread would stop at the fold), when its slots cover ≥ 85 % of
//    the page (the background would hardly show) or when no such photo exists. Choice: matches the
//    page orientation first, then sharpest (blurScore), largest, smallest id.
// 5. pruneAiBackgrounds (Update album / photo delete / rebuild): an AI photo background whose photo
//    is no longer kept (dropped or deleted), is not on its chapter's first page any more, or is the
//    chapter's second, is removed (the page falls back to the book default); an AI photo book
//    background (not produced by these rules, possible from T12) falls back to the style default.

import { getLayout } from "@/lib/layouts";
import type { Background, BookDoc, BookPage, DesignStyle, PageBackground } from "@/lib/book/types";
import {
  BACKGROUND_SWATCHES,
  isKnownTextureId,
  swatchById,
  textureById,
  type TextureId,
} from "./backgrounds";

// --- catalogue -----------------------------------------------------------------------------------

/** Design styles that get AI background suggestions (D-068). Classic stays white. */
export const AI_BACKGROUND_STYLES = ["modern", "geometric", "scrapbook"] as const satisfies readonly DesignStyle[];

export function suggestsBackgrounds(style: DesignStyle | null | undefined): boolean {
  return (AI_BACKGROUND_STYLES as readonly string[]).includes(style ?? "classic");
}

/** Catalogue id of the faded-photo background (Scrapbook chapter openers only). */
export const FADED_PHOTO_ID = "faded-photo";
/** Veil of an AI faded-photo background: strong enough for dark captions on any photo. */
export const FADED_PHOTO_VEIL = 0.8;
/** Veil colour of an AI faded-photo background: the catalogue "cream" swatch (warm, paper-like). */
export const FADED_PHOTO_VEIL_SWATCH = "cream";

/** Slot coverage (share of the page) at or above which a faded photo would hardly show. */
export const FADED_PHOTO_MAX_COVERAGE = 0.85;

/**
 * Background ids the AI (and these rules) may use per style. Swatch ids and texture ids come from
 * backgrounds.ts (the two id sets are disjoint); FADED_PHOTO_ID needs a photo and is only valid on a
 * Scrapbook chapter's first page. Only light swatches (dark ink): the frozen Modern text and the
 * Geometric/Scrapbook palettes are dark-on-light.
 */
export const AI_BACKGROUND_CATALOGUE = {
  modern: ["white", "cream", "warm-sand", "blush", "butter", "sage", "sky", "lavender", "stone", "paper-white", "paper-cream"],
  geometric: ["white", "cream", "warm-sand", "blush", "butter", "sage", "sky", "lavender", "stone", "paper-white"],
  scrapbook: [
    "paper-cream",
    "paper-white",
    "linen",
    "kraft",
    "watercolour-blush",
    "watercolour-sky",
    "cream",
    "warm-sand",
    "blush",
    "sage",
    "sky",
    FADED_PHOTO_ID,
  ],
} as const satisfies Record<(typeof AI_BACKGROUND_STYLES)[number], readonly string[]>;

export type AiBackgroundStyle = keyof typeof AI_BACKGROUND_CATALOGUE;
export type AiBackgroundId = (typeof AI_BACKGROUND_CATALOGUE)[AiBackgroundStyle][number];

/** Style default book background (no photo colours known / no clear hue). */
export const STYLE_DEFAULT_BACKGROUND: Record<DesignStyle, Background> = {
  classic: { kind: "color", hex: "#FFFFFF" },
  modern: { kind: "color", hex: "#FFFFFF" },
  geometric: { kind: "color", hex: "#FFFFFF" },
  scrapbook: { kind: "texture", textureId: "paper-cream" },
};

export function styleDefaultBackground(style: DesignStyle | null | undefined): Background {
  return { ...(STYLE_DEFAULT_BACKGROUND[style ?? "classic"] ?? STYLE_DEFAULT_BACKGROUND.classic) };
}

/** Candidates the colour vote may pick per style (subset of the catalogue). */
const COLOUR_CANDIDATES: Record<AiBackgroundStyle, readonly string[]> = {
  modern: ["cream", "warm-sand", "blush", "butter", "sage", "sky", "lavender"],
  geometric: ["cream", "warm-sand", "blush", "butter", "sage", "sky", "lavender"],
  // paper-cream (= the default) catches warm/yellow photos so they keep the paper look.
  scrapbook: ["paper-cream", "watercolour-blush", "watercolour-sky"],
};

function isAiStyle(style: DesignStyle | null | undefined): style is AiBackgroundStyle {
  return suggestsBackgrounds(style);
}

/**
 * The Background for a catalogue id of `style` (no photo), or null when the id isn't in the style's
 * catalogue or is FADED_PHOTO_ID (use fadedPhotoBackground). Textures never get a tint.
 */
export function backgroundForId(style: DesignStyle | null | undefined, id: string): Background | null {
  if (!isAiStyle(style) || id === FADED_PHOTO_ID) return null;
  if (!(AI_BACKGROUND_CATALOGUE[style] as readonly string[]).includes(id)) return null;
  const swatch = swatchById(id);
  if (swatch) return { kind: "color", hex: swatch.hex };
  if (isKnownTextureId(id)) return { kind: "texture", textureId: id as TextureId };
  return null;
}

/** The AI faded-photo background for `photoId` (catalogue veil + veil colour). */
export function fadedPhotoBackground(photoId: string): Background {
  return {
    kind: "photo",
    photoId,
    veil: FADED_PHOTO_VEIL,
    veilColor: (swatchById(FADED_PHOTO_VEIL_SWATCH) as { hex: string }).hex,
  };
}

// --- validation (T12 uses this on Storyteller picks) ---------------------------------------------

export interface AiBackgroundContext {
  /** "book" = style.background; "chapterOpener" = the first page of a chapter. */
  scope: "book" | "chapterOpener";
  /** Kept photo ids of the book (D-062: AI backgrounds use kept photos only). */
  keptPhotoIds?: ReadonlySet<string>;
  /** Photo ids on the chapter's pages (chapterOpener + photo only). */
  chapterPhotoIds?: ReadonlySet<string>;
  /** Photo ids in the slots of the opener page itself (never used as its faded background). */
  pagePhotoIds?: ReadonlySet<string>;
}

/**
 * True when `bg` is something the AI may write for `style` in `ctx`: exactly a catalogue swatch hex
 * or untinted catalogue texture of the style's catalogue; a photo only as the catalogue faded photo
 * (veil FADED_PHOTO_VEIL, cream veil colour), Scrapbook only, chapter opener only, a kept photo of
 * that chapter that is not in a slot of the opener page. Classic → always false.
 */
export function isValidAiBackground(style: DesignStyle | null | undefined, bg: Background, ctx: AiBackgroundContext): boolean {
  if (!isAiStyle(style)) return false;
  const ids = AI_BACKGROUND_CATALOGUE[style] as readonly string[];
  switch (bg.kind) {
    case "color": {
      const s = BACKGROUND_SWATCHES.find((w) => w.hex.toUpperCase() === bg.hex.toUpperCase());
      return !!s && ids.includes(s.id);
    }
    case "texture":
      return bg.tint === undefined && ids.includes(bg.textureId);
    case "photo": {
      if (!ids.includes(FADED_PHOTO_ID) || ctx.scope !== "chapterOpener") return false;
      const ref = fadedPhotoBackground(bg.photoId) as Extract<Background, { kind: "photo" }>;
      if (bg.veil !== ref.veil || bg.veilColor.toUpperCase() !== ref.veilColor.toUpperCase()) return false;
      return (
        !!ctx.keptPhotoIds?.has(bg.photoId) &&
        !!ctx.chapterPhotoIds?.has(bg.photoId) &&
        !ctx.pagePhotoIds?.has(bg.photoId)
      );
    }
    default:
      return false;
  }
}

// --- colour vote ---------------------------------------------------------------------------------

interface Lab {
  L: number;
  a: number;
  b: number;
}

function toLab(hex: string): Lab | null {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const chroma = (c: Lab) => Math.hypot(c.a, c.b);
const hue = (c: Lab) => ((Math.atan2(c.b, c.a) * 180) / Math.PI + 360) % 360;
const hueGap = (x: number, y: number) => {
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
};

/** Photo colours with chroma below this vote "neutral" (style default). */
export const NEUTRAL_CHROMA = 12;
/** A photo hue further than this from every candidate votes neutral. */
export const MAX_HUE_GAP = 40;
/** Fewer known colours than this → style default (too little evidence). */
export const MIN_COLOURED_PHOTOS = 3;
/** The winning candidate needs at least this share of all known colours. */
export const MIN_WINNER_SHARE = 0.4;

function candidateBackground(id: string): Background | null {
  const swatch = swatchById(id);
  if (swatch) return { kind: "color", hex: swatch.hex };
  if (isKnownTextureId(id)) return { kind: "texture", textureId: id };
  return null;
}

function candidateHex(id: string): string | null {
  return swatchById(id)?.hex ?? textureById(id)?.baseHex ?? null;
}

/**
 * Book background for `style` from the kept photos' colours (null/invalid = unknown). Each known
 * colour votes: chroma < NEUTRAL_CHROMA or no candidate hue within MAX_HUE_GAP → neutral; else the
 * candidate with the nearest hue (ties → catalogue order). The top candidate wins when there are
 * ≥ MIN_COLOURED_PHOTOS known colours, it has ≥ MIN_WINNER_SHARE of them and more votes than
 * neutral; otherwise the style default. Classic → white.
 */
export function suggestBookBackground(style: DesignStyle | null | undefined, colours: readonly (string | null | undefined)[]): Background {
  if (!isAiStyle(style)) return styleDefaultBackground(style);
  const known = colours.map((c) => (typeof c === "string" ? toLab(c) : null)).filter((c): c is Lab => c !== null);
  if (known.length < MIN_COLOURED_PHOTOS) return styleDefaultBackground(style);
  const candidates = COLOUR_CANDIDATES[style]
    .map((id) => {
      const lab = toLab(candidateHex(id) ?? "");
      return lab ? { id, hue: hue(lab) } : null;
    })
    .filter((c): c is { id: string; hue: number } => c !== null);
  const votes = new Map<string, number>();
  let neutral = 0;
  for (const c of known) {
    if (chroma(c) < NEUTRAL_CHROMA) {
      neutral++;
      continue;
    }
    const h = hue(c);
    let best: { id: string; gap: number } | null = null;
    for (const cand of candidates) {
      const gap = hueGap(h, cand.hue);
      if (gap <= MAX_HUE_GAP && (!best || gap < best.gap)) best = { id: cand.id, gap };
    }
    if (!best) neutral++;
    else votes.set(best.id, (votes.get(best.id) ?? 0) + 1);
  }
  let winner: { id: string; n: number } | null = null;
  for (const cand of candidates) {
    const n = votes.get(cand.id) ?? 0;
    if (n > 0 && (!winner || n > winner.n)) winner = { id: cand.id, n };
  }
  if (!winner || winner.n <= neutral || winner.n < MIN_WINNER_SHARE * known.length) return styleDefaultBackground(style);
  return candidateBackground(winner.id) ?? styleDefaultBackground(style);
}

// --- apply / prune -------------------------------------------------------------------------------

export interface SuggestPhoto {
  id: string;
  status: "kept" | "dropped";
  /** photos.color ("#rrggbb"); null/undefined = unknown. */
  color?: string | null;
  width: number | null;
  height: number | null;
  blurScore?: number | null;
}

/** Storyteller picks (T12). Invalid or missing picks fall back to the rules. */
export interface AiBackgroundPicks {
  /** Catalogue id for the book background. */
  book?: string | null;
  /**
   * chapterId → pick for the chapter's first page: a catalogue id, or FADED_PHOTO_ID + photoId.
   * `null` = the AI chose "no background" for that chapter (the rules don't add one).
   */
  chapters?: ReadonlyMap<string, { id: string; photoId?: string | null } | null>;
}

const pos = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1);
const sharpOf = (p: SuggestPhoto) => (typeof p.blurScore === "number" && Number.isFinite(p.blurScore) ? p.blurScore : 0);
const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Share of the page covered by the layout's slots (sum of slot areas, capped at 1). */
function slotCoverage(page: BookPage): number {
  const layout = getLayout(page.layout);
  if (!layout) return 1;
  const area = layout.slots.reduce((sum, s) => sum + (s.w * s.h) / 10_000, 0);
  return Math.min(1, area);
}

function withoutBackground(page: BookPage): BookPage {
  const rest = { ...page };
  delete rest.background;
  return rest;
}

/** Index of the first page of each chapter, in doc order. */
function chapterOpeners(doc: BookDoc): Map<string, number> {
  const out = new Map<string, number>();
  doc.pages.forEach((p, i) => {
    if (p.chapterId !== null && !out.has(p.chapterId)) out.set(p.chapterId, i);
  });
  return out;
}

function chapterPhotoIds(doc: BookDoc, chapterId: string): Set<string> {
  const ids = new Set<string>();
  for (const p of doc.pages) {
    if (p.chapterId !== chapterId) continue;
    for (const s of p.slots) if (s.photoId !== null) ids.add(s.photoId);
  }
  return ids;
}

const slotIdsOf = (page: BookPage) => new Set(page.slots.flatMap((s) => (s.photoId !== null ? [s.photoId] : [])));

/** Rule 4: the faded photo for a Scrapbook chapter opener, or null. */
function ruleFadedPhoto(doc: BookDoc, pageIdx: number, kept: Map<string, SuggestPhoto>): string | null {
  const page = doc.pages[pageIdx];
  if (page.chapterId === null || page.side !== undefined) return null;
  if (getLayout(page.layout)?.role !== "page") return null;
  if (slotCoverage(page) >= FADED_PHOTO_MAX_COVERAGE) return null;
  const onPage = slotIdsOf(page);
  const pagePortrait = doc.format !== "A5_LANDSCAPE";
  const candidates = [...chapterPhotoIds(doc, page.chapterId)]
    .filter((id) => !onPage.has(id) && kept.has(id))
    .map((id) => kept.get(id) as SuggestPhoto);
  if (candidates.length === 0) return null;
  const matches = (p: SuggestPhoto) => {
    const r = pos(p.width) / pos(p.height);
    return pagePortrait ? r <= 1.05 : r >= 0.95;
  };
  candidates.sort(
    (a, b) =>
      Number(matches(b)) - Number(matches(a)) ||
      sharpOf(b) - sharpOf(a) ||
      pos(b.width) * pos(b.height) - pos(a.width) * pos(a.height) ||
      cmpId(a.id, b.id),
  );
  return candidates[0].id;
}

/**
 * Applies the suggestions (file header rules 1–4) to `doc`: book background when
 * style.backgroundSource is absent/"ai", page backgrounds on chapter openers, never touching a
 * "user" page background. AI `picks` are used when valid (isValidAiBackground), else the rules.
 * Classic (and unknown styles) → `doc` returned as is. Call only on freshly built albums (rule or
 * AI): an absent backgroundSource is read as "nobody chose yet".
 */
export function applyBackgroundSuggestions(doc: BookDoc, photos: readonly SuggestPhoto[], picks: AiBackgroundPicks = {}): BookDoc {
  const style = doc.style.designStyle ?? "classic";
  if (!isAiStyle(style)) return doc;
  const kept = new Map<string, SuggestPhoto>();
  for (const p of photos) if (p.status === "kept" && !kept.has(p.id)) kept.set(p.id, p);
  const keptIds = new Set(kept.keys());

  // Book background.
  let docStyle = doc.style;
  if (doc.style.backgroundSource !== "user") {
    const picked = picks.book ? backgroundForId(style, picks.book) : null;
    const background = picked ?? suggestBookBackground(style, [...kept.values()].map((p) => p.color ?? null));
    docStyle = { ...doc.style, background, backgroundSource: "ai" };
  }

  // Page backgrounds: drop every AI one, then suggest on chapter openers.
  const pages = doc.pages.map((p) => (p.background?.source === "ai" ? withoutBackground(p) : p));
  const base: BookDoc = { ...doc, style: docStyle, pages };
  for (const [chapterId, idx] of chapterOpeners(base)) {
    const page = pages[idx];
    if (page.background?.source === "user") continue;
    let bg: Background | null = null;
    const pick = picks.chapters?.get(chapterId);
    if (pick !== undefined) {
      if (pick === null) continue; // the AI chose none
      const candidate =
        pick.id === FADED_PHOTO_ID && typeof pick.photoId === "string"
          ? fadedPhotoBackground(pick.photoId)
          : backgroundForId(style, pick.id);
      const ctx: AiBackgroundContext = {
        scope: "chapterOpener",
        keptPhotoIds: keptIds,
        chapterPhotoIds: chapterPhotoIds(base, chapterId),
        pagePhotoIds: slotIdsOf(page),
      };
      if (candidate && isValidAiBackground(style, candidate, ctx) && (candidate.kind !== "photo" || ruleFadedPhotoAllowed(base, idx))) {
        bg = candidate;
      }
    }
    if (bg === null && style === "scrapbook") {
      const photoId = ruleFadedPhoto(base, idx, kept);
      if (photoId) bg = fadedPhotoBackground(photoId);
    }
    if (bg) pages[idx] = { ...page, background: { ...bg, source: "ai" } as PageBackground };
  }
  return { ...base, pages };
}

/** Page shape checks of rule 4 (single page, enough background showing). */
function ruleFadedPhotoAllowed(doc: BookDoc, idx: number): boolean {
  const page = doc.pages[idx];
  return page.side === undefined && getLayout(page.layout)?.role === "page" && slotCoverage(page) < FADED_PHOTO_MAX_COVERAGE;
}

export interface PruneResult {
  doc: BookDoc;
  changed: boolean;
}

/**
 * Rule 5. `usable(photoId)` = the photo is still kept (Update album) / still exists (photo delete).
 * Removes AI photo page backgrounds whose photo isn't usable, that are no longer on their chapter's
 * first page, that duplicate an earlier one in the chapter, or whose photo is now in a slot of that
 * page; an AI photo book background with an unusable photo → the style default. "user" backgrounds
 * and every non-photo background are kept. Returns the input object (changed:false) when nothing
 * changes.
 */
export function pruneAiBackgrounds(doc: BookDoc, usable: (photoId: string) => boolean): PruneResult {
  let changed = false;
  let style = doc.style;
  if (style.backgroundSource === "ai" && style.background.kind === "photo" && !usable(style.background.photoId)) {
    style = { ...style, background: styleDefaultBackground(style.designStyle) };
    changed = true;
  }
  const openers = chapterOpeners(doc);
  const pages = doc.pages.map((page, i) => {
    const bg = page.background;
    if (!bg || bg.source !== "ai" || bg.kind !== "photo") return page;
    const ok =
      usable(bg.photoId) &&
      page.chapterId !== null &&
      openers.get(page.chapterId) === i &&
      !slotIdsOf(page).has(bg.photoId);
    if (ok) return page;
    changed = true;
    return withoutBackground(page);
  });
  return changed ? { doc: { ...doc, style, pages }, changed } : { doc, changed };
}

/** True when the doc has any AI photo background (book or page) — the only kind the privacy prunes touch. */
export function hasAiPhotoBackground(doc: BookDoc): boolean {
  if (doc.style.backgroundSource === "ai" && doc.style.background.kind === "photo") return true;
  return doc.pages.some((p) => p.background?.source === "ai" && p.background.kind === "photo");
}

/**
 * Privacy prune (D-062, M10c review S1) for snapshots (publish, PDF export): removes ONLY AI photo
 * backgrounds whose photo isn't `usable` (kept) — page → book default, book → style default.
 * Narrower than pruneAiBackgrounds on purpose: the snapshot otherwise matches what the editor
 * shows. "user" backgrounds (an explicit pick may use a dropped photo, D-062) and every
 * non-photo background are kept. Returns the input object (changed:false) when nothing changes.
 */
export function stripUnusableAiPhotoBackgrounds(doc: BookDoc, usable: (photoId: string) => boolean): PruneResult {
  let changed = false;
  let style = doc.style;
  if (style.backgroundSource === "ai" && style.background.kind === "photo" && !usable(style.background.photoId)) {
    style = { ...style, background: styleDefaultBackground(style.designStyle) };
    changed = true;
  }
  const pages = doc.pages.map((page) => {
    const bg = page.background;
    if (!bg || bg.source !== "ai" || bg.kind !== "photo" || usable(bg.photoId)) return page;
    changed = true;
    return withoutBackground(page);
  });
  return changed ? { doc: { ...doc, style, pages }, changed } : { doc, changed };
}
