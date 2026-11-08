import "server-only";
// agent_runs / agent_steps queries (0600, D-021 / D-022 / D-027).
//
// Writes always use the secret-key admin client: clients have no INSERT/UPDATE
// privileges on agent_runs and none at all on agent_steps. Callers MUST have
// checked book ownership first (getMyBook under RLS) before creating / advancing
// a run. Owner-facing reads (progress screen) use the RLS client.
//
// Errors carry only the operation and a Postgres code — never ids, step output
// or photo content. Nothing here logs.
import type { AgentStepRecord, RunTotalsDelta, StepLogger } from "@/lib/ai/run-step";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { clipText } from "@/lib/text/clip";
import { isUuid } from "@/lib/uuid";

export type RunTrigger = "build" | "rebuild" | "rewrite";
export type RunMode = "live" | "replay" | "rule";
export type RunState =
  | "queued"
  | "curating"
  | "storytelling"
  | "captioning"
  | "critiquing"
  | "repairing"
  | "validating"
  | "done"
  | "failed";
export type RunAiStatus = "ok" | "partial" | "failed";

export const ACTIVE_RUN_EXCLUDED_STATES = ["done", "failed"] as const;

export class AgentRunsQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "AgentRunsQueryError";
    this.code = code;
  }
}

const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Create / lease / checkpoint (admin)

export type CreateRunInput = {
  bookId: string;
  userId: string;
  trigger: RunTrigger;
  mode: RunMode;
};

/**
 * Inserts a queued run. `{ error: 'already_running' }` when the book already
 * has an active (not done/failed) run — agent_runs_one_active_per_book_idx.
 */
