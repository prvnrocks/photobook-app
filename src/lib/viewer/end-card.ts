// Paid end card model (D-054): fonts, language and ink colour derived from the published book
// style. Pure (no React/DOM) and unit-tested; EndCard.tsx only renders what this returns.

import { captionFontFamily } from "@/lib/book/fonts";
import { coverFont } from "@/lib/book/render";
import { isMainlyArabic } from "@/lib/review/ui";

export const END_CARD_HEADING = "The end";

export interface EndCardModel {
  /** Snapshot book title (may be Arabic; render with dir="auto"). */
  title: string;
  titleLang: "ar" | undefined;
  /** CSS font-family of the title: the cover font (Arabic font for an Arabic title). */
  titleFontFamily: string;
  /** CSS font-family of "The end": the book style font. */
  headingFontFamily: string;
  /** Page background colour of the book. */
  background: string;
  /** True when the background is dark → light ink. */
  dark: boolean;
}

const HEX = /^#([0-9a-f]{6})$/i;

/** Relative luminance (WCAG) of a #RRGGBB colour; null when not a 6-digit hex. */
export function hexLuminance(hex: string): number | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

export function endCardModel(input: { title: string; styleFont: string; background: string }): EndCardModel {
  const title = input.title.trim();
  const lum = hexLuminance(input.background);
  return {
    title,
    titleLang: isMainlyArabic(title) ? "ar" : undefined,
    titleFontFamily: captionFontFamily(coverFont(title, input.styleFont)),
    headingFontFamily: captionFontFamily(coverFont(END_CARD_HEADING, input.styleFont)),
    background: lum === null ? "#FFFFFF" : input.background,
    // Black text contrasts better than white above ~0.18 luminance.
    dark: lum !== null && lum < 0.18,
  };
}
