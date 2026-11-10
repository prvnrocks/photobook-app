// Static font instances for the print document only (M8 fix, D-050). Chromium/Skia embeds
// variable fonts (what next/font/google serves for Inter, Cairo and Playfair Display, even
// with explicit `weight` arrays) as Type3 glyph procedures, which print shops reject. These
// static TrueType instances embed as Type0/CIDFontType2 subsets instead.
//
// The class names re-declare the SAME CSS variables the renderer uses (src/lib/book/fonts.ts
// BOOK_FONTS: --font-inter, --font-playfair, --font-cairo, --font-tajawal + the M10b pairs) on the print wrapper, so
// <BookPage mode="print"> markup is unchanged; the editor/viewer keep the root layout fonts.
//
// Weights = what the book renderer uses: 400 (captions, cover subtitle) and 600 (cover title,
// `font-semibold`). Tajawal has no 600, so it ships 400 + 700 like the root layout (600 → 700).
// Files: Google Fonts' per-weight static TTFs, converted losslessly to woff2 (no glyph
// subsetting: Playfair Display has a Reserved Font Name, and full coverage keeps print = viewer).
// Licences: SIL OFL 1.1, see ./fonts/OFL-*.txt. Served same-origin from /_next/static/media.

import localFont from "next/font/local";

// next/font/local names each family after the const it is assigned to, and CSS family names are
// case-insensitive: `const cairo` would become 'cairo' and merge with the root layout's
// variable 'Cairo' faces in dev (Chrome then picked the variable face). Keep the print prefix.
//
// adjustFontFallback: false and no `fallback` list (M10b A3): next/font otherwise appends a
// "printX Fallback" face = local(Arial) to each variable. Arial has Arabic glyphs, so Arabic in a
// Latin chain (Playfair → Cairo → Tajawal) was drawn in the system Arial (partly Type3 in the PDF)
// instead of Cairo; a generic family mid-chain would do the same. Print waits for the fonts
// (display: block + document.fonts.ready), so the metric-adjusted fallback face is never needed.

const printInter = localFont({
  variable: "--font-inter",
  src: [
    { path: "./fonts/Inter-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Inter-600.woff2", weight: "600", style: "normal" },
  ],
  display: "block",
  adjustFontFallback: false,
});

const printPlayfair = localFont({
  variable: "--font-playfair",
  src: [
    { path: "./fonts/PlayfairDisplay-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/PlayfairDisplay-600.woff2", weight: "600", style: "normal" },
  ],
  display: "block",
  adjustFontFallback: false,
});

const printCairo = localFont({
  variable: "--font-cairo",
  src: [
    { path: "./fonts/Cairo-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Cairo-600.woff2", weight: "600", style: "normal" },
  ],
  display: "block",
  adjustFontFallback: false,
});

const printTajawal = localFont({
  variable: "--font-tajawal",
  src: [
    { path: "./fonts/Tajawal-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Tajawal-700.woff2", weight: "700", style: "normal" },
  ],
  display: "block",
  adjustFontFallback: false,
});

// --- M10b OFL pairs (A3, D-065): same CSS variables as the screen module
// (src/components/book/book-fonts.ts). adjustFontFallback: false — the generated "… Fallback" face
// is local(Arial/Times), whose Arabic glyphs would beat the Arabic partner in the chain (and are
// system fonts in print). Aref Ruqaa has a Reserved Font Name: files ship unmodified.

const printCormorant = localFont({
  variable: "--font-cormorant",
  src: [
    { path: "./fonts/CormorantGaramond-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/CormorantGaramond-400italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/CormorantGaramond-600.woff2", weight: "600", style: "normal" },
  ],
  display: "block",
  adjustFontFallback: false,
});

const printAmiri = localFont({
  variable: "--font-amiri",
  src: [
    { path: "./fonts/Amiri-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Amiri-700.woff2", weight: "700", style: "normal" },
  ],
  display: "block",
  adjustFontFallback: false,
});

const printBebas = localFont({
  variable: "--font-bebas",
  src: [{ path: "./fonts/BebasNeue-400.woff2", weight: "400", style: "normal" }],
  display: "block",
  adjustFontFallback: false,
});

const printLalezar = localFont({
  variable: "--font-lalezar",
  src: [{ path: "./fonts/Lalezar-400.woff2", weight: "400", style: "normal" }],
  display: "block",
  adjustFontFallback: false,
});

const printGreatVibes = localFont({
  variable: "--font-great-vibes",
  src: [{ path: "./fonts/GreatVibes-400.woff2", weight: "400", style: "normal" }],
  display: "block",
  adjustFontFallback: false,
});

const printArefRuqaa = localFont({
  variable: "--font-aref-ruqaa",
  src: [
    { path: "./fonts/ArefRuqaa-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ArefRuqaa-700.woff2", weight: "700", style: "normal" },
  ],
  display: "block",
  adjustFontFallback: false,
});

/** Classes that point the renderer's font variables at the static print fonts. */
export const PRINT_FONT_CLASSES = [
  printInter.variable,
  printPlayfair.variable,
  printCairo.variable,
  printTajawal.variable,
  printCormorant.variable,
  printAmiri.variable,
  printBebas.variable,
  printLalezar.variable,
  printGreatVibes.variable,
  printArefRuqaa.variable,
].join(" ");

/** Variables re-declared by PRINT_FONT_CLASSES (must cover every BOOK_FONTS cssVar). */
export const PRINT_FONT_VARS = [
  "--font-inter",
  "--font-playfair",
  "--font-cairo",
  "--font-tajawal",
  "--font-cormorant",
  "--font-amiri",
  "--font-bebas",
  "--font-lalezar",
  "--font-great-vibes",
  "--font-aref-ruqaa",
] as const;