export async function createRun(
  input: CreateRunInput,
): Promise<{ id: string } | { error: "already_running" }> {
  if (!isUuid(input.bookId) || !isUuid(input.userId)) {
    throw new AgentRunsQueryError("create run", "invalid_id");
  }
  const { data, error } = await createAdminClient()
    .from("agent_runs")
    .insert({
      book_id: input.bookId,
      user_id: input.userId,
      trigger: input.trigger,
      mode: input.mode,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { error: "already_running" };
    throw new AgentRunsQueryError("create run", error.code);
  }
  return { id: data.id };
}

/** Takes the tick lease (claim_agent_run). false = someone holds it, or the run is done/failed/missing. */
export async function claimRun(runId: string, leaseSeconds: number): Promise<boolean> {
  if (!isUuid(runId)) return false;
  const { data, error } = await createAdminClient().rpc("claim_agent_run", {
    p_run_id: runId,
    p_lease_seconds: Math.floor(leaseSeconds),
  });
  if (error) throw new AgentRunsQueryError("claim run", error.code);
  return data === true;
}

/** Releases the tick lease so the next advance can claim immediately. */
export async function releaseRun(runId: string): Promise<void> {
  if (!isUuid(runId)) return;
  const { error } = await createAdminClient().rpc("release_agent_run", { p_run_id: runId });
  if (error) throw new AgentRunsQueryError("release run", error.code);
}

export type RunCheckpointPatch = {
  state?: RunState;
  cursor?: Json;
  progress?: Json;
  ai_status?: RunAiStatus | null;
  error_code?: string | null;
  critic_score?: number | null;
  finished_at?: string | null;
};

/** Error codes are clipped to the DB's 64 chars. */
export const RUN_ERROR_CODE_MAX = 64;

/** Persists a tick's progress. Only the given keys are written. No-op for an empty patch. */
export async function checkpointRun(runId: string, patch: RunCheckpointPatch): Promise<void> {
  if (!isUuid(runId)) throw new AgentRunsQueryError("checkpoint run", "invalid_id");
  const update: Record<string, unknown> = {};
  for (const key of [
    "state",
    "cursor",
    "progress",
    "ai_status",
    "critic_score",
    "finished_at",
  ] as const) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  if (patch.error_code !== undefined) {
    update.error_code =
      patch.error_code === null ? null : clipText(patch.error_code, RUN_ERROR_CODE_MAX, "");
  }
  if (Object.keys(update).length === 0) return;

  const { error } = await createAdminClient()
    .from("agent_runs")
    .update(update as Partial<Tables<"agent_runs">>)
    .eq("id", runId);
  if (error) throw new AgentRunsQueryError("checkpoint run", error.code);
}

// ---------------------------------------------------------------------------
// Step logger (implements src/lib/ai/run-step.ts StepLogger)

/** Column limits from 0600 (agent_steps_*_length). */
const STEP_LIMITS = { stepKey: 64, model: 64, stopReason: 32, error: 200, inputSummaryChars: 6000 };

/** Maps an AgentStepRecord to an agent_steps insert row. Exported for tests. */
export function stepRow(row: AgentStepRecord) {
  // `retries` has no column — folded into input_summary (ids/counts only, D-027).
  let inputSummary: Json = { ...row.inputSummary, retries: row.retries } as Json;
  if (JSON.stringify(inputSummary).length > STEP_LIMITS.inputSummaryChars) {
    inputSummary = { truncated: true, retries: row.retries };
  }
  return {
    run_id: row.runId,
    agent: row.agent,
    step_key: clipText(row.stepKey, STEP_LIMITS.stepKey, ""),
    attempt: Math.max(1, Math.floor(row.attempt)),
    status: row.status,
    input_summary: inputSummary,
    output: (row.output ?? null) as Json,
    model: clipText(row.model, STEP_LIMITS.model, ""),
    input_tokens: nonNegInt(row.inputTokens),
    output_tokens: nonNegInt(row.outputTokens),
    cache_read_tokens: nonNegInt(row.cacheReadTokens),
    cache_write_tokens: nonNegInt(row.cacheWriteTokens),
    cost_usd: Math.max(0, Number.isFinite(row.costUsd) ? row.costUsd : 0),
    latency_ms: nonNegInt(row.latencyMs),
    stop_reason: row.stopReason === null ? null : clipText(row.stopReason, STEP_LIMITS.stopReason, ""),
    error: row.error === null ? null : clipText(row.error, STEP_LIMITS.error, ""),
  };
}

function nonNegInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/**
 * StepLogger bound to one run (admin client).
 *
 * insertStep: `INSERT … ON CONFLICT (run_id, step_key, attempt) DO NOTHING` —
 *   a resumed tick that re-logs an already logged step is ignored (idempotent).
 *
 * addRunTotals: recomputes the run totals from agent_steps (sum) and writes
 *   them, instead of incrementing by `delta`. This makes it idempotent (a
 *   duplicate step adds nothing) and self-healing (any later call fixes a
 *   stale total). Calls from one logger are serialised; across processes the
 *   run lease (claimRun) guarantees a single writer. `delta` is ignored.
 *   No extra migration needed (an INSERT trigger on agent_steps would be the
 *   fully atomic alternative — optional follow-up).
 */
export function stepLogger(runId: string): StepLogger {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    async insertStep(row: AgentStepRecord): Promise<void> {
      if (!isUuid(row.runId) || row.runId !== runId) {
        throw new AgentRunsQueryError("insert step", "run_mismatch");
      }
      const { error } = await createAdminClient()
        .from("agent_steps")
        .upsert(stepRow(row), {
          onConflict: "run_id,step_key,attempt",
          ignoreDuplicates: true,
        });
      if (error) throw new AgentRunsQueryError("insert step", error.code);
    },

    async addRunTotals(totalsRunId: string, delta: RunTotalsDelta): Promise<void> {
      void delta;
      if (totalsRunId !== runId) throw new AgentRunsQueryError("add run totals", "run_mismatch");
      await serial(() => syncRunTotals(runId));
    },
  };
}

export type RunTotals = { costUsd: number; inputTokens: number; outputTokens: number };

/** Sums agent_steps of the run into agent_runs.total_*. Returns the totals written. */
export async function syncRunTotals(runId: string): Promise<RunTotals> {
  if (!isUuid(runId)) throw new AgentRunsQueryError("sync run totals", "invalid_id");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_steps")
    .select("cost_usd, input_tokens, output_tokens")
    .eq("run_id", runId);
  if (error) throw new AgentRunsQueryError("sync run totals", error.code);

  let cost = 0;
  let input = 0;
  let output = 0;
  for (const s of data) {
    cost += Number(s.cost_usd) || 0;
    input += Number(s.input_tokens) || 0;
    output += Number(s.output_tokens) || 0;
  }
  const totals = { costUsd: Math.round(cost * 10_000) / 10_000, inputTokens: input, outputTokens: output };

  const { error: updateError } = await admin
    .from("agent_runs")
    .update({
      total_cost_usd: totals.costUsd,
      total_input_tokens: totals.inputTokens,
      total_output_tokens: totals.outputTokens,
    })
    .eq("id", runId);
  if (updateError) throw new AgentRunsQueryError("sync run totals", updateError.code);
  return totals;
}

