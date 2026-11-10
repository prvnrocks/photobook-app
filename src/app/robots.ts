import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/auth/redirect";

// robots.txt. Only the internal print route is disallowed. /b/ stays crawlable on purpose: link
// previews (WhatsApp, iMessage, Slack) must fetch shared books — those pages send X-Robots-Tag
// noindex instead (next.config.ts). The sitemap lists only /, /privacy and /terms.
export default function robots(): MetadataRoute.Robots {
  let sitemap: string | undefined;
  try {
    sitemap = `${getSiteUrl()}/sitemap.xml`;
  } catch {
    sitemap = undefined; // production build without NEXT_PUBLIC_APP_URL: omit rather than guess
  }
  return { rules: [{ userAgent: "*", disallow: "/print/" }], ...(sitemap ? { sitemap } : {}) };
}
