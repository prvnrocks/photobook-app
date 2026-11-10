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

/** Snap a fade value into range and onto the slider step (2 decimals, no float noise). */
export function clampFade(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_BACKGROUND_VEIL;
  const snapped = Math.round(v / FADE_STEP) * FADE_STEP;
  return Math.round(Math.min(FADE_MAX, Math.max(FADE_MIN, snapped)) * 100) / 100;
}

/** A photo background for `photoId`, keeping fade + veil colour of the current photo background. */
export function photoBackground(photoId: string, current: Background): Background {
  return current.kind === "photo"
    ? { kind: "photo", photoId, veil: current.veil, veilColor: current.veilColor }
    : { kind: "photo", photoId, veil: DEFAULT_BACKGROUND_VEIL, veilColor: DEFAULT_VEIL_COLOR };
}

/** Fade as a whole percent for labels ("75%"). */
export function fadeLabel(veil: number): string {
  return `${Math.round(veil * 100)}%`;
}

/** Case-insensitive hex equality (swatch selected state). */
export function sameHex(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toUpperCase() === b.toUpperCase();
}
