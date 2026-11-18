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
import type { GroundingIssue } from "@/lib/ai/story/grounding";
import type { StoryPlan } from "@/lib/ai/story/plan";
import type { MemoryContext, PhotoAnalysis, Storybook } from "./types";
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

/**
 * ③ + ④ are implemented in src/lib/ai/story (Task 6) as three server functions rather than
 * classes; these interfaces describe the same contract.
 *   - StoryPlan (src/lib/ai/story/plan.ts) = the outline (chapters of moments, title + arc per
 *     chapter, hero photo, which moments get a paragraph) + the page skeleton computed in code so
 *     the 65 / 35 balance holds by construction. Plain JSON, re-validated by the writer.
 *   - Inputs (photos, moments, memory context) are loaded by the functions themselves after the
 *     ownership check; there is no agent_runs row — every call is logged to story_ai_calls.
 */
export type { StoryPlan } from "@/lib/ai/story/plan";

/** ③ planStory(): ONE Storyteller-agent call, else the deterministic rule plan (never throws for an AI failure). */
export interface StoryPlanner {
  plan(bookId: string): Promise<StoryPlan>;
}

/** ④ writeStory() / rewriteNarrativeBlock(): one call per chapter; every block passes grounding.ts or is dropped. */
export interface StoryWriter {
  /** Writes the plan (or regenerates one chapter) and appends the next version; user text is never overwritten. */
  write(bookId: string, plan: StoryPlan, opts?: { chapterId?: string }): Promise<StoryRunResult & { issues: GroundingIssue[] }>;
  /** `blockId` = "<bookId>/<blockId>". Stores a new version, or returns a proposal for a protected block. */
  rewriteBlock(blockId: string, instruction: { kind: "regenerate" | "shorter" | "longer" | "simpler" | "tone"; tone?: string; note?: string }, opts?: { propose?: boolean }): Promise<{ stored: boolean; storybook: Storybook | null }>;
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
