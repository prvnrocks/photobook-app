"use client";

// Dashboard card cover (M11 T8, D-067): the book's real cover photo (listMyBooks().coverThumbUrl,
// a signed 512 px thumb that may be null or expire after 600 s) in the book's page shape. On null
// AND on a failed load it shows a styled placeholder in the paper palette (Classic = framed photo,
// Modern = edge-to-edge block) so a card never shows a broken image. Decorative: the title sits
// next to it in the card link, so the image has alt="".
//
// Sizing is a fixed width per orientation with the A5 aspect ratio; no layout maths beyond that.
// M18: size "shelf" fills a share of the library card's cover stage (portrait 60 %, landscape 84 %
// of its width) and reads as a hard-cover book: spine shading, page edges and a soft floor shadow.
// No cn() here (lesson 2026-11-14: keeps the merge tables out of the dashboard client bundle).

import { useEffect, useRef, useState } from "react";
import type { BookFormat, DesignStyle } from "@/lib/book/types";
import { BookCoverPlaceholder, BookCoverSheen, bookCoverClass, type BookCoverSize } from "./book-cover-art";

export type { BookCoverSize } from "./book-cover-art";

export function BookCover({
  url,
  format,
  designStyle,
  size = "thumb",
  className,
}: {
  url: string | null;
  format: BookFormat;
  designStyle: DesignStyle;
  size?: BookCoverSize;
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
      className={bookCoverClass(size, format, className)}
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
        <BookCoverPlaceholder size={size} designStyle={designStyle} />
      )}
      <BookCoverSheen size={size} />
    </div>
  );
}
