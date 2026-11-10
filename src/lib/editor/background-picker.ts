// Background picker (M10a A8): pure helpers behind the editor's "Background" tool
// (src/components/editor/tools/background-picker.tsx). No React, no layout maths.
//
// Scope: "page" = page.background override (source "user"), "book" = style.background (the
// cover and every page; replaces page overrides — setBookBackground). The cover has no page
// entry, so on the cover only "book" is offered.

import { PhotoBackgroundSchema } from "@/lib/book/schema";
import type { Background, BookDoc, PageBackground } from "@/lib/book/types";
import {
  BACKGROUND_SWATCHES,
  BACKGROUND_VEIL_MAX,
  BACKGROUND_VEIL_MIN,
  DEFAULT_BACKGROUND_VEIL,
  DEFAULT_VEIL_COLOR,
  inkForHex,
  swatchById,
  type BackgroundSwatch,
} from "@/lib/design/backgrounds";
import type { EditorPosition } from "./store";
import type { EditorShellPhoto } from "./types";

export type BackgroundScope = "page" | "book";
export type BackgroundTab = "color" | "texture" | "photo";

export const BACKGROUND_TABS: readonly { id: BackgroundTab; label: string }[] = [
  { id: "color", label: "Colour" },
  { id: "texture", label: "Paper" },
  { id: "photo", label: "Photo" },
];

export const BACKGROUND_SCOPES: readonly { id: BackgroundScope; label: string }[] = [
  { id: "page", label: "This page" },
  { id: "book", label: "Whole book" },
];

/** Fade slider (veil opacity) range and step. */
export const FADE_MIN = BACKGROUND_VEIL_MIN;
export const FADE_MAX = BACKGROUND_VEIL_MAX;
export const FADE_STEP = 0.05;

function swatches(ids: readonly string[]): BackgroundSwatch[] {
  return ids.map((id) => swatchById(id)).filter((s): s is BackgroundSwatch => s !== undefined);
}

/** Veil colours over a photo background: two light (dark text), two dark (white text). */
export const VEIL_SWATCHES: readonly BackgroundSwatch[] = swatches(["white", "cream", "navy", "black"]);

/**
 * Tints for paper textures: the light swatches (a multiply tint only darkens; dark tints would
 * turn paper into mud). White is "No tint".
 */
export const TINT_SWATCHES: readonly BackgroundSwatch[] = BACKGROUND_SWATCHES.filter(
  (s) => s.ink === "dark" && s.id !== "white",
);

/** Page index the "This page" scope edits, or null on the cover / out of range. */
export function backgroundPageIdx(doc: BookDoc, page: EditorPosition): number | null {
  return typeof page === "number" && page >= 0 && page < doc.pages.length ? page : null;
}

/** Scopes to offer: the cover only has the book background. */
export function availableScopes(pageIdx: number | null): BackgroundScope[] {
  return pageIdx === null ? ["book"] : ["page", "book"];
}

/** The page's own background, or null (absent / null = book default). */
export function pageOverride(doc: BookDoc, pageIdx: number | null): PageBackground | null {
  return pageIdx === null ? null : (doc.pages[pageIdx]?.background ?? null);
}

/** A page background without its `source` (the shape the edit ops take). */
export function withoutSource(bg: PageBackground): Background {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop the key
  const { source: _source, ...rest } = bg;
  return rest as Background;
}

/** The background the chosen scope currently shows (page override, else book default), no `source`. */
export function currentBackground(doc: BookDoc, scope: BackgroundScope, pageIdx: number | null): Background {
  if (scope === "page") {
    const own = pageOverride(doc, pageIdx);
    if (own) return withoutSource(own);
  }
  return doc.style.background;
}

/** Tab to open first: the kind of the background on show. */
export function initialTab(bg: Background): BackgroundTab {
  return bg.kind;
}

/** True when the page shows an AI suggestion (M10c), so the picker marks it "Suggested". */
export function isSuggested(doc: BookDoc, pageIdx: number | null): boolean {
  return pageOverride(doc, pageIdx)?.source === "ai";
}

/**
 * Photos that can be a background: every upload-ready photo of the book, kept or dropped
 * (a background does not place a photo — validate-editor-doc.ts), with a schema-valid id.
 * Kept photos first, then dropped, each in the given order.
 */
export function backgroundPhotoCandidates(photos: readonly EditorShellPhoto[]): EditorShellPhoto[] {
  const ok = photos.filter((p) => PhotoBackgroundSchema.shape.photoId.safeParse(p.id).success);
  return [...ok.filter((p) => p.status === "kept"), ...ok.filter((p) => p.status !== "kept")];
}

