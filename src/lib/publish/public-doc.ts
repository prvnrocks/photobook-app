// Public snapshot of a book document (D-039: `books.published_doc`), served to anonymous viewers.
// Pure + isomorphic. Keeps ONLY what <BookPage>/<BookCover> render plus chapter titles for the
// viewer's chapter label "title · date" / Contents sheet (D-040). Kept: chapter `dateLabel` (a
// coarse human label like "March 2025" the owner shares as part of the album). Dropped: `meta`
// (generator, runId, userEdited), caption `source` (who wrote it), page background `source`
// (who chose it), chapter `place` (GPS-derived), `occasion`, and any unknown keys — objects are
// rebuilt field by field, never spread.
// `captionLang` (optional, added in the M6 review): the book's caption language frozen at publish
// time, so the viewer never reads the live books.caption_lang (D-039). Snapshots published before
// it existed simply lack the key and still parse; the viewer then falls back to the live column.
//
// Two snapshot versions (M10a A4, same rule as serializeDoc in src/lib/book/doc-version.ts):
// v1 (M6–M9 shape) whenever the doc uses no v2-only feature — so republishing an existing book
// writes a byte-identical snapshot — else v2 (format, Background union, design style, per-page
// backgrounds without `source`, spread side). parsePublicDoc returns the stored shape (v1 | v2);
// publicDocToRenderDoc normalises either to the in-memory v2 BookDoc the renderer takes.
// v2 caption `align` is the alignment the renderer shows (design-style panels resolved to left/right
// by the caption's dir="auto" direction, M10b A13), since `source` is not published.

import { z } from "zod";
import {
  BackgroundSchema,
  BookFormatSchema,
  CaptionSchema,
  ChapterSchema,
  CoverSchema,
  CropSchema,
  DEFAULT_DESIGN_STYLE,
  DesignStyleSchema,
  MAX_SLOTS_V1,
  MAX_SLOTS_V2,
  PageSchema,
  StyleSchema,
  StyleSchemaV1,
} from "@/lib/book/schema";
import { usesV2Features } from "@/lib/book/doc-version";
import { backgroundColor, captionAlignOn } from "@/lib/book/render";
import { getLayout } from "@/lib/layouts";
import { CAPTION_LANGS, type CaptionLang } from "@/lib/book/options";
import type { Background, BookDoc, BookPage, Caption } from "@/lib/book/types";
import { LIMITS } from "@/lib/ai/limits";

const PublicCaptionSchema = CaptionSchema.pick({ text: true, font: true, align: true }).strict();
const PublicSlotSchema = z.object({ photoId: PageSchema.shape.slots.element.shape.photoId, crop: CropSchema.strict() }).strict();
const PublicChapterSchema = ChapterSchema.pick({ id: true, title: true, dateLabel: true }).strict();
const CaptionLangField = z.enum(CAPTION_LANGS).optional();

const PublicPageSchemaV1 = z
  .object({
    id: PageSchema.shape.id,
    chapterId: PageSchema.shape.chapterId,
    layout: PageSchema.shape.layout,
    slots: z.array(PublicSlotSchema).max(MAX_SLOTS_V1),
    caption: PublicCaptionSchema.nullable(),
  })
  .strict();

/** v1 snapshot (M6–M9). Strict: any extra key fails to parse (viewer then shows "unavailable"). */
export const PublicBookDocV1Schema = z
  .object({
    version: z.literal(1),
    format: z.literal("A5_PORTRAIT"),
    cover: CoverSchema.strict(),
    chapters: z.array(PublicChapterSchema).max(100),
    pages: z.array(PublicPageSchemaV1).max(LIMITS.paid.maxPages),
    style: StyleSchemaV1.strict(),
    /** Optional: absent in snapshots published before the M6 review fix. */
    captionLang: CaptionLangField,
  })
  .strict();

const PublicPageSchemaV2 = z
  .object({
    id: PageSchema.shape.id,
    chapterId: PageSchema.shape.chapterId,
    layout: PageSchema.shape.layout,
    slots: z.array(PublicSlotSchema).max(MAX_SLOTS_V2),
    caption: PublicCaptionSchema.nullable(),
    /** Page override WITHOUT `source` (strict variants: a `source` key rejects the snapshot). */
    background: BackgroundSchema.optional(),
    side: PageSchema.shape.side,
  })
  .strict();

