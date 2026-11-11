"use client";

// One square photo toggle on the review screen. aria-pressed = kept.
import { useEffect, useRef, useState } from "react";
import { Check, ImageOff } from "lucide-react";
import { isKept, reasonLabel, thumbSize, type ReviewTilePhoto } from "@/lib/review/ui";
import { cn } from "@/lib/utils";

type PhotoTileProps = {
  photo: ReviewTilePhoto;
  /** 1-based position (for the accessible name). */
  index: number;
  busy: boolean;
  /** Toggled into the other tab; stays visible until the tab changes. */
  moved: boolean;
  onTap: (photo: ReviewTilePhoto) => void;
  onThumbError: () => void;
};

export function PhotoTile({ photo, index, busy, moved, onTap, onThumbError }: PhotoTileProps) {
  // Track the URL that failed, so a re-signed URL (after router.refresh) is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const kept = isKept(photo);
  const url = photo.thumbUrl;
  const showImg = !!url && failedUrl !== url;
  const { width, height } = thumbSize(photo);
  const chipId = `photo-chip-${photo.id}`;
  const imgRef = useRef<HTMLImageElement>(null);

  // A server-rendered <img> can fail before hydration attaches onError; catch that on mount.
  useEffect(() => {
    const img = imgRef.current;
    if (img && url && img.complete && img.naturalWidth === 0) {
      setFailedUrl(url);
      onThumbError();
    }
  }, [url, onThumbError]);

  return (
    <button
      type="button"
      aria-pressed={kept}
      aria-label={`Keep photo ${index}`}
      aria-describedby={chipId}
      aria-busy={busy || undefined}
      onClick={() => onTap(photo)}
      data-testid="review-tile"
      data-photo-id={photo.id}
      data-state={kept ? "kept" : "dropped"}
      className={cn(
        "relative block aspect-square w-full min-w-0 overflow-hidden rounded-lg bg-muted outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        kept ? "ring-2 ring-primary" : "ring-1 ring-input/50",
        busy && "cursor-progress",
      )}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs; next/image would cache/proxy them
        <img
          key={url}
          ref={imgRef}
          src={url}
          alt=""
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => {
            setFailedUrl(url);
            onThumbError();
          }}
          className={cn(
            "size-full object-cover transition-[filter,opacity]",
            !kept && "opacity-50 grayscale",
          )}
        />
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground" data-testid="review-tile-placeholder">
          <ImageOff className="size-6" aria-hidden />
        </span>
      )}

      {kept ? (
        <span
          className="absolute end-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-card"
          aria-hidden
        >
          <Check className="size-4" />
        </span>
      ) : null}

      {photo.userOverride ? (
        <span
          className="absolute start-1.5 top-1.5 size-3 rounded-full bg-accent-strong ring-2 ring-card"
          title="You changed this"
          data-testid="review-user-dot"
          aria-hidden
        />
      ) : null}

      <span id={chipId} className="absolute inset-x-1 bottom-1 flex flex-wrap justify-start gap-1">
        {!kept ? (
          <span className="max-w-full rounded-md bg-card/95 px-1.5 py-0.5 text-xs leading-tight break-words font-medium text-foreground shadow-card" data-testid="review-reason">
            {reasonLabel(photo.dropReason)}
          </span>
        ) : null}
        {photo.dupGroup != null && !(photo.dropReason === "duplicate" && !kept) ? (
          <span className="max-w-full rounded-md bg-card/95 px-1.5 py-0.5 text-xs leading-tight break-words text-muted-foreground shadow-card" data-testid="review-dup">
            Possible duplicate
          </span>
        ) : null}
        {moved ? (
          <span className="sr-only">{kept ? "Moved to Kept" : "Moved to Dropped"}</span>
        ) : null}
        {photo.userOverride ? <span className="sr-only">You changed this</span> : null}
      </span>
    </button>
  );
}