/**
 * Lowest fade the slider offers over a LIGHT veil (white / cream → dark text): a 50 % light veil
 * over a busy photo leaves dark captions hard to read. Dark veils (white text) keep FADE_MIN.
 * UI-only clamp (M10a N4); the save validator still accepts BACKGROUND_VEIL_MIN.
 */
export const LIGHT_VEIL_FADE_MIN = 0.6;

/** Slider minimum for a veil colour: LIGHT_VEIL_FADE_MIN for light veils, else FADE_MIN. */
export function fadeMin(veilColor: string): number {
  return inkForHex(veilColor) === "dark" ? LIGHT_VEIL_FADE_MIN : FADE_MIN;
}

/** Snap a fade value into [min, FADE_MAX] and onto the slider step (2 decimals, no float noise). */
export function clampFade(v: number, min: number = FADE_MIN): number {
  if (!Number.isFinite(v)) return DEFAULT_BACKGROUND_VEIL;
  const snapped = Math.round(v / FADE_STEP) * FADE_STEP;
  return Math.round(Math.min(FADE_MAX, Math.max(min, snapped)) * 100) / 100;
}

/** Fade slider state (M10b A4): range minimum, thumb position and the value to announce. */
export interface FadeSliderState {
  min: number;
  value: number;
  /** "50%" for the stored fade; null without a photo background (the label shows a dash). */
  valueText: string | null;
}

/**
 * Fade slider for a photo background. It shows the STORED fade — a light veil saved at 50 %
 * (before the N4 minimum, or by the AI) reads 50 % and sits at 50 %, exactly as the page renders
 * it — so the range reaches down to the stored value. New changes still respect fadeMin (nextFade).
 */
export function fadeSlider(photo: { veil: number; veilColor: string } | null): FadeSliderState {
  if (!photo) return { min: FADE_MIN, value: DEFAULT_BACKGROUND_VEIL, valueText: null };
  const value = Number.isFinite(photo.veil) ? Math.min(FADE_MAX, Math.max(FADE_MIN, photo.veil)) : DEFAULT_BACKGROUND_VEIL;
  // Stay on the FADE_MIN + k·FADE_STEP grid so the slider's steps don't shift.
  const onGrid = Math.round((FADE_MIN + Math.floor((value - FADE_MIN) / FADE_STEP + 1e-9) * FADE_STEP) * 100) / 100;
  return { min: Math.min(fadeMin(photo.veilColor), onGrid), value, valueText: fadeLabel(photo.veil) };
}

/**
 * Fade to store when the user moves the slider to `raw`: snapped and raised to the veil colour's
 * minimum (N4) — a stored light 50 % veil stays until changed, then jumps to 60 %.
 */
export function nextFade(raw: number, veilColor: string): number {
  return clampFade(raw, fadeMin(veilColor));
}

/** A photo background for `photoId`, keeping fade + veil colour of the current photo background. */
export function photoBackground(photoId: string, current: Background): Background {
  return current.kind === "photo"
    ? { kind: "photo", photoId, veil: clampFade(current.veil, fadeMin(current.veilColor)), veilColor: current.veilColor }
    : { kind: "photo", photoId, veil: DEFAULT_BACKGROUND_VEIL, veilColor: DEFAULT_VEIL_COLOR };
}

/** The photo background with another veil colour; the fade rises to that colour's minimum. */
export function withVeilColor(photo: Extract<Background, { kind: "photo" }>, veilColor: string): Background {
  return { ...photo, veilColor, veil: clampFade(photo.veil, fadeMin(veilColor)) };
}

/**
 * "Whole book" edits that only adjust the existing book photo background (same photo — fade or
 * veil colour) keep the pages' own backgrounds: no silent clearing while dragging the slider.
 * Any other change (new photo, colour, paper) replaces them (with the warning + Undo toast).
 */
export function keepsPageOverrides(bookBackground: Background, next: Background): boolean {
  return bookBackground.kind === "photo" && next.kind === "photo" && bookBackground.photoId === next.photoId;
}

/**
 * How a "Whole book" pick applies: keep page overrides (an adjustment of the same photo) or
 * replace them; `replaced` = pages that lose their own background (> 0 → warning toast).
 */
export function planBookBackground(doc: BookDoc, next: Background): { keepPageOverrides: boolean; replaced: number } {
  if (keepsPageOverrides(doc.style.background, next)) return { keepPageOverrides: true, replaced: 0 };
  return { keepPageOverrides: false, replaced: doc.pages.filter((p) => p.background != null).length };
}

/** Fade as a whole percent for labels ("75%"). */
export function fadeLabel(veil: number): string {
  return `${Math.round(veil * 100)}%`;
}

/** Case-insensitive hex equality (swatch selected state). */
export function sameHex(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toUpperCase() === b.toUpperCase();
}
