// TS types for the storybook layer, inferred from the zod schemas (single source).

import type { z } from "zod";
import type {
  AiObservationSchema,
  StoryAnswerSchema,
  ChapterSchema,
  ContentSourceSchema,
  MemoryContextSchema,
  MomentSchema,
  NarrativeBlockSchema,
  PersonSchema,
  PhotoAnalysisSchema,
  PhotoVisionSchema,
  ProvenanceSchema,
  StoryGeneratorSchema,
  StoryPageSchema,
  StorybookSchema,
  VersionOriginSchema,
  NARRATIVE_KINDS,
  STORYBOOK_STATUSES,
  STORY_BEATS,
  STORY_PAGE_KINDS,
} from "./schemas";

export type ContentSource = z.infer<typeof ContentSourceSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type StoryGenerator = z.infer<typeof StoryGeneratorSchema>;
export type VersionOrigin = z.infer<typeof VersionOriginSchema>;
/** Story-layer view of a photo. (The Curator's raw output type is `PhotoAnalysis` in lib/ai/schemas.) */
export type PhotoAnalysis = z.infer<typeof PhotoAnalysisSchema>;
/** Vision-model output for one photo (visible content only). */
export type PhotoVision = z.infer<typeof PhotoVisionSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type MemoryContext = z.infer<typeof MemoryContextSchema>;
/** One user answer on the story step (source is always "user"). */
export type StoryAnswer = z.infer<typeof StoryAnswerSchema>;
/** A model observation about one photo — never part of MemoryContext. */
export type AiObservation = z.infer<typeof AiObservationSchema>;
export type Moment = z.infer<typeof MomentSchema>;
/** Story chapter. (The book doc's rendered chapter type is `Chapter` in lib/book/types.) */
export type Chapter = z.infer<typeof ChapterSchema>;
export type NarrativeBlock = z.infer<typeof NarrativeBlockSchema>;
export type NarrativeKind = (typeof NARRATIVE_KINDS)[number];
export type StoryPage = z.infer<typeof StoryPageSchema>;
export type StoryPageKind = (typeof STORY_PAGE_KINDS)[number];
export type StoryBeat = (typeof STORY_BEATS)[number];
export type Storybook = z.infer<typeof StorybookSchema>;
export type StorybookStatus = (typeof STORYBOOK_STATUSES)[number];
