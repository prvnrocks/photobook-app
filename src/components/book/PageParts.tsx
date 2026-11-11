// Building blocks shared by <BookPage> and <BookCover>. Markup only: positions and crop come
// from the pure render model in src/lib/book/render.ts. No hooks, no "use client" — usable from
// server components (viewer, print) and client components (editor) alike.

import type { CSSProperties, ReactNode } from "react";
import { rgbaOf, textureLayerStyle } from "@/lib/book/background-style";
import {
  cropBoxStyle,
  rectStyle,
  type RenderSlot,
  type RenderSlotLook,
  type RenderTextPanel,
  type ResolvedBackground,
} from "@/lib/book/render";
import { orientationOf, pageMm, sheetMm } from "@/lib/book/format";
import { textureSrc, type Ink } from "@/lib/design/backgrounds";
import type { TextRole } from "@/lib/design/styles";
import { withPageAspect } from "@/lib/book/format-style";
import type { BookFormat, Rect } from "@/lib/book/types";
import { BLEED_MM } from "@/lib/layouts";
import { rotateStyle, StickerArt } from "./Decoration";

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
  if (slot.look) return <ShapedPhotoSlot slot={slot} look={slot.look} mode={mode} priority={priority} overlay={overlay} />;
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

/** The slot's photo (crop maths) or, in edit mode, the empty placeholder. */
function SlotContent({ slot, mode, priority }: { slot: RenderSlot; mode: BookRenderMode; priority?: boolean }) {
  if (slot.photo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs; next/image would cache/proxy them
      <img
        src={slot.photo.url}
        alt=""
        draggable={false}
        decoding="async"
        loading={priority || mode === "print" ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        className="pointer-events-none absolute block"
        style={{ ...cropBoxStyle(slot.photo.style), maxWidth: "none" }}
      />
    );
  }
  if (mode !== "edit") return null;
  return (
    <div
      className="absolute inset-0 flex items-center justify-center border border-dashed border-neutral-400 bg-neutral-100 text-neutral-500"
      style={{ fontSize: "3cqw", borderWidth: "0.4cqw" }}
      data-testid="slot-placeholder"
    >
      Add photo
    </div>
  );
}

/**
 * M10c slot (T8a): the slot element carries the tilt (rotate about its centre), the shape
 * (border-radius or vector clip-path) and the frame colour; a frame's photo sits in an inner box
 * (photo rect = slot minus frame inset) with the crop applied to that box. The shadow (G1) is a
 * sibling drawn just before the slot: the same box, shape and tilt, offset down/right, flat
 * translucent fill. Never CSS filter or box-shadow (blur → soft masks in the PDF). The edit
 * overlay covers the whole slot (a tap on the frame means this photo).
 */
function ShapedPhotoSlot({
  slot,
  look,
  mode,
  priority,
  overlay,
}: {
  slot: RenderSlot;
  look: RenderSlotLook;
  mode: BookRenderMode;
  priority?: boolean;
  overlay?: ReactNode;
}) {
  const empty = slot.photo === null;
  const outer: CSSProperties = {
    ...rectStyle(slot.rect),
    ...rotateStyle(look.rotate),
    ...(look.borderRadius ? { borderRadius: look.borderRadius } : {}),
    ...(look.clipPath ? { clipPath: look.clipPath } : {}),
    ...(look.frame ? { background: look.frame.color } : {}),
  };
  const data: Record<`data-${string}`, string> = {
    "data-slot-index": String(slot.index),
    "data-slot-empty": String(empty),
  };
  if (look.shape) data["data-slot-shape"] = look.shape;
  if (look.frame) data["data-slot-frame"] = look.frame.kind;
  if (look.rotate) data["data-slot-rotate"] = String(look.rotate);
  const f = look.frame;
  const sh = look.shadow;
  return (
    <>
      {sh ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{
            ...rectStyle(slot.rect),
            // `translate` applies after the tilt, in page space: the offset is always down/right.
            translate: sh.translate,
            ...rotateStyle(look.rotate),
            ...(look.borderRadius ? { borderRadius: look.borderRadius } : {}),
            ...(look.clipPath ? { clipPath: look.clipPath } : {}),
            background: sh.color,
          }}
          data-slot-shadow={String(slot.index)}
        />
      ) : null}
      <div className="absolute overflow-hidden" style={outer} {...data}>
        {f ? (
          <div
            className="absolute overflow-hidden"
            style={{
              ...rectStyle(f.photo),
              ...(f.borderRadius ? { borderRadius: f.borderRadius } : {}),
              ...(f.clipPath ? { clipPath: f.clipPath } : {}),
            }}
            data-slot-photo="true"
          >
            <SlotContent slot={slot} mode={mode} priority={priority} />
          </div>
        ) : (
          <SlotContent slot={slot} mode={mode} priority={priority} />
        )}
        {mode === "edit" ? overlay : null}
      </div>
    </>
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

