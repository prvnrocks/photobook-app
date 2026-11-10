import type { MetadataRoute } from "next";

// robots.txt. Only the internal print route is disallowed. /b/ stays crawlable on purpose: link
// previews (WhatsApp, iMessage, Slack) must fetch shared books — those pages send X-Robots-Tag
// noindex instead (next.config.ts).
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/print/" }] };
}
