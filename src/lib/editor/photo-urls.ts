// Editor photo URLs (M5 Task 8): signed URLs expire (EDITOR_URL_TTL_SECONDS); when an <img>
// fails, its photo id is reported here, ids are batched (debounced) into one
// POST /api/books/[id]/photo-urls, and the fresh URLs are merged by id.
// Pure part (no React / DOM): injected timers + fetcher, unit-testable in node.

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

export type FetchPhotoUrls = (ids: string[]) => Promise<FreshPhotoUrls[] | null>;

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
    if (this.queued.has(id)) return true;
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
    this.timer = null;
  }

  private async run() {
    this.timer = null;
    const ids = [...this.queued].slice(0, MAX_IDS_PER_REQUEST);
    for (const id of ids) this.queued.delete(id);
    if (ids.length === 0) return;
    if (this.queued.size > 0) this.timer = this.timers.set(() => void this.run(), this.debounceMs);
    let fresh: FreshPhotoUrls[] | null = null;
    try {
      fresh = await this.fetchUrls(ids);
    } catch {
      fresh = null;
    }
    if (this.disposed || !fresh || fresh.length === 0) return;
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
