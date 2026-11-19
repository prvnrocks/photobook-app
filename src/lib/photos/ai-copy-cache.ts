// Tick-scoped memory of validated AI copies (512 px, metadata-free JPEG as base64), keyed by thumb
// path. A storybook tick that analyses photos and then scores their quality reads the SAME copies
// twice (loadThumbBase64 → prepareAiCopy, seconds apart); with this the second stage reuses the
// bytes the first one just read instead of downloading them again. It lives only as long as one
// tick (never shared between users, requests or ticks), is bounded in bytes, and is never logged.

export type AiCopyCache = {
  get(thumbPath: string): string | undefined;
  /** Ignored once the byte bound is reached (the stage then simply downloads as before). */
  set(thumbPath: string, base64: string): void;
};

/** 32 MB of base64 ≈ 400 typical copies (~60 KB) — more than one tick analyses. */
export const AI_COPY_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export function newAiCopyCache(maxBytes: number = AI_COPY_CACHE_MAX_BYTES): AiCopyCache {
  const m = new Map<string, string>();
  let bytes = 0;
  return {
    get: (path) => m.get(path),
    set(path, base64) {
      if (m.has(path) || bytes + base64.length > maxBytes) return;
      m.set(path, base64);
      bytes += base64.length;
    },
  };
}
