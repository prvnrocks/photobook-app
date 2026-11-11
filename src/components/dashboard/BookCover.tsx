"use client";

// Dashboard card cover (M11 T8, D-067): the book's real cover photo (listMyBooks().coverThumbUrl,
// a signed 512 px thumb that may be null or expire after 600 s) in the book's page shape. On null
// AND on a failed load it shows a styled placeholder in the paper palette (Classic = framed photo,
// Modern = edge-to-edge block) so a card never shows a broken image. Decorative: the title sits
// next to it in the card link, so the image has alt="".
//
// Sizing is a fixed width per orientation with the A5 aspect ratio; no layout maths beyond that.

import { useEffect, useRef, useState } from "react";
import type { BookFormat, DesignStyle } from "@/lib/book/types";
import { cn } from "@/lib/utils";

const BOX: Record<BookFormat, string> = {
  A5_PORTRAIT: "w-[4.5rem] aspect-[148/210]",
  A5_LANDSCAPE: "w-24 aspect-[210/148]",
};

export function BookCover({
  url,
  format,
  designStyle,
  className,
}: {
  url: string | null;
  format: BookFormat;
  designStyle: DesignStyle;
  className?: string;
}) {
  // Track the URL that failed, so a re-signed URL (after router.refresh) is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const showImg = !!url && failedUrl !== url;

  // A server-rendered <img> can fail before hydration attaches onError (lessons 2026-11-09).
  useEffect(() => {
    const img = imgRef.current;
    if (img && url && img.complete && img.naturalWidth === 0) setFailedUrl(url);
  }, [url]);

  return (
    <div
      aria-hidden="true"
      data-testid="book-cover"
      data-cover={showImg ? "photo" : "placeholder"}
      data-format={format}
      className={cn(
        "relative shrink-0 overflow-hidden rounded-[3px] bg-secondary shadow-lift ring-1 ring-primary/10",
        BOX[format] ?? BOX.A5_PORTRAIT,
        className,
      )}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs; next/image would cache/proxy them
        <img
          ref={imgRef}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(url)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <CoverPlaceholder designStyle={designStyle} />
      )}
      {/* Spine shading: reads as a book, not a photo tile. */}
      <span className="pointer-events-none absolute inset-y-0 start-0 w-1.5 bg-gradient-to-r from-primary/15 to-transparent rtl:bg-gradient-to-l" />
    </div>
  );
}

function CoverPlaceholder({ designStyle }: { designStyle: DesignStyle }) {
  if (designStyle === "classic") {
    return (
      <span data-testid="book-cover-placeholder" className="absolute inset-0 flex flex-col items-center bg-card p-[14%]">
        <span className="block aspect-[4/3] w-full rounded-[1px] bg-secondary outline outline-1 outline-offset-2 outline-input/60" />
        <span className="mt-[18%] block h-[3px] w-1/2 rounded-full bg-border" />
      </span>
    );
  }
  return (
    <span data-testid="book-cover-placeholder" className="absolute inset-0 flex flex-col bg-card">
      <span className="block flex-[3] bg-secondary" />
      <span className="flex flex-1 items-center ps-[18%]">
        <span className="block h-[3px] w-1/2 rounded-full bg-accent-strong/40" />
      </span>
    </span>
  );
}
