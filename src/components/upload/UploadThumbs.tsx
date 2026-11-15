"use client";
// Recently uploaded photos on the wizard upload stage (M19 T6, D-071; M20 T5: up to 12 on the book). The pictures are
// object URLs of the picked files (nothing is fetched); each URL lives only while its thumbnail is
// shown and all are revoked on unmount (src/lib/upload/thumb-strip.ts). Decorative: the count line
// above carries the meaning, so the strip is hidden from screen readers.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { QueueEvent } from "@/lib/upload/queue";
import { createThumbStrip, type ThumbStrip, type ThumbStripItem } from "@/lib/upload/thumb-strip";
import { assignSlots, STAGE_MAX_THUMBS, THUMB_H, THUMB_SLOTS, THUMB_W } from "./upload-stage-model";

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

/**
 * The landed photos on the upload stage's open book (M20 T5): at most STAGE_MAX_THUMBS, each in a
 * stable slot (upload-stage-model) so nothing jumps when the oldest leaves; the newest reuses its slot.
 * Positioned over the whole stage box by <UploadStage>; motion (fly-in, sparkle) in upload-motion.css.
 */
export function UploadThumbs({ items }: { items: readonly ThumbStripItem[] }) {
  const shown = items.slice(-STAGE_MAX_THUMBS);
  const [state, setState] = useState(() => ({ items, slots: assignSlots(new Map(), shown.map((t) => t.key)) }));
  let slots = state.slots;
  if (state.items !== items) {
    slots = assignSlots(state.slots, shown.map((t) => t.key));
    setState({ items, slots });
  }
  return (
    <ul aria-hidden="true" className="up-thumbs pointer-events-none absolute inset-0" data-testid="upload-thumbs" data-count={shown.length}>
      {shown.map((item) => {
        const slot = THUMB_SLOTS[slots.get(item.key) ?? 0];
        const style = {
          left: `${slot.left}%`,
          top: `${slot.top}%`,
          width: `${THUMB_W}%`,
          height: `${THUMB_H}%`,
          "--r": `${slot.rot}deg`,
          "--fx": `${slot.fx}%`,
          "--fy": `${slot.fy}%`,
        } as CSSProperties;
        return (
          <li key={`k${item.key}`} className="up-thumb absolute" style={style}>
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not optimisable */}
            <img src={item.url} alt="" decoding="async" className="up-thumb-img" data-testid="upload-thumb" />
          </li>
        );
      })}
    </ul>
  );
}
