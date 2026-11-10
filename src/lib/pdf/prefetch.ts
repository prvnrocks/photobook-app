// Print image prefetch (M8 render headroom). Pure helpers + a small controller over a
// PrintImageLoader-like object, so the scheduling is unit-testable without sharp or Chromium.
//
// runExport builds the plan, then starts producing print images for the first
// PREFETCH_WINDOW_CHUNKS chunks while Chromium launches; Chromium's image requests then mostly hit
// ready (or in-flight) promises. When a chunk has rendered, the photos whose LAST use is that chunk
// are released (their buffers become garbage once Chromium has them) and the next chunk's photos
// are queued. Memory bound: at most the photos of PREFETCH_WINDOW_CHUNKS chunks (≤ 2 × 20 sheets)
// are held at once, plus photos shared with later chunks. With parallel chunks (not used, see
// RENDER_PARALLEL_CHUNKS) a photo released by a later chunk that an earlier, still-rendering chunk
// has not requested yet is simply reloaded.

import { availableParallelism } from "node:os";
import type { SheetRange } from "./rules";
import { printPhotoIds, printSheetTargets } from "./print-doc";

/** Chunks whose photos may be produced/held at once: the one rendering + the next. */
export const PREFETCH_WINDOW_CHUNKS = 2;
/**
 * Print copies in flight at once (download → encode). Downloads from Storage dominate (live
 * 40-page book, local: ~0.55 s per ~1 MB original warm, ~1.8 s cold, vs ~0.1 s encode), so this
 * is an I/O limit, not a CPU one. Measured first-window images-ready: 2 → 13.2 s, 6 → 4.4–5.1 s,
 * 8 → 3.5–4.3 s, 12 → 2.6 s. Memory: each in-flight photo holds its downloaded original until
 * encoded — phone JPEGs are typically 2–6 MB (≤ 72 MB for 12), the upload cap 20 MB (≤ 240 MB).
 */
export const PRINT_IMAGE_IN_FLIGHT = 12;
/** Bounds for parallel sharp encodes (CPU): one per vCPU, 2..4. */
export const PRINT_ENCODE_CONCURRENCY_MIN = 2;
export const PRINT_ENCODE_CONCURRENCY_MAX = 4;

/**
 * Parallel sharp encodes for this machine (nested inside the in-flight limit). Vercel functions
 * have 1–2 vCPUs (Standard) up to 4 (Performance); libvips also threads within one image, so
 * more encodes than vCPUs only adds memory. Floor 2 keeps one encode running while another
 * finishes its last write.
 */
export function printEncodeConcurrency(cpus: number = safeParallelism()): number {
  const n = Number.isFinite(cpus) ? Math.floor(cpus) : 0;
  return Math.min(PRINT_ENCODE_CONCURRENCY_MAX, Math.max(PRINT_ENCODE_CONCURRENCY_MIN, n));
}

function safeParallelism(): number {
  try {
    return availableParallelism();
  } catch {
    return PRINT_ENCODE_CONCURRENCY_MIN;
  }
}

/** Counting semaphore; a released slot goes straight to the next waiter (FIFO). */
export function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (active < max) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export interface ChunkPhotoSchedule {
  /** Photo ids each chunk shows (deduplicated, sheet order), limited to planned photos. */
  uses: string[][];
  /** Photo ids whose last use is chunk k: safe to release once chunk k has rendered. */
  releaseAfter: string[][];
}

type ScheduleDoc = Parameters<typeof printPhotoIds>[0];

/** Which planned photos each chunk needs and when each can be released. */
export function chunkPhotoSchedule(
  doc: ScheduleDoc,
  ranges: readonly SheetRange[],
  planned: (photoId: string) => boolean = () => true,
): ChunkPhotoSchedule {
  const uses = ranges.map(({ from, to }) => {
    const targets = printSheetTargets(doc.pages.length, from, to) ?? [];
    return printPhotoIds(doc, targets).filter(planned);
  });
  const last = new Map<string, number>();
  uses.forEach((ids, k) => ids.forEach((id) => last.set(id, k)));
  // In each chunk's sheet order.
  const releaseAfter = uses.map((ids, k) => ids.filter((id) => last.get(id) === k));
  return { uses, releaseAfter };
}

export interface PrefetchTarget {
  prefetch(photoIds: Iterable<string>): void;
  release(photoIds: Iterable<string>): void;
}

export interface PrefetchController {
  /** Call when chunk k has rendered (any order): releases its last-use photos, queues the next chunk. */
  chunkDone(k: number): void;
}

/**
 * Queues the photos of the first `window` chunks now (chunk order = loader queue order), and one
 * more chunk per finished chunk. Idempotent per chunk.
 */
export function startPrefetch(
  target: PrefetchTarget,
  schedule: ChunkPhotoSchedule,
  window: number = PREFETCH_WINDOW_CHUNKS,
): PrefetchController {
  const total = schedule.uses.length;
  const w = Number.isFinite(window) ? Math.max(1, Math.floor(window)) : PREFETCH_WINDOW_CHUNKS;
  let next = 0;
  const queued = () => {
    target.prefetch(schedule.uses[next] ?? []);
    next++;
  };
  while (next < Math.min(w, total)) queued();
  const done = new Set<number>();
  return {
    chunkDone(k: number) {
      if (!Number.isSafeInteger(k) || k < 0 || k >= total || done.has(k)) return;
      done.add(k);
      target.release(schedule.releaseAfter[k] ?? []);
      if (next < total) queued();
    },
  };
}
