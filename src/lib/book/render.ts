// Render model for <BookPage> / <BookCover>: everything the shared renderer needs, computed from
// the book document + layout data. Pure (no React, no DOM) so editor, flipbook viewer and print
// produce identical output and the maths is unit-testable. Components only map this to markup.

import { BACKGROUND_SWATCHES, inkFor, textureById, type Ink, type Texture } from "@/lib/design/backgrounds";
import { getLayout } from "@/lib/layouts";
import { captionTextAttrs, isMainlyArabic } from "@/lib/review/ui";
import { cropToStyle, DEFAULT_CROP, type CropStyle } from "./crop";
import {
  ARABIC_CAPTION_FONTS,
  captionFontFamily,
  defaultCaptionFont,
  DEFAULT_ARABIC_CAPTION_FONT,
  DEFAULT_LATIN_CAPTION_FONT,
  isCaptionFont,
  type CaptionFont,
} from "./fonts";
import { bleedRect } from "./bleed";
import { pageMm } from "./format";
import { slotSizeMm } from "./resolution";
import type { Background, BookDoc, BookFormat, BookPage, Caption, Crop, Rect } from "./types";

/** A photo as the renderer needs it: a signed URL (web copy) + the stored pixel size. */
export interface RenderPhoto {
  url: string;
  width: number | null;
  height: number | null;
}
export type RenderPhotos = Readonly<Record<string, RenderPhoto | undefined>>;

export { bleedRect, printSlotSizeMm, EDGE_EPS_PCT, type BleedRect } from "./bleed";

export interface RenderOptions {
  /**
   * Print (D-050): slots touching a trim edge are extended into the 3 mm bleed (rect may run
   * past 0..100 %) and the crop is computed for the extended box. Text rects never change.
   */
  bleed?: boolean;
}

/** Format-dependent inputs of a slot: page mm for bleed + crop maths (doc.format). */
interface SlotCtx extends RenderOptions {
  format: BookFormat;
}

export interface RenderSlot {
  index: number;
  /** Slot rectangle in % of the trim page. With `bleed`, edge slots run past 0..100 %. */
  rect: Rect;
  photoId: string | null;
  /** null = empty slot (no photo, or the photo is not in `photos`, e.g. deleted). */
  photo: { url: string; style: CropStyle } | null;
}

export interface RenderText {
  text: string;
  lang: "ar" | undefined;
  fontFamily: string;
}

export interface RenderCaption extends RenderText {
  /** Caption area in % of the page (from the layout). */
  rect: Rect;
  /** The doc caption (null = layout has a caption area but the page has no caption). */
  caption: Caption | null;
  align: Caption["align"];
}

export interface PageRenderModel {
  kind: "page";
  pageId: string;
  layoutId: string;
  /** false when the layout id is not in the catalogue (page renders blank). */
  knownLayout: boolean;
  slots: RenderSlot[];
  /** null when the layout has no caption area. */
  caption: RenderCaption | null;
}

export interface CoverRenderModel {
  kind: "cover";
  layoutId: string;
  knownLayout: boolean;
  slot: RenderSlot | null;
  /** Title/subtitle block area in % of the page (the cover layout's caption rect). */
  textRect: Rect | null;
  title: RenderText & { sizeCqw: number };
  subtitle: RenderText;
}

/**
 * Plain CSS colour for a background (doc v2 `Background`). Colour → its hex, exactly the string a
 * v1 doc stored, so colour-only books render byte-identically. Texture → the texture's base colour,
 * photo → the veil colour: placeholders until texture/photo layers are rendered (M10a A6), and
 * the colour under those layers afterwards. Unknown texture → white.
 */
export function backgroundColor(bg: Background): string {
  switch (bg.kind) {
    case "color":
      return bg.hex;
    case "texture":
      return textureById(bg.textureId)?.baseHex ?? "#FFFFFF";
    case "photo":
      return bg.veilColor;
  }
}

/** The background a page shows: its own override (`page.background`), else the book default. */
export function effectiveBackground(doc: Pick<BookDoc, "style">, page?: Pick<BookPage, "background"> | null): Background {
  return page?.background ?? doc.style.background;
}

