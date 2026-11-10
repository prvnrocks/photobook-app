// Request routing for the headless print page (D-049). Pure: no puppeteer, no env, no node:.
//
// Chromium may only talk to the app itself (print route, _next assets, self-hosted next/font
// files) and to the reserved print-asset origin, whose requests are answered in-process with the
// in-memory print copies. Everything else is aborted: no third-party fetches, no tracking, no
// Google Fonts, and no way for user content to make the renderer reach the network.

import { PRINT_ASSET_ORIGIN } from "./print-assets";

export { PRINT_ASSET_ORIGIN };

export type RequestClass =
  /** A print image: answer from the PrintImageLoader. */
  | "asset"
  /** The app itself: continue (with the Vercel protection-bypass header when configured). */
  | "same_origin"
  /** data:/blob: URLs: in-page content, no network. */
  | "passthrough"
  /** Anything else: abort. */
  | "block";

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin === "null" ? null : u.origin;
  } catch {
    return null;
  }
}

/** How the renderer handles a request for `url` from a page served by `appOrigin`. */
export function classifyRequest(url: string, appOrigin: string): RequestClass {
  if (typeof url !== "string") return "block";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === "data" || scheme === "blob") return "passthrough";
  if (scheme !== "http" && scheme !== "https") return "block";
  const origin = originOf(url);
  if (!origin) return "block";
  if (origin === PRINT_ASSET_ORIGIN) return "asset";
  const app = originOf(appOrigin);
  if (app && origin === app) return "same_origin";
  return "block";
}

const ASSET_PATH_RE = /^\/([A-Za-z0-9_-]{1,64})\.jpg$/;

/**
 * Photo id of a print-asset URL (`printAssetUrl(id)` = `${PRINT_ASSET_ORIGIN}/{id}.jpg`, any query
 * ignored), else null. Ids are matched exactly (photo uuids, dev fixture ids like "d3"); only ids
 * in the export's plan are served — the loader rejects everything else.
 */
export function assetPhotoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== PRINT_ASSET_ORIGIN) return null;
    const m = ASSET_PATH_RE.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
