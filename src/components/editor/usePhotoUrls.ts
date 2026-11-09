"use client";

// Editor photos with self-healing signed URLs: report a broken photo id → batched
// POST /api/books/[id]/photo-urls → URLs merged by id → <BookPage> re-renders with the new src.
// Also builds the RenderPhotos maps <BookPage> needs (web for the big page, thumb for strips).

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RenderPhotos } from "@/lib/book/render";
import { mergePhotoUrls, PhotoUrlRefresher } from "@/lib/editor/photo-urls";
import type { EditorTransport } from "@/lib/editor/transport";
import type { EditorShellPhoto } from "@/lib/editor/types";

export interface EditorPhotos {
  photos: EditorShellPhoto[];
  byId: ReadonlyMap<string, EditorShellPhoto>;
  /** photoId → web URL (big page). */
  web: RenderPhotos;
  /** photoId → thumb URL, falling back to web (strip thumbnails). */
  thumbs: RenderPhotos;
  /** Signed URL (web or thumb) → photo id, to map a failed <img> back to its photo. */
  idForUrl(url: string): string | undefined;
  reportBroken(id: string): void;
}

export function usePhotoUrls(initial: EditorShellPhoto[], transport: EditorTransport): EditorPhotos {
  const [photos, setPhotos] = useState(initial);
  const [refresher] = useState(
    () => new PhotoUrlRefresher((ids) => transport.photoUrls(ids), (fresh) => setPhotos((p) => mergePhotoUrls(p, fresh))),
  );
  useEffect(() => () => refresher.dispose(), [refresher]);

  return useMemo(() => {
    const byId = new Map(photos.map((p) => [p.id, p]));
    const web: Record<string, { url: string; width: number | null; height: number | null }> = {};
    const thumbs: typeof web = {};
    const urlToId = new Map<string, string>();
    for (const p of photos) {
      if (p.webUrl) {
        web[p.id] = { url: p.webUrl, width: p.width, height: p.height };
        urlToId.set(p.webUrl, p.id);
      }
      const t = p.thumbUrl ?? p.webUrl;
      if (t) {
        thumbs[p.id] = { url: t, width: p.width, height: p.height };
        urlToId.set(t, p.id);
      }
    }
    return {
      photos,
      byId,
      web,
      thumbs,
      idForUrl: (url: string) => urlToId.get(url),
      reportBroken: (id: string) => void refresher.report(id),
    };
  }, [photos, refresher]);
}

/**
 * Watches every <img> under `root` for load errors (capture phase — `error` doesn't bubble) and
 * reports the photo. Also catches images that failed before hydration (`complete && naturalWidth
 * === 0`, lessons 2026-11-09), re-checked whenever the photo URLs change.
 */
export function useBrokenImageWatcher(root: React.RefObject<HTMLElement | null>, photos: EditorPhotos) {
  const { idForUrl, reportBroken } = photos;
  const report = useCallback(
    (img: HTMLImageElement) => {
      const src = img.getAttribute("src");
      const id = src ? idForUrl(src) : undefined;
      if (id) reportBroken(id);
    },
    [idForUrl, reportBroken],
  );

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onError = (e: Event) => {
      if (e.target instanceof HTMLImageElement) report(e.target);
    };
    el.addEventListener("error", onError, true);
    for (const img of Array.from(el.querySelectorAll("img"))) {
      if (img.complete && img.naturalWidth === 0 && img.getAttribute("src")) report(img);
    }
    return () => el.removeEventListener("error", onError, true);
  }, [root, report]);
}
