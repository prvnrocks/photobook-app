// Contract between the story server actions (src/app/books/story-actions.ts) and the wizard's
// story step. Types + constants only, client-safe (a "use server" file may only export async
// functions, so these live here).

import type { DesignRecommendation } from "@/lib/design/recommend";
import type { StoryTone } from "@/lib/story/questions";

/** What the wizard sends. Blank answers are dropped by the server; `skipped` stores no answers. */
export type StoryAnswersInput = {
  storyTone: StoryTone | null;
  answers: { questionId: string; text: string }[];
  skipped: boolean;
};

/** What is stored for the book (rev 0 = nothing stored yet). */
export type StoryAnswersView = {
  storyTone: StoryTone | null;
  answers: { questionId: string; text: string }[];
  skipped: boolean;
  rev: number;
};

export type StoryActionError = "unauthenticated" | "not_found" | "invalid" | "unavailable";

export type StoryAnswersResult = { ok: true; context: StoryAnswersView } | { ok: false; error: StoryActionError };

export type RecommendDesignResult =
  | { ok: true; recommendation: DesignRecommendation }
  | { ok: false; error: Exclude<StoryActionError, "invalid"> };

export const EMPTY_STORY_ANSWERS: StoryAnswersView = { storyTone: null, answers: [], skipped: false, rev: 0 };
