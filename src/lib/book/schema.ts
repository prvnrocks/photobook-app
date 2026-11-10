// Zod schemas for the book document (`books.doc`) — the single source of truth rendered by
// editor, flipbook viewer and PDF. See docs/PLAN.md → "Book document format".
// Pure (no server-only): used by client editor, API routes and the AI pipeline.
//
// Two stored versions (M10, D-062): v1 (M1–M9: A5 portrait, hex background) and v2 (formats,
// Background union, design style, page backgrounds). parseBookDoc accepts both and ALWAYS returns
// v2 (src/lib/book/doc-version.ts upgrades v1 1:1); writers go through serializeDoc, which writes
// v1 whenever the doc uses no v2-only feature, so existing books stay byte-identical.

import { z } from "zod";
import { LIMITS } from "@/lib/ai/limits";
import { BACKGROUND_VEIL_MAX, BACKGROUND_VEIL_MIN, TEXTURE_IDS } from "@/lib/design/backgrounds";
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

export const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

// --- Backgrounds (v2) ----------------------------------------------------------------------------
// The texture ids and veil range come from src/lib/design/backgrounds.ts (catalogue + rendering
// helpers); the zod schema — and the `Background` type inferred from it — live here. Strict:
// an unknown key inside a background rejects the doc (never silently dropped).

export const ColorBackgroundSchema = z.strictObject({ kind: z.literal("color"), hex: HexColorSchema });
export const TextureBackgroundSchema = z.strictObject({
  kind: z.literal("texture"),
  textureId: z.enum(TEXTURE_IDS),
  /** Optional #RRGGBB multiplied over the texture. */
  tint: HexColorSchema.optional(),
});
export const PhotoBackgroundSchema = z.strictObject({
  kind: z.literal("photo"),
  /** photos.id (uuid) of one of the book's photos. */
  photoId: z.uuid(),
  /** Veil opacity over the photo (faded photo look; no blur — D-062 / plan decision 10). */
  veil: z.number().min(BACKGROUND_VEIL_MIN).max(BACKGROUND_VEIL_MAX),
  veilColor: HexColorSchema,
});

export const BackgroundSchema = z.discriminatedUnion("kind", [
  ColorBackgroundSchema,
  TextureBackgroundSchema,
  PhotoBackgroundSchema,
]);

/** Who chose a page background: AI never overwrites a "user" background. Required. */
export const BackgroundSourceSchema = z.enum(["ai", "user"]);
const withSource = { source: BackgroundSourceSchema };
export const PageBackgroundSchema = z.discriminatedUnion("kind", [
  ColorBackgroundSchema.extend(withSource),
  TextureBackgroundSchema.extend(withSource),
  PhotoBackgroundSchema.extend(withSource),
]);

export const BOOK_FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const;
export const BookFormatSchema = z.enum(BOOK_FORMATS);
export const DESIGN_STYLES = ["classic", "modern", "geometric", "scrapbook"] as const;
export const DesignStyleSchema = z.enum(DESIGN_STYLES);
export const DEFAULT_DESIGN_STYLE = "classic" satisfies (typeof DESIGN_STYLES)[number];

/** Slots per page: v1 docs keep the M1–M9 cap; v2 allows dense grids (M10b). */
export const MAX_SLOTS_V1 = 8;
export const MAX_SLOTS_V2 = 12;

// --- Page + style, v1 (stored by M1–M9) ----------------------------------------------------------

export const PageSchemaV1 = z.object({
  id: IdSchema,
  chapterId: IdSchema.nullable(),
  layout: IdSchema,
  slots: z.array(SlotSchema).max(MAX_SLOTS_V1),
  caption: CaptionSchema.nullable(),
});

export const StyleSchemaV1 = z.object({
  background: HexColorSchema,
  font: FontSchema,
});

// --- Page + style, v2 (in-memory shape everywhere) -----------------------------------------------

export const PageSchema = z.object({
  id: IdSchema,
  chapterId: IdSchema.nullable(),
  layout: IdSchema,
  slots: z.array(SlotSchema).max(MAX_SLOTS_V2),
  caption: CaptionSchema.nullable(),
  /** Page override of style.background; absent/null = the book default. */
  background: PageBackgroundSchema.nullable().optional(),
  /** Half of a spread layout (M10b, plan decision 2). Accepted now, not used yet. */
  side: z.enum(["left", "right"]).optional(),
});

