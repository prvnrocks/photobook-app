// Share primitives shared by the viewer's ShareButtons and the share page's ShareLinkCard (M21 T3):
// clipboard copy with the legacy fallback, timed copy feedback, and native share-sheet detection.
// Client-only hooks (callers are "use client" components). No analytics: nothing here logs or tags
// the slug/URL. Import-light on purpose — this ships on the public viewer.

import { useCallback, useEffect, useRef, useState } from "react";

/** Copies `text`; navigator.clipboard first, then the execCommand textarea fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied / insecure context: try the legacy path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "fixed -left-[9999px] top-0 opacity-0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** How long copy feedback ("Link copied" / the copied ring) stays up. */
export const COPY_FEEDBACK_MS = 2200;

/** Copy + feedback state: `copied` is { ok } for COPY_FEEDBACK_MS after a tap, else null. */
export function useCopyFeedback(text: string, ms: number = COPY_FEEDBACK_MS) {
  const [copied, setCopied] = useState<{ ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    const ok = await copyText(text);
    setCopied({ ok });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), ms);
  }, [text, ms]);
  return { copied, copy };
}

/** navigator.share exists — detected after mount so server and client markup match. */
export function useCanNativeShare(): boolean {
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setCanShare(typeof navigator.share === "function"));
    return () => cancelAnimationFrame(id);
  }, []);
  return canShare;
}

/** Opens the native share sheet; a cancel (AbortError) or failure is silently ignored. */
export async function nativeShare(title: string, url: string): Promise<void> {
  try {
    await navigator.share({ title, url });
  } catch {
    // User cancelled (AbortError) or share failed: nothing to do.
  }
}
