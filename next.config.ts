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

/**
 * Headers for the internal print route /print/[bookId] (M8, D-048): only headless Chromium opens
 * it, with a short-lived token in the URL — never index, never cache, never send a Referer.
 */
export const PRINT_ROUTE_HEADERS = [
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Cache-Control", value: "no-store" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  // Pin the workspace root to this repo. Without it Next picks up a stray
  // lockfile in a parent folder and infers the wrong root for file tracing.
  outputFileTracingRoot: path.join(__dirname),
  // PDF export (D-052): load Chromium + puppeteer from node_modules at runtime instead of bundling
  // them (sharp is already on Next's built-in external list).
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // @sparticuz/chromium resolves its compressed binary (bin/*.br) at runtime, which file tracing
  // can't see — ship it explicitly with the one route that renders PDFs.
  outputFileTracingIncludes: {
    "/api/books/[id]/pdf": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  async headers() {
    return [
      { source: "/b/:path*", headers: PUBLIC_BOOK_HEADERS },
      { source: "/print/:path*", headers: PRINT_ROUTE_HEADERS },
    ];
  },
};

export default nextConfig;
