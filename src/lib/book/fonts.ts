// Caption fonts offered by the editor (M5). Pure: shared by editor, viewer and print.
// CSS variables come from next/font in src/app/layout.tsx (--font-inter, --font-cairo,
// --font-tajawal; --font-playfair must be registered there too). Every family string ends with
// an Arabic-capable fallback so Arabic text typed in a Latin font still renders correctly.

import { isMainlyArabic } from "@/lib/review/ui";

export const CAPTION_FONTS = ["Inter", "Playfair", "Cairo", "Tajawal"] as const;
export type CaptionFont = (typeof CAPTION_FONTS)[number];

/** CSS custom property per font (without `var(...)`). */
export const CAPTION_FONT_VARS: Record<CaptionFont, string> = {
  Inter: "--font-inter",
  Playfair: "--font-playfair",
  Cairo: "--font-cairo",
  Tajawal: "--font-tajawal",
};

/** Fonts with Arabic glyphs. */
export const ARABIC_CAPTION_FONTS: readonly CaptionFont[] = ["Cairo", "Tajawal"];

/** Same choice as the AI/autolayout pipeline: Cairo for Arabic, Playfair otherwise. */
export const DEFAULT_LATIN_CAPTION_FONT: CaptionFont = "Playfair";
export const DEFAULT_ARABIC_CAPTION_FONT: CaptionFont = "Cairo";

export function isCaptionFont(v: unknown): v is CaptionFont {
  return typeof v === "string" && (CAPTION_FONTS as readonly string[]).includes(v);
}

/**
 * Default font for a new caption: Cairo when the text is mainly Arabic script, or when the text
 * has no letters yet and the book's caption language is Arabic; Playfair otherwise.
 */
export function defaultCaptionFont(text: string, captionLang?: string): CaptionFont {
  if (isMainlyArabic(text)) return DEFAULT_ARABIC_CAPTION_FONT;
  const hasLatin = /[A-Za-zÀ-ɏ]/.test(text);
  if (!hasLatin && captionLang === "ar") return DEFAULT_ARABIC_CAPTION_FONT;
  return DEFAULT_LATIN_CAPTION_FONT;
}

/**
 * CSS `font-family` value for a caption font. Unknown names (older docs) fall back to the
 * default Latin font. Always followed by the Arabic fallbacks and a generic family.
 */
export function captionFontFamily(font: string): string {
  const f: CaptionFont = isCaptionFont(font) ? font : DEFAULT_LATIN_CAPTION_FONT;
  const generic = f === "Playfair" ? "serif" : "sans-serif";
  const chain = [f, ...ARABIC_CAPTION_FONTS.filter((a) => a !== f)];
  return [...chain.map((c) => `var(${CAPTION_FONT_VARS[c]})`), generic].join(", ");
}
