// Share page preview tile (M21 T2): the book's cover as a hard-cover book (BookCover size "shelf")
// standing on the My books ivory stage (LIBRARY_STAGE), floating slowly; the title on the cover
// (user text → dir="auto"), page count + shape under it, and the "Open flipbook" link the page passes
// in (testid publish-open). Portrait and landscape books keep their own shape (BookCover's A5 boxes);
// no cover photo → BookCover's shelf placeholder (cream linen / emerald cloth).
// `compact` is the phone row (small cover beside title + meta + link) for tight spots like a sticky
// summary; the default tile already scales to 375 px.
// Celebration: celebrate → data-celebrate="on" fires a CSS foil-confetti burst + a cover hop once
// (share-motion.css; nothing moves under prefers-reduced-motion). Re-trigger by re-keying the tile.
// Hook-free, no cn/buttonVariants/next/link (link as prop). The stage clips the burst, so nothing can
// widen the page at 375 px.

import type { ReactNode } from "react";
import type { BookFormat, DesignStyle } from "@/lib/book/types";
import { cx } from "@/lib/cx";
import { BookCover } from "@/components/dashboard/BookCover";
import { LIBRARY_STAGE } from "@/components/dashboard/library-classes";
import { ShareBurst } from "./ShareBurst";
import { SHARE_TITLE_FALLBACK } from "./ShareBand";
import "./share-motion.css";

/** getPublishState().preview (M21 T1). */
export type SharePreviewData = {
  coverThumbUrl: string | null;
  format: BookFormat;
  designStyle: DesignStyle;
};

export type SharePreviewProps = {
  preview: SharePreviewData;
  /** Book title (user text). Blank → "Your book". */
  title: string | null | undefined;
  /** Pages in the book (what the viewer will flip). */
  pageCount: number;
  /** "Open flipbook" link (next/link or <a>, data-testid="publish-open", className SHARE_OPEN_LINK). */
  open?: ReactNode;
  /** Phone row layout: small cover beside the text. */
  compact?: boolean;
  /** Fire the publish celebration (once per mount). */
  celebrate?: boolean;
  className?: string;
};

export function pageCountLabel(n: number): string {
  const count = Math.max(0, Math.floor(n));
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

export function formatLabel(format: BookFormat): string {
  return format === "A5_LANDSCAPE" ? "Landscape" : "Portrait";
}

/** Title plate inset so it sits inside the cover board (cover = 60 % / 84 % of the stage, centred). */
const PLATE_INSET: Record<BookFormat, string> = {
  A5_PORTRAIT: "inset-x-[24%]",
  A5_LANDSCAPE: "inset-x-[13%]",
};

export function SharePreview({ preview, title, pageCount, open, compact = false, celebrate = false, className }: SharePreviewProps) {
  const t = (title ?? "").trim() || SHARE_TITLE_FALLBACK;
  const { coverThumbUrl, format, designStyle } = preview;
  const meta = `${pageCountLabel(pageCount)} · ${formatLabel(format)}`;

  if (compact) {
    return (
      <figure
        className={cx("relative flex min-w-0 items-center gap-3", className)}
        data-testid="share-preview"
        data-variant="compact"
        data-format={format}
        data-celebrate={celebrate ? "on" : undefined}
      >
        <div className={cx(LIBRARY_STAGE, "relative isolate flex w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl px-1.5 py-3")}>
          <div className="share-cover-hop flex w-full justify-center">
            <BookCover url={coverThumbUrl} format={format} designStyle={designStyle} size="shelf" />
          </div>
          <ShareBurst />
        </div>
        <figcaption className="flex min-w-0 flex-1 flex-col items-start">
          <span className="block w-full truncate font-display text-base font-semibold text-[#0e3b2e]" data-testid="share-preview-title">
            <span dir="auto">{t}</span>
          </span>
          <span className="text-sm text-muted-foreground" data-testid="share-preview-meta">
            {meta}
          </span>
          {open ? <span className="-ms-3 mt-0.5 flex">{open}</span> : null}
        </figcaption>
      </figure>
    );
  }

  return (
    <figure
      className={cx("flex min-w-0 flex-col", className)}
      data-testid="share-preview"
      data-variant="tile"
      data-format={format}
      data-celebrate={celebrate ? "on" : undefined}
    >
      <div
        className={cx(
          LIBRARY_STAGE,
          "relative isolate flex justify-center overflow-hidden rounded-[1.75rem] border border-[#e9dfca] px-5 pt-7 pb-9 sm:px-8 sm:pt-10 sm:pb-12",
        )}
      >
        <div className="share-float w-full max-w-[19rem]">
          <div className="share-cover-hop relative flex w-full justify-center">
            <BookCover url={coverThumbUrl} format={format} designStyle={designStyle} size="shelf" />
            {/* Decorative repeat of the band's title, so the cover reads as this book. */}
            <span
              aria-hidden="true"
              className={cx(
                "pointer-events-none absolute bottom-[9%] rounded-[3px] border-t border-[#c9a227]/70 bg-[#0e3b2e]/85 px-2 py-1 text-center font-display text-sm leading-tight font-semibold text-[#f2e8d8] shadow-[0_4px_10px_-6px_rgb(0_0_0/0.6)] sm:text-base",
                PLATE_INSET[format] ?? PLATE_INSET.A5_PORTRAIT,
              )}
              data-testid="share-preview-cover-title"
            >
              <span dir="auto" className="line-clamp-2 break-words">
                {t}
              </span>
            </span>
          </div>
        </div>
        <ShareBurst />
      </div>
      <figcaption className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 pt-2">
        <span className="text-sm text-muted-foreground" data-testid="share-preview-meta">
          {meta}
        </span>
        {open ? <span className="-me-3 flex">{open}</span> : null}
      </figcaption>
    </figure>
  );
}