/**
 * A background resolved for rendering (M10a A6). `baseHex` is the frame's plain CSS colour —
 * exactly backgroundColor() — painted under any texture/photo layer (and shown while a layer
 * loads or if it fails). `ink` is the text colour family that reads on it (inkFor).
 */
export type ResolvedBackground =
  | { kind: "color"; hex: string; baseHex: string; ink: Ink }
  | { kind: "texture"; texture: Texture; tint?: string; baseHex: string; ink: Ink }
  | {
      kind: "photo";
      photoId: string;
      veil: number;
      veilColor: string;
      baseHex: string;
      ink: Ink;
      /** URL of the background photo from the render map; undefined = not loaded (veil colour only). */
      photoSrc?: string;
    };

/**
 * Text ink on a colour background: the swatch's declared ink (contrast-tested, = inkFor) for a
 * catalogue swatch; any other hex keeps the M1–M9 dark text, so colour-only docs render
 * byte-identically to the M9 goldens (which freeze dark text on a non-swatch #1F2937). Only the
 * swatch picker sets colours from M10 on; widen to inkFor() if custom colours are ever offered.
 */
export function colorInk(hex: string): Ink {
  const h = hex.toUpperCase();
  return BACKGROUND_SWATCHES.find((s) => s.hex === h)?.ink ?? "dark";
}

/**
 * The background a page (or, without `page`, the cover = book default — the cover has no page
 * entry, so it never has an override) shows, resolved for rendering. A texture id missing from the
 * catalogue renders as a white colour background. Photo src comes from `photos` (web URL on
 * screen, print-asset URL in print); a photo absent from the map renders the veil colour only.
 */
export function resolveBackground(
  doc: Pick<BookDoc, "style">,
  page?: Pick<BookPage, "background"> | null,
  photos?: RenderPhotos,
): ResolvedBackground {
  const bg = effectiveBackground(doc, page);
  const baseHex = backgroundColor(bg);
  switch (bg.kind) {
    case "color":
      return { kind: "color", hex: bg.hex, baseHex, ink: colorInk(bg.hex) };
    case "texture": {
      const texture = textureById(bg.textureId);
      if (!texture) return { kind: "color", hex: "#FFFFFF", baseHex: "#FFFFFF", ink: "dark" };
      return { kind: "texture", texture, ...(bg.tint ? { tint: bg.tint } : {}), baseHex, ink: inkFor(bg) };
    }
    case "photo": {
      const p = photos && Object.prototype.hasOwnProperty.call(photos, bg.photoId) ? photos[bg.photoId] : undefined;
      return {
        kind: "photo",
        photoId: bg.photoId,
        veil: bg.veil,
        veilColor: bg.veilColor,
        baseHex,
        ink: inkFor(bg),
        ...(p?.url ? { photoSrc: p.url } : {}),
      };
    }
  }
}

/** Page caption type size (cqw = % of page width) and line height — shared by the static caption
 * in <BookPage> and the editor's tappable/editable caption so both look identical. */
export const CAPTION_FONT_SIZE_CQW = 2.6;
export const CAPTION_LINE_HEIGHT = 1.25;

