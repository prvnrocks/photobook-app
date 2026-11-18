// AI Balanced Storybook — domain schemas (Task 1 foundation, no runtime wiring yet).
//
// These describe the STORY layer that sits between the existing AI pipeline (Curator →
// Storyteller → Caption Writer → Critic, src/lib/ai) and the book document (src/lib/book). The
// book doc stays the single source of truth for rendering: a Storybook is composed INTO a book
// doc by the Page Composition module; nothing here is read by <BookPage>.
//
// Pure module: zod only, no server-only imports — safe for client, server and tests.
// Enums are reused from the existing code so the two layers cannot drift.

import { z } from "zod";
import { DROP_REASONS, MOODS, SCENES } from "@/lib/ai/schemas";
import { CAPTION_LANGS, OCCASIONS, TONES } from "@/lib/book/options";
import { BOOK_FORMATS, DESIGN_STYLES } from "@/lib/book/schema";
import { STORY_ANSWER_MAX, STORY_QUESTIONS_MAX, STORY_TONES } from "@/lib/story/questions";
import { codePointLength, hasLoneSurrogate } from "@/lib/text/clip";

/** Bump when a stored shape changes incompatibly; older rows are migrated on read. */
export const STORYBOOK_SCHEMA_VERSION = 1;

/** Balanced Storybook target: 65 % of the page area is photos, 35 % narrative. */
export const STORY_BALANCE = { photoShare: 0.65, narrativeShare: 0.35, tolerance: 0.05 } as const;

export const STORY_LIMITS = {
  photosPerBook: 500, // = paid AI analysis limit (src/lib/ai/limits.ts)
  momentsPerBook: 100, // = AlbumPlanStrictSchema
  chaptersPerBook: 30,
  pagesPerBook: 100, // = paid page limit
  photosPerPage: 6, // = largest layout in the catalogue
  blocksPerPage: 4,
  /** UTF-16 units, like the book doc's text limits. */
  title: 120,
  shortText: 80,
  factText: 200,
  noteText: 600,
  /** One narrative block. ~120 words; the Critic enforces the word budget per block kind. */
  narrativeText: 900,
  people: 20,
  places: 20,
  facts: 20,
  avoid: 10,
  tags: 8,
} as const;

