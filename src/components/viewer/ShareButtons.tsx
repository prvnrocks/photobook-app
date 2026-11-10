"use client";

// Share actions for a book link: WhatsApp, Copy link (with toast), and the native share sheet
// when the browser has one. Reused by the publish screen (T8). No analytics: nothing here logs
// or tags the slug/URL.

import { useEffect, useRef, useState } from "react";
import { Check, Link2, MessageCircle, Share2 } from "lucide-react";
import { whatsappShareUrl } from "@/lib/viewer/share";

export type ShareButtonsProps = {
  /** Absolute book URL (https://…/b/<slug>). */
  url: string;
  /** Text placed before the URL in the WhatsApp message / native share title. */
  title: string;
  /** "stack": full-width buttons (sheets, publish screen). "row": inline buttons. */
  layout?: "stack" | "row";
  className?: string;
};

async function copyText(text: string): Promise<boolean> {
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

const BTN =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors";

export function ShareButtons({ url, title, layout = "stack", className }: ShareButtonsProps) {
  const [canShare, setCanShare] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Feature-detect after mount so server and client markup match.
    const id = requestAnimationFrame(() => setCanShare(typeof navigator.share === "function"));
    return () => {
      cancelAnimationFrame(id);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = async () => {
    const ok = await copyText(url);
    setToast({ ok });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2200);
  };

  const onNativeShare = async () => {
    try {
      await navigator.share({ title, url });
    } catch {
      // User cancelled (AbortError) or share failed: nothing to do.
    }
  };

  const wrap = layout === "stack" ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2";
  const width = layout === "stack" ? "w-full" : "";

  return (
    <div className={`${wrap} ${className ?? ""}`} data-testid="share-buttons">
      <a
        href={whatsappShareUrl(title, url)}
        target="_blank"
        rel="noopener noreferrer"
        className={`${BTN} ${width} border-transparent bg-[#25D366] text-white hover:bg-[#1ebe5b]`}
        data-testid="share-whatsapp"
      >
        <MessageCircle className="size-4" aria-hidden />
        WhatsApp
      </a>
      <button
        type="button"
        onClick={onCopy}
        className={`${BTN} ${width} border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50`}
        data-testid="share-copy"
      >
        {toast?.ok ? <Check className="size-4" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
        Copy link
      </button>
      {canShare ? (
        <button
          type="button"
          onClick={onNativeShare}
          className={`${BTN} ${width} border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50`}
          data-testid="share-native"
        >
          <Share2 className="size-4" aria-hidden />
          More options
        </button>
      ) : null}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] flex justify-center">
        {toast ? (
          <span role="status" className="rounded-full bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg" data-testid="share-toast">
            {toast.ok ? "Link copied" : "Couldn't copy the link"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
