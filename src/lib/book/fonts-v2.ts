// Caption font names that only doc v2 may store (M10b, D-065). Pure data, no imports.
//
// A doc whose book font (style.font) or any page caption font is one of these cannot be written as
// v1: M9 code would not know the face (usesV2Features in doc-version.ts). The font files, CSS
// chains and editor offering live in src/lib/book/fonts.ts / print fonts (A3); this list is only
// the version rule, kept separate so the doc-version module has no dependency on font loading.

export const V2_CAPTION_FONTS = [
  "Cormorant",
  "Amiri",
  "Bebas",
  "Lalezar",
  "GreatVibes",
  "ArefRuqaa",
] as const; // same ids as BOOK_FONTS_M10B in fonts.ts (short ids, like "Playfair"); a test keeps them equal

export type V2CaptionFont = (typeof V2_CAPTION_FONTS)[number];

const SET: ReadonlySet<string> = new Set(V2_CAPTION_FONTS);

/** True when `font` is a caption font only doc v2 may store. */
export function isV2CaptionFont(font: unknown): font is V2CaptionFont {
  return typeof font === "string" && SET.has(font);
}
