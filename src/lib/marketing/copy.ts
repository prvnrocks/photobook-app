// Landing page copy (M9 T11). Pure data — safe in client and server code.
// Numbers never appear here as literals: prices come from src/lib/pricing.ts, limits from
// src/lib/ai/limits.ts, retention from src/lib/cleanup/rules.ts.

import { LIMITS } from "@/lib/ai/limits";

/**
 * How long a build takes, as promised in the hero. Switch to "in minutes" if live timings
 * (M4b / launch smoke) are slower than about a minute for a full free book.
 */
export const BUILD_TIME_CLAIM = "in about a minute";

/** Hero headline — the one claim we make about speed and size (approved in M9 plan). */
export const HERO_CLAIM = `Upload up to ${LIMITS.free.maxAnalyzedPhotos} photos → AI builds your book ${BUILD_TIME_CLAIM}`;

export const HERO_SUBCOPY =
  "Share it as a flipbook link that opens on any phone — perfect for WhatsApp — and download a print-quality PDF when you upgrade.";

export const CTA_LABEL = "Make your book";
/** Small line under the hero CTA. */
export const CTA_NOTE = "Free to try. No card needed.";
/** Tracked caps above the hero headline (M11). */
export const HERO_EYEBROW = "AI photobooks · Flipbook links";
/**
 * M13 T5 (D-070): photos first — /books/start is one big "Choose photos". Signed-in visitors skip
 * the login form: /login redirects straight to `next`.
 */
export const CTA_HREF = "/login?next=%2Fbooks%2Fstart";

export const HOW_IT_WORKS = [
  {
    title: "Upload your photos",
    text: "Pick them straight from your phone. We skip screenshots, blurry shots and duplicates for you.",
  },
  {
    title: "AI builds the book",
    text: "Photos are grouped into moments by date and place, laid out on pages and given short captions. You can change everything.",
  },
  {
    title: "Share on WhatsApp",
    text: "Publish and send one link. Friends and family flip through it on any phone, anywhere in the world.",
  },
] as const;

/** Sample captions in the hero illustration (one English, one Arabic). */
export const HERO_SAMPLE_CAPTION_EN = "Golden hour on the Corniche, just the two of us.";
export const HERO_SAMPLE_CAPTION_AR = "أجمل الذكريات تبدأ بصورة";

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
