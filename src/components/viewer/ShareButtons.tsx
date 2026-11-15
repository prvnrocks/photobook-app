"use client";

// Share actions for a book link: "Send on WhatsApp" (the call to action), Copy link (with toast)
// and the native share sheet when the browser has one, as secondary actions. Reused by the publish
// screen (T8, M11 T15) and the viewer's share sheet. No analytics: nothing here logs or tags the
// slug/URL. This file ships on the public viewer, so it must not import ui/button or cn (~14 kB gzip).
// M23 T3: classes come from viewer-classes (plain strings, joined with cx) — WhatsApp is the green
// pill, Copy link and More options are emerald outline pills. No gold here.

import type { ReactNode } from "react";
import { Check, Link2, MessageCircle, Share2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { whatsappShareUrl } from "@/lib/viewer/share";
import { nativeShare, useCanNativeShare, useCopyFeedback } from "./share-actions";
import { VW_CTA_EMERALD_OUTLINE, VW_CTA_WHATSAPP, VW_TOAST } from "./viewer-classes";

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

/** Stacked secondary actions (Copy link, More options): emerald outline pills, two per row. */
const SHARE_SECONDARY_CLASS = cx(VW_CTA_EMERALD_OUTLINE, "min-w-[9rem] flex-1 basis-0 whitespace-nowrap");

export function ShareButtons({ url, title, layout = "stack", secondary, className }: ShareButtonsProps) {
  const canShare = useCanNativeShare();
  const { copied: toast, copy: onCopy } = useCopyFeedback(url);
  const onNativeShare = () => nativeShare(title, url);

  const stack = layout === "stack";
  // Secondary actions share a row on a phone (two per line, wrapping) and never overflow 375 px.
  const second = stack ? SHARE_SECONDARY_CLASS : cx(VW_CTA_EMERALD_OUTLINE, "shrink-0 whitespace-nowrap");
  const box = stack ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2";

  return (
    <div className={className ? `${box} ${className}` : box} data-testid="share-buttons">
      <a
        href={whatsappShareUrl(title, url)}
        target="_blank"
        rel="noopener noreferrer"
        className={stack ? cx(VW_CTA_WHATSAPP, "w-full") : cx(VW_CTA_WHATSAPP, "shrink-0 whitespace-nowrap")}
        data-testid="share-whatsapp"
      >
        <MessageCircle className="size-5" aria-hidden />
        Send on WhatsApp
      </a>
      {/* Same as cn("flex flex-wrap gap-2", !stack && "contents"): contents replaces flex. */}
      <div className={stack ? "flex flex-wrap gap-2" : "flex-wrap gap-2 contents"}>
        <button type="button" onClick={onCopy} className={second} data-testid="share-copy">
          {toast?.ok ? <Check className="size-4" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
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
          <span role="status" className={VW_TOAST} data-testid="share-toast">
            {toast.ok ? "Link copied" : "Couldn't copy the link"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
