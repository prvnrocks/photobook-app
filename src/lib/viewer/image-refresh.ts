// Signed viewer image URLs expire after 6 h (VIEWER_URL_TTL_SECONDS). When a book photo fails to
// load, the public viewer asks the server for fresh URLs with ONE router.refresh(). This guard
// keeps that from looping when an image is genuinely broken: at most one refresh per window per
// slug, remembered in sessionStorage (survives the refresh) with an in-memory fallback.

/** Minimum time between two automatic refreshes of the same book. */
export const IMAGE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

export function imageRefreshKey(slug: string): string {
  return `pb_img_refresh:${slug}`;
}

export type RefreshStore = { get(key: string): string | null; set(key: string, value: string): void };

/**
 * True when a refresh may run now (and records it). `memory` holds the last refresh time for
 * environments where sessionStorage throws (Safari private mode, blocked storage).
 */
export function claimImageRefresh(
  slug: string,
  now: number,
  store: RefreshStore | null,
  memory: { last: number | null },
): boolean {
  const key = imageRefreshKey(slug);
  let last = memory.last;
  if (store) {
    try {
      const raw = Number(store.get(key));
      if (Number.isFinite(raw) && raw > 0) last = Math.max(last ?? 0, raw);
    } catch {
      // storage unavailable — memory only
    }
  }
  if (last !== null && now - last >= 0 && now - last < IMAGE_REFRESH_COOLDOWN_MS) return false;
  memory.last = now;
  if (store) {
    try {
      store.set(key, String(now));
    } catch {
      // ignore
    }
  }
  return true;
}

/** True when `src` is one of the book's signed photo URLs (ignore unrelated broken images). */
export function isBookPhotoSrc(src: string, urls: ReadonlySet<string>): boolean {
  if (!src) return false;
  if (urls.has(src)) return true;
  try {
    // currentSrc is absolute and may be re-encoded; compare normalised forms too.
    const norm = new URL(src).href;
    for (const u of urls) if (new URL(u).href === norm) return true;
  } catch {
    // not a URL
  }
  return false;
}
