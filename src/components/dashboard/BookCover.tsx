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

export type BookCoverSize = "thumb" | "shelf";

const BOX: Record<BookCoverSize, Record<BookFormat, string>> = {
  thumb: {
    A5_PORTRAIT: "w-[4.5rem] aspect-[148/210]",
    A5_LANDSCAPE: "w-24 aspect-[210/148]",
  },
  shelf: {
    A5_PORTRAIT: "w-[60%] aspect-[148/210]",
    A5_LANDSCAPE: "w-[84%] aspect-[210/148]",
  },
};

const SKIN: Record<BookCoverSize, string> = {
  thumb: "rounded-[3px] shadow-lift ring-1 ring-primary/10",
  // Page block on the fore-edge (two paper lines) + a deep, soft emerald-tinted floor shadow.
  shelf:
    "rounded-s-[2px] rounded-e-[5px] ring-1 ring-primary/15 shadow-[1px_0_0_#fff,3px_1px_0_-0.5px_#e9e1d1,4px_2px_0_-0.5px_#fff,6px_3px_0_-1px_#ddd3bf,0_22px_32px_-16px_rgb(14_59_46/0.55),0_6px_12px_-6px_rgb(14_59_46/0.3)]",
};

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
      className={[
        "relative shrink-0 overflow-hidden bg-secondary",
        SKIN[size],
        BOX[size][format] ?? BOX[size].A5_PORTRAIT,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
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
        size === "shelf" ? <ShelfPlaceholder designStyle={designStyle} /> : <CoverPlaceholder designStyle={designStyle} />
      )}
      {/* Spine shading: reads as a book, not a photo tile. */}
      <span className="pointer-events-none absolute inset-y-0 start-0 w-1.5 bg-gradient-to-r from-primary/15 to-transparent rtl:bg-gradient-to-l" />
      {size === "shelf" ? (
        // Hinge groove + a faint sheen across the board, so a photo cover reads as a printed hard cover.
        <>
          <span className="pointer-events-none absolute inset-y-0 start-[7%] w-px bg-white/35 mix-blend-soft-light" />
          <span className="pointer-events-none absolute inset-y-0 start-[calc(7%+1px)] w-[3px] bg-gradient-to-r from-black/12 to-transparent rtl:bg-gradient-to-l" />
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/14 via-transparent to-black/8" />
        </>
      ) : null}
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

/**
 * Library-size placeholder (M18): an unprinted hard cover in the brand materials — Classic in cream
 * linen with a gold double frame and photo window, every other style in emerald cloth with gold foil
 * rules and a small emblem. Decorative only.
 */
function ShelfPlaceholder({ designStyle }: { designStyle: DesignStyle }) {
  if (designStyle === "classic") {
    return (
      <span data-testid="book-cover-placeholder" className="absolute inset-0 flex flex-col items-center bg-[linear-gradient(160deg,#fbf6ea,#efe5cf)] p-[13%]">
        <span className="absolute inset-[6%] rounded-[1px] border border-[#c9a227]/60" />
        <span className="absolute inset-[8%] rounded-[1px] border border-[#c9a227]/30" />
        <span className="relative block aspect-[4/3] w-full rounded-[1px] bg-[#e9dfca] outline outline-1 outline-offset-2 outline-[#c9a227]/50" />
        <span className="relative mt-[16%] block h-[2px] w-1/2 rounded-full bg-[#c9a227]/70" />
        <span className="relative mt-[6%] block h-[2px] w-1/3 rounded-full bg-[#c9a227]/40" />
      </span>
    );
  }
  return (
    <span data-testid="book-cover-placeholder" className="absolute inset-0 flex flex-col items-center justify-center gap-[7%] bg-[radial-gradient(120%_90%_at_30%_20%,#1f6f54,#0e3b2e_70%)]">
      <span className="absolute inset-x-[10%] top-[9%] block h-px home-foil-h opacity-80" />
      <span className="absolute inset-x-[10%] bottom-[9%] block h-px home-foil-h opacity-80" />
      <span className="block size-[22%] rotate-45 rounded-[2px] border border-[#c9a227]/80" />
      <span className="block h-[2px] w-[42%] rounded-full home-foil-h" />
    </span>
  );
}