// ---------------------------------------------------------------------------- primitives

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "uuid");
/** Stable ids inside one storybook: m1, c1, pg1, b1 … (same style as the AI moment ids). */
const localId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[1-9]\\d{0,3}$`), `id must look like ${prefix}3`);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0, { message: "blank" })
    .refine((v) => !hasLoneSurrogate(v), { message: "lone surrogate" });
const isoDateTime = z.string().datetime({ offset: true });
const share = z.number().min(0).max(1);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

function unique<T>(items: readonly T[], key: (t: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}

// ---------------------------------------------------------------------------- versioning

/** Who wrote a piece of content. "user" content is never overwritten by an AI run. */
export const CONTENT_SOURCES = ["ai", "user"] as const;
export const ContentSourceSchema = z.enum(CONTENT_SOURCES);

/**
 * Provenance of one editable piece (narrative block, title, context). `rev` counts changes to
 * this piece; `aiVersion` is the storybook version whose AI run last wrote it (kept after a user
 * edit, so "restore AI text" can find the draft in storybook_versions).
 */
export const ProvenanceSchema = z
  .object({
    source: ContentSourceSchema,
    rev: int(1, 100000),
    aiVersion: int(1, 100000).nullable(),
    editedAt: isoDateTime.nullable(),
  })
  .strict()
  .refine((p) => p.source !== "ai" || p.aiVersion !== null, { message: "ai content needs aiVersion", path: ["aiVersion"] })
  .refine((p) => p.source !== "user" || p.editedAt !== null, { message: "user content needs editedAt", path: ["editedAt"] });

/** What produced a version (stored with every snapshot; never contains photo content). */
export const StoryGeneratorSchema = z
  .object({
    pipeline: z.string().min(1).max(40), // e.g. "storybook-1"
    model: z.string().min(1).max(64).nullable(), // null for rule-built / user versions
    prompts: z.record(z.string().max(40), z.string().max(40)), // agent → prompt version
  })
  .strict();

export const VERSION_ORIGINS = ["ai", "user", "merge", "rule"] as const;
export const VersionOriginSchema = z.enum(VERSION_ORIGINS);

// ---------------------------------------------------------------------------- ① Photo Intelligence

/** What a photo can do in a story. A SUGGESTION from the vision model; the planner decides. */
export const STORY_PHOTO_ROLES = ["establishing", "action", "portrait", "detail", "emotion", "closing"] as const;

/** photos.drop_reason is free text (Curator reasons + the user's own removal); anything else is "other". */
export const STORY_DROP_REASONS = [...DROP_REASONS, "user_removed", "other"] as const;

export const VISION_LIMITS = { objects: 12, objectText: 40, activities: 6, activityText: 60 } as const;

/**
 * Output of the Photo Intelligence service (src/lib/ai/photo-intelligence) for one photo.
 * Everything here is about what is VISIBLE. There is deliberately no field for names,
 * relationships, dates, places or memories: those come only from metadata or the user.
 * `atmosphere` is the one subjective field and says so in the data (`interpretation: true`).
 */
export const PhotoVisionSchema = z
  .object({
    description: text(STORY_LIMITS.factText),
    scene: z.enum(SCENES),
    objects: z.array(text(VISION_LIMITS.objectText)).max(VISION_LIMITS.objects),
    activities: z.array(text(VISION_LIMITS.activityText)).max(VISION_LIMITS.activities),
    peopleCount: int(0, 200),
    /** From the stored pixel size, not from the model. */
    orientation: z.enum(["portrait", "landscape", "square"]),
    storyRole: z.enum(STORY_PHOTO_ROLES),
    atmosphere: z.object({ label: z.enum(MOODS), interpretation: z.literal(true) }).strict(),
    model: z.string().min(1).max(64),
    promptVersion: z.string().min(1).max(40),
  })
  .strict();

/**
 * One photo as the story layer sees it: the upload pipeline's metadata (exifr, dHash, blur,
 * colour) + the Curator's note (photos.ai) + optional story signals added by Task 2.
 * `description` is user data: never logged to analytics, deleted with the photo.
 */
export const PhotoAnalysisSchema = z
  .object({
    v: z.literal(STORYBOOK_SCHEMA_VERSION),
    photoId: uuid,
    // metadata (photos row)
    takenAt: isoDateTime.nullable(),
    dateSource: z.enum(["exif", "file"]).nullable(),
    place: text(STORY_LIMITS.shortText).nullable(),
    hasGps: z.boolean(),
    orientation: z.enum(["portrait", "landscape", "square"]),
    aspect: z.number().positive().max(20),
    blurScore: z.number().min(0).nullable(),
    dupGroup: z.number().int().min(0).nullable(),
    color: z.string().regex(/^#[0-9a-f]{6}$/).nullable(),
    // Curator note (photos.ai) — null when the photo has not been analysed (AI off / over limit)
    ai: z
      .object({
        description: text(STORY_LIMITS.factText),
        scene: z.enum(SCENES),
        peopleCount: int(0, 200),
        mood: z.enum(MOODS),
        quality: int(1, 10),
        coverWorthy: z.boolean(),
      })
      .strict()
      .nullable(),
    // decision (photos.status / drop_reason / user_override)
    keep: z.boolean(),
    dropReason: z.enum(STORY_DROP_REASONS).nullable(),
    userOverride: z.boolean(),
    /** Photo Intelligence result (Task 3); absent until the photo was analysed. */
    vision: PhotoVisionSchema.optional(),
    // story signals (optional; filled by Photo Intelligence in Task 2)
    story: z
      .object({
        /** 1–10: how much this photo carries the story (a turning point scores high). */
        significance: int(1, 10),
        /** What the photo can do in the story. */
        role: z.enum(STORY_PHOTO_ROLES),
        tags: z.array(text(40)).max(STORY_LIMITS.tags),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((p) => p.keep || p.dropReason !== null || p.userOverride, { message: "dropped photo needs a reason", path: ["dropReason"] })
  .refine((p) => !p.keep || p.dropReason === null, { message: "kept photo has no dropReason", path: ["dropReason"] });

// ---------------------------------------------------------------------------- ② Memory Context

export const PersonSchema = z
  .object({
    name: text(40),
    /** Free text the user typed, e.g. "my sister", "the groom". */
    relation: text(STORY_LIMITS.shortText).nullable(),
  })
  .strict();

/**
 * One answer the user gave on the wizard's story step ("Every memory has a story.").
 * `question` is the server's prompt text for `questionId` at the time of answering (never client
 * text); `text` is the user's own words or a chip the user tapped. `source` can only be "user":
 * an unanswered question has NO entry — the AI never fills one in.
 */
export const StoryAnswerSchema = z
  .object({
    questionId: z.string().max(60).regex(/^[a-z]+\.[a-z_]+$/, "question id must look like travel.companions"),
    question: text(200),
    /** 1–STORY_ANSWER_MAX Unicode code points (Postgres char_length), not UTF-16 units. */
    text: z
      .string()
      .min(1)
      .refine((v) => codePointLength(v) <= STORY_ANSWER_MAX, { message: "too long" })
      .refine((v) => v.trim().length > 0, { message: "blank" })
      .refine((v) => !hasLoneSurrogate(v), { message: "lone surrogate" }),
    source: z.literal("user"),
  })
  .strict();

/**
 * What the USER tells us about the memory, so the narrative can use real names and facts instead
 * of inventing them (CLAUDE.md: never invent names/places/facts not in the metadata). Everything
 * here is user-written or user-confirmed; the AI may only quote from it.
 *
 * Separation rule: this object holds ONLY what the user said or confirmed. What the model sees in
 * the photos is an AiObservation (below) and lives with the photo (PhotoVisionSchema /
 * photos.ai), never here: the schema is strict, has no field for model output, and the only
 * `source` it accepts is "user".
 */
export const MemoryContextSchema = z
  .object({
    v: z.literal(STORYBOOK_SCHEMA_VERSION),
    occasion: z.enum(OCCASIONS),
    /** The book's tone (books.tone). */
    tone: z.enum(TONES),
    lang: z.enum(CAPTION_LANGS),
    /** The story voice the user picked on the story step; null = not chosen. */
    storyTone: z.enum(STORY_TONES).nullable(),
    /** Answers to the story questions. A skipped question has no entry. */
    answers: z.array(StoryAnswerSchema).max(STORY_QUESTIONS_MAX),
    /** True when the user chose "Skip" for the whole story step (≠ "not reached yet"). */
    skipped: z.boolean(),
    /** "Tell us about this memory" — the user's own words. */
    note: text(STORY_LIMITS.noteText).nullable(),
    people: z.array(PersonSchema).max(STORY_LIMITS.people),
    places: z.array(text(STORY_LIMITS.shortText)).max(STORY_LIMITS.places),
    /** Short user-confirmed facts ("We got engaged on day 3"). */
    facts: z.array(text(STORY_LIMITS.factText)).max(STORY_LIMITS.facts),
    /** Things the story must not mention. */
    avoid: z.array(text(60)).max(STORY_LIMITS.avoid),
    narrator: z.enum(["first_singular", "first_plural", "third"]),
    /** Start/end derived from photo dates; the user may correct them. */
    dateRange: z.object({ from: isoDateTime, to: isoDateTime }).strict().nullable(),
    rev: int(1, 100000),
    updatedAt: isoDateTime,
  })
  .strict()
  .refine((c) => unique(c.people, (p) => p.name.trim().toLowerCase()), { message: "duplicate person", path: ["people"] })
  .refine((c) => unique(c.answers, (a) => a.questionId), { message: "duplicate question", path: ["answers"] })
  .refine((c) => !c.skipped || c.answers.length === 0, { message: "a skipped step has no answers", path: ["answers"] })
  .refine((c) => !c.dateRange || Date.parse(c.dateRange.from) <= Date.parse(c.dateRange.to), {
    message: "dateRange.from is after dateRange.to",
    path: ["dateRange"],
  });

/**
 * The OTHER side of the separation: something the model observed in one photo. Documented here so
 * the two cannot be confused — an AiObservation is derived from PhotoVisionSchema at read time
 * and is never written into MemoryContext (which rejects `source: "ai"`).
 */
export const AiObservationSchema = z
  .object({
    photoId: uuid,
    source: z.literal("ai"),
    kind: z.literal("vision"),
    /** What is visible — PhotoVisionSchema.description. */
    text: text(STORY_LIMITS.factText),
  })
  .strict();

// ---------------------------------------------------------------------------- ③ Story Planning

export const STORY_BEATS = ["opening", "build", "highlight", "quiet", "closing"] as const;

/** A group of photos that belong together (time + place + content) — the Storyteller's unit. */
export const MomentSchema = z
  .object({
    id: localId("m"),
    title: text(STORY_LIMITS.shortText),
    dateLabel: text(40).nullable(),
    /** Only a place from the metadata or the memory context. */
    place: text(STORY_LIMITS.shortText).nullable(),
    photoIds: z.array(uuid).min(1).max(STORY_LIMITS.photosPerBook),
    heroPhotoId: uuid.nullable(),
    beat: z.enum(STORY_BEATS),
    /** One factual line about what happens — input for the Story Writer, never printed. */
    summary: text(STORY_LIMITS.factText).nullable(),
  })
  .strict()
  .refine((m) => unique(m.photoIds, (id) => id), { message: "duplicate photo in moment", path: ["photoIds"] })
  .refine((m) => m.heroPhotoId === null || m.photoIds.includes(m.heroPhotoId), { message: "hero photo is not in the moment", path: ["heroPhotoId"] });

export const ChapterSchema = z
  .object({
    id: localId("c"),
    title: z.object({ text: text(STORY_LIMITS.shortText), provenance: ProvenanceSchema }).strict(),
    momentIds: z.array(localId("m")).min(1).max(STORY_LIMITS.momentsPerBook),
    /** Planned share of this chapter's page area given to narrative (0–1). */
    narrativeShare: share,
  })
  .strict()
  .refine((c) => unique(c.momentIds, (id) => id), { message: "duplicate moment in chapter", path: ["momentIds"] });

// ---------------------------------------------------------------------------- ④ Story Writing

export const NARRATIVE_KINDS = ["intro", "paragraph", "pull_quote", "caption", "closing"] as const;

/** One piece of narrative text on a page. The unit of user editing and of AI rewriting. */
export const NarrativeBlockSchema = z
  .object({
    id: localId("b"),
    kind: z.enum(NARRATIVE_KINDS),
    text: text(STORY_LIMITS.narrativeText),
    lang: z.enum(CAPTION_LANGS),
    provenance: ProvenanceSchema,
    /** Photos this text is grounded in (the Critic checks the text against them). */
    groundedIn: z.array(uuid).max(STORY_LIMITS.photosPerPage * 2),
  })
  .strict();

// ---------------------------------------------------------------------------- ⑤ Page Composition

export const STORY_PAGE_KINDS = ["cover", "chapter_opener", "photo", "mixed", "narrative", "closing"] as const;

/**
 * One planned page, before it becomes a book-doc page. `narrativeShare` is the fraction of the
 * page AREA given to text (0 = all photos, 1 = all text); the book balance is the mean over pages
 * (see balance.ts). `layoutId` is filled by Page Composition from the style's layout catalogue.
 */
export const StoryPageSchema = z
  .object({
    id: localId("pg"),
    kind: z.enum(STORY_PAGE_KINDS),
    chapterId: localId("c").nullable(),
    momentId: localId("m").nullable(),
    photoIds: z.array(uuid).max(STORY_LIMITS.photosPerPage),
    blocks: z.array(NarrativeBlockSchema).max(STORY_LIMITS.blocksPerPage),
    narrativeShare: share,
    layoutId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).nullable(),
    /** True once the user changed this page in the editor: AI rebuilds leave it alone. */
    userLocked: z.boolean(),
  })
  .strict()
  .refine((p) => unique(p.photoIds, (id) => id), { message: "duplicate photo on page", path: ["photoIds"] })
  .refine((p) => unique(p.blocks, (b) => b.id), { message: "duplicate block id", path: ["blocks"] })
  .refine((p) => p.kind !== "photo" || (p.photoIds.length > 0 && p.narrativeShare <= 0.2), { message: "a photo page needs photos and at most 20 % text", path: ["kind"] })
  .refine((p) => p.kind !== "narrative" || (p.blocks.length > 0 && p.narrativeShare >= 0.8), { message: "a narrative page needs text and at least 80 % text area", path: ["kind"] })
  .refine((p) => p.kind !== "mixed" || (p.photoIds.length > 0 && p.blocks.length > 0), { message: "a mixed page needs photos and text", path: ["kind"] })
  .refine((p) => p.narrativeShare === 0 || p.blocks.length > 0, { message: "text area without text", path: ["narrativeShare"] });

// ---------------------------------------------------------------------------- ⑥ Storybook

/**
 * The whole story for one book = the content of one storybook_versions row. Cross-reference
 * rules are checked here; the 65/35 balance is NOT a schema rule (a draft may be off-target and
 * the user may push it further) — balance.ts reports it and the Critic repairs it.
 */
export const StorybookSchema = z
  .object({
    v: z.literal(STORYBOOK_SCHEMA_VERSION),
    bookId: uuid,
    version: int(1, 100000),
    parentVersion: int(1, 100000).nullable(),
    origin: VersionOriginSchema,
    generator: StoryGeneratorSchema,
    format: z.enum(BOOK_FORMATS),
    designStyle: z.enum(DESIGN_STYLES),
    lang: z.enum(CAPTION_LANGS),
    title: z.object({ text: text(STORY_LIMITS.title), provenance: ProvenanceSchema }).strict(),
    subtitle: z.object({ text: text(STORY_LIMITS.title), provenance: ProvenanceSchema }).strict().nullable(),
    coverPhotoId: uuid.nullable(),
    /** The memory-context revision this version was written from. */
    contextRev: int(1, 100000).nullable(),
    target: z.object({ photoShare: share, narrativeShare: share }).strict(),
    moments: z.array(MomentSchema).max(STORY_LIMITS.momentsPerBook),
    chapters: z.array(ChapterSchema).max(STORY_LIMITS.chaptersPerBook),
    pages: z.array(StoryPageSchema).max(STORY_LIMITS.pagesPerBook),
    createdAt: isoDateTime,
  })
  .strict()
  .superRefine((s, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (Math.abs(s.target.photoShare + s.target.narrativeShare - 1) > 1e-6) issue(["target"], "target shares must add up to 1");
    if (s.parentVersion !== null && s.parentVersion >= s.version) issue(["parentVersion"], "parentVersion must be lower than version");
    if (!unique(s.moments, (m) => m.id)) issue(["moments"], "duplicate moment id");
    if (!unique(s.chapters, (c) => c.id)) issue(["chapters"], "duplicate chapter id");
    if (!unique(s.pages, (p) => p.id)) issue(["pages"], "duplicate page id");

    const momentIds = new Set(s.moments.map((m) => m.id));
    const chapterIds = new Set(s.chapters.map((c) => c.id));
    const photoOwner = new Map<string, string>();
    s.moments.forEach((m, i) =>
      m.photoIds.forEach((id) => {
        if (photoOwner.has(id)) issue(["moments", i, "photoIds"], "a photo belongs to more than one moment");
        photoOwner.set(id, m.id);
      }),
    );
    const momentChapter = new Map<string, string>();
    s.chapters.forEach((c, i) =>
      c.momentIds.forEach((id) => {
        if (!momentIds.has(id)) issue(["chapters", i, "momentIds"], `unknown moment ${id}`);
        if (momentChapter.has(id)) issue(["chapters", i, "momentIds"], `moment ${id} is in more than one chapter`);
        momentChapter.set(id, c.id);
      }),
    );
    const placed = new Set<string>();
    const blockIds = new Set<string>();
    s.pages.forEach((p, i) => {
      if (p.chapterId !== null && !chapterIds.has(p.chapterId)) issue(["pages", i, "chapterId"], `unknown chapter ${p.chapterId}`);
      if (p.momentId !== null && !momentIds.has(p.momentId)) issue(["pages", i, "momentId"], `unknown moment ${p.momentId}`);
      for (const id of p.photoIds) {
        if (!photoOwner.has(id) && id !== s.coverPhotoId) issue(["pages", i, "photoIds"], "photo is not in any moment");
        // the cover photo may appear once more inside the book, like in the existing album plan
        if (placed.has(id) && p.kind !== "cover") issue(["pages", i, "photoIds"], "a photo is placed on more than one page");
        if (p.kind !== "cover") placed.add(id);
      }
      for (const b of p.blocks) {
        if (blockIds.has(b.id)) issue(["pages", i, "blocks"], `block id ${b.id} is used on more than one page`);
        blockIds.add(b.id);
      }
    });
    if (s.pages.filter((p) => p.kind === "cover").length > 1) issue(["pages"], "more than one cover page");
  });

// ---------------------------------------------------------------------------- DB row shapes

export const STORYBOOK_STATUSES = ["empty", "drafting", "ready", "failed"] as const;

/** public.storybooks.context — the memory context, or {} before the user has written one. */
export const StoredMemoryContextSchema = z.union([MemoryContextSchema, z.object({}).strict()]);
