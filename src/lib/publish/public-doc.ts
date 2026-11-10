// Public snapshot of a book document (D-039: `books.published_doc`), served to anonymous viewers.
// Pure + isomorphic. Keeps ONLY what <BookPage>/<BookCover> render plus chapter titles for the
// viewer's chapter label "title · date" / Contents sheet (D-040). Kept: chapter `dateLabel` (a
// coarse human label like "March 2025" the owner shares as part of the album). Dropped: `meta`
// (generator, runId, userEdited), caption `source` (who wrote it), chapter `place` (GPS-derived),
// `occasion`, and any unknown keys — objects are rebuilt field by field, never spread.

import { z } from "zod";
import {
  CaptionSchema,
  ChapterSchema,
  CoverSchema,
  CropSchema,
  PageSchema,
  StyleSchema,
} from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { LIMITS } from "@/lib/ai/limits";

const PublicCaptionSchema = CaptionSchema.pick({ text: true, font: true, align: true }).strict();
const PublicSlotSchema = z.object({ photoId: PageSchema.shape.slots.element.shape.photoId, crop: CropSchema.strict() }).strict();
const PublicPageSchema = z
  .object({
    id: PageSchema.shape.id,
    chapterId: PageSchema.shape.chapterId,
    layout: PageSchema.shape.layout,
    slots: z.array(PublicSlotSchema).max(8),
    caption: PublicCaptionSchema.nullable(),
  })
  .strict();
const PublicChapterSchema = ChapterSchema.pick({ id: true, title: true, dateLabel: true }).strict();

/** Strict: a published_doc with any extra key fails to parse (viewer then shows "unavailable"). */
export const PublicBookDocSchema = z
  .object({
    version: z.literal(1),
    format: z.literal("A5_PORTRAIT"),
    cover: CoverSchema.strict(),
    chapters: z.array(PublicChapterSchema).max(100),
    pages: z.array(PublicPageSchema).max(LIMITS.paid.maxPages),
    style: StyleSchema.strict(),
  })
  .strict();

export type PublicBookDoc = z.infer<typeof PublicBookDocSchema>;

/** Public copy of a (parsed) book doc. */
export function toPublicDoc(doc: BookDoc): PublicBookDoc {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    cover: {
      layout: doc.cover.layout,
      photoId: doc.cover.photoId,
      title: doc.cover.title,
      subtitle: doc.cover.subtitle,
    },
    chapters: doc.chapters.map((c) => ({ id: c.id, title: c.title, dateLabel: c.dateLabel })),
    pages: doc.pages.map((p) => ({
      id: p.id,
      chapterId: p.chapterId,
      layout: p.layout,
      slots: p.slots.map((s) => ({
        photoId: s.photoId,
        crop: { x: s.crop.x, y: s.crop.y, zoom: s.crop.zoom },
      })),
      caption: p.caption ? { text: p.caption.text, font: p.caption.font, align: p.caption.align } : null,
    })),
    style: { background: doc.style.background, font: doc.style.font },
  };
}

export type PublicDocParse = { ok: true; doc: PublicBookDoc } | { ok: false };

/** Validate `books.published_doc` read from the DB before rendering it. */
export function parsePublicDoc(input: unknown): PublicDocParse {
  const r = PublicBookDocSchema.safeParse(input);
  return r.success ? { ok: true, doc: r.data } : { ok: false };
}

/**
 * Adapter for the shared renderer, whose props are typed as the full BookDoc. Fills fields the
 * renderer never reads with neutral values (caption source "user", null place,
 * occasion "other", no meta). Render-only — never save the result as a book doc.
 */
export function publicDocToRenderDoc(pub: PublicBookDoc): BookDoc {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "other",
    cover: { ...pub.cover },
    chapters: pub.chapters.map((c) => ({ id: c.id, title: c.title, dateLabel: c.dateLabel, place: null })),
    pages: pub.pages.map((p) => ({
      id: p.id,
      chapterId: p.chapterId,
      layout: p.layout,
      slots: p.slots.map((s) => ({ photoId: s.photoId, crop: { ...s.crop } })),
      caption: p.caption ? { ...p.caption, source: "user" } : null,
    })),
    style: { ...pub.style },
  };
}

/** Distinct photo ids the public doc shows (cover first, then page order) — the only photos the
 * viewer may sign URLs for. */
export function publicPhotoIds(pub: PublicBookDoc): string[] {
  const seen = new Set<string>();
  const add = (id: string | null) => {
    if (id !== null && !seen.has(id)) seen.add(id);
  };
  add(pub.cover.photoId);
  for (const p of pub.pages) for (const s of p.slots) add(s.photoId);
  return [...seen];
}
