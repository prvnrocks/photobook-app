// Share metadata (title / Open Graph / Twitter) for the public viewer /b/[slug] (M6 T7, D-040).
// Pure: the page calls getOgData(slug) and passes the result in, so this never touches the DB.
//
// Privacy rules (D-040): a password book ("locked") never exposes its title or cover — the OG
// image URL still points at the og route, which draws a generic card for locked books. Expired
// and missing books get a generic title too. Every link is absolute on getSiteUrl()
// (NEXT_PUBLIC_APP_URL = production domain; deployment-hash URLs are behind Vercel auth and
// WhatsApp can't fetch them — lessons 2026-11-03).
import type { Metadata } from "next";
import { getSiteUrl } from "@/lib/auth/redirect";
import { APP_NAME } from "@/lib/brand";
import type { OgData } from "@/lib/db/public-books";
import { isValidSlug } from "@/lib/publish/slug";

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export const BOOK_DESCRIPTION = `A photobook made with ${APP_NAME} — tap to flip through`;
export const PRIVATE_BOOK_TITLE = "A private photobook";
export const EXPIRED_BOOK_TITLE = "Photobook expired";
export const MISSING_BOOK_TITLE = "Photobook not found";

/** Fields of OgData the metadata needs (keeps tests and callers light). */
export type BookMetadataInput = Pick<OgData, "state" | "title" | "publishedRev" | "hasPassword">;

/** Path of the OG image; the version busts WhatsApp/CDN caches on republish or password change. */
export function ogImagePath(slug: string, og: Pick<OgData, "publishedRev" | "hasPassword">): string {
  return `/b/${slug}/og?v=${og.publishedRev ?? 0}-${og.hasPassword ? 1 : 0}`;
}

/** Page title by state. Never the book title for locked/expired/missing books. */
export function bookMetadataTitle(og: BookMetadataInput): string {
  switch (og.state) {
    case "ok":
      return og.title?.trim() || APP_NAME;
    case "locked":
      return PRIVATE_BOOK_TITLE;
    case "expired":
      return EXPIRED_BOOK_TITLE;
    case "not_found":
      return MISSING_BOOK_TITLE;
    default:
      return APP_NAME;
  }
}

export function buildBookMetadata(slug: string, og: BookMetadataInput): Metadata {
  const siteUrl = getSiteUrl();
  const title = bookMetadataTitle(og);
  const robots = { index: false, follow: false };
  const base: Metadata = {
    metadataBase: new URL(siteUrl),
    title: { absolute: title },
    description: BOOK_DESCRIPTION,
    robots,
  };

  // Never echo an unvalidated slug into URLs.
  if (!isValidSlug(slug)) {
    return {
      ...base,
      openGraph: { type: "website", siteName: APP_NAME, title, description: BOOK_DESCRIPTION },
      twitter: { card: "summary", title, description: BOOK_DESCRIPTION },
    };
  }

  const pageUrl = `${siteUrl}/b/${slug}`;
  const image = {
    url: `${siteUrl}${ogImagePath(slug, og)}`,
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    alt: og.state === "ok" && og.title?.trim() ? `${og.title.trim()} — ${APP_NAME}` : APP_NAME,
  };
  return {
    ...base,
    openGraph: {
      type: "website",
      siteName: APP_NAME,
      url: pageUrl,
      title,
      description: BOOK_DESCRIPTION,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: BOOK_DESCRIPTION,
      images: [image],
    },
  };
}
