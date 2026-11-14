// Covers + spines for the home bookshelf (M14). Decorative marketing art — not a book render (real
// pages always go through <BookPage>). All sizing is relative (container units / %), so the same
// markup serves the shelf (≈200–420 px tall) and the preview card.
/* eslint-disable @next/next/no-img-element -- tiny static PNGs with fixed width/height; the optimiser would only add a round trip */
import type { CSSProperties } from "react";
import { spineCropStyle, type ShelfBook } from "@/lib/marketing/shelf";
import { cx } from "@/lib/cx";

/** Fine cloth weave + soft light from the top left, on top of the cloth colour. */
const CLOTH =
  "repeating-linear-gradient(0deg, rgb(255 255 255 / 0.045) 0 1px, transparent 1px 3px), " +
  "repeating-linear-gradient(90deg, rgb(0 0 0 / 0.055) 0 1px, transparent 1px 3px), " +
  "linear-gradient(135deg, rgb(255 255 255 / 0.14), transparent 45%, rgb(0 0 0 / 0.12))";

function titleColor(book: ShelfBook) {
  return book.tone === "light" ? "#9B4B35" : "#F3E7D6";
}

/** Front cover: the real image when there is one, else built from the spine. */
export function ShelfCover({ book, priority = false, className }: { book: ShelfBook; priority?: boolean; className?: string }) {
  if (book.cover) {
    return (
      <img
        src={book.cover.src}
        width={book.cover.w}
        height={book.cover.h}
        alt=""
        draggable={false}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        className={cx("block h-full w-full object-contain select-none", className)}
      />
    );
  }
  const photo = spineCropStyle(book, "photo");
  const glyph = spineCropStyle(book, "glyph");
  return (
    <div className={cx("relative h-full w-full select-none", className)}>
      {/* page block peeking out at the right and bottom, like the real cover's */}
      <div
        aria-hidden="true"
        className="absolute inset-0 translate-x-[2.2%] translate-y-[1.6%] rounded-[3%] bg-[#efe6d8] shadow-[inset_-1px_-1px_0_rgb(0_0_0/0.12)]"
      />
      <div
        className="@container absolute inset-0 flex flex-col items-center overflow-hidden rounded-[3%] rounded-l-[1.5%] px-[9%] pt-[8%] pb-[6%] shadow-[0_1px_0_rgb(255_255_255/0.25)_inset,0_-2px_6px_rgb(0_0_0/0.15)_inset]"
        style={{ backgroundColor: book.color, backgroundImage: CLOTH }}
      >
        {/* hinge groove */}
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-[5.5%] w-[1.6%] bg-gradient-to-r from-black/20 via-white/10 to-black/10"
        />
        {book.arabic ? (
          <>
            <p
              lang="ar"
              data-testid="shelf-cover-title-ar"
              className="w-full text-center font-arabic text-[11cqw] leading-[1.25] font-bold text-balance"
              style={{ color: titleColor(book) }}
            >
              <span dir="auto">{book.arabic.title}</span>
            </p>
            <p className="mt-[1.5%] w-full text-center font-display text-[5cqw] leading-tight italic opacity-80" style={{ color: titleColor(book) }}>
              <span dir="auto">{book.title}</span>
            </p>
          </>
        ) : (
          <p
            className="w-full text-center font-display text-[10cqw] leading-[1.08] font-semibold text-balance"
            style={{ color: titleColor(book) }}
          >
            <span dir="auto">{book.title}</span>
          </p>
        )}
        {photo ? (
          <div
            aria-hidden="true"
            className="mt-[7%] w-[50%] rounded-[3%] shadow-[0_0_0_1.6cqw_rgb(255_255_255/0.18),0_0_0_calc(1.6cqw+1px)_rgb(0_0_0/0.18),inset_0_1px_4px_rgb(0_0_0/0.35)]"
            style={photo as CSSProperties}
          />
        ) : null}
        {glyph ? <div aria-hidden="true" className="mt-auto w-[14%] opacity-90 [mask-image:radial-gradient(closest-side,#000_55%,transparent)]" style={glyph as CSSProperties} /> : null}
      </div>
    </div>
  );
}

/** Spine: the PNG when there is one, else drawn from colour + title (vertical, like the others). */
export function ShelfSpine({ book, eager }: { book: ShelfBook; eager: boolean }) {
  if (book.spine) {
    return (
      <img
        src={book.spine.src}
        width={book.spine.w}
        height={book.spine.h}
        alt=""
        draggable={false}
        loading={eager ? "eager" : "lazy"}
        className="block h-full w-full select-none"
      />
    );
  }
  return (
    <div
      className="@container flex h-full w-full flex-col items-center justify-between rounded-[9%/2.5%] py-[22%] shadow-[inset_-3px_0_6px_rgb(0_0_0/0.18),inset_3px_0_4px_rgb(255_255_255/0.25)]"
      style={{ backgroundColor: book.color, backgroundImage: CLOTH }}
    >
      <span
        className="font-display text-[30cqw] leading-none font-semibold whitespace-nowrap [writing-mode:vertical-rl]"
        style={{ color: titleColor(book) }}
      >
        <span dir="auto">{book.title}</span>
      </span>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="w-[34%]" fill="none" stroke={titleColor(book)} strokeWidth="1.6">
        <circle cx="9" cy="13" r="5" />
        <circle cx="15" cy="13" r="5" />
        <path d="M13.5 5.5 15 3.5l1.5 2-1.5 1.5z" />
      </svg>
    </div>
  );
}
