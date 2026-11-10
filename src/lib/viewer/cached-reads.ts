import "server-only";
// Per-request memoised public book reads for /b/[slug] (T10 N3). React `cache()` dedupes calls
// with the same primitive arguments within one server render, so generateMetadata and the page
// share the result instead of each querying (and signing URLs) again. Outside a React server
// render (route handlers, tests) cache() just calls through.
//
// Arguments are primitives on purpose: cache() compares arguments by identity, so an options
// object built per call would never hit.
import { cache } from "react";
import { getOgData, getViewerBook } from "@/lib/db/public-books";

/** getViewerBook(slug, { accessCookie }) memoised per request by (slug, accessCookie). */
export const getViewerBookCached = cache((slug: string, accessCookie: string | null) =>
  getViewerBook(slug, { accessCookie }),
);

/** getOgData(slug) memoised per request. */
export const getOgDataCached = cache((slug: string) => getOgData(slug));

