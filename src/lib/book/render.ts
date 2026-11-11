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
import { roleFont, type TextRole } from "@/lib/design/styles";
import { bleedRect, spreadBleedRect } from "./bleed";
import { pageMm } from "./format";
import { slotSizeMm } from "./resolution";
import type { TEXT_BINDINGS } from "./schema";
import type { Background, BookDoc, BookFormat, BookPage, Caption, Crop, Layout, Rect } from "./types";

/** A photo as the renderer needs it: a signed URL (web copy) + the stored pixel size. */
export interface RenderPhoto {
  url: string;
  width: number | null;
  height: number | null;
}
export type RenderPhotos = Readonly<Record<string, RenderPhoto | undefined>>;

export { bleedRect, spreadBleedRect, printSlotSizeMm, EDGE_EPS_PCT, type BleedRect } from "./bleed";

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

/** CSS text-align of rendered text: the doc caption's physical value or a panel's logical one. */
export type RenderAlign = Caption["align"] | "start" | "end";

/**
 * Typography of non-classic text (M10b A9): weight / style / case from the design-style token
 * (styles.ts roleFont, nearest shipped weight → no faux bold). Absent for classic text, whose
 * markup is frozen by the M9 goldens.
 */
export interface RenderTypography {
  fontWeight: number;
  fontStyle: "normal" | "italic";
  textTransform?: "uppercase";
}

export interface RenderCaption extends RenderText {
  /** Caption area in % of the page (from the layout). */
  rect: Rect;
  /** The doc caption (null = layout has a caption area but the page has no caption). */
  caption: Caption | null;
  align: RenderAlign;
  /**
   * Type size in cqw when it differs from CAPTION_FONT_SIZE_CQW (non-portrait formats: sized in
   * mm, so landscape type matches portrait). Use captionSizeCqw(model).
   */
  fontSizeCqw?: number;
  typography?: RenderTypography;
}

export type TextBinding = (typeof TEXT_BINDINGS)[number];

/**
 * A layout text panel (M10b A9) bound to doc data: chapter title / date label of the page's
 * chapter, or the cover title / subtitle. The pageCaption binding never becomes a panel — it only
 * styles the page caption (same box), so the caption is drawn once.
 */
export interface RenderTextPanel extends RenderText {
  bind: TextBinding;
  role: TextRole;
  /** % of the page (spread halves: already shifted into this page). */
  rect: Rect;
  align: "start" | "center" | "end";
  fontSizeCqw: number;
  lineHeight: number;
  typography: RenderTypography;
}

