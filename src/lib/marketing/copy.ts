// Landing page copy (M9 T11). Pure data — safe in client and server code.
// Numbers never appear here as literals: prices come from src/lib/pricing.ts, limits from
// src/lib/ai/limits.ts, retention from src/lib/cleanup/rules.ts.

/** Hero headline (M14, user decision 2026-11-14: use exactly as written). */
export const HERO_HEADLINE = "Your memories, in print.";
/** M16: the headline's last words are set in gold foil; the text itself never changes. */
export const HERO_HEADLINE_ACCENT = "in print.";
export const HERO_HEADLINE_LEAD = HERO_HEADLINE.slice(0, HERO_HEADLINE.length - HERO_HEADLINE_ACCENT.length);

export const HERO_SUBCOPY = "Upload your photos. AI turns them into a book you can share.";

/** The hero's terracotta pill (M14 mockup). */
export const HERO_CTA_LABEL = "Make my book";

/** Pricing CTA — same words as the hero (M14 final, user decision 2026-11-14). */
export const CTA_LABEL = HERO_CTA_LABEL;
/**
 * M19 (D-071): the creation wizard at /books/new (was /books/start, D-070). Signed-in visitors skip
 * the login form: /login redirects straight to `next`.
 */
export const CTA_HREF = "/login?next=%2Fbooks%2Fnew";

/** Small caps line above the hero headline (M16). */
export const HERO_EYEBROW = "AI photobooks · Abu Dhabi";
/** Gold foil seal on the hero book (M16), one entry per line. True for every new book. */
export const HERO_SEAL = ["Free", "to try"] as const;
/**
 * Cream card on the hero (M16): an Arabic sample title + one true line about captions. It is the
 * landing page's proof that Arabic renders (Lalezar, RTL) since the M15 shelf was removed.
 */
export const HERO_TAG_TITLE_AR = "لمّة العائلة";
export const HERO_TAG_LINE = "Captions in Arabic or English";

/** Scrolling strip under the hero (M15). True benefits only — no invented claims. */
export const MARQUEE_ITEMS = [
  "AI picks your best photos",
  "Arabic & English captions",
  "Share on WhatsApp",
  "High-quality PDF",
  "Made in Abu Dhabi",
] as const;

/** Small caps labels above the section headings (M16). */
export const SECTION_LABELS = { how: "Three steps", pricing: "Per book, not per month", faq: "Good to know" } as const;

/** "How it works" row under the marquee (M14 mockup: icon + title, one short line each). */
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
 * Text drawn on the static OG card (M16 emerald & gold). Basic Latin + Latin-1 only (the "·" is
 * U+00B7): next/og's bundled Noto Sans latin subset covers those, and any other glyph would make it
 * fetch fonts from Google at request time (tests/landing.test.tsx).
 */
export const OG_EYEBROW = "AI PHOTOBOOKS · ABU DHABI";
export const OG_HEADLINE_LEAD = "Your memories,";
export const OG_HEADLINE_ACCENT = "in print.";
export const OG_HEADLINE = `${OG_HEADLINE_LEAD} ${OG_HEADLINE_ACCENT}`;
export const OG_SUBLINE = "AI builds the book. Share it as one link.";
