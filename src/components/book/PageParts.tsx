// Building blocks shared by <BookPage> and <BookCover>. Markup only: positions and crop come
// from the pure render model in src/lib/book/render.ts. No hooks, no "use client" — usable from
// server components (viewer, print) and client components (editor) alike.

import type { CSSProperties, ReactNode } from "react";
import { cropBoxStyle, rectStyle, type RenderSlot } from "@/lib/book/render";
import type { Rect } from "@/lib/book/types";

export type BookRenderMode = "edit" | "view" | "print";

/**
 * A5 page box (148×210). `container-type: inline-size` makes `cqw` = 1 % of the page width, so
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