/** Which half of a spread layout a page shows (M10b): content comes from the left page (owner). */
export interface RenderSpreadHalf {
  side: "left" | "right";
  /** Index in doc.pages of the page that owns the slots + caption (the left half), null if orphaned. */
  ownerIndex: number | null;
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
  /** Spread halves only (absent on single pages). Slot `index` = index in the owner's slots. */
  spread?: RenderSpreadHalf;
  /** Text panels with text (absent when none — every classic layout). */
  texts?: RenderTextPanel[];
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
  /**
   * Text scale for the stacked title block when ≠ 1 (non-portrait formats: subtitle 3 cqw and gap
   * 1.5 cqw are multiplied by it; title.sizeCqw already is). Absent on A5 portrait.
   */
  textScale?: number;
  /**
   * Layouts with coverTitle/coverSubtitle panels (M10b): drawn INSTEAD of the stacked title block.
   * `textRect` stays the whole block (edit overlay / tap target). Absent for classic covers.
   */
  panels?: RenderTextPanel[];
  /**
   * Split-strip covers: windows (in % of the cover slot box) the one cover photo is clipped to.
   * Absent for single-window covers.
   */
  slices?: Rect[];
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

// --- Text sizing (M10b A9) ------------------------------------------------------------------------
// Sizes are designed on the A5 portrait page, where 1 cqw = 1.48 mm. Captions are % of the page
// WIDTH, so the same cqw on a 210 mm landscape page would print ~42 % larger. textScale() keeps
// type the same size in mm on every format: cqw × min(w, h) / w (portrait → exactly 1, so classic
// portrait markup stays byte-identical).

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Multiplier for portrait-designed cqw sizes on `format` (portrait 1, landscape 148/210). */
export function textScale(format?: BookFormat | null): number {
  const p = pageMm(format);
  return Math.min(p.w, p.h) / p.w;
}

/** `cqw` × `k` (textScale), 4 decimals; exactly `cqw` when k is 1 or absent. */
export function scaleCqw(cqw: number, k?: number): number {
  return k === undefined || k === 1 ? cqw : round4(cqw * k);
}

/** Caption size in cqw for a render model (CAPTION_FONT_SIZE_CQW unless the model overrides it). */
export function captionSizeCqw(c: Pick<RenderCaption, "fontSizeCqw">): number {
  return c.fontSizeCqw ?? CAPTION_FONT_SIZE_CQW;
}

/** Panel sizing per role: largest size in mm, smallest it may shrink to, line height, average glyph width (em). */
const PANEL_TYPE: Record<TextRole, { maxMm: number; minMm: number; lineHeight: number; charEm: number }> = {
  title: { maxMm: 15, minMm: 5, lineHeight: 1.1, charEm: 0.42 },
  chapter: { maxMm: 8, minMm: 3.5, lineHeight: 1.05, charEm: 0.42 },
  subtitle: { maxMm: 4.6, minMm: 2.8, lineHeight: 1.25, charEm: 0.48 },
  year: { maxMm: 4.6, minMm: 2.8, lineHeight: 1.25, charEm: 0.48 },
  caption: { maxMm: 3.85, minMm: 2.8, lineHeight: CAPTION_LINE_HEIGHT, charEm: 0.48 },
};

/**
 * Font size (mm) for a text panel: the largest size ≤ maxMm whose estimated wrapped height fits
 * the box (never truncates — below minMm it stops shrinking and the box may clip, which the
 * layout tests keep out of reach for the title limits). Deterministic, so all modes agree.
 */
export function panelFontMm(text: string, role: TextRole, boxWmm: number, boxHmm: number): number {
  const t = PANEL_TYPE[role];
  const chars = Math.max(1, Array.from(text.trim()).length);
  let size = Math.min(t.maxMm, boxHmm / t.lineHeight);
  while (size > t.minMm) {
    const perLine = Math.max(1, Math.floor(boxWmm / (size * t.charEm)));
    const lines = Math.ceil(chars / perLine);
    if (lines * size * t.lineHeight <= boxHmm) break;
    size = Math.max(t.minMm, size * 0.92);
  }
  return Math.round(size * 100) / 100;
}

// --- Spread halves (M10b A9) ---------------------------------------------------------------------

/** A spread rect (x 0..200) seen from one half: shifted into that page's 0..100 (may run outside). */
function shiftRect(r: Rect, offset: number): Rect {
  return offset === 0 ? r : { ...r, x: r.x - offset };
}

/** True when the (shifted) rect shows on the page, i.e. overlaps x 0..100. */
function onPage(r: Rect): boolean {
  return r.x < 100 - 1e-9 && r.x + r.w > 1e-9;
}

/**
 * The half a page shows and where its content comes from. Left half (or a spread page without
 * side, malformed) = itself; right half = the page before it when that is the matching left half,
 * else orphaned (renders background only).
 */
function spreadHalfOf(doc: BookDoc, pageIndex: number, page: BookPage): { half: RenderSpreadHalf; owner: BookPage | null; offset: number } {
  if (page.side !== "right") return { half: { side: "left", ownerIndex: pageIndex }, owner: page, offset: 0 };
  const prev = doc.pages[pageIndex - 1];
  const ok = !!prev && prev.side === "left" && prev.layout === page.layout;
  return { half: { side: "right", ownerIndex: ok ? pageIndex - 1 : null }, owner: ok ? prev : null, offset: 100 };
}

function spreadSlot(
  index: number,
  layoutRect: Rect,
  offset: number,
  photoId: string | null,
  crop: Crop,
  photos: RenderPhotos,
  ctx: SlotCtx,
): RenderSlot {
  // One box across both halves (bleed only on the spread's outer edges): crop maths on the whole
  // box, so a photo crossing the fold lines up exactly on the two pages.
  const full = ctx.bleed ? spreadBleedRect(layoutRect, pageMm(ctx.format)).pct : layoutRect;
  const rect = shiftRect(full, offset);
  const p = photoId !== null && Object.prototype.hasOwnProperty.call(photos, photoId) ? photos[photoId] : undefined;
  if (!p || !p.url) return { index, rect, photoId, photo: null };
  const mm = slotSizeMm(full, ctx.format);
  return { index, rect, photoId, photo: { url: p.url, style: cropToStyle(p.width ?? 0, p.height ?? 0, mm.w, mm.h, crop) } };
}

// --- Text panels ---------------------------------------------------------------------------------

function typographyOf(f: ReturnType<typeof roleFont>): RenderTypography {
  return { fontWeight: f.fontWeight, fontStyle: f.fontStyle, ...(f.textTransform ? { textTransform: f.textTransform } : {}) };
}

function boundText(doc: BookDoc, bind: TextBinding, owner: BookPage | null): string {
  switch (bind) {
    case "coverTitle":
      return doc.cover.title;
    case "coverSubtitle":
      return doc.cover.subtitle;
    case "chapterTitle":
    case "dateLabel": {
      const id = owner?.chapterId;
      const ch = id ? doc.chapters.find((c) => c.id === id) : undefined;
      return (bind === "chapterTitle" ? ch?.title : ch?.dateLabel) ?? "";
    }
    case "pageCaption":
      return owner?.caption?.text ?? "";
  }
}

/** Panels of `layout` (except pageCaption) visible on this page, with non-empty bound text. */
function textPanels(
  doc: BookDoc,
  layout: Layout,
  owner: BookPage | null,
  offset: number,
  captionLang: string,
  binds: readonly TextBinding[],
): RenderTextPanel[] {
  const page = pageMm(doc.format);
  const out: RenderTextPanel[] = [];
  for (const t of layout.texts ?? []) {
    if (t.bind === "pageCaption" || !binds.includes(t.bind)) continue;
    const rect = shiftRect(t.box, offset);
    if (!onPage(rect)) continue;
    const text = boundText(doc, t.bind, owner);
    if (!text.trim()) continue;
    const f = roleFont(layout.style, t.font, text, { captionLang });
    const sizeMm = panelFontMm(text, t.font, (rect.w / 100) * page.w, (rect.h / 100) * page.h);
    out.push({
      bind: t.bind,
      role: t.font,
      rect,
      text,
      lang: captionTextAttrs(text, captionLang).lang,
      align: t.align,
      fontFamily: f.fontFamily,
      fontSizeCqw: round4((sizeMm / page.w) * 100),
      lineHeight: PANEL_TYPE[t.font].lineHeight,
      typography: typographyOf(f),
    });
  }
  return out;
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
  if (!layout || (layout.role !== "page" && layout.role !== "spread")) {
    return { kind: "page", pageId: page.id, layoutId: page.layout, knownLayout: false, slots: [], caption: null };
  }
  const ctx: SlotCtx = { ...opts, format: doc.format };
  const isSpread = layout.role === "spread";
  const { half, owner, offset } = isSpread
    ? spreadHalfOf(doc, pageIndex, page)
    : { half: null, owner: page, offset: 0 };

  const slots: RenderSlot[] = [];
  if (owner) {
    layout.slots.forEach((rect, i) => {
      const s = owner.slots[i];
      if (!isSpread) {
        slots.push(renderSlot(i, rect, s?.photoId ?? null, s?.crop ?? DEFAULT_CROP, photos, ctx));
      } else if (onPage(shiftRect(rect, offset))) {
        slots.push(spreadSlot(i, rect, offset, s?.photoId ?? null, s?.crop ?? DEFAULT_CROP, photos, ctx));
      }
    });
  }

  let caption: RenderCaption | null = null;
  const captionRect = layout.caption && owner ? shiftRect(layout.caption, offset) : null;
  if (captionRect && (!isSpread || onPage(captionRect))) {
    const c = owner?.caption ?? null;
    const text = c?.text ?? "";
    const attrs = captionTextAttrs(text, captionLang);
    const k = textScale(doc.format);
    const sizing = k === 1 ? {} : { fontSizeCqw: scaleCqw(CAPTION_FONT_SIZE_CQW, k) };
    if (layout.style === "classic") {
      caption = {
        rect: captionRect,
        caption: c,
        text,
        lang: attrs.lang,
        align: c?.align ?? "center",
        fontFamily: captionFontFamily(c ? captionFontOf(c, captionLang) : defaultCaptionFont("", captionLang)),
        ...sizing,
      };
    } else {
      // Design-style caption: the pageCaption panel (same box) supplies the logical alignment and
      // font role; a font stored on the caption overrides the face, and an alignment the user
      // picked (source "user") wins over the panel's.
      const panel = layout.texts?.find((t) => t.bind === "pageCaption");
      const f = roleFont(layout.style, panel?.font ?? "caption", text, { captionLang, override: c?.font ?? null });
      caption = {
        rect: captionRect,
        caption: c,
        text,
        lang: attrs.lang,
        // No caption panel: follow the page's chapter panel (a text column reads as one block).
        align: c?.source === "user" ? c.align : (panel ?? layout.texts?.find((t) => t.bind === "chapterTitle"))?.align ?? "center",
        fontFamily: f.fontFamily,
        ...sizing,
        typography: typographyOf(f),
      };
    }
  }

  const texts = layout.texts ? textPanels(doc, layout, owner, offset, captionLang, ["chapterTitle", "dateLabel"]) : [];
  return {
    kind: "page",
    pageId: page.id,
    layoutId: layout.id,
    knownLayout: true,
    slots,
    caption,
    ...(half ? { spread: half } : {}),
    ...(texts.length > 0 ? { texts } : {}),
  };
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
  const k = textScale(doc.format);
  const slot = rect ? renderSlot(0, rect, doc.cover.photoId, DEFAULT_CROP, photos, { ...opts, format: doc.format }) : null;
  const panels = known && layout.texts?.length ? textPanels(doc, layout, null, 0, captionLang, ["coverTitle", "coverSubtitle"]) : null;
  const slices = known && slot && layout.slices ? sliceWindows(layout.slices, slot.rect, doc.format, !!opts.bleed) : null;
  return {
    kind: "cover",
    layoutId: doc.cover.layout,
    knownLayout: known,
    slot,
    textRect: known ? layout.caption : null,
    title: {
      text: title,
      lang: titleAttrs.lang,
      fontFamily: captionFontFamily(coverFont(title, doc.style.font)),
      sizeCqw: scaleCqw(coverTitleSizeCqw(title), k),
    },
    subtitle: {
      text: subtitle,
      lang: subAttrs.lang,
      fontFamily: captionFontFamily(coverFont(subtitle, doc.style.font)),
    },
    ...(k === 1 ? {} : { textScale: round4(k) }),
    ...(panels ? { panels } : {}),
    ...(slices ? { slices } : {}),
  };
}

/**
 * Split-strip slices (% of the page) → windows in % of the cover slot box as rendered (`slotRect`,
 * bleed-extended in print). In print, slice sides on a trim edge run into the bleed like slots.
 */
export function sliceWindows(slices: readonly Rect[], slotRect: Rect, format: BookFormat, bleed: boolean): Rect[] {
  return slices.map((sl) => {
    const r = bleed ? bleedRect(sl, pageMm(format)).pct : sl;
    return {
      x: round4(((r.x - slotRect.x) / slotRect.w) * 100),
      y: round4(((r.y - slotRect.y) / slotRect.h) * 100),
      w: round4((r.w / slotRect.w) * 100),
      h: round4((r.h / slotRect.h) * 100),
    };
  });
}
