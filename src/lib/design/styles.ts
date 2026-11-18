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
// magazine (M30, D-090) = bold travel magazine (ref mg-5): masthead Archivo Black caps / Lalezar,
//           title + chapter Poppins 700 / Tajawal 700, subtitle + date Poppins 400 tracked,
//           captions + chapter descriptions (body) Poppins 400 / Tajawal 400.
// editorial (M30, D-090) = minimal Swiss (ref mg-covers): masthead + title + chapter Poppins 700 in
//           sentence case / Tajawal 700, everything else Poppins 400 / Tajawal 400.
// Both use `uppercaseLatin` / `letterSpacingEm`, which roleFont applies to Latin text only. Their
// accent colours are per book: src/lib/design/colourways.ts (palette.accent = the default one).

import { isMainlyArabic } from "@/lib/review/ui";
import { BOOK_FONTS, bookFontFamily, fontWeightFor, isBookFont, type BookFontName } from "@/lib/book/fonts";
import type { DesignStyle } from "@/lib/book/types";
import type { StickerId } from "@/lib/design/stickers";

// M30: "masthead" (big cover title of the magazine styles) and "body" (chapter descriptions). For
// the four pre-M30 styles masthead = the title token and body = the caption token (none of their
// layouts use the two roles, so nothing renders differently).
export const TEXT_ROLES = ["title", "subtitle", "year", "chapter", "caption", "masthead", "body"] as const;
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
  /**
   * M30: uppercase ONLY when the resolved face and the text are Latin (never on Arabic text or an
   * Arabic face). `uppercase` (modern chapter) is unconditional and frozen by the m10b goldens.
   */
  uppercaseLatin?: boolean;
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

/**
 * A crisp drawn shadow (M10c G1 fix): a translucent copy of the slot shape (same box, shape,
 * rotation, frame outline) offset down/right and painted just under the slot. No blur, no
 * box-shadow, no CSS filter: Chromium prints blurred shadows as Luminosity soft masks that Apple
 * PDF renderers (Preview, iOS) paint as a hard grey box; a flat rgba fill prints as plain vector
 * with a constant alpha.
 */
export interface DrawnShadow {
  /** Offset to the right, mm of the page. */
  dxMm: number;
  /** Offset down, mm of the page. */
  dyMm: number;
  /** Translucent black fill (CSS rgba). */
  color: string;
}

/** Slot shadow presets (never CSS filter or blurred box-shadow: print rule D-062 + G1). */
export interface StyleShadows {
  soft: DrawnShadow;
  lifted: DrawnShadow;
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
    masthead: { latin: "Playfair", arabic: "Cairo", weight: 600 },
    body: { latin: "Playfair", arabic: "Cairo", weight: 400 },
  },
};

const MODERN_FONTS: Record<TextRole, RoleFontToken> = {
  title: { latin: "GreatVibes", arabic: "ArefRuqaa", weight: 400 },
  subtitle: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
  year: { latin: "Cormorant", arabic: "Amiri", weight: 600 },
  chapter: { latin: "Bebas", arabic: "Lalezar", weight: 400, uppercase: true },
  caption: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
  masthead: { latin: "GreatVibes", arabic: "ArefRuqaa", weight: 400 },
  body: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
};

// Crisp drawn shadows (G1 sign-off): soft = paper lying flat, lifted = polaroid standing off the page.
const SHADOWS: StyleShadows = {
  soft: { dxMm: 0.7, dyMm: 0.9, color: "rgba(0, 0, 0, 0.14)" },
  lifted: { dxMm: 1.1, dyMm: 1.5, color: "rgba(0, 0, 0, 0.17)" },
};

const GEOMETRIC: StyleTokens = {
  id: "geometric",
  fonts: {
    title: { latin: "Cormorant", arabic: "Amiri", weight: 600, letterSpacingEm: 0.01 },
    subtitle: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.18 },
    year: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.16 },
    chapter: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.05 },
    caption: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
    masthead: { latin: "Cormorant", arabic: "Amiri", weight: 600, letterSpacingEm: 0.01 },
    body: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
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
    masthead: { latin: "Bebas", arabic: "Lalezar", weight: 400, letterSpacingEm: 0.03 },
    body: { latin: "Cormorant", arabic: "Amiri", weight: 400 },
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

