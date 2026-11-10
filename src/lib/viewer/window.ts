// Photo windowing for the flipbook viewer. Pure (no React/DOM) and unit-tested.
// Flip indexes: 0 = cover, i >= 1 = doc.pages[i - 1]. With `showCover` the cover is shown alone
// and spreads are [1,2], [3,4], …; an unpaired last page is shown alone (page-flip's behaviour).
// Only pages inside the window get photo URLs; the visible page/spread gets fetch priority.

/** Pages beyond the visible page/spread (each side) that already get photo URLs. */
export const PHOTO_WINDOW_RADIUS = 2;

export interface PhotoWindow {
  /** First / last flip index (inclusive) that gets photo URLs. from > to = nothing. */
  from: number;
  to: number;
  /** Visible flip indexes (1 on phones, up to 2 in a spread): eager + high fetch priority. */
  priority: readonly number[];
}

function clampIndex(i: number, count: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.min(Math.max(Math.trunc(i), 0), count - 1);
}

/** Flip indexes visible when page-flip's current index is `current`. */
export function visiblePages(current: number, count: number, spread: boolean): number[] {
  if (count <= 0) return [];
  const c = clampIndex(current, count);
  if (!spread || c === 0) return [c];
  const left = c % 2 === 1 ? c : c - 1;
  return left + 1 < count ? [left, left + 1] : [left];
}

export function photoWindow(opts: {
  current: number;
  count: number;
  spread: boolean;
  radius?: number;
}): PhotoWindow {
  const { current, count, spread, radius = PHOTO_WINDOW_RADIUS } = opts;
  const priority = visiblePages(current, count, spread);
  if (priority.length === 0) return { from: 0, to: -1, priority };
  const r = Math.max(0, Math.trunc(radius));
  return {
    from: Math.max(0, priority[0] - r),
    to: Math.min(count - 1, priority[priority.length - 1] + r),
    priority,
  };
}

export function inPhotoWindow(w: PhotoWindow, index: number): boolean {
  return index >= w.from && index <= w.to;
}

/** First flip index of the page/spread that contains `index` (what page-flip reports as current). */
export function spreadStart(index: number, count: number, spread: boolean): number {
  return visiblePages(index, count, spread)[0] ?? 0;
}
