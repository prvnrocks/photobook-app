// Design-style tokens (M10b A3, D-065): the default face per text role for each designStyle, with
// the Arabic face used when the text is mainly Arabic. Pure data + lookups, client-safe; shared
// by editor, viewer, print and the AI pipeline. Layout-level text panels (A2 texts[]) and the
// cover pick their font through roleFont(); a font stored in the doc (caption.font,
// style.font) overrides the token's Latin face.
//
// classic = the M5–M10a rendering exactly (Playfair, Cairo for Arabic; cover title 600).
// modern  = title script (Great Vibes / Aref Ruqaa), year + subtitle serif (Cormorant / Amiri),
//           chapter display (Bebas Neue / Lalezar), captions serif (Cormorant / Amiri).
// geometric / scrapbook arrive in M10c; until then they use the modern tokens.

import { isMainlyArabic } from "@/lib/review/ui";
import { BOOK_FONTS, bookFontFamily, fontWeightFor, isBookFont, type BookFontName } from "@/lib/book/fonts";
import type { DesignStyle } from "@/lib/book/types";

export const TEXT_ROLES = ["title", "subtitle", "year", "chapter", "caption"] as const;
export type TextRole = (typeof TEXT_ROLES)[number];

export interface RoleFontToken {
  /** Face for Latin (and mixed / letterless, unless the caption language is Arabic) text. */
  latin: BookFontName;
  /** Face for mainly-Arabic text. */
  arabic: BookFontName;
  /** Wanted weight; the face's nearest shipped weight is used (fontWeightFor). */
  weight: 400 | 600 | 700;
  italic?: boolean;
  uppercase?: boolean;
}

export interface StyleTokens {
  id: DesignStyle;
  fonts: Record<TextRole, RoleFontToken>;
}

const CLASSIC: StyleTokens = {
  id: "classic",
  fonts: {
    title: { latin: "Playfair", arabic: "Cairo", weight: 600 },
    subtitle: { latin: "Playfair", arabic: "Cairo", weight: 400 },
    year: { latin: "Playfair", arabic: "Cairo", weight: 400 },
    chapter: { latin: "Playfair", arabic: "Cairo", weight: 600 },
    caption: { latin: "Playfair", arabic: "Cairo", weight: 400 },
  },
};

const MODERN_FONTS: Record<TextRole, RoleFontToken> = {
  title: { latin: "GreatVibes", arabic: "ArefRuqaa", weight: 400 },
  subtitle: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
  year: { latin: "Cormorant", arabic: "Amiri", weight: 600 },
  chapter: { latin: "Bebas", arabic: "Lalezar", weight: 400, uppercase: true },
  caption: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
};

export const STYLE_TOKENS: Record<DesignStyle, StyleTokens> = {
  classic: CLASSIC,
  modern: { id: "modern", fonts: MODERN_FONTS },
  // M10c defines these; modern until then (not offered on the New book form, D-065).
  geometric: { id: "geometric", fonts: MODERN_FONTS },
  scrapbook: { id: "scrapbook", fonts: MODERN_FONTS },
};

export function styleTokens(style: DesignStyle | null | undefined): StyleTokens {
  return (style && STYLE_TOKENS[style]) || CLASSIC;
}

export interface ResolvedRoleFont {
  font: BookFontName;
  /** CSS font-family chain (face → Arabic/Latin partner → Cairo → Inter → generic). */
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  textTransform?: "uppercase";
}

/**
 * Font for `text` in `role` of `style`. Arabic text (or letterless text in an Arabic-caption
 * book, like defaultCaptionFont) uses the token's Arabic face. `override` = a font stored in the
 * doc (e.g. caption.font): a Latin override still switches to its Arabic partner for Arabic text;
 * an Arabic override is used as is (it has Latin glyphs).
 */
export function roleFont(
  style: DesignStyle | null | undefined,
  role: TextRole,
  text: string,
  opts: { captionLang?: string; override?: string | null } = {},
): ResolvedRoleFont {
  const token = styleTokens(style).fonts[role];
  const hasLatin = /[A-Za-zÀ-ɏ]/.test(text);
  const arabic = isMainlyArabic(text) || (!hasLatin && opts.captionLang === "ar");
  let font: BookFontName;
  if (isBookFont(opts.override)) {
    const def = BOOK_FONTS[opts.override];
    font = arabic && def.script === "latin" ? def.partner : opts.override;
  } else {
    font = arabic ? token.arabic : token.latin;
  }
  const italic = !!token.italic && BOOK_FONTS[font].italic;
  return {
    font,
    fontFamily: bookFontFamily(font),
    fontWeight: fontWeightFor(font, token.weight),
    fontStyle: italic ? "italic" : "normal",
    ...(token.uppercase ? { textTransform: "uppercase" as const } : {}),
  };
}
