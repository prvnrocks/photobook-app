// "Accent colour" tool logic (M30 T13, D-090). Pure: no React/DOM. Magazine and editorial books
// draw rules, headings, panels and cover details in one of six colourways
// (src/lib/design/colourways.ts); the AI suggests one from the photos, the user may pick another.
// The four older styles have no colourways, so the tool is absent there.

import { colourwaysFor, resolveColourway, type Colourway } from "@/lib/design/colourways";
import type { BookDoc } from "@/lib/book/types";

export interface AccentOption {
  colourway: Colourway;
  /** The colourway the book draws with now (the stored one, or the style's default when none is stored). */
  current: boolean;
  /** Swatch: the surface the accent mostly sits on in this style, and the accent as drawn on it. */
  swatch: { base: string; dot: string };
}

/**
 * How a colourway looks in a style, as two flat colours: magazine sets the vivid accent on its dark
 * panels; editorial sets the deepened accent on white pages.
 */
function swatchOf(style: BookDoc["style"]["designStyle"], c: Colourway): AccentOption["swatch"] {
  return style === "editorial" ? { base: "#FFFFFF", dot: c.accentOnLight } : { base: c.panel, dot: c.accent };
}

/** The book's colourways in picker order (default first); empty for the four older styles. */
export function accentOptions(doc: Pick<BookDoc, "style">): AccentOption[] {
  const style = doc.style.designStyle;
  const current = resolveColourway(style, doc.style.colourway?.id);
  return colourwaysFor(style).map((colourway) => ({
    colourway,
    current: colourway.id === current?.id,
    swatch: swatchOf(style, colourway),
  }));
}

/** The tool shows only for books whose style has colourways (magazine, editorial). */
export function accentAvailable(doc: Pick<BookDoc, "style">): boolean {
  return colourwaysFor(doc.style.designStyle).length > 1;
}
