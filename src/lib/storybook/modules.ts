// Module contracts for the AI Balanced Storybook. Interfaces only (Task 1): each module is a
// plain TypeScript service inside this Next.js app — no microservices, no new queue. Task 2+
// implements them on top of the existing pieces named in each comment.
//
//   photos ─▶ ① PhotoIntelligence ─▶ ③ StoryPlanner ─▶ ④ StoryWriter ─▶ ⑤ PageComposer ─▶ book doc ─▶ ⑥ Export
//                     ▲                    ▲                  ▲
//               ② MemoryContext (user) ────┴──────────────────┘
//
// Every AI call inside an implementation goes through runAgentStep() (src/lib/ai/run-step.ts),
// so limits, budget, replay mode and agent_steps logging keep working unchanged.

import type { BookDoc } from "@/lib/book/types";
import type { MemoryContext, Moment, PhotoAnalysis, Storybook, Chapter } from "./types";
import type { StoryBalance } from "./balance";
import type { MergeReport } from "./versioning";

export type StoryRunContext = {
  bookId: string;
  userId: string;
  /** agent_runs.id — steps are logged under it. */
  runId: string;
  /** Version number the run will write (current + 1). */
  version: number;
};

/** ① Reuses: upload pipeline metadata (src/lib/photos, src/lib/image) + Curator (src/lib/ai/agents/curator.ts, photos.ai). */
export interface PhotoIntelligence {
  /** Photos of the book as the story layer sees them; analyses missing photos when AI is on. */
  analyse(ctx: StoryRunContext): Promise<PhotoAnalysis[]>;
}

/** ② Reuses: books.occasion / tone / caption_lang + user_memory (src/lib/ai/memory.ts). Stored in storybooks.context. */
export interface MemoryContextStore {
  load(bookId: string): Promise<MemoryContext | null>;
  /** Owner-written; bumps `rev`. Never called by an AI step. */
  save(bookId: string, next: Omit<MemoryContext, "rev" | "updatedAt">): Promise<MemoryContext>;
  /** Defaults from the book row + photo dates/places, shown to the user to confirm. */
  suggest(bookId: string, photos: PhotoAnalysis[]): Promise<Omit<MemoryContext, "rev" | "updatedAt">>;
}

export type StoryPlan = { moments: Moment[]; chapters: Chapter[]; coverPhotoId: string | null; title: string; subtitle: string | null };

/** ③ Reuses: Storyteller (src/lib/ai/agents/storyteller.ts, AlbumPlan moments) + rule grouping (src/lib/ai/story.ts, autolayout). */
export interface StoryPlanner {
  plan(ctx: StoryRunContext, input: { photos: PhotoAnalysis[]; context: MemoryContext | null; pageBudget: number; narrativePages: number }): Promise<StoryPlan>;
}

/** ④ Reuses: Caption Writer + Critic + Rewriter (src/lib/ai/agents), caption-check.ts grounding rules. */
export interface StoryWriter {
  /** Fills narrative blocks for the planned pages; returns a full draft storybook (origin "ai"). */
  write(ctx: StoryRunContext, input: { plan: StoryPlan; photos: PhotoAnalysis[]; context: MemoryContext | null }): Promise<Storybook>;
}

/** ⑤ Reuses: layout catalogue (src/lib/layouts), bestPageLayout / fit.ts, plan-to-doc.ts, design defaults + colourways. */
export interface PageComposer {
  /** Picks layouts and returns the book doc pages; never changes text. Pure given its inputs. */
  compose(storybook: Storybook, base: BookDoc): { doc: BookDoc; storybook: Storybook; balance: StoryBalance };
}

/** ⑥ Unchanged: publish snapshot (src/lib/publish), PDF export (src/lib/pdf, /print/[bookId]), OG image. They read the book doc only. */
export interface StoryExport {
  /** Hook for export-time checks (e.g. every narrative block fits its panel); no new renderer. */
  preflight(doc: BookDoc): { ok: boolean; issues: string[] };
}

/** Storage of versions (storybooks + storybook_versions tables; implemented in src/lib/db/storybooks.ts in Task 2). */
export interface StorybookStore {
  current(bookId: string): Promise<Storybook | null>;
  version(bookId: string, version: number): Promise<Storybook | null>;
  /** Appends a version; fails if `storybook.version` is not current + 1 (optimistic concurrency). */
  append(storybook: Storybook, runId: string | null): Promise<void>;
}

export type StoryRunResult = { storybook: Storybook; merge: MergeReport | null; balance: StoryBalance };
