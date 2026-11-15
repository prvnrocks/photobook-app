// Recent-upload thumbnail strip for the wizard upload card (M19 T6, D-071). Pure (no React, no DOM
// globals: object-URL functions are injected), so the revoke rules are unit-tested in node.
//
// Rules:
//   - A picked file is remembered by its queue key (0-based position across add() calls) until the
//     queue reports it settled; only "uploaded" files become thumbnails.
//   - At most `max` thumbnails (newest last). An object URL exists only while its thumbnail is shown:
//     the oldest is revoked the moment it falls out of the strip, all are revoked on dispose().
//   - Files that failed / were skipped are forgotten without ever getting a URL.

export type ThumbStripItem = { key: number; url: string };

export type ThumbStripDeps = {
  createUrl: (file: Blob) => string;
  revokeUrl: (url: string) => void;
  /** Thumbnails kept on screen (default 12: the M20 upload stage animates at most 12, D-072). */
  max?: number;
};

export type ThumbStrip = {
  /** Remember files just handed to queue.add(); `firstKey` = the key of files[0]. */
  track(firstKey: number, files: readonly Blob[]): void;
  /** The queue reported this key uploaded → it becomes the newest thumbnail. Returns the new list. */
  uploaded(key: number): readonly ThumbStripItem[];
  /** The queue reported this key failed / skipped → forget the file (no URL was made). */
  settled(key: number): void;
  items(): readonly ThumbStripItem[];
  /** Revoke every URL and forget every file (unmount / queue replaced). */
  dispose(): void;
};

export const THUMB_STRIP_MAX = 12;

export function createThumbStrip({ createUrl, revokeUrl, max = THUMB_STRIP_MAX }: ThumbStripDeps): ThumbStrip {
  const files = new Map<number, Blob>();
  let shown: ThumbStripItem[] = [];

  return {
    track(firstKey, list) {
      list.forEach((f, i) => files.set(firstKey + i, f));
    },
    uploaded(key) {
      const file = files.get(key);
      files.delete(key);
      if (!file || shown.some((t) => t.key === key)) return shown;
      const next = [...shown, { key, url: createUrl(file) }];
      const evicted = next.length > max ? next.slice(0, next.length - max) : [];
      for (const t of evicted) revokeUrl(t.url);
      shown = next.slice(next.length - Math.min(max, next.length));
      return shown;
    },
    settled(key) {
      files.delete(key);
    },
    items() {
      return shown;
    },
    dispose() {
      for (const t of shown) revokeUrl(t.url);
      shown = [];
      files.clear();
    },
  };
}
