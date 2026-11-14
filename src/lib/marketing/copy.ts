// Landing page copy (M9 T11). Pure data — safe in client and server code.
// Numbers never appear here as literals: prices come from src/lib/pricing.ts, limits from
// src/lib/ai/limits.ts, retention from src/lib/cleanup/rules.ts.

/** Hero headline (M14, user decision 2026-11-14: use exactly as written). */
export const HERO_HEADLINE = "Your memories, in print.";

export const HERO_SUBCOPY = "Upload your photos. AI turns them into a book you can share.";

/** The hero's terracotta pill (M14 mockup). Pricing keeps CTA_LABEL. */
export const HERO_CTA_LABEL = "Make my book";

export const CTA_LABEL = "Make your book";
/** CTA in the bookshelf preview card (M14). */
export const SHELF_PREVIEW_CTA_LABEL = "Make a book like this";
/** Small line under the bookshelf preview CTA. */
export const CTA_NOTE = "Free to try. No card needed.";
/**
 * M13 T5 (D-070): photos first — /books/start is one big "Choose photos". Signed-in visitors skip
 * the login form: /login redirects straight to `next`.
 */
export const CTA_HREF = "/login?next=%2Fbooks%2Fstart";

/** "How it works" row under the bookshelf (M14 mockup: icon + title, one short line each). */
export const HOW_IT_WORKS = [
  { icon: "upload", title: "Upload photos", text: "Straight from your phone. Screenshots, blurry shots and duplicates are skipped." },
  { icon: "ai", title: "AI builds your book", text: "Grouped into moments by date and place, laid out, captioned. You can change everything." },
  { icon: "share", title: "Share your flipbook", text: "Send one link on WhatsApp. It opens on any phone, anywhere." },
] as const;

/** SEO title + description for "/". */
export const LANDING_TITLE = "AI photobooks you share as a link";
export const LANDING_DESCRIPTION =
  "Upload your photos, AI builds the book and writes the captions (English or Arabic), and you share it as a flipbook link on WhatsApp. Made in Abu Dhabi.";

/**
 * Text drawn on the static OG card. ASCII only: next/og's bundled font covers basic Latin, and any
 * other glyph would make it fetch fonts from Google at request time (tests/landing.test.tsx).
 */
export const OG_HEADLINE = "Your photos, an AI-built album, one link to share";
export const OG_SUBLINE = "Flipbook link + PDF. Made in Abu Dhabi.";
