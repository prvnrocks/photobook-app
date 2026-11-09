// Render model for <BookPage> / <BookCover>: everything the shared renderer needs, computed from
// the book document + layout data. Pure (no React, no DOM) so editor, flipbook viewer and print
// produce identical output and the maths is unit-testable. Components only map this to markup.

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
import { slotSizeMm } from "./resolution";
import type { BookDoc, Caption, Crop, Rect } from "./types";

/** A photo as the renderer needs it: a signed URL (web copy) + the stored pixel size. */
export interface RenderPhoto {
  url: string;
  width: number | null;
  height: number | null;
}
export type RenderPhotos = Readonly<Record<string, RenderPhoto | undefined>>;

export interface RenderSlot {
  index: number;
  /** Slot rectangle in % of the page. */
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

function renderSlot(index: number, rect: Rect, photoId: string | null, crop: Crop, photos: RenderPhotos): RenderSlot {
  const p = photoId !== null && Object.prototype.hasOwnProperty.call(photos, photoId) ? photos[photoId] : undefined;
  if (!p || !p.url) return { index, rect, photoId, photo: null };
  const mm = slotSizeMm(rect);
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
): PageRenderModel | null {
  const page = Number.isInteger(pageIndex) ? doc.pages[pageIndex] : undefined;
  if (!page) return null;
  const layout = getLayout(page.layout);
  if (!layout || layout.role !== "page") {
    return { kind: "page", pageId: page.id, layoutId: page.layout, knownLayout: false, slots: [], caption: null };
  }
  const slots = layout.slots.map((rect, i) => {
    const s = page.slots[i];
    return renderSlot(i, rect, s?.photoId ?? null, s?.crop ?? DEFAULT_CROP, photos);
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
function coverFont(text: string, styleFont: string): CaptionFont {
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

export function coverRenderModel(doc: BookDoc, photos: RenderPhotos, captionLang = "en"): CoverRenderModel {
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
    slot: rect ? renderSlot(0, rect, doc.cover.photoId, DEFAULT_CROP, photos) : null,
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
