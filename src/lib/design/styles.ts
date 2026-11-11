// Design-style tokens (M10b A3, D-065): the default face per text role for each designStyle, with
// the Arabic face used when the text is mainly Arabic. Pure data + lookups, client-safe; shared
// by editor, viewer, print and the AI pipeline. Layout-level text panels (A2 texts[]) and the
// cover pick their font through roleFont(); a font stored in the doc (caption.font,
// style.font) overrides the token's Latin face.
//
// classic = the M5–M10a rendering exactly (Playfair, Cairo for Arabic; cover title 600).
// modern  = title script (Great Vibes / Aref Ruqaa), year + subtitle serif (Cormorant / Amiri),
//           chapter display (Bebas Neue / Lalezar), captions serif (Cormorant / Amiri).
// geometric (M10c, D-068) = magazine: title serif (Cormorant / Amiri), subtitle + date + chapter
//           display (Bebas / Lalezar, Latin tracked), captions serif.
// scrapbook (M10c, D-068) = handmade: title + chapter + date labels display (Bebas / Lalezar),
//           subtitle serif italic (Cormorant italic / Amiri), captions serif (Cormorant / Amiri).
// No new fonts (D-068). Every face ends in an Arabic chain (bookFontFamily). Letter-spacing is a
// Latin-only token: Arabic text never gets letter-spacing (it breaks joining) and new styles use no
// uppercase transform (Bebas is caps by design; Arabic has no case).

import { isMainlyArabic } from "@/lib/review/ui";
import { BOOK_FONTS, bookFontFamily, fontWeightFor, isBookFont, type BookFontName } from "@/lib/book/fonts";
import type { DesignStyle } from "@/lib/book/types";
import type { StickerId } from "@/lib/design/stickers";

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
  /** Tracking in em, applied ONLY when the resolved face is a Latin face (never on Arabic). */
  letterSpacingEm?: number;
}

/**
 * Colours + effects of a style (M10c). Classic and modern have none (their rendering is frozen);
 * renderers fall back to the current look when `palette` is absent.
 */
export interface StylePalette {
  /** Default page background (hex) for new books; AI / user backgrounds override it. */
  background: string;
  /** Title / chapter text on light backgrounds. */
  ink: string;
  /** Subtitle / date / secondary text on light backgrounds. */
  muted: string;
  /** Rules, small marks, the accent in text blocks. */
  accent: string;
  /** Photo frame paper (border / polaroid). */
  frame: string;
  /** Default label plate sticker + tint (src/lib/design/stickers.ts). */
  plate: { id: StickerId; tint: string };
  /** Default tint for tape decorations. */
  tape: string;
  /** Sticker tints that sit well on this style (layouts pick from these). */
  stickerTints: readonly string[];
}

/** Slot shadow presets as CSS box-shadow, in mm (never CSS filter: it rasterises in print). */
export interface StyleShadows {
  soft: string;
  lifted: string;
}

export interface StyleTokens {
  id: DesignStyle;
  fonts: Record<TextRole, RoleFontToken>;
  /** M10c styles only. */
  palette?: StylePalette;
  shadows?: StyleShadows;
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

// Small blur radii keep the print soft-mask small (each box-shadow = one mask per sheet; M10c risk).
const SHADOWS: StyleShadows = {
  soft: "0 0.35mm 1mm rgba(0, 0, 0, 0.16)",
  lifted: "0.3mm 0.9mm 1.8mm rgba(0, 0, 0, 0.2), 0 0.15mm 0.4mm rgba(0, 0, 0, 0.12)",
};

const GEOMETRIC: StyleTokens = {
  id: "geometric",
  fonts: {
    title: { latin: "Cormorant", arabic: "Amiri", weight: 600, letterSpacingEm: 0.01 },
    subtitle: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.18 },
    year: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.16 },
    chapter: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.05 },
    caption: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
  },
  palette: {
    background: "#FFFFFF",
    ink: "#1F2328",
    muted: "#5E636B",
    accent: "#235A5E",
    frame: "#FFFFFF",
    plate: { id: "plate-label", tint: "#1F2328" },
    tape: "#E9D9B6",
    stickerTints: ["#235A5E", "#D9A84E", "#1F2328", "#B65A4E"],
  },
  shadows: SHADOWS,
};

const SCRAPBOOK: StyleTokens = {
  id: "scrapbook",
  fonts: {
    title: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.03 },
    subtitle: { latin: "Cormorant", arabic: "Amiri", weight: 400, italic: true },
    year: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.12 },
    chapter: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.03 },
    caption: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
  },
  palette: {
    background: "#F6F0E4",
    ink: "#2A2622",
    muted: "#6B5F52",
    accent: "#B65A4E",
    frame: "#FBF8F1",
    plate: { id: "plate-label", tint: "#232326" },
    tape: "#E9D9B6",
    stickerTints: ["#B98A5E", "#B65A4E", "#7E9A6E", "#D9A84E"],
  },
  shadows: SHADOWS,
};

export const STYLE_TOKENS: Record<DesignStyle, StyleTokens> = {
  classic: CLASSIC,
  modern: { id: "modern", fonts: MODERN_FONTS },
  geometric: GEOMETRIC,
  scrapbook: SCRAPBOOK,
};

export function styleTokens(style: DesignStyle | null | undefined): StyleTokens {
  return (style && STYLE_TOKENS[style]) || CLASSIC;
}

/**
 * The caption face a generator (rule autolayout, AI Storyteller/Caption Writer) writes into
 * doc.style.font and AI caption.font for a book of `style` (M10b A11): the style's caption token,
 * Arabic face when the book's caption language is Arabic. Classic → Playfair / Cairo, exactly as
 * before M10b (classic docs stay byte-identical); modern → Cormorant / Amiri. caption.font overrides
 * the style's face in the renderer, so a modern book must never get the classic faces here.
 */
export function styleCaptionFont(style: DesignStyle | null | undefined, captionLang: string | null | undefined): BookFontName {
  const t = styleTokens(style).fonts.caption;
  return captionLang === "ar" ? t.arabic : t.latin;
}

export interface ResolvedRoleFont {
  font: BookFontName;
  /** CSS font-family chain (face → Arabic/Latin partner → Cairo → Inter → generic). */
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  textTransform?: "uppercase";
  /** CSS letter-spacing ("0.12em"); only for Latin faces, never for Arabic. */
  letterSpacing?: string;
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
  // Tracking only when both the face and the text are Latin: an Arabic face, or Arabic text in a
  // Latin face (e.g. a mixed caption), never gets letter-spacing (it breaks Arabic joining).
  const track = token.letterSpacingEm && BOOK_FONTS[font].script === "latin" && !arabic && !/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  return {
    font,
    fontFamily: bookFontFamily(font),
    fontWeight: fontWeightFor(font, token.weight),
    fontStyle: italic ? "italic" : "normal",
    ...(token.uppercase ? { textTransform: "uppercase" as const } : {}),
    ...(track ? { letterSpacing: `${token.letterSpacingEm}em` } : {}),
  };
}