// ---------------------------------------------------------------------------
// Reads

/** What the owner may see of a run (no cursor, no totals). */
export type OwnerRun = Pick<
  Tables<"agent_runs">,
  | "id"
  | "book_id"
  | "state"
  | "ai_status"
  | "progress"
  | "error_code"
  | "mode"
  | "trigger"
  | "started_at"
  | "finished_at"
>;

const OWNER_RUN_COLUMNS =
  "id, book_id, state, ai_status, progress, error_code, mode, trigger, started_at, finished_at";

/** The run if it belongs to the signed-in user (RLS agent_runs_select_own), else null. */
export async function getRunForOwner(runId: string): Promise<OwnerRun | null> {
  if (!isUuid(runId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("agent_runs")
    .select(OWNER_RUN_COLUMNS)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new AgentRunsQueryError("load run", error.code);
  return data;
}

/** The book's active (not done/failed) run visible to the signed-in user, or null. RLS client. */
export async function getActiveRunForBook(bookId: string): Promise<OwnerRun | null> {
  if (!isUuid(bookId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("agent_runs")
    .select(OWNER_RUN_COLUMNS)
    .eq("book_id", bookId)
    .not("state", "in", `(${ACTIVE_RUN_EXCLUDED_STATES.join(",")})`)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AgentRunsQueryError("load active run", error.code);
  return data;
}

/** Everything the orchestrator needs to run a tick (incl. cursor). Admin client — check ownership first. */
export type RunForTick = Pick<
  Tables<"agent_runs">,
  | "id"
  | "book_id"
  | "user_id"
  | "state"
  | "ai_status"
  | "progress"
  | "cursor"
  | "mode"
  | "trigger"
  | "attempts"
  | "error_code"
  | "started_at"
  | "finished_at"
>;

export async function getRunForTick(runId: string): Promise<RunForTick | null> {
  if (!isUuid(runId)) return null;
  const { data, error } = await createAdminClient()
    .from("agent_runs")
    .select(
      "id, book_id, user_id, state, ai_status, progress, cursor, mode, trigger, attempts, error_code, started_at, finished_at",
    )
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new AgentRunsQueryError("load run", error.code);
  return data;
}

/**
 * Live runs a user started since `since` (ISO). Default triggers: build +
 * rebuild (the D-026 daily build cap). Counts failed runs too (they cost).
 * Runs of deleted books keep user_id, so they still count. Admin client.
 */
export async function countLiveRuns(input: {
  userId: string;
  since: string;
  triggers?: RunTrigger[];
}): Promise<number> {
  if (!isUuid(input.userId)) return 0;
  const triggers = input.triggers ?? ["build", "rebuild"];
  if (triggers.length === 0) return 0;
  const { count, error } = await createAdminClient()
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .eq("mode", "live")
    .in("trigger", triggers)
    .gte("started_at", input.since);
  if (error) throw new AgentRunsQueryError("count runs", error.code);
  return count ?? 0;
}

/** Live rebuild runs of the book, all time (per-book maxRebuilds). Admin client. */
export async function countLiveRebuilds(bookId: string): Promise<number> {
  if (!isUuid(bookId)) return 0;
  const { count, error } = await createAdminClient()
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("mode", "live")
    .eq("trigger", "rebuild");
  if (error) throw new AgentRunsQueryError("count rebuilds", error.code);
  return count ?? 0;
}

export type RunTrace = {
  run: Tables<"agent_runs">;
  steps: Tables<"agent_steps">[];
};

/**
 * Full run + steps (oldest first) for /admin/runs/[id] ONLY (D-027). Admin
 * client; the page must check ADMIN_USER_IDS before calling.
 */
export async function getRunTrace(runId: string): Promise<RunTrace | null> {
  if (!isUuid(runId)) return null;
  const admin = createAdminClient();
  const { data: run, error } = await admin.from("agent_runs").select("*").eq("id", runId).maybeSingle();
  if (error) throw new AgentRunsQueryError("load run trace", error.code);
  if (!run) return null;

  const { data: steps, error: stepsError } = await admin
    .from("agent_steps")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true })
    .order("step_key", { ascending: true })
    .order("attempt", { ascending: true });
  if (stepsError) throw new AgentRunsQueryError("load run trace", stepsError.code);
  return { run, steps };
}