/** CSS position for a % rect: `position:absolute` + these. */
export function rectStyle(rect: Rect): { left: string; top: string; width: string; height: string } {
  return { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%` };
}

/** CSS for the photo box inside an overflow-hidden slot (no object-fit; crop.ts maths). */
export function cropBoxStyle(s: CropStyle): { left: string; top: string; width: string; height: string } {
  return { left: `${s.left}%`, top: `${s.top}%`, width: `${s.width}%`, height: `${s.height}%` };
}

function renderSlot(
  index: number,
  layoutRect: Rect,
  photoId: string | null,
  crop: Crop,
  photos: RenderPhotos,
  ctx: SlotCtx,
): RenderSlot {
  // Slot rects are % of the doc format's trim page, so bleed and crop use that page's mm.
  const rect = ctx.bleed ? bleedRect(layoutRect, pageMm(ctx.format)).pct : layoutRect;
  const p = photoId !== null && Object.prototype.hasOwnProperty.call(photos, photoId) ? photos[photoId] : undefined;
  if (!p || !p.url) return { index, rect, photoId, photo: null };
  const mm = slotSizeMm(rect, ctx.format);
  return {
    index,
    rect,
    photoId,
    photo: { url: p.url, style: cropToStyle(p.width ?? 0, p.height ?? 0, mm.w, mm.h, crop) },
  };
}

/** Caption font: the doc's font when known, else the default for the text / caption language. */
export function captionFontOf(caption: Pick<Caption, "text" | "font">, captionLang: string): CaptionFont {
  return isCaptionFont(caption.font) ? caption.font : defaultCaptionFont(caption.text, captionLang);
}

/** Render model of `doc.pages[pageIndex]`; null when the index is out of range. */
export function pageRenderModel(
  doc: BookDoc,
  pageIndex: number,
  photos: RenderPhotos,
  captionLang = "en",
  opts: RenderOptions = {},
): PageRenderModel | null {
  const page = Number.isInteger(pageIndex) ? doc.pages[pageIndex] : undefined;
  if (!page) return null;
  const layout = getLayout(page.layout);
  if (!layout || layout.role !== "page") {
    return { kind: "page", pageId: page.id, layoutId: page.layout, knownLayout: false, slots: [], caption: null };
  }
  const ctx: SlotCtx = { ...opts, format: doc.format };
  const slots = layout.slots.map((rect, i) => {
    const s = page.slots[i];
    return renderSlot(i, rect, s?.photoId ?? null, s?.crop ?? DEFAULT_CROP, photos, ctx);
  });
  let caption: RenderCaption | null = null;
  if (layout.caption) {
    const c = page.caption;
    const text = c?.text ?? "";
    const attrs = captionTextAttrs(text, captionLang);
    caption = {
      rect: layout.caption,
      caption: c,
      text,
      lang: attrs.lang,
      align: c?.align ?? "center",
      fontFamily: captionFontFamily(
        c ? captionFontOf(c, captionLang) : defaultCaptionFont("", captionLang),
      ),
    };
  }
  return { kind: "page", pageId: page.id, layoutId: layout.id, knownLayout: true, slots, caption };
}

/** Cover title font: the book style font, switched to an Arabic font for an Arabic title. */
export function coverFont(text: string, styleFont: string): CaptionFont {
  const base: CaptionFont = isCaptionFont(styleFont) ? styleFont : DEFAULT_LATIN_CAPTION_FONT;
  if (isMainlyArabic(text) && !ARABIC_CAPTION_FONTS.includes(base)) return DEFAULT_ARABIC_CAPTION_FONT;
  return base;
}

/**
 * Cover title size in cqw (1 cqw = 1 % of the page width). Never truncate the user's title:
 * long titles get smaller so up to 120 code points fit the cover text area in ≤ 3 lines.
 */
export function coverTitleSizeCqw(title: string): number {
  const n = Array.from(title.trim()).length;
  if (n <= 24) return 7;
  if (n <= 48) return 5.5;
  if (n <= 80) return 4.5;
  return 3.6;
}

export function coverRenderModel(
  doc: BookDoc,
  photos: RenderPhotos,
  captionLang = "en",
  opts: RenderOptions = {},
): CoverRenderModel {
  const layout = getLayout(doc.cover.layout);
  const known = !!layout && layout.role === "cover";
  const rect = known ? layout.slots[0] : undefined;
  const { title, subtitle } = doc.cover;
  const titleAttrs = captionTextAttrs(title, captionLang);
  const subAttrs = captionTextAttrs(subtitle, captionLang);
  return {
    kind: "cover",
    layoutId: doc.cover.layout,
    knownLayout: known,
    slot: rect ? renderSlot(0, rect, doc.cover.photoId, DEFAULT_CROP, photos, { ...opts, format: doc.format }) : null,
    textRect: known ? layout.caption : null,
    title: {
      text: title,
      lang: titleAttrs.lang,
      fontFamily: captionFontFamily(coverFont(title, doc.style.font)),
      sizeCqw: coverTitleSizeCqw(title),
    },
    subtitle: {
      text: subtitle,
      lang: subAttrs.lang,
      fontFamily: captionFontFamily(coverFont(subtitle, doc.style.font)),
    },
  };
}
