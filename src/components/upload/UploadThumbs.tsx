"use client";
// Last three uploaded photos on the wizard upload card (M19 T6, D-071; wizard.png). The pictures are
// object URLs of the picked files (nothing is fetched); each URL lives only while its thumbnail is
// shown and all are revoked on unmount (src/lib/upload/thumb-strip.ts). Decorative: the count line
// above carries the meaning, so the strip is hidden from screen readers.
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueEvent } from "@/lib/upload/queue";
import { createThumbStrip, THUMB_STRIP_MAX, type ThumbStrip, type ThumbStripItem } from "@/lib/upload/thumb-strip";

export type ThumbStripControl = {
  items: readonly ThumbStripItem[];
  /** Call right after queue.add(files); `firstKey` = files already added to this queue before. */
  track: (firstKey: number, files: readonly File[]) => void;
  /** Feed every queue event (only photo events matter). */
  onQueueEvent: (e: QueueEvent) => void;
  /** Queue replaced (keys restart at 0): revoke and forget everything. */
  reset: () => void;
};

/** `enabled` false → a no-op control (the classic upload screen shows no strip). */
export function useThumbStrip(enabled: boolean): ThumbStripControl {
  const [items, setItems] = useState<readonly ThumbStripItem[]>([]);
  const stripRef = useRef<ThumbStrip | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true; // StrictMode re-mounts
    return () => {
      mountedRef.current = false;
      stripRef.current?.dispose();
      stripRef.current = null;
    };
  }, []);

  const strip = useCallback((): ThumbStrip => {
    stripRef.current ??= createThumbStrip({
      createUrl: (f) => URL.createObjectURL(f),
      revokeUrl: (u) => URL.revokeObjectURL(u),
    });
    return stripRef.current;
  }, []);

  const track = useCallback(
    (firstKey: number, files: readonly File[]) => {
      if (enabled && mountedRef.current) strip().track(firstKey, files);
    },
    [enabled, strip],
  );

  const onQueueEvent = useCallback(
    (e: QueueEvent) => {
      if (!enabled || e.type !== "photo" || !mountedRef.current || !stripRef.current) return;
      if (e.status === "uploaded") setItems(stripRef.current.uploaded(e.key));
      else stripRef.current.settled(e.key);
    },
    [enabled],
  );

  const reset = useCallback(() => {
    stripRef.current?.dispose();
    setItems([]);
  }, []);

  return { items, track, onQueueEvent, reset };
}

export function UploadThumbs({ items }: { items: readonly ThumbStripItem[] }) {
  return (
    <ul aria-hidden="true" className="grid grid-cols-3 gap-2 sm:gap-3" data-testid="upload-thumbs" data-count={items.length}>
      {Array.from({ length: THUMB_STRIP_MAX }, (_, i) => {
        const item = items[i];
        return (
          <li key={item ? `k${item.key}` : `empty${i}`} className="aspect-[4/3] overflow-hidden rounded-lg bg-muted shadow-card">
            {item ? (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL, not optimisable
              <img src={item.url} alt="" decoding="async" className="size-full object-cover" data-testid="upload-thumb" />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
