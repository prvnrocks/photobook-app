// The stored StoryBrief shape (story v3, memory narrative layer) — zod only, client-safe, so the
// storybook version schema can carry it. Built and validated by src/lib/ai/story/brief.ts.
// No import from ./schemas (that module imports this one): limits are literal here.

import { z } from "zod";

/** = STORY_LIMITS.momentsPerBook. */
const MAX_MOMENTS = 100;

export const STORY_BRIEF_VERSION = 1;
export const BRIEF_BEATS = ["opening", "middle", "closing"] as const;
export type BriefBeat = (typeof BRIEF_BEATS)[number];
export const BRIEF_FACT_SOURCES = ["user", "title", "occasion", "metadata", "photos"] as const;

export const BRIEF_LIMITS = {
  theme: 120,
  occasion: 60,
  location: 80,
  relationship: 80,
  fact: 160,
  facts: 12,
  why: 160,
  beat: 160,
  beats: 5,
  assumption: 100,
  assumptions: 12,
  refs: 6,
} as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const fid = z.string().regex(/^f[1-9]\d{0,3}$/);
const mid = z.string().regex(/^m[1-9]\d{0,3}$/);
const line = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => [...v].length <= max && v.trim().length > 0, { message: "length" });

/** The stored brief (StoryPlan.brief and Storybook.brief). Photo references are uuids. */
export const StoryBriefSchema = z
  .object({
    v: z.literal(STORY_BRIEF_VERSION),
    source: z.enum(["ai", "rule"]),
    mode: z.enum(["personal", "observational"]),
    centralTheme: line(BRIEF_LIMITS.theme),
    occasion: z.object({ text: line(BRIEF_LIMITS.occasion), source: z.enum(["user", "book", "none"]), factRefs: z.array(fid).max(BRIEF_LIMITS.refs) }).strict(),
    location: z.object({ text: line(BRIEF_LIMITS.location), source: z.enum(["user", "title", "metadata"]), factRefs: z.array(fid).max(BRIEF_LIMITS.refs) }).strict().nullable(),
    relationships: z.array(z.object({ text: line(BRIEF_LIMITS.relationship), factRef: fid }).strict()).max(10),
    verifiedFacts: z
      .array(
        z
          .object({
            text: line(BRIEF_LIMITS.fact),
            source: z.enum(BRIEF_FACT_SOURCES),
            factRefs: z.array(fid).max(BRIEF_LIMITS.refs),
            photoIds: z.array(uuid).max(BRIEF_LIMITS.refs),
          })
          .strict(),
      )
      .max(BRIEF_LIMITS.facts),
    momentGroups: z.array(z.object({ momentIds: z.array(mid).min(1).max(MAX_MOMENTS), beat: z.enum(BRIEF_BEATS), whyItMatters: line(BRIEF_LIMITS.why) }).strict()).max(MAX_MOMENTS),
    emotionalDirection: z.object({ text: line(BRIEF_LIMITS.beat), source: z.enum(["user", "neutral"]), factRefs: z.array(fid).max(BRIEF_LIMITS.refs) }).strict(),
    narrativeArc: z.array(z.object({ beat: z.enum(BRIEF_BEATS), text: line(BRIEF_LIMITS.beat) }).strict()).min(1).max(BRIEF_LIMITS.beats),
    unsupportedAssumptions: z.array(line(BRIEF_LIMITS.assumption)).max(BRIEF_LIMITS.assumptions),
    contextRev: z.number().int().min(1).nullable(),
    generator: z.object({ model: z.string().min(1).max(64).nullable(), promptVersion: z.string().min(1).max(40) }).strict(),
  })
  .strict();
export type StoryBrief = z.infer<typeof StoryBriefSchema>;

