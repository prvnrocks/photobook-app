// Editor photo URLs (M5 Task 8): signed URLs expire (EDITOR_URL_TTL_SECONDS); when an <img>
// fails, its photo id is reported here, ids are batched (debounced) into one
// POST /api/books/[id]/photo-urls, and the fresh URLs are merged by id.
// Pure part (no React / DOM): injected timers + fetcher, unit-testable in node.
// M12 T5: a 503 (server busy, Retry-After) is not a failed refresh — the ids are queued again
// for after the wait without using up a refresh, and the old URLs stay in place meanwhile.

export const REFRESH_DEBOUNCE_MS = 300;
/** A photo is refreshed at most this many times per editor session (stops 404/broken loops). */
export const MAX_REFRESHES_PER_PHOTO = 2;
/** Matches MAX_PHOTO_URL_IDS of the route. */
export const MAX_IDS_PER_REQUEST = 500;

export interface FreshPhotoUrls {
  id: string;
  webUrl: string | null;
  thumbUrl: string | null;
}

/** The route answered 503 (Supabase timeout): ask again after `retryAfterMs`. */
export interface PhotoUrlsRetryLater {
  retryAfterMs: number;
}

export type PhotoUrlsResult = FreshPhotoUrls[] | PhotoUrlsRetryLater | null;

export type FetchPhotoUrls = (ids: string[]) => Promise<PhotoUrlsResult>;

/** Consecutive "retry later" answers before the refresher stops re-queuing (until the next report). */
export const MAX_RETRY_LATER = 5;
export const DEFAULT_RETRY_LATER_MS = 3_000;
const MIN_RETRY_LATER_MS = 1_000;
const MAX_RETRY_LATER_MS = 60_000;

export function isRetryLater(r: PhotoUrlsResult): r is PhotoUrlsRetryLater {
  return !!r && !Array.isArray(r) && typeof r.retryAfterMs === "number";
}

export interface RefresherTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: RefresherTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class PhotoUrlRefresher {
  private queued = new Set<string>();
  private attempts = new Map<string, number>();
  private timer: unknown = null;
  /** Ids waiting out a 503 (already counted in `attempts`). */
  private deferred = new Set<string>();
  private retryTimer: unknown = null;
  private retryLater = 0;
  private disposed = false;
  private readonly fetchUrls: FetchPhotoUrls;
  private readonly onFresh: (photos: FreshPhotoUrls[]) => void;
  private readonly timers: RefresherTimers;
  private readonly debounceMs: number;

  constructor(
    fetchUrls: FetchPhotoUrls,
    onFresh: (photos: FreshPhotoUrls[]) => void,
    timers: RefresherTimers = defaultTimers,
    debounceMs = REFRESH_DEBOUNCE_MS,
  ) {
    this.fetchUrls = fetchUrls;
    this.onFresh = onFresh;
    this.timers = timers;
    this.debounceMs = debounceMs;
  }

  /** An image of this photo failed to load. Returns false when the photo is out of refreshes. */
  report(id: string): boolean {
    if (this.disposed) return false;
    if (this.queued.has(id) || this.deferred.has(id)) return true;
    const n = this.attempts.get(id) ?? 0;
    if (n >= MAX_REFRESHES_PER_PHOTO) return false;
    this.attempts.set(id, n + 1);
    this.queued.add(id);
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => void this.run(), this.debounceMs);
    return true;
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    if (this.retryTimer !== null) this.timers.clear(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  private scheduleRetry(ids: string[], waitMs: number) {
    for (const id of ids) this.deferred.add(id);
    if (this.retryTimer !== null) return; // one pending retry carries every deferred id
    const ms = Math.min(MAX_RETRY_LATER_MS, Math.max(MIN_RETRY_LATER_MS, waitMs));
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null;
      if (this.disposed) return;
      for (const id of this.deferred) this.queued.add(id);
      this.deferred.clear();
      if (this.timer !== null) this.timers.clear(this.timer);
      this.timer = this.timers.set(() => void this.run(), this.debounceMs);
    }, ms);
  }

  private async run() {
    this.timer = null;
    const ids = [...this.queued].slice(0, MAX_IDS_PER_REQUEST);
    for (const id of ids) this.queued.delete(id);
    if (ids.length === 0) return;
    if (this.queued.size > 0) this.timer = this.timers.set(() => void this.run(), this.debounceMs);
    let fresh: PhotoUrlsResult = null;
    try {
      fresh = await this.fetchUrls(ids);
    } catch {
      fresh = null;
    }
    if (this.disposed) return;
    if (isRetryLater(fresh)) {
      this.retryLater++;
      if (this.retryLater <= MAX_RETRY_LATER) this.scheduleRetry(ids, fresh.retryAfterMs);
      return;
    }
    this.retryLater = 0;
    if (!fresh || fresh.length === 0) return;
    this.onFresh(fresh);
  }
}

/** Merge fresh URLs into a list of photos by id (unknown ids ignored; null URLs keep the old one). */
export function mergePhotoUrls<T extends FreshPhotoUrls>(photos: T[], fresh: FreshPhotoUrls[]): T[] {
  if (fresh.length === 0) return photos;
  const byId = new Map(fresh.map((f) => [f.id, f]));
  let changed = false;
  const out = photos.map((p) => {
    const f = byId.get(p.id);
    if (!f) return p;
    const webUrl = f.webUrl ?? p.webUrl;
    const thumbUrl = f.thumbUrl ?? p.thumbUrl;
    if (webUrl === p.webUrl && thumbUrl === p.thumbUrl) return p;
    changed = true;
    return { ...p, webUrl, thumbUrl };
  });
  return changed ? out : photos;
}
