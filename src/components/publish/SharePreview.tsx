// Share page preview tile (M21 T2): the book's cover as a hard-cover book (BookCover size "shelf";
// since T5 the server-renderable BookCoverStatic, so the page ships no cover JS)
// standing on the My books ivory stage (LIBRARY_STAGE), floating slowly; the title on the cover
// (user text → dir="auto"), page count + shape under it, and the "Open flipbook" link the page passes
// in (testid publish-open). Portrait and landscape books keep their own shape (BookCover's A5 boxes);
// no cover photo → BookCover's shelf placeholder (cream linen / emerald cloth).
// `compact` is the phone row (small cover beside title + meta + link) for tight spots like a sticky
// summary; the default tile already scales to 375 px. `responsive` (M21 T5, the share page) is ONE
// element that is the compact row below lg and the tile from lg (CSS only), so the page has exactly
// one "Open flipbook" link at every width (no hidden duplicate for tests or screen readers).
// Celebration: celebrate → data-celebrate="on" fires a CSS foil-confetti burst + a cover hop once
// (share-motion.css; nothing moves under prefers-reduced-motion). Re-trigger by re-keying the tile.
// Hook-free, no cn/buttonVariants/next/link (link as prop). The stage clips the burst, so nothing can
// widen the page at 375 px.

import type { ReactNode } from "react";
import type { BookDoc, BookFormat, DesignStyle } from "@/lib/book/types";
import type { RenderPhotos } from "@/lib/book/render";
import { cx } from "@/lib/cx";
import { BookPage } from "@/components/book/BookPage";
import {
  BOOK_COVER_BOX,
  BOOK_COVER_SKIN,
  BookCoverStatic,
} from "@/components/dashboard/book-cover-art";
import { LIBRARY_STAGE } from "@/components/dashboard/library-classes";
import { ShareBurst } from "./ShareBurst";
import { SHARE_TITLE_FALLBACK } from "./ShareBand";
import "./share-motion.css";

/** getPublishState().preview (M21 T1). */
export type SharePreviewData = {
  coverThumbUrl: string | null;
  format: BookFormat;
  designStyle: DesignStyle;
  /** The real cover (chosen cover style, title, stickers); absent/null → generic shelf cover. */
  cover?: {
    doc: BookDoc;
    photos: RenderPhotos;
    captionLang: "en" | "ar";
  } | null;
};

/**
 * The book on the stage: its real cover through the shared <BookPage> (same render as editor,
 * viewer and PDF) when the preview has it, else the generic shelf cover. Same box and board skin
 * either way, so the stage layout doesn't change.
 */
function BookCover({ preview }: { preview: SharePreviewData }) {
  const { cover, format, designStyle, coverThumbUrl } = preview;
  if (!cover)
    return (
      <BookCoverStatic
        url={coverThumbUrl}
        format={format}
        designStyle={designStyle}
        size="shelf"
      />
    );
  return (
    <div
      className={cx(
        "relative overflow-hidden bg-white",
        BOOK_COVER_BOX.shelf[format],
        BOOK_COVER_SKIN.shelf,
      )}
      data-testid="share-preview-cover"
    >
      <BookPage
        doc={cover.doc}
        page="cover"
        mode="view"
        photos={cover.photos}
        captionLang={cover.captionLang}
      />
    </div>
  );
}

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
  /** Compact row below lg, tile from lg (one element; wins over `compact`). */
  responsive?: boolean;
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

export function SharePreview({
  preview,
  title,
  pageCount,
  open,
  compact = false,
  responsive = false,
  celebrate = false,
  className,
}: SharePreviewProps) {
  const t = (title ?? "").trim() || SHARE_TITLE_FALLBACK;
  const { format } = preview;
  const meta = `${pageCountLabel(pageCount)} · ${formatLabel(format)}`;

  if (responsive) {
    return (
      <figure
        className={cx(
          "relative flex min-w-0 items-center gap-4 lg:flex-col lg:items-stretch lg:gap-0",
          className,
        )}
        data-testid="share-preview"
        data-variant="responsive"
        data-format={format}
        data-celebrate={celebrate ? "on" : undefined}
      >
        <div
          className={cx(
            LIBRARY_STAGE,
            "relative isolate flex w-20 shrink-0 justify-center overflow-hidden rounded-2xl border border-[#e9dfca] px-1.5 py-2.5 lg:w-auto lg:rounded-[1.75rem] lg:px-8 lg:pt-10 lg:pb-12",
          )}
        >
          <div className="share-float-lg w-full lg:max-w-[19rem]">
            <div className="share-cover-hop relative flex w-full justify-center">
              <BookCover preview={preview} />
              {preview.cover ? null : (
                <span
                  aria-hidden="true"
                  className={cx(
                    "pointer-events-none absolute bottom-[9%] hidden rounded-[3px] border-t border-[#c9a227]/70 bg-[#0e3b2e]/85 px-2 py-1 text-center font-display text-base leading-tight font-semibold text-[#f2e8d8] shadow-[0_4px_10px_-6px_rgb(0_0_0/0.6)] lg:block",
                    PLATE_INSET[format] ?? PLATE_INSET.A5_PORTRAIT,
                  )}
                  data-testid="share-preview-cover-title"
                >
                  <span dir="auto" className="line-clamp-2 break-words">
                    {t}
                  </span>
                </span>
              )}
            </div>
          </div>
          <ShareBurst />
        </div>
        <figcaption className="flex min-w-0 flex-1 flex-col items-start lg:min-h-11 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between lg:gap-x-3 lg:gap-y-1 lg:px-1 lg:pt-2">
          <span
            className="block w-full truncate font-display text-base font-semibold text-[#0e3b2e] lg:sr-only"
            data-testid="share-preview-title"
          >
            <span dir="auto">{t}</span>
          </span>
          <span
            className="text-sm text-muted-foreground"
            data-testid="share-preview-meta"
          >
            {meta}
          </span>
          {open ? (
            <span className="-ms-3 mt-0.5 flex lg:ms-0 lg:-me-3 lg:mt-0">
              {open}
            </span>
          ) : null}
        </figcaption>
      </figure>
    );
  }

  if (compact) {
    return (
      <figure
        className={cx("relative flex min-w-0 items-center gap-3", className)}
        data-testid="share-preview"
        data-variant="compact"
        data-format={format}
        data-celebrate={celebrate ? "on" : undefined}
      >
        <div
          className={cx(
            LIBRARY_STAGE,
            "relative isolate flex w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl px-1.5 py-3",
          )}
        >
          <div className="share-cover-hop flex w-full justify-center">
            <BookCover preview={preview} />
          </div>
          <ShareBurst />
        </div>
        <figcaption className="flex min-w-0 flex-1 flex-col items-start">
          <span
            className="block w-full truncate font-display text-base font-semibold text-[#0e3b2e]"
            data-testid="share-preview-title"
          >
            <span dir="auto">{t}</span>
          </span>
          <span
            className="text-sm text-muted-foreground"
            data-testid="share-preview-meta"
          >
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
            <BookCover preview={preview} />
            {/* Decorative repeat of the band's title, so the cover reads as this book (generic cover only). */}
            {preview.cover ? null : (
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
            )}
          </div>
        </div>
        <ShareBurst />
      </div>
      <figcaption className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 pt-2">
        <span
          className="text-sm text-muted-foreground"
          data-testid="share-preview-meta"
        >
          {meta}
        </span>
        {open ? <span className="-me-3 flex">{open}</span> : null}
      </figcaption>
    </figure>
  );
}