export const StyleSchema = z.object({
  /** Book default background. */
  background: BackgroundSchema,
  /** Absent = "classic". */
  designStyle: DesignStyleSchema.optional(),
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

/** The stored M1–M9 shape. Only used to read old rows and by serializeDoc's v1 output. */
export const BookDocV1Schema = z.object({
  version: z.literal(1),
  format: z.literal("A5_PORTRAIT"),
  occasion: OccasionSchema,
  cover: CoverSchema,
  chapters: z.array(ChapterSchema).max(100),
  pages: z.array(PageSchemaV1).max(LIMITS.paid.maxPages),
  style: StyleSchemaV1,
  meta: DocMetaSchema.optional(),
});

/** v2 — what parseBookDoc returns and every renderer/editor/AI step works on. */
export const BookDocSchema = z.object({
  version: z.literal(2),
  format: BookFormatSchema,
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

/**
 * Shape check only. Accepts a stored v1 or v2 doc and ALWAYS returns v2 (v1 is upgraded 1:1, see
 * upgradeDocV1). `version` picks the schema; anything else (missing, 3, …) is checked against v2
 * so the issue list names the version. Issues contain paths + zod codes, never field values.
 */
export function parseBookDoc(input: unknown): ParseResult {
  const version = input !== null && typeof input === "object" ? (input as { version?: unknown }).version : undefined;
  if (version === 1) {
    const r = BookDocV1Schema.safeParse(input);
    if (r.success) return { ok: true, doc: upgradeV1(r.data) };
    return { ok: false, issues: zodIssues(r.error) };
  }
  const r = BookDocSchema.safeParse(input);
  if (r.success) return { ok: true, doc: r.data };
  return { ok: false, issues: zodIssues(r.error) };
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
}

/**
 * v1 → v2, 1:1 (re-exported as upgradeDocV1 from doc-version.ts). Lives here so parseBookDoc has
 * no import cycle. Only copies known keys: the result must serialize back to the same v1 JSON.
 */
export function upgradeV1(v1: z.infer<typeof BookDocV1Schema>): z.infer<typeof BookDocSchema> {
  const doc: z.infer<typeof BookDocSchema> = {
    version: 2,
    format: v1.format,
    occasion: v1.occasion,
    cover: { ...v1.cover },
    chapters: v1.chapters.map((c) => ({ ...c })),
    pages: v1.pages.map((p) => ({
      id: p.id,
      chapterId: p.chapterId,
      layout: p.layout,
      slots: p.slots.map((s) => ({ photoId: s.photoId, crop: { ...s.crop } })),
      caption: p.caption === null ? null : { ...p.caption },
    })),
    style: { background: { kind: "color", hex: v1.style.background }, designStyle: DEFAULT_DESIGN_STYLE, font: v1.style.font },
  };
  if (v1.meta !== undefined) doc.meta = { ...v1.meta };
  return doc;
}

export interface ValidateOptions {
  /** Ids of the book's photos that may be placed (e.g. status = ready, not excluded). */
  photoIds: Set<string>;
  /**
   * Ids a photo background (book default or page override) may use. Default = photoIds.
   * Wider than photoIds where a user may pick an AI-dropped photo as a faded background (D-062):
   * Update album passes every ready photo (kept + dropped) here and only kept ones in photoIds.
   * AI-built docs keep the default (AI background suggestions must use kept photos only).
   */
  backgroundPhotoIds?: ReadonlySet<string>;
  maxPages: number;
}

/**
 * Semantic checks on a shape-valid doc: layouts exist and match role, slot count == photoCount,
 * photos exist and are used at most once in pages (the cover photo may appear once more),
 * page count ≤ maxPages, chapter/page ids unique, chapterIds exist, photo backgrounds (book
 * default and page overrides) use a known photo (backgroundPhotoIds, default photoIds) — a
 * background photo may also be on a page.
 * Returns [] when valid. Issue strings contain indices and layout ids only — no user data.
 */
export function validateBookDoc(
  doc: z.infer<typeof BookDocSchema>,
  { photoIds, backgroundPhotoIds = photoIds, maxPages }: ValidateOptions,
): string[] {
  const issues: string[] = [];

  const coverLayout = getLayout(doc.cover.layout);
  if (!coverLayout) issues.push(`cover: unknown layout "${safeId(doc.cover.layout)}"`);
  else if (coverLayout.role !== "cover") issues.push(`cover: layout "${coverLayout.id}" is not a cover layout`);
  if (doc.cover.photoId !== null && !photoIds.has(doc.cover.photoId)) {
    issues.push("cover: unknown photo");
  }

  if (doc.style.background.kind === "photo" && !backgroundPhotoIds.has(doc.style.background.photoId)) {
    issues.push("style.background: unknown photo");
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
    if (page.background?.kind === "photo" && !backgroundPhotoIds.has(page.background.photoId)) {
      issues.push(`${at}.background: unknown photo`);
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
