import "server-only";
// story_ai_calls (migration 2600): usage log of the Story Planner / Narrative Writer / block
// Rewriter (src/lib/ai/story). One row per model call: kind, scope, tokens, cost, latency, error
// code. The table holds NO text — no prompt, answer, description or generated narrative.
//
// Service role only. Callers MUST have proved that `userId` owns `bookId` (getMyBook under RLS);
// every per-book query filters by both. Nothing in this file logs.

import { dubaiDayStart } from "@/lib/db/photo-analyses";
import { createAdminClient } from "@/lib/supabase/admin";

export class StoryAiCallsError extends Error {
  constructor(
    what: string,
    public readonly code: string | undefined,
  ) {
    super(`${what} failed${code ? ` (${code})` : ""}`);
    this.name = "StoryAiCallsError";
  }
}

const missingTable = (code: string | undefined) => code === "42P01" || code === "PGRST205";

export const STORY_CALL_KINDS = ["plan", "write", "repair", "rewrite"] as const;
export type StoryCallKind = (typeof STORY_CALL_KINDS)[number];
/** What the run the call belongs to produces: an outline, the whole book, one chapter, one block. */
export const STORY_CALL_SCOPES = ["plan", "book", "chapter", "block"] as const;
export type StoryCallScope = (typeof STORY_CALL_SCOPES)[number];

export type StoryCallRecord = {
  userId: string;
  bookId: string;
  /** One id per planStory / writeStory / rewriteNarrativeBlock invocation. */
  runId: string;
  kind: StoryCallKind;
  scope: StoryCallScope;
  /** c3, or "closing" for the closing page; null for a plan / rewrite. */
  chapterId: string | null;
  /** The version the run is writing (current + 1); null for a plan. */
  storybookVersion: number | null;
  model: string;
  promptVersion: string;
  mode: "live" | "replay";
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  latencyMs: number;
} & ({ status: "ok" } | { status: "error"; error: string });

/** False while migration 2600 is not applied (live calls are then refused). */
export async function storyUsageAvailable(): Promise<boolean> {
  const { error } = await createAdminClient().from("story_ai_calls").select("id").limit(1);
  if (!error) return true;
  if (missingTable(error.code)) return false;
  throw new StoryAiCallsError("probe story usage", error.code);
}

export async function recordStoryCall(rec: StoryCallRecord): Promise<void> {
  const { error } = await createAdminClient()
    .from("story_ai_calls")
    .insert({
      user_id: rec.userId,
      book_id: rec.bookId,
      run_id: rec.runId,
      kind: rec.kind,
      scope: rec.scope,
      chapter_id: rec.chapterId,
      storybook_version: rec.storybookVersion,
      model: rec.model.slice(0, 64),
      prompt_version: rec.promptVersion.slice(0, 40),
      mode: rec.mode,
      status: rec.status,
      error: rec.status === "error" ? rec.error.replace(/[^a-z_]/g, "_").slice(0, 40).padEnd(3, "_") : null,
      input_tokens: Math.max(0, Math.round(rec.usage.input)),
      output_tokens: Math.max(0, Math.round(rec.usage.output)),
      cache_read_tokens: Math.max(0, Math.round(rec.usage.cacheRead)),
      cache_write_tokens: Math.max(0, Math.round(rec.usage.cacheWrite)),
      cost_usd: Math.max(0, rec.costUsd),
      latency_ms: Math.max(0, Math.round(rec.latencyMs)),
    });
  if (error) throw new StoryAiCallsError("record story call", error.code);
}

/** LIVE runs of the book that produced at least one usable answer, per scope (the per-book limits). */
export type StoryUsageCounts = { plans: number; writes: number; chapterRegens: number; rewrites: number };

export async function countStoryRuns(bookId: string, userId: string): Promise<StoryUsageCounts> {
  const { data, error } = await createAdminClient()
    .from("story_ai_calls")
    .select("run_id, scope")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .eq("mode", "live")
    .eq("status", "ok")
    .limit(10000);
  if (error) {
    if (missingTable(error.code)) return { plans: 0, writes: 0, chapterRegens: 0, rewrites: 0 };
    throw new StoryAiCallsError("count story runs", error.code);
  }
  const runs = { plan: new Set<string>(), book: new Set<string>(), chapter: new Set<string>(), block: new Set<string>() };
  for (const r of data) if (r.scope in runs) runs[r.scope as StoryCallScope].add(r.run_id);
  return { plans: runs.plan.size, writes: runs.book.size, chapterRegens: runs.chapter.size, rewrites: runs.block.size };
}

/** USD spent by live story calls today (all users) — part of the daily AI budget (D-059). */
export async function getTodayStorySpendUsd(now: number = Date.now()): Promise<number> {
  const { data, error } = await createAdminClient().from("story_ai_calls").select("cost_usd").eq("mode", "live").gte("created_at", dubaiDayStart(now)).limit(10000);
  if (error) {
    if (missingTable(error.code)) return 0;
    throw new StoryAiCallsError("read story spend", error.code);
  }
  return data.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
}
