// Building blocks shared by <BookPage> and <BookCover>. Markup only: positions and crop come
// from the pure render model in src/lib/book/render.ts. No hooks, no "use client" — usable from
// server components (viewer, print) and client components (editor) alike.

import type { CSSProperties, ReactNode } from "react";
import { cropBoxStyle, rectStyle, type RenderSlot } from "@/lib/book/render";
import type { Rect } from "@/lib/book/types";
import { BLEED_MM, PAGE_MM, SHEET_MM } from "@/lib/layouts";

export type BookRenderMode = "edit" | "view" | "print";

/**
 * A5 page box (148×210). In print mode: the 154×216 mm bleed sheet instead (see PrintSheet). `container-type: inline-size` makes `cqw` = 1 % of the page width, so
 * every text size scales with the page: strip thumbnail, big editor page and print look identical.
 */
export function PageFrame({
  background,
  mode,
  className,
  children,
  data,
}: {
  background: string;
  mode: BookRenderMode;
  className?: string;
  children?: ReactNode;
  data?: Record<`data-${string}`, string>;
}) {
  if (mode === "print") {
    return (
      <PrintSheet background={background} className={className} data={data}>
        {children}
      </PrintSheet>
    );
  }
  const style: CSSProperties = {
    containerType: "inline-size",
    background,
    printColorAdjust: "exact",
    WebkitPrintColorAdjust: "exact",
  };
  return (
    <div
      className={`relative aspect-[148/210] w-full overflow-hidden select-none ${className ?? ""}`}
      style={style}
      data-mode={mode}
      {...data}
    >
      {children}
    </div>
  );
}

/**
 * Print sheet (D-050): 154×216 mm = 148×210 trim + 3 mm bleed on every side, in CSS mm so the
 * PDF page maps 1:1. The background fills the whole sheet (bleed included). Children are laid
 * out in the trim box, which is the `cqw` container — text sizes match the viewer exactly. Photo
 * slots from a `bleed` render model use rects that run past 0..100 % of the trim box into the
 * bleed; the trim box doesn't clip, the sheet does.
 */
function PrintSheet({
  background,
  className,
  children,
  data,
}: {
  background: string;
  className?: string;
  children?: ReactNode;
  data?: Record<`data-${string}`, string>;
}) {
  const sheet: CSSProperties = {
    width: `${SHEET_MM.w}mm`,
    height: `${SHEET_MM.h}mm`,
    background,
    printColorAdjust: "exact",
    WebkitPrintColorAdjust: "exact",
  };
  const trim: CSSProperties = {
    left: `${BLEED_MM}mm`,
    top: `${BLEED_MM}mm`,
    width: `${PAGE_MM.w}mm`,
    height: `${PAGE_MM.h}mm`,
    containerType: "inline-size",
  };
  return (
    <div
      className={`relative shrink-0 overflow-hidden select-none ${className ?? ""}`}
      style={sheet}
      data-mode="print"
      data-print-sheet="true"
      {...data}
    >
      <div className="absolute" style={trim} data-print-trim="true">
        {children}
      </div>
    </div>
  );
}

export function Box({ rect, className, children, data }: {
  rect: Rect;
  className?: string;
  children?: ReactNode;
  data?: Record<`data-${string}`, string>;
}) {
  return (
    <div className={`absolute ${className ?? ""}`} style={rectStyle(rect)} {...data}>
      {children}
    </div>
  );
}

/** One photo slot: overflow-hidden box, photo absolutely positioned per the crop maths. */
export function PhotoSlot({
  slot,
  mode,
  priority,
  overlay,
}: {
  slot: RenderSlot;
  mode: BookRenderMode;
  priority?: boolean;
  overlay?: ReactNode;
}) {
  const empty = slot.photo === null;
  return (
    <Box
      rect={slot.rect}
      className="overflow-hidden"
      data={{ "data-slot-index": String(slot.index), "data-slot-empty": String(empty) }}
    >
      {slot.photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs; next/image would cache/proxy them
        <img
          src={slot.photo.url}
          alt=""
          draggable={false}
          decoding="async"
          // Print (Puppeteer) must load every image before the PDF is taken: never lazy there.
          loading={priority || mode === "print" ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          className="pointer-events-none absolute block"
          style={{ ...cropBoxStyle(slot.photo.style), maxWidth: "none" }}
        />
      ) : mode === "edit" ? (
        <div
          className="absolute inset-0 flex items-center justify-center border border-dashed border-neutral-400 bg-neutral-100 text-neutral-500"
          style={{ fontSize: "3cqw", borderWidth: "0.4cqw" }}
          data-testid="slot-placeholder"
        >
          Add photo
        </div>
      ) : null}
      {mode === "edit" ? overlay : null}
    </Box>
  );
}
