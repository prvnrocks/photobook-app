// Zod schemas for structured AI outputs (docs/PLAN.md → "AI output schemas", docs/AI-AGENTS.md).
//
// Two variants per output:
//  - `XxxAiSchema`: lean, sent as output_config.format. Structured outputs do not enforce numeric
//    ranges or string lengths, so the AI schema only carries types/enums/nullability plus
//    `.describe()` hints; every field is required (nullable instead of optional).
//  - `XxxStrictSchema`: what code accepts. Ranges, integer checks, alias-id formats, uniqueness;
//    stored text is trimmed, stripped of lone surrogates and clipped (src/lib/text/clip.ts) so a
//    long model string never makes a jsonb write fail.
// Photo ids are short aliases ("p12") in prompts and outputs (D-023); code maps them back.

import { z } from "zod";
import { BOOK_TITLE_MAX_CODE_POINTS } from "@/lib/book/options";
import { clipCodePoints, clipText } from "@/lib/text/clip";

// ---------------------------------------------------------------------------- shared enums

export const SCENES = ["portrait", "group", "landscape", "food", "detail", "document", "screenshot", "other"] as const;
export const MOODS = ["joyful", "romantic", "calm", "adventurous", "nostalgic", "formal", "neutral"] as const;
export const DROP_REASONS = ["screenshot", "document", "blurry", "duplicate", "poor_quality", "irrelevant"] as const;
export const CRITIQUE_ISSUE_TYPES = [
  "duplicate_feel",
  "weak_cover",
  "chronology",
  "caption_mismatch",
  "caption_invented_fact",
  "too_repetitive",
  "unbalanced_chapter",
  "low_quality_photo",
] as const;
export const CRITIQUE_FIXES = ["swap_photo", "reorder", "rewrite_caption", "change_layout", "change_cover"] as const;

export const SceneSchema = z.enum(SCENES);
export const MoodSchema = z.enum(MOODS);
export const DropReasonSchema = z.enum(DROP_REASONS);

/** Text limits for stored AI text (UTF-16 units unless noted). Match src/lib/book/schema.ts. */
export const AI_TEXT_LIMITS = {
  description: 200,
  chapterTitle: 80,
  dateLabel: 40,
  place: 80,
  subtitle: 120,
  caption: 200,
  critiqueDetail: 300,
} as const;

export const PHOTO_ALIAS_RE = /^p[1-9]\d*$/;
export const MOMENT_ID_RE = /^m[1-9]\d*$/;
export const LAYOUT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const alias = z.string().regex(PHOTO_ALIAS_RE, "photo alias must look like p12");
const momentId = z.string().regex(MOMENT_ID_RE, "moment id must look like m3");

/** Trim + strip lone surrogates + clip to `max` UTF-16 units. `required` rejects empty. */
const storedText = (max: number, required = true) => {
  const s = z.string().transform((v) => clipText(v.trim(), max));
  return required ? s.refine((v) => v.length > 0, { message: "empty" }) : s;
};
const nullableStoredText = (max: number) =>
  z
    .string()
    .nullable()
    .transform((v) => {
      if (v === null) return null;
      const t = clipText(v.trim(), max);
      return t.length ? t : null;
    });
const int = (min: number, max: number) => z.number().int().min(min).max(max);