/** v2 snapshot (M10). Strict at every level, incl. inside backgrounds. */
export const PublicBookDocV2Schema = z
  .object({
    version: z.literal(2),
    format: BookFormatSchema,
    cover: CoverSchema.strict(),
    chapters: z.array(PublicChapterSchema).max(100),
    pages: z.array(PublicPageSchemaV2).max(LIMITS.paid.maxPages),
    style: z
      .object({ background: BackgroundSchema, designStyle: DesignStyleSchema, font: StyleSchema.shape.font })
      .strict(),
    captionLang: CaptionLangField,
  })
  .strict();

export const PublicBookDocSchema = z.discriminatedUnion("version", [PublicBookDocV1Schema, PublicBookDocV2Schema]);

export type PublicBookDocV1 = z.infer<typeof PublicBookDocV1Schema>;
export type PublicBookDocV2 = z.infer<typeof PublicBookDocV2Schema>;
export type PublicBookDoc = z.infer<typeof PublicBookDocSchema>;

export type ToPublicDocOptions = {
  /** books.caption_lang at publish time; stored in the snapshot when given. */
  captionLang?: CaptionLang | null;
};

function copyBackground(bg: Background): Background {
  switch (bg.kind) {
    case "color":
      return { kind: "color", hex: bg.hex };
    case "texture":
      return bg.tint === undefined
        ? { kind: "texture", textureId: bg.textureId }
        : { kind: "texture", textureId: bg.textureId, tint: bg.tint };
    case "photo":
      return { kind: "photo", photoId: bg.photoId, veil: bg.veil, veilColor: bg.veilColor };
  }
}

const publicCover = (doc: BookDoc) => ({
  layout: doc.cover.layout,
  photoId: doc.cover.photoId,
  title: doc.cover.title,
  subtitle: doc.cover.subtitle,
});
const publicChapters = (doc: BookDoc) => doc.chapters.map((c) => ({ id: c.id, title: c.title, dateLabel: c.dateLabel }));
const publicPageBase = (p: BookPage) => ({
  id: p.id,
  chapterId: p.chapterId,
  layout: p.layout,
  slots: p.slots.map((s) => ({
    photoId: s.photoId,
    crop: { x: s.crop.x, y: s.crop.y, zoom: s.crop.zoom },
  })),
  caption: p.caption ? { text: p.caption.text, font: p.caption.font, align: p.caption.align } : null,
});

/** Direction `dir="auto"` gives `text`: its first strong (letter) character, LTR when none. */
export function autoDirection(text: string): "ltr" | "rtl" {
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    return /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u.test(ch)
      ? "rtl"
      : "ltr";
  }
  return "ltr";
}

/**
 * The caption alignment a v2 snapshot stores: the one the renderer would use for the source doc,
 * as a physical value. Design-style layouts follow their text panel's LOGICAL alignment for
 * captions the user didn't align (source ≠ "user") — but the snapshot drops `source` (who wrote
 * the caption) and the render doc marks every caption "user", so the viewer would show the stored
 * value (usually "center") instead (M10b A13). A logical start/end is resolved with the
 * direction dir="auto" gives the caption, which renders identically.
 */
function publicCaptionAlign(page: BookPage, c: Caption): Caption["align"] {
  const layout = getLayout(page.layout);
  if (!layout) return c.align;
  const a = captionAlignOn(layout, c);
  if (a !== "start" && a !== "end") return a;
  const rtl = autoDirection(c.text) === "rtl";
  return (a === "start") !== rtl ? "left" : "right";
}

/**
 * Public copy of a (parsed) book doc: v1 shape when the doc uses no v2-only feature (byte-identical
 * to M6–M9 snapshots), else v2. Fresh objects, never aliases `doc`.
 */
