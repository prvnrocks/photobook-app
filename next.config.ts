import path from "node:path";
import type { NextConfig } from "next";

/**
 * Headers for the public flipbook /b/[slug] (and its og image). noindex: shared books are private
 * links, not search results — but /b/ is NOT disallowed in robots.txt, because link-preview
 * crawlers (WhatsApp, iMessage, Slack) must still fetch the page and its og image.
 * no-referrer: viewers' clicks out of a book don't leak the secret slug to other sites.
 */
export const PUBLIC_BOOK_HEADERS = [
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  // Pin the workspace root to this repo. Without it Next picks up a stray
  // lockfile in a parent folder and infers the wrong root for file tracing.
  outputFileTracingRoot: path.join(__dirname),
  async headers() {
    return [{ source: "/b/:path*", headers: PUBLIC_BOOK_HEADERS }];
  },
};

export default nextConfig;
