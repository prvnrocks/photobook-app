"use client";

// Share actions for a book link: "Send on WhatsApp" (the call to action), Copy link (with toast)
// and the native share sheet when the browser has one, as secondary actions. Reused by the publish
// screen (T8, M11 T15) and the viewer's share sheet. No analytics: nothing here logs or tags the
// slug/URL.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Link2, MessageCircle, Share2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { whatsappShareUrl } from "@/lib/viewer/share";

export type ShareButtonsProps = {
  /** Absolute book URL (https://…/b/<slug>). */
  url: string;
  /** Text placed before the URL in the WhatsApp message / native share title. */
  title: string;
  /** "stack": full-width buttons (sheets, publish screen). "row": inline buttons. */
  layout?: "stack" | "row";
  /** Extra secondary actions placed next to Copy link (publish screen: "Open book"). */
  secondary?: ReactNode;
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

/** Class for a secondary share action passed via `secondary` (same look as Copy link). */
export const SHARE_SECONDARY_CLASS = cn(buttonVariants({ variant: "outline", size: "touch" }), "min-w-[9rem] flex-1 basis-0 bg-card");

export function ShareButtons({ url, title, layout = "stack", secondary, className }: ShareButtonsProps) {
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

  const stack = layout === "stack";
  // Secondary actions share a row on a phone (two per line, wrapping) and never overflow 375 px.
  const second = stack ? SHARE_SECONDARY_CLASS : cn(buttonVariants({ variant: "outline", size: "touch" }), "bg-card");

  return (
    <div className={cn(stack ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2", className)} data-testid="share-buttons">
      <a
        href={whatsappShareUrl(title, url)}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonVariants({ variant: "accent", size: stack ? "cta" : "touch" }))}
        data-testid="share-whatsapp"
      >
        <MessageCircle className="size-5" aria-hidden />
        Send on WhatsApp
      </a>
      <div className={cn("flex flex-wrap gap-2", !stack && "contents")}>
        <button type="button" onClick={onCopy} className={second} data-testid="share-copy">
          {toast?.ok ? <Check className="size-4 text-success" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
          Copy link
        </button>
        {secondary}
        {canShare ? (
          <button type="button" onClick={onNativeShare} className={second} data-testid="share-native">
            <Share2 className="size-4" aria-hidden />
            More options
          </button>
        ) : null}
      </div>
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] flex justify-center px-gutter">
        {toast ? (
          <span role="status" className="type-small rounded-xl bg-primary px-4 py-2.5 text-primary-foreground shadow-lift" data-testid="share-toast">
            {toast.ok ? "Link copied" : "Couldn't copy the link"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
