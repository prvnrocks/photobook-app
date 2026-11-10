// Building blocks shared by <BookPage> and <BookCover>. Markup only: positions and crop come
// from the pure render model in src/lib/book/render.ts. No hooks, no "use client" — usable from
// server components (viewer, print) and client components (editor) alike.

import type { CSSProperties, ReactNode } from "react";
import { rgbaOf, textureLayerStyle } from "@/lib/book/background-style";
import { cropBoxStyle, rectStyle, type RenderSlot, type ResolvedBackground } from "@/lib/book/render";
import { orientationOf, pageMm, sheetMm } from "@/lib/book/format";
import { textureSrc } from "@/lib/design/backgrounds";
import { withPageAspect } from "@/lib/book/format-style";
import type { BookFormat, Rect } from "@/lib/book/types";
import { BLEED_MM } from "@/lib/layouts";

export type BookRenderMode = "edit" | "view" | "print";

/**
 * Trim page box of `format` (A5 portrait 148×210 via the aspect class; other formats add an inline
 * aspect-ratio, see format-style.ts). In print mode: the format's bleed sheet instead (see PrintSheet). `container-type: inline-size` makes `cqw` = 1 % of the page width, so
 * every text size scales with the page: strip thumbnail, big editor page and print look identical.
 */
export function PageFrame({
  background,
  layer,
  mode,
  format,
  className,
  children,
  data,
}: {
  /** Plain CSS colour of the frame (the colour background, or the base under `layer`). */
  background: string;
  /** Texture / photo background layer (<BackgroundLayer>), painted first; covers the bleed in print. */
  layer?: ReactNode;
  mode: BookRenderMode;
  /** doc.format; missing → A5 portrait. */
  format?: BookFormat | null;
  className?: string;
  children?: ReactNode;
  data?: Record<`data-${string}`, string>;
}) {
  if (mode === "print") {
    return (
      <PrintSheet background={background} layer={layer} format={format} className={className} data={data}>
        {children}
      </PrintSheet>
    );
  }
  const style: CSSProperties = withPageAspect(
    {
      containerType: "inline-size",
      background,
      printColorAdjust: "exact",
      WebkitPrintColorAdjust: "exact",
    },
    format,
  );
  return (
    <div
      className={`relative aspect-[148/210] w-full overflow-hidden select-none ${className ?? ""}`}
      style={style}
      data-mode={mode}
      {...data}
    >
      {layer}
      {children}
    </div>
  );
}

/**
 * Print sheet (D-050): sheetMm(format) = trim page + 3 mm bleed on every side (portrait 154×216,
 * landscape 216×154 mm), in CSS mm so the
 * PDF page maps 1:1. The background fills the whole sheet (bleed included). Children are laid
 * out in the trim box, which is the `cqw` container — text sizes match the viewer exactly. Photo
 * slots from a `bleed` render model use rects that run past 0..100 % of the trim box into the
 * bleed; the trim box doesn't clip, the sheet does.
 */
function PrintSheet({
  background,
  layer,
  format,
  className,
  children,
  data,
}: {
  background: string;
  layer?: ReactNode;
  format?: BookFormat | null;
  className?: string;
  children?: ReactNode;
  data?: Record<`data-${string}`, string>;
}) {
  const sheetSize = sheetMm(format);
  const pageSize = pageMm(format);
  const sheet: CSSProperties = {
    width: `${sheetSize.w}mm`,
    height: `${sheetSize.h}mm`,
    background,
    printColorAdjust: "exact",
    WebkitPrintColorAdjust: "exact",
  };
  const trim: CSSProperties = {
    left: `${BLEED_MM}mm`,
    top: `${BLEED_MM}mm`,
    width: `${pageSize.w}mm`,
    height: `${pageSize.h}mm`,
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
      {layer}
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

/**
 * Texture / faded-photo background layer (M10a A6), the first child of the frame: the trim page on
 * screen, the whole bleed sheet in print. Colour backgrounds have no layer (the frame's own
 * background colour, unchanged markup). No CSS `filter` anywhere (rasterises in the PDF).
 * In print, textures carry `data-bg-src` so <PrintReady> waits for the CSS image to load.
 */
export function BackgroundLayer({
  bg,
  mode,
  format,
  priority,
}: {
  bg: ResolvedBackground;
  mode: BookRenderMode;
  format?: BookFormat | null;
  priority?: boolean;
}) {
  if (bg.kind === "color") return null;
  const target = mode === "print" ? "print" : "screen";
  if (bg.kind === "texture") {
    const style = textureLayerStyle(bg.texture, format, target);
    return (
      <>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={style}
          data-bg="texture"
          data-bg-texture={bg.texture.id}
          {...(target === "print" ? { "data-bg-src": textureSrc(bg.texture, orientationOf(format), "print") } : {})}
        />
        {bg.tint ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ background: bg.tint, mixBlendMode: "multiply" }}
            data-bg="tint"
          />
        ) : null}
      </>
    );
  }
  return (
    <>
      {bg.photoSrc ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs; next/image would cache/proxy them
        <img
          src={bg.photoSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          loading={priority || mode === "print" ? "eager" : "lazy"}
          className="pointer-events-none absolute inset-0 block h-full w-full object-cover"
          style={{ maxWidth: "none" }}
          data-bg="photo"
        />
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: rgbaOf(bg.veilColor, bg.veil) }}
        data-bg="veil"
      />
    </>
  );
}

/** Text colour classes per ink. Dark = the classes M1–M9 markup always used (goldens). */
export const INK_TEXT = {
  caption: { dark: "text-neutral-800", light: "text-white" },
  coverTitle: { dark: "text-neutral-900", light: "text-white" },
  coverSubtitle: { dark: "text-neutral-600", light: "text-neutral-200" },
} as const;
