// Screen faces for the M10b OFL font pairs (A3, D-065): loaded only on book screens (editor,
// viewer, dev book fixtures) through <BookFonts>, never globally — marketing pages don't pay for
// ~800 KB of fonts. Print has its own static declarations (src/components/print/print-fonts.ts);
// both declare the same CSS variables (registry: src/lib/book/fonts.ts → BOOK_FONTS).
//
// Same static per-weight woff2 files as print (Google Fonts static TTFs, lossless woff2, no
// subsetting — Aref Ruqaa has a Reserved Font Name). Licences: ../print/fonts/OFL-*.txt.
//
// - Const names are the CSS family names: `book*` keeps them distinct from the root layout and the
//   `print*` faces (lessons 2026-11-10: same-named families merge).
// - preload: false — a phone viewing a classic book must not download these; @font-face only
//   fetches a face when text actually uses it.
// - adjustFontFallback: false — the generated "… Fallback" face is local(Arial/Times), which
//   has Arabic glyphs and would catch Arabic text before the Arabic partner in the chain.

import localFont from "next/font/local";

const bookCormorant = localFont({
  variable: "--font-cormorant",
  src: [
    { path: "../print/fonts/CormorantGaramond-400.woff2", weight: "400", style: "normal" },
    { path: "../print/fonts/CormorantGaramond-400italic.woff2", weight: "400", style: "italic" },
    { path: "../print/fonts/CormorantGaramond-600.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const bookAmiri = localFont({
  variable: "--font-amiri",
  src: [
    { path: "../print/fonts/Amiri-400.woff2", weight: "400", style: "normal" },
    { path: "../print/fonts/Amiri-700.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const bookBebas = localFont({
  variable: "--font-bebas",
  src: [{ path: "../print/fonts/BebasNeue-400.woff2", weight: "400", style: "normal" }],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const bookLalezar = localFont({
  variable: "--font-lalezar",
  src: [{ path: "../print/fonts/Lalezar-400.woff2", weight: "400", style: "normal" }],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const bookGreatVibes = localFont({
  variable: "--font-great-vibes",
  src: [{ path: "../print/fonts/GreatVibes-400.woff2", weight: "400", style: "normal" }],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const bookArefRuqaa = localFont({
  variable: "--font-aref-ruqaa",
  src: [
    { path: "../print/fonts/ArefRuqaa-400.woff2", weight: "400", style: "normal" },
    { path: "../print/fonts/ArefRuqaa-700.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

/** Classes declaring the M10b font variables (screen). Apply on a book-screen wrapper. */
export const BOOK_FONT_CLASSES = [
  bookCormorant.variable,
  bookAmiri.variable,
  bookBebas.variable,
  bookLalezar.variable,
  bookGreatVibes.variable,
  bookArefRuqaa.variable,
].join(" ");

/** Variables declared by BOOK_FONT_CLASSES (must cover every M10b registry entry). */
export const BOOK_FONT_VARS = [
  "--font-cormorant",
  "--font-amiri",
  "--font-bebas",
  "--font-lalezar",
  "--font-great-vibes",
  "--font-aref-ruqaa",
] as const;