function uniqueBy<T>(items: T[], key: (t: T) => string | number): boolean {
  const seen = new Set<string | number>();
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

// ---------------------------------------------------------------------------- ① Curator

export const PhotoAnalysisAiSchema = z.object({
  photoId: z.string().describe('Alias given in the prompt, e.g. "p12". Never invent ids.'),
  description: z.string().describe("One factual sentence about what is visible, at most 200 characters."),
  scene: SceneSchema,
  peopleCount: z.number().describe("Integer: number of clearly visible people, 0 if none."),
  mood: MoodSchema,
  quality: z.number().describe("Integer 1-10: sharpness, exposure, composition, faces visible."),
  coverWorthy: z.boolean(),
  keep: z.boolean(),
  dropReason: DropReasonSchema.nullable().describe("null when keep is true."),
});

export const CuratorBatchAiSchema = z.object({ photos: z.array(PhotoAnalysisAiSchema) });

export const PhotoAnalysisStrictSchema = z
  .object({
    photoId: alias,
    description: storedText(AI_TEXT_LIMITS.description),
    scene: SceneSchema,
    peopleCount: int(0, 200),
    mood: MoodSchema,
    quality: int(1, 10),
    coverWorthy: z.boolean(),
    keep: z.boolean(),
    dropReason: DropReasonSchema.nullable(),
  })
  // A dropped photo must say why (shown to the user); a kept photo has no drop reason.
  .refine((p) => p.keep || p.dropReason !== null, { message: "dropped photo needs a dropReason", path: ["dropReason"] })
  .transform((p) => (p.keep ? { ...p, dropReason: null } : p));

export const CuratorBatchStrictSchema = z
  .object({ photos: z.array(PhotoAnalysisStrictSchema).min(1).max(10) })
  .refine((b) => uniqueBy(b.photos, (p) => p.photoId), { message: "duplicate photoId", path: ["photos"] });

export type PhotoAnalysisAi = z.infer<typeof PhotoAnalysisAiSchema>;
export type CuratorBatchAi = z.infer<typeof CuratorBatchAiSchema>;
export type PhotoAnalysis = z.infer<typeof PhotoAnalysisStrictSchema>;
export type CuratorBatch = z.infer<typeof CuratorBatchStrictSchema>;

// ---------------------------------------------------------------------------- ② Storyteller

export const AlbumPlanAiSchema = z.object({
  title: z.string().describe("Album title, at most 60 characters."),
  subtitle: z.string().describe("Short subtitle, e.g. dates. Use an empty string if none."),
  coverPhotoId: z.string().describe("Alias of the cover photo."),
  moments: z.array(
    z.object({
      id: z.string().describe('Moment id "m1", "m2", ... in order.'),
      title: z.string().describe("Chapter title, at most 60 characters."),
      dateLabel: z.string().describe("Derived from photo dates only, e.g. 12 Oct 2026."),
      place: z.string().nullable().describe("Only a place given in the metadata, else null. Never invent places."),
      pages: z.array(
        z.object({
          layoutId: z.string().describe("A layout id from the catalogue."),
          photoIds: z.array(z.string()).describe("Aliases, exactly as many as the layout has slots."),
        }),
      ),
    }),
  ),
});

const PlanPageStrictSchema = z.object({
  layoutId: z.string().regex(LAYOUT_ID_RE),
  photoIds: z.array(alias).min(1).max(8),
});

const PlanMomentStrictSchema = z.object({
  id: momentId,
  title: storedText(AI_TEXT_LIMITS.chapterTitle),
  dateLabel: storedText(AI_TEXT_LIMITS.dateLabel, false),
  place: nullableStoredText(AI_TEXT_LIMITS.place),
  pages: z.array(PlanPageStrictSchema).min(1),
});

export const AlbumPlanStrictSchema = z
  .object({
    title: z
      .string()
      .transform((v) => clipCodePoints(v.trim(), BOOK_TITLE_MAX_CODE_POINTS))
      .refine((v) => v.length > 0, { message: "empty" }),
    subtitle: storedText(AI_TEXT_LIMITS.subtitle, false),
    coverPhotoId: alias,
    moments: z.array(PlanMomentStrictSchema).min(1).max(100),
  })
  .refine((p) => uniqueBy(p.moments, (m) => m.id), { message: "duplicate moment id", path: ["moments"] })
  .refine((p) => uniqueBy(p.moments.flatMap((m) => m.pages.flatMap((pg) => pg.photoIds)), (id) => id), {
    message: "a photo is placed on more than one page slot",
    path: ["moments"],
  });

export type AlbumPlanAi = z.infer<typeof AlbumPlanAiSchema>;
export type AlbumPlan = z.infer<typeof AlbumPlanStrictSchema>;

// ---------------------------------------------------------------------------- ③ Caption Writer (M4)

export const MomentCaptionsAiSchema = z.object({
  momentId: z.string(),
  heading: z.string().describe("Chapter heading, at most 60 characters."),
  pageCaptions: z.array(
    z.object({
      pageIndex: z.number().describe("Integer index of the page within the moment, from 0."),
      text: z.string().describe("Original quote, at most 18 words, grounded in what is visible."),
    }),
  ),
});

export const MomentCaptionsStrictSchema = z
  .object({
    momentId,
    heading: storedText(AI_TEXT_LIMITS.chapterTitle),
    pageCaptions: z.array(
      z.object({ pageIndex: int(0, 999), text: storedText(AI_TEXT_LIMITS.caption) }),
    ),
  })
  .refine((c) => uniqueBy(c.pageCaptions, (p) => p.pageIndex), {
    message: "duplicate pageIndex",
    path: ["pageCaptions"],
  });

export type MomentCaptionsAi = z.infer<typeof MomentCaptionsAiSchema>;
export type MomentCaptions = z.infer<typeof MomentCaptionsStrictSchema>;

/** Whitespace word count (works for English and Arabic) — quotes must be ≤ 18 words (M4 check). */
export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}
export const MAX_QUOTE_WORDS = 18;

// ---------------------------------------------------------------------------- ④ Critic (M4 placeholder)

export const CritiqueAiSchema = z.object({
  score: z.number().describe("Integer 1-10 overall."),
  issues: z.array(
    z.object({
      type: z.enum(CRITIQUE_ISSUE_TYPES),
      pageIndex: z.number().nullable(),
      detail: z.string(),
      fix: z.enum(CRITIQUE_FIXES),
    }),
  ),
});

export const CritiqueStrictSchema = z.object({
  score: int(1, 10),
  issues: z
    .array(
      z.object({
        type: z.enum(CRITIQUE_ISSUE_TYPES),
        pageIndex: int(0, 999).nullable(),
        detail: storedText(AI_TEXT_LIMITS.critiqueDetail),
        fix: z.enum(CRITIQUE_FIXES),
      }),
    )
    .max(50),
});

export type CritiqueAi = z.infer<typeof CritiqueAiSchema>;
export type Critique = z.infer<typeof CritiqueStrictSchema>;