/** Ink class family per text-panel role (M10b A9): title-like roles use the cover-title ink. */
const PANEL_INK: Record<TextRole, keyof typeof INK_TEXT> = {
  title: "coverTitle",
  chapter: "coverTitle",
  subtitle: "coverSubtitle",
  year: "coverSubtitle",
  caption: "caption",
};

/**
 * A layout text panel (M10b A9): bound doc text in its design-style font, logical alignment,
 * dir="auto" (Arabic renders right-to-left with start/end mirrored). Vertically centred in its box.
 */
export function TextPanel({ panel, ink }: { panel: RenderTextPanel; ink: Ink }) {
  if (panel.plate || panel.rotate) return <PlatedTextPanel panel={panel} ink={ink} />;
  return (
    <Box rect={panel.rect} className="flex flex-col justify-center overflow-hidden" data={{ "data-text-panel": panel.bind }}>
      <p
        dir="auto"
        lang={panel.lang}
        className={`w-full whitespace-pre-line break-words ${INK_TEXT[PANEL_INK[panel.role]][ink]}`}
        style={{
          fontFamily: panel.fontFamily,
          textAlign: panel.align,
          fontSize: `${panel.fontSizeCqw}cqw`,
          lineHeight: panel.lineHeight,
          ...panel.typography,
        }}
        data-testid={`text-${panel.bind}`}
      >
        {panel.text}
      </p>
    </Box>
  );
}

/**
 * M10c text panel (T8b) with a label plate and/or tilt: the panel box rotates about its centre
 * (text stays live text), the plate artwork fills it and the text sits in the plate's text box in
 * the plate's ink. Font, dir="auto" and Latin-only tracking as in TextPanel.
 */
function PlatedTextPanel({ panel, ink }: { panel: RenderTextPanel; ink: Ink }) {
  const plate = panel.plate;
  const textInk = plate ? plate.ink : ink;
  const data: Record<`data-${string}`, string> = { "data-text-panel": panel.bind };
  if (plate) data["data-text-plate"] = plate.art.stickerId;
  return (
    <div className="absolute" style={{ ...rectStyle(panel.rect), ...rotateStyle(panel.rotate) }} {...data}>
      {plate ? <StickerArt art={plate.art} /> : null}
      <div
        className="absolute flex flex-col justify-center overflow-hidden"
        style={rectStyle(plate ? plate.textBox : { x: 0, y: 0, w: 100, h: 100 })}
      >
        <p
          dir="auto"
          lang={panel.lang}
          className={`w-full whitespace-pre-line break-words ${INK_TEXT[PANEL_INK[panel.role]][textInk]}`}
          style={{
            fontFamily: panel.fontFamily,
            textAlign: panel.align,
            fontSize: `${panel.fontSizeCqw}cqw`,
            lineHeight: panel.lineHeight,
            ...panel.typography,
          }}
          data-testid={`text-${panel.bind}`}
        >
          {panel.text}
        </p>
      </div>
    </div>
  );
}

/**
 * Split-strip cover photo (M10b A9): the slot box (data-slot-index 0, the edit overlay's target)
 * holds one window per slice; each window clips the SAME photo, laid out over the whole slot box
 * with the usual crop maths, so the strips read as one picture with gaps showing the background.
 */
export function SlicedPhotoSlot({
  slot,
  slices,
  mode,
  priority,
  overlay,
}: {
  slot: RenderSlot;
  /** Windows in % of the slot box (render.ts sliceWindows). */
  slices: readonly Rect[];
  mode: BookRenderMode;
  priority?: boolean;
  overlay?: ReactNode;
}) {
  const empty = slot.photo === null;
  return (
    <Box rect={slot.rect} data={{ "data-slot-index": String(slot.index), "data-slot-empty": String(empty), "data-slot-sliced": "true" }}>
      {slices.map((sl, i) => (
        <Box key={i} rect={sl} className="overflow-hidden" data={{ "data-slice": String(i) }}>
          {slot.photo ? (
            // The slot-sized photo box, positioned so this window shows its part of the picture.
            <div
              className="pointer-events-none absolute"
              style={{
                left: `${(-sl.x / sl.w) * 100}%`,
                top: `${(-sl.y / sl.h) * 100}%`,
                width: `${(100 / sl.w) * 100}%`,
                height: `${(100 / sl.h) * 100}%`,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs; next/image would cache/proxy them */}
              <img
                src={slot.photo.url}
                alt=""
                draggable={false}
                decoding="async"
                loading={priority || mode === "print" ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : undefined}
                className="pointer-events-none absolute block"
                style={{ ...cropBoxStyle(slot.photo.style), maxWidth: "none" }}
              />
            </div>
          ) : mode === "edit" ? (
            <div
              className="absolute inset-0 border border-dashed border-neutral-400 bg-neutral-100"
              style={{ borderWidth: "0.4cqw" }}
              data-testid="slot-placeholder"
            />
          ) : null}
        </Box>
      ))}
      {mode === "edit" ? overlay : null}
    </Box>
  );
}
