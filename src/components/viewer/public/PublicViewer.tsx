"use client";

// Client wrapper for the published book: ViewerShell + recovery from expired signed image URLs.
// Signed URLs live 6 h; a reader who keeps the tab open longer sees broken photos. On the first
// failing book photo we ask the server for fresh URLs with ONE router.refresh(), guarded by a
// per-slug cooldown (claimImageRefresh) so a genuinely broken image can't loop. The page nodes
// are moved around by the flip engine, so errors are caught with a capturing document listener
// (error events don't bubble) plus a scan for images that failed before the listener existed.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import type { RenderPhotos } from "@/components/book/BookPage";
import { ViewerShell, type ViewerShellProps } from "@/components/viewer/ViewerShell";
import { track } from "@/lib/analytics/client";
import { claimImageRefresh, isBookPhotoSrc, type RefreshStore } from "@/lib/viewer/image-refresh";

export type PublicViewerProps = ViewerShellProps & {
  slug: string;
  /** Signed-in owner viewing their own book (analytics only; false when analytics is off). */
  isOwner?: boolean;
};

function sessionStore(): RefreshStore | null {
  try {
    const s = window.sessionStorage;
    return { get: (k) => s.getItem(k), set: (k, v) => s.setItem(k, v) };
  } catch {
    return null;
  }
}

function photoUrls(photos: RenderPhotos): Set<string> {
  const out = new Set<string>();
  for (const p of Object.values(photos)) if (p?.url) out.add(p.url);
  return out;
}

export function PublicViewer({ slug, isOwner = false, ...shell }: PublicViewerProps) {
  const router = useRouter();

  // analytics (M9 T14): once per page load; flags + page count only (never the slug or title).
  const openedRef = useRef(false);
  const pageCount = shell.doc.pages.length;
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    track("viewer_opened", { is_paid: shell.isPaid, pages: pageCount, is_owner: isOwner });
  }, [shell.isPaid, pageCount, isOwner]);
  const memory = useRef<{ last: number | null }>({ last: null });
  const urls = useMemo(() => photoUrls(shell.photos), [shell.photos]);

  useEffect(() => {
    const failed = (img: HTMLImageElement) => {
      const src = img.currentSrc || img.src;
      if (!isBookPhotoSrc(src, urls)) return;
      if (claimImageRefresh(slug, Date.now(), sessionStore(), memory.current)) router.refresh();
    };
    const onError = (e: Event) => {
      if (e.target instanceof HTMLImageElement) failed(e.target);
    };
    document.addEventListener("error", onError, true);
    for (const img of Array.from(document.images)) {
      if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)) failed(img);
    }
    return () => document.removeEventListener("error", onError, true);
  }, [router, slug, urls]);

  return <ViewerShell {...shell} />;
}
