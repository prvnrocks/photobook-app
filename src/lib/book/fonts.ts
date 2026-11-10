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

// --- Font registry (M10b A3, D-065) --------------------------------------------------------------
// Every face a book can use, classic (M5) + the M10b OFL pairs. Pure data, client-safe.
//
// One CSS variable per face, used by editor, viewer AND print (the renderer emits one
// font-family string for all modes): the screen module (src/components/book/book-fonts.ts, loaded
// only on book screens) and the print module (src/components/print/print-fonts.ts, static files →
// no Type3) both declare the same variable on their wrapper. Classic faces are declared globally
// by src/app/layout.tsx (screen) and print-fonts.ts (print).
//
// Pairs (A7 spike): every Latin face has an Arabic partner so Arabic typed in a Latin face renders
// in a matching face (and in print never falls back to a system font, which may be Type3 or
// missing on Linux Chromium). Chains: face → its pair → Cairo (wider Arabic: Persian/Urdu letters,
// Turkish Latin) → Inter (symbols: arrows, ♥ ★ ✓ — static in print) → generic.
//
// The doc schema's list of allowed v2 font names lives elsewhere (A2); any name in
// BOOK_FONTS_M10B is a doc v2 feature (D-065).

export type FontScript = "latin" | "arabic";
/** Font pair ids. `classic` = the M5 faces (Playfair/Inter + Cairo/Tajawal). */
export type FontPairId = "classic" | "serif" | "display" | "script";

/** The M10b OFL faces (doc font names). */
export const BOOK_FONTS_M10B = ["Cormorant", "Amiri", "Bebas", "Lalezar", "GreatVibes", "ArefRuqaa"] as const;
export type M10bFont = (typeof BOOK_FONTS_M10B)[number];
export type BookFontName = CaptionFont | M10bFont;
export const BOOK_FONT_NAMES: readonly BookFontName[] = [...CAPTION_FONTS, ...BOOK_FONTS_M10B];

export interface BookFontDef {
  name: BookFontName;
  /** Human label for pickers. */
  label: string;
  /** CSS custom property (without `var(...)`), declared by both the screen and the print module. */
  cssVar: string;
  /**
   * Const names of the next/font/local declarations (screen + print). They become the CSS family
   * names, so they must be unique and never equal a root-layout family (lessons 2026-11-10).
   * Classic screen faces come from next/font/google in the root layout (`null`).
   */
  screenConst: string | null;
  printConst: string;
  script: FontScript;
  pair: FontPairId;
  /** Partner face: Arabic face for a Latin face, Latin face for an Arabic face. */
  partner: BookFontName;
  generic: "serif" | "sans-serif";
  /** Static weights shipped (others are synthesised by the browser — avoid them). */
  weights: readonly (400 | 600 | 700)[];
  italic: boolean;
}