// M30 (D-090). Faces: Archivo Black → Lalezar, Poppins → Tajawal (400 / 700 both shipped). White
// pages; `accent` is the default colourway's accentOnLight (lime / ink — a test keeps them equal);
// the per-book accent and the dark panel colours come from src/lib/design/colourways.ts.
const MAGAZINE: StyleTokens = {
  id: "magazine",
  fonts: {
    title: { latin: "Poppins", arabic: "Tajawal", weight: 700 },
    subtitle: { latin: "Poppins", arabic: "Tajawal", weight: 400, letterSpacingEm: 0.06 },
    year: { latin: "Poppins", arabic: "Tajawal", weight: 400, letterSpacingEm: 0.14 },
    chapter: { latin: "Poppins", arabic: "Tajawal", weight: 700 },
    caption: { latin: "Poppins", arabic: "Tajawal", weight: 400 },
    masthead: { latin: "ArchivoBlack", arabic: "Lalezar", weight: 400, uppercaseLatin: true },
    body: { latin: "Poppins", arabic: "Tajawal", weight: 400 },
  },
  palette: {
    background: "#FFFFFF",
    ink: "#1B1C1F",
    muted: "#5E636B",
    accent: "#566B00",
    frame: "#FFFFFF",
    plate: { id: "plate-label", tint: "#26282B" },
    tape: "#E9D9B6",
    stickerTints: ["#26282B", "#B9D531", "#FF8A3D", "#4FC3F7"],
  },
  shadows: SHADOWS,
};

const EDITORIAL: StyleTokens = {
  id: "editorial",
  fonts: {
    title: { latin: "Poppins", arabic: "Tajawal", weight: 700 },
    subtitle: { latin: "Poppins", arabic: "Tajawal", weight: 400 },
    year: { latin: "Poppins", arabic: "Tajawal", weight: 400 },
    chapter: { latin: "Poppins", arabic: "Tajawal", weight: 700 },
    caption: { latin: "Poppins", arabic: "Tajawal", weight: 400 },
    masthead: { latin: "Poppins", arabic: "Tajawal", weight: 700 },
    body: { latin: "Poppins", arabic: "Tajawal", weight: 400 },
  },
  palette: {
    background: "#FFFFFF",
    ink: "#111111",
    muted: "#5E636B",
    accent: "#111111",
    frame: "#FFFFFF",
    plate: { id: "plate-label", tint: "#111111" },
    tape: "#E9D9B6",
    stickerTints: ["#111111", "#0E6F6E", "#C22F45", "#8A6200"],
  },
  shadows: SHADOWS,
};

export const STYLE_TOKENS: Record<DesignStyle, StyleTokens> = {
  classic: CLASSIC,
  modern: { id: "modern", fonts: MODERN_FONTS },
  geometric: GEOMETRIC,
  scrapbook: SCRAPBOOK,
  magazine: MAGAZINE,
  editorial: EDITORIAL,
};

export function styleTokens(style: DesignStyle | null | undefined): StyleTokens {
  return (style && STYLE_TOKENS[style]) || CLASSIC;
}

/**
 * The caption face a generator (rule autolayout, AI Storyteller/Caption Writer) writes into
 * doc.style.font and AI caption.font for a book of `style` (M10b A11): the style's caption token,
 * Arabic face when the book's caption language is Arabic. Classic → Playfair / Cairo, exactly as
 * before M10b (classic docs stay byte-identical); modern → Cormorant / Amiri; magazine + editorial
 * (M30) → Poppins / Tajawal. caption.font overrides
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
  const latinOnly = BOOK_FONTS[font].script === "latin" && !arabic && !/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  const track = token.letterSpacingEm && latinOnly;
  const upper = token.uppercase || (token.uppercaseLatin && latinOnly);
  return {
    font,
    fontFamily: bookFontFamily(font),
    fontWeight: fontWeightFor(font, token.weight),
    fontStyle: italic ? "italic" : "normal",
    ...(upper ? { textTransform: "uppercase" as const } : {}),
    ...(track ? { letterSpacing: `${token.letterSpacingEm}em` } : {}),
  };
}
