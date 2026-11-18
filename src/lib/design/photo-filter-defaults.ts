// Default looks for a freshly built album (D-089): which photos get one, and which. Server side
// (album builders) + tests; split from photo-filters.ts to keep it out of the client bundles.

import type { PhotoFilterId } from "./photo-filters";

/**
 * Looks a new album may get by default: the gentle, flattering ones (no strong tints; black & white
 * only as the occasional accent).
 */
export const DEFAULT_FILTER_POOL: readonly PhotoFilterId[] = ["vivid", "glow", "golden", "champagne", "soft", "film", "velvet", "mono"];
/** Share of an album's photos that get a default look (the rest stay as shot). */
export const DEFAULT_FILTER_SHARE = 0.35;

/** FNV-1a, 32 bit: stable across runs and machines (a rebuild gives the same looks). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * "Random" default looks for `photoIds`: decided by a hash of each photo id, so the same photos
 * always get the same looks (stable rebuilds, testable) while the spread across an album looks
 * random. About DEFAULT_FILTER_SHARE of the photos get one of DEFAULT_FILTER_POOL.
 */
export function defaultPhotoFilters(photoIds: Iterable<string>): Record<string, PhotoFilterId> {
  const out: Record<string, PhotoFilterId> = {};
  for (const id of photoIds) {
    const h = hash(id);
    if ((h % 1000) / 1000 >= DEFAULT_FILTER_SHARE) continue;
    out[id] = DEFAULT_FILTER_POOL[hash(`look:${id}`) % DEFAULT_FILTER_POOL.length];
  }
  return out;
}
