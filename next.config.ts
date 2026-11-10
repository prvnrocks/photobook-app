import path from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

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

/**
 * Headers for our own design assets under public/design (M10a textures; later stickers/fonts).
 * File names are NOT content-hashed, so no `immutable`: a day fresh, then a week of
 * stale-while-revalidate. Regenerated files keep their names — after changing one, rename it
 * (or accept up to ~1 day of stale caches).
 */
export const DESIGN_ASSET_HEADERS = [
  { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
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
      { source: "/design/:path*", headers: DESIGN_ASSET_HEADERS },
    ];
  },
};

// --- Sentry (M9 T13, D-058) ------------------------------------------------------------------
// Always wrapped so dev/CI/prod builds behave the same; without SENTRY_AUTH_TOKEN nothing is
// uploaded (and the runtime SDK is a no-op without a DSN). With the token, source maps are
// generated hidden, uploaded to Sentry EU and deleted from the build output.
// Build-time auto-instrumentation is off: route handlers (incl. the raw-body Stripe webhook),
// middleware and app-dir components stay unwrapped; server errors come from onRequestError in
// src/instrumentation.ts. Tracing/Replay/debug code is tree-shaken out (no performance data).
export const SENTRY_BUILD_OPTIONS: Parameters<typeof withSentryConfig>[1] = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sentryUrl: "https://de.sentry.io/",
  silent: !process.env.CI,
  telemetry: false,
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN, deleteSourcemapsAfterUpload: true },
  webpack: {
    autoInstrumentServerFunctions: false,
    autoInstrumentMiddleware: false,
    autoInstrumentAppDirectory: false,
  },
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeTracing: true,
    excludeReplayIframe: true,
    excludeReplayShadowDom: true,
    excludeReplayWorker: true,
  },
  // tunnelRoute deliberately unset: it would add a public route that proxies to Sentry.
};

export default withSentryConfig(nextConfig, SENTRY_BUILD_OPTIONS);
// --- end Sentry ----------------------------------------------------------------------------
