"use client";

// Share page link card (M21 T3): shown while the link is live (testid publish-live). The big
// WhatsApp button first (the next tap for most users), then the read-only link field with Copy
// beside it (share-copy-pulse ring + data-copied, "Copied" for COPY_FEEDBACK_MS, the result
// announced politely), then the native share sheet where the browser has one and the "Open book"
// link the panel passes in (testid publish-open; omitted when the preview tile carries it).
// Copy / native-share logic is shared with the viewer's ShareButtons (viewer/share-actions.ts).
// No analytics, no cn/buttonVariants/next/link. The URL is app data (ltr); the title only goes
// into the WhatsApp message / share sheet.

import { Check, Link2, MessageCircle, Share2 } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { SHARE_COPY } from "@/lib/publish/ui";
import { whatsappShareUrl } from "@/lib/viewer/share";
import { nativeShare, useCanNativeShare, useCopyFeedback } from "@/components/viewer/share-actions";
import { SHARE_CARD, SHARE_CTA_EMERALD, SHARE_CTA_WHATSAPP, SHARE_LINK_FIELD } from "./share-classes";

export type ShareLinkCardProps = {
  /** Absolute book URL (state.url). */
  url: string;
  /** Book title for the WhatsApp message / native share title. */
  title: string;
  /** "Open book" link (<a data-testid="publish-open">), or nothing when the preview tile has it. */
  open?: ReactNode;
};

export function ShareLinkCard({ url, title, open }: ShareLinkCardProps) {
  const fieldId = useId();
  const canShare = useCanNativeShare();
  const { copied, copy } = useCopyFeedback(url);
  const ok = copied?.ok === true;

  return (
    <section className={cx(SHARE_CARD, "flex flex-col gap-4")} data-testid="publish-live" aria-labelledby={`${fieldId}-h`}>
      <div>
        <h2 id={`${fieldId}-h`} className="font-display text-lg leading-tight font-semibold text-[#0e3b2e] sm:text-xl">
          {SHARE_COPY.linkHeading}
        </h2>
        <p className="type-small mt-1 text-muted-foreground">{SHARE_COPY.linkNote}</p>
      </div>
      <div className="flex flex-col gap-2" data-testid="share-buttons">
        <a href={whatsappShareUrl(title, url)} target="_blank" rel="noopener noreferrer" className={SHARE_CTA_WHATSAPP} data-testid="share-whatsapp">
          <MessageCircle className="size-5" aria-hidden="true" />
          {SHARE_COPY.whatsapp}
        </a>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
          {SHARE_COPY.linkLabel}
        </label>
        <div className="flex min-w-0 items-center gap-2">
          <input
            id={fieldId}
            readOnly
            value={url}
            dir="ltr"
            onFocus={(e) => e.currentTarget.select()}
            className={SHARE_LINK_FIELD}
            data-testid="publish-url"
          />
          <button
            type="button"
            onClick={copy}
            className={cx(SHARE_CTA_EMERALD, "share-copy-pulse min-w-24 shrink-0")}
            data-testid="share-copy"
            data-copied={ok ? "" : undefined}
          >
            {ok ? <Check className="size-4" aria-hidden="true" /> : <Link2 className="size-4" aria-hidden="true" />}
            {ok ? SHARE_COPY.copied : SHARE_COPY.copy}
            <span className="sr-only"> link</span>
          </button>
        </div>
        <p aria-live="polite" className="min-h-5 text-xs text-muted-foreground" data-testid="share-copy-status">
          {copied ? (copied.ok ? <span className="sr-only">{SHARE_COPY.copiedStatus}</span> : SHARE_COPY.copyFailed) : null}
        </p>
      </div>
      {canShare || open ? (
        <div className="-mt-2 flex flex-wrap gap-2">
          {canShare ? (
            <button type="button" onClick={() => nativeShare(title, url)} className={SHARE_CTA_EMERALD} data-testid="share-native">
              <Share2 className="size-4" aria-hidden="true" />
              {SHARE_COPY.nativeShare}
            </button>
          ) : null}
          {open}
        </div>
      ) : null}
    </section>
  );
}
