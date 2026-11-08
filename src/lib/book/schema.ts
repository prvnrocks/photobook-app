// Zod schemas for the book document (`books.doc`) — the single source of truth rendered by
// editor, flipbook viewer and PDF. See docs/PLAN.md → "Book document format".
// Pure (no server-only): used by client editor, API routes and the AI pipeline.

import { z } from "zod";
import { LIMITS } from "@/lib/ai/limits";
import { getLayout } from "@/lib/layouts";
import { codePointLength, hasLoneSurrogate } from "@/lib/text/clip";
import { BOOK_TITLE_MAX_CODE_POINTS, CAPTION_LANGS, OCCASIONS, TONES } from "./options";

export const OccasionSchema = z.enum(OCCASIONS);
export const ToneSchema = z.enum(TONES);
export const CaptionLangSchema = z.enum(CAPTION_LANGS);

/**
 * Text that Postgres jsonb accepts: no unpaired UTF-16 surrogates (e.g. half an emoji from a bad
 * `slice`). Without this a doc passes validation and then fails on write, every time.
 */
const NO_LONE_SURROGATE = { message: "contains an unpaired UTF-16 surrogate" };
const wellFormed = (s: string) => !hasLoneSurrogate(s);
/** String of at most `maxUnits` UTF-16 units (zod .max counts `.length`), well-formed. */
const text = (maxUnits: number) => z.string().max(maxUnits).refine(wellFormed, NO_LONE_SURROGATE);

const IdSchema = z.string().min(1).max(64).refine(wellFormed, NO_LONE_SURROGATE);
const FontSchema = z.string().regex(/^[A-Za-z0-9 ]{1,40}$/);

/** Focal point (x, y as 0..1 of the photo) + zoom (1 = cover the slot exactly). */
export const CropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  zoom: z.number().min(1).max(4),
});

export const SlotSchema = z.object({
  photoId: IdSchema.nullable(),
  crop: CropSchema,
});

/**
 * `source` records who wrote the text: "ai" (pipeline), "user" (typed/edited in the editor —
 * must never be overwritten by AI), "auto" (rule-based fallback, e.g. date/place label).
 */
export const CaptionSchema = z.object({
  text: text(200),
  font: FontSchema,
  align: z.enum(["left", "center", "right"]),
  source: z.enum(["ai", "user", "auto"]),
});

export const ChapterSchema = z.object({
  id: IdSchema,
  title: text(80),
  dateLabel: text(40),
  place: text(80).nullable(),
});

export const CoverSchema = z.object({
  layout: IdSchema,
  photoId: IdSchema.nullable(),
  /**
   * The user's book title, never shortened: limit is BOOK_TITLE_MAX_CODE_POINTS (120) code points,
   * same unit as TITLE_MAX_CHARS / Postgres char_length. The zod .max(240) is the matching UTF-16
   * bound (each code point is ≤ 2 units); the refine enforces the real code-point limit.
   */
  title: text(BOOK_TITLE_MAX_CODE_POINTS * 2).refine(
    (s) => codePointLength(s) <= BOOK_TITLE_MAX_CODE_POINTS,
    { message: `more than ${BOOK_TITLE_MAX_CODE_POINTS} code points` },
  ),
  subtitle: text(120),
});

export const PageSchema = z.object({
  id: IdSchema,
  chapterId: IdSchema.nullable(),
  layout: IdSchema,
  slots: z.array(SlotSchema).max(8),
  caption: CaptionSchema.nullable(),
});

export const StyleSchema = z.object({
  background: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  font: FontSchema,
});

export const GENERATORS = ["rule", "ai"] as const;
export const GeneratorSchema = z.enum(GENERATORS);

/**
 * Album origin marker (D-018). Optional on the doc: a doc without `meta` (written by M2) means
 * "rule-built, not edited". The AI may replace `books.doc` only when it is `{}` or
 * `meta.userEdited === false` (see src/lib/book/replaceable.ts).
 *
 * Strict: unknown keys inside `meta` are REJECTED (the whole doc fails to parse), not stripped.
 * `meta` drives an overwrite decision, so an unexpected shape must land on the safe side —
 * docOrigin() treats an unparsable doc as user-edited and it is never overwritten.
 */
export const DocMetaSchema = z
  .object({
    generator: GeneratorSchema,
    generatorVersion: z.number().int().min(1),
    /** agent_runs.id for AI-built docs; null for rule-built docs. */
    runId: z.uuid().nullable(),
    /** Set to true by the editor (M5) on the first user change; AI never overwrites it. */
    userEdited: z.boolean(),
  })
  .strict();