export function toPublicDoc(doc: BookDoc, opts: ToPublicDocOptions = {}): PublicBookDoc {
  let out: PublicBookDoc;
  if (!usesV2Features(doc)) {
    out = {
      version: 1,
      format: "A5_PORTRAIT",
      cover: publicCover(doc),
      chapters: publicChapters(doc),
      pages: doc.pages.map(publicPageBase),
      // No v2 feature ⇒ colour background; backgroundColor gives its hex.
      style: { background: backgroundColor(doc.style.background), font: doc.style.font },
    };
  } else {
    out = {
      version: 2,
      format: doc.format,
      cover: publicCover(doc),
      chapters: publicChapters(doc),
      pages: doc.pages.map((p) => {
        const page: PublicBookDocV2["pages"][number] = publicPageBase(p);
        if (p.caption && page.caption) page.caption.align = publicCaptionAlign(p, p.caption);
        if (p.background) page.background = copyBackground(p.background);
        if (p.side !== undefined) page.side = p.side;
        return page;
      }),
      style: {
        background: copyBackground(doc.style.background),
        designStyle: doc.style.designStyle ?? DEFAULT_DESIGN_STYLE,
        font: doc.style.font,
      },
    };
  }
  if (opts.captionLang === "en" || opts.captionLang === "ar") out.captionLang = opts.captionLang;
  return out;
}

export type PublicDocParse = { ok: true; doc: PublicBookDoc } | { ok: false };

/** Validate `books.published_doc` read from the DB (v1 or v2 snapshot) before rendering it. */
export function parsePublicDoc(input: unknown): PublicDocParse {
  const r = PublicBookDocSchema.safeParse(input);
  return r.success ? { ok: true, doc: r.data } : { ok: false };
}

/**
 * Adapter for the shared renderer, whose props are typed as the full BookDoc. Fills fields the
 * renderer never reads with neutral values (caption and page-background source "user", null place,
 * occasion "other", no meta). Returns the in-memory v2 doc (v1 snapshot upgraded: colour
 * background, classic style). Render-only — never save the result as a book doc.
 */
export function publicDocToRenderDoc(pub: PublicBookDoc): BookDoc {
  const base = {
    version: 2 as const,
    occasion: "other" as const,
    cover: { ...pub.cover },
    chapters: pub.chapters.map((c) => ({ id: c.id, title: c.title, dateLabel: c.dateLabel, place: null })),
  };
  const page = (p: PublicBookDoc["pages"][number]): BookPage => ({
    id: p.id,
    chapterId: p.chapterId,
    layout: p.layout,
    slots: p.slots.map((s) => ({ photoId: s.photoId, crop: { ...s.crop } })),
    caption: p.caption ? { ...p.caption, source: "user" } : null,
  });
  if (pub.version === 1) {
    return {
      ...base,
      format: pub.format,
      pages: pub.pages.map(page),
      style: { background: { kind: "color", hex: pub.style.background }, designStyle: DEFAULT_DESIGN_STYLE, font: pub.style.font },
    };
  }
  return {
    ...base,
    format: pub.format,
    pages: pub.pages.map((p) => {
      const out = page(p);
      if (p.background) out.background = { ...copyBackground(p.background), source: "user" };
      if (p.side !== undefined) out.side = p.side;
      return out;
    }),
    style: { background: copyBackground(pub.style.background), designStyle: pub.style.designStyle, font: pub.style.font },
  };
}

/**
 * Distinct photo ids the public doc shows — the only photos the viewer may sign URLs for. Order:
 * cover, page slots in page order, then background photos (book default, then page overrides), so
 * the OG image's "first photo" stays a content photo.
 */
export function publicPhotoIds(pub: PublicBookDoc): string[] {
  const seen = new Set<string>();
  const add = (id: string | null) => {
    if (id !== null && !seen.has(id)) seen.add(id);
  };
  add(pub.cover.photoId);
  for (const p of pub.pages) for (const s of p.slots) add(s.photoId);
  if (pub.version === 2) {
    if (pub.style.background.kind === "photo") add(pub.style.background.photoId);
    for (const p of pub.pages) if (p.background?.kind === "photo") add(p.background.photoId);
  }
  return [...seen];
}
