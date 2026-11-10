// Static font instances for the print document only (M8 fix, D-050). Chromium/Skia embeds
// variable fonts (what next/font/google serves for Inter, Cairo and Playfair Display, even
// with explicit `weight` arrays) as Type3 glyph procedures, which print shops reject. These
// static TrueType instances embed as Type0/CIDFontType2 subsets instead.
//
// The class names re-declare the SAME CSS variables the renderer uses (src/lib/book/fonts.ts:
// --font-inter, --font-playfair, --font-cairo, --font-tajawal) on the print wrapper, so
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

const printInter = localFont({
  variable: "--font-inter",
  src: [
    { path: "./fonts/Inter-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Inter-600.woff2", weight: "600", style: "normal" },
  ],
  display: "block",
  fallback: ["sans-serif"],
});

const printPlayfair = localFont({
  variable: "--font-playfair",
  src: [
    { path: "./fonts/PlayfairDisplay-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/PlayfairDisplay-600.woff2", weight: "600", style: "normal" },
  ],
  display: "block",
  fallback: ["serif"],
});

const printCairo = localFont({
  variable: "--font-cairo",
  src: [
    { path: "./fonts/Cairo-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Cairo-600.woff2", weight: "600", style: "normal" },
  ],
  display: "block",
  fallback: ["sans-serif"],
});

const printTajawal = localFont({
  variable: "--font-tajawal",
  src: [
    { path: "./fonts/Tajawal-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Tajawal-700.woff2", weight: "700", style: "normal" },
  ],
  display: "block",
  fallback: ["sans-serif"],
});

/** Classes that point the renderer's font variables at the static print fonts. */
export const PRINT_FONT_CLASSES = [printInter.variable, printPlayfair.variable, printCairo.variable, printTajawal.variable].join(" ");

/** Variables re-declared by PRINT_FONT_CLASSES (must cover every CAPTION_FONT_VARS entry). */
export const PRINT_FONT_VARS = ["--font-inter", "--font-playfair", "--font-cairo", "--font-tajawal"] as const;