export const BookDocSchema = z.object({
  version: z.literal(1),
  format: z.literal("A5_PORTRAIT"),
  occasion: OccasionSchema,
  cover: CoverSchema,
  chapters: z.array(ChapterSchema).max(100),
  pages: z.array(PageSchema).max(LIMITS.paid.maxPages),
  style: StyleSchema,
  meta: DocMetaSchema.optional(),
});

/** Rectangle in % of the page (0..100). */
export const RectSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  w: z.number().positive().max(100),
  h: z.number().positive().max(100),
});

export const LayoutSlotSchema = RectSchema;

export const LayoutSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /** "cover" layouts are only valid for `doc.cover`, "page" layouts only for `doc.pages`. */
  role: z.enum(["cover", "page"]),
  photoCount: z.number().int().min(1).max(8),
  prefers: z.array(z.enum(["portrait", "landscape", "any"])),
  slots: z.array(LayoutSlotSchema),
  caption: RectSchema.nullable(),
});

export type ParseResult =
  | { ok: true; doc: z.infer<typeof BookDocSchema> }
  | { ok: false; issues: string[] };

/** Shape check only. Issues contain paths + zod codes, never field values. */
export function parseBookDoc(input: unknown): ParseResult {
  const r = BookDocSchema.safeParse(input);
  if (r.success) return { ok: true, doc: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
  };
}

export interface ValidateOptions {
  /** Ids of the book's photos that may be placed (e.g. status = ready, not excluded). */
  photoIds: Set<string>;
  maxPages: number;
}

/**
 * Semantic checks on a shape-valid doc: layouts exist and match role, slot count == photoCount,
 * photos exist and are used at most once in pages (the cover photo may appear once more),
 * page count ≤ maxPages, chapter/page ids unique, chapterIds exist.
 * Returns [] when valid. Issue strings contain indices and layout ids only — no user data.
 */
export function validateBookDoc(
  doc: z.infer<typeof BookDocSchema>,
  { photoIds, maxPages }: ValidateOptions,
): string[] {
  const issues: string[] = [];

  const coverLayout = getLayout(doc.cover.layout);
  if (!coverLayout) issues.push(`cover: unknown layout "${safeId(doc.cover.layout)}"`);
  else if (coverLayout.role !== "cover") issues.push(`cover: layout "${coverLayout.id}" is not a cover layout`);
  if (doc.cover.photoId !== null && !photoIds.has(doc.cover.photoId)) {
    issues.push("cover: unknown photo");
  }

  if (doc.pages.length > maxPages) {
    issues.push(`pages: ${doc.pages.length} pages exceeds limit of ${maxPages}`);
  }

  const chapterIds = new Set<string>();
  doc.chapters.forEach((c, i) => {
    if (chapterIds.has(c.id)) issues.push(`chapters[${i}]: duplicate chapter id`);
    chapterIds.add(c.id);
  });

  const pageIds = new Set<string>();
  const used = new Set<string>();
  doc.pages.forEach((page, i) => {
    const at = `pages[${i}]`;
    if (pageIds.has(page.id)) issues.push(`${at}: duplicate page id`);
    pageIds.add(page.id);

    if (page.chapterId !== null && !chapterIds.has(page.chapterId)) {
      issues.push(`${at}: unknown chapter`);
    }

    const layout = getLayout(page.layout);
    if (!layout) {
      issues.push(`${at}: unknown layout "${safeId(page.layout)}"`);
    } else {
      if (layout.role !== "page") issues.push(`${at}: layout "${layout.id}" is not a page layout`);
      if (page.slots.length !== layout.photoCount) {
        issues.push(
          `${at}: layout "${layout.id}" needs ${layout.photoCount} slots, got ${page.slots.length}`,
        );
      }
      if (page.caption !== null && layout.caption === null) {
        issues.push(`${at}: layout "${layout.id}" has no caption area`);
      }
    }

    page.slots.forEach((slot, j) => {
      if (slot.photoId === null) return;
      if (!photoIds.has(slot.photoId)) issues.push(`${at}.slots[${j}]: unknown photo`);
      else if (used.has(slot.photoId)) issues.push(`${at}.slots[${j}]: photo used more than once`);
      used.add(slot.photoId);
    });
  });

  return issues;
}

/** Layout ids come from code/AI, but cap and sanitise before echoing them in an issue. */
function safeId(id: string): string {
  return id.replace(/[^a-z0-9-]/gi, "?").slice(0, 32);
}