export const BOOK_FONTS: Record<BookFontName, BookFontDef> = {
  // classic (M5) — chains via captionFontFamily (unchanged, goldens)
  Playfair: { name: "Playfair", label: "Playfair Display", cssVar: "--font-playfair", screenConst: null, printConst: "printPlayfair", script: "latin", pair: "classic", partner: "Cairo", generic: "serif", weights: [400, 600], italic: false },
  Inter: { name: "Inter", label: "Inter", cssVar: "--font-inter", screenConst: null, printConst: "printInter", script: "latin", pair: "classic", partner: "Cairo", generic: "sans-serif", weights: [400, 600], italic: false },
  Cairo: { name: "Cairo", label: "Cairo", cssVar: "--font-cairo", screenConst: null, printConst: "printCairo", script: "arabic", pair: "classic", partner: "Playfair", generic: "sans-serif", weights: [400, 600], italic: false },
  Tajawal: { name: "Tajawal", label: "Tajawal", cssVar: "--font-tajawal", screenConst: null, printConst: "printTajawal", script: "arabic", pair: "classic", partner: "Playfair", generic: "sans-serif", weights: [400, 700], italic: false },
  // M10b serif pair
  Cormorant: { name: "Cormorant", label: "Cormorant Garamond", cssVar: "--font-cormorant", screenConst: "bookCormorant", printConst: "printCormorant", script: "latin", pair: "serif", partner: "Amiri", generic: "serif", weights: [400, 600], italic: true },
  Amiri: { name: "Amiri", label: "Amiri", cssVar: "--font-amiri", screenConst: "bookAmiri", printConst: "printAmiri", script: "arabic", pair: "serif", partner: "Cormorant", generic: "serif", weights: [400, 700], italic: false },
  // M10b display pair (Bebas Neue is caps-only by design: lowercase maps to caps glyphs)
  Bebas: { name: "Bebas", label: "Bebas Neue", cssVar: "--font-bebas", screenConst: "bookBebas", printConst: "printBebas", script: "latin", pair: "display", partner: "Lalezar", generic: "sans-serif", weights: [400], italic: false },
  Lalezar: { name: "Lalezar", label: "Lalezar", cssVar: "--font-lalezar", screenConst: "bookLalezar", printConst: "printLalezar", script: "arabic", pair: "display", partner: "Bebas", generic: "sans-serif", weights: [400], italic: false },
  // M10b script pair (Aref Ruqaa: Reserved Font Name "EURM10" — ship unmodified, never subset/rename)
  GreatVibes: { name: "GreatVibes", label: "Great Vibes", cssVar: "--font-great-vibes", screenConst: "bookGreatVibes", printConst: "printGreatVibes", script: "latin", pair: "script", partner: "ArefRuqaa", generic: "serif", weights: [400], italic: false },
  ArefRuqaa: { name: "ArefRuqaa", label: "Aref Ruqaa", cssVar: "--font-aref-ruqaa", screenConst: "bookArefRuqaa", printConst: "printArefRuqaa", script: "arabic", pair: "script", partner: "GreatVibes", generic: "serif", weights: [400, 700], italic: false },
};

/** Caption font pairs offered by the editor (D-065): Latin face + its Arabic partner. */
export const FONT_PAIRS: Record<Exclude<FontPairId, "classic">, { label: string; latin: M10bFont; arabic: M10bFont }> = {
  serif: { label: "Serif", latin: "Cormorant", arabic: "Amiri" },
  display: { label: "Display", latin: "Bebas", arabic: "Lalezar" },
  script: { label: "Script", latin: "GreatVibes", arabic: "ArefRuqaa" },
};

export function isBookFont(v: unknown): v is BookFontName {
  return typeof v === "string" && (BOOK_FONT_NAMES as readonly string[]).includes(v);
}

export function isM10bFont(v: unknown): v is M10bFont {
  return typeof v === "string" && (BOOK_FONTS_M10B as readonly string[]).includes(v);
}

/** The face to use for `text`: the Arabic partner when the text is mainly Arabic and `font` is Latin. */
export function fontForText(font: BookFontName, text: string): BookFontName {
  const def = BOOK_FONTS[font];
  return def.script === "latin" && isMainlyArabic(text) ? def.partner : font;
}

/** Nearest shipped weight (avoids browser-synthesised bold/thin, which also differs in print). */
export function fontWeightFor(font: BookFontName, wanted: number): number {
  const ws = BOOK_FONTS[font].weights;
  return ws.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), ws[0]);
}

// M10b faces are declared only on book screens + print. A var() that is undefined makes the whole
// font-family declaration invalid (the element would lose every fallback), so each M10b var
// carries a fallback family name: elsewhere it resolves to a name that simply doesn't match.
function fontVarRef(f: BookFontName): string {
  const def = BOOK_FONTS[f];
  return def.screenConst ? `var(${def.cssVar}, "${def.label}")` : `var(${def.cssVar})`;
}

/**
 * CSS `font-family` for any registry face. Classic faces return exactly captionFontFamily()
 * (byte-identical goldens). M10b faces: face → partner → Cairo → Inter → generic. Unknown names
 * fall back to the classic default.
 */
export function bookFontFamily(font: string): string {
  if (!isM10bFont(font)) return captionFontFamily(font);
  const def = BOOK_FONTS[font];
  const chain: BookFontName[] = [font, def.partner, "Cairo", "Inter"];
  return [...chain.map(fontVarRef), def.generic].join(", ");
}
