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
//
// Leases (0700): claimRun returns a lease token; releaseRun / checkpointRun
// only act when the token still matches, so a stale tick (its lease expired
// and another tick claimed the run) can't free or overwrite the new tick's work.
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

/**
 * Triggers of BUILD runs — the only runs the build machinery (orchestrator ticks, progress screen,
 * review / build pages, run start) may ever see. Rewrite runs (M5 ✨, trigger 'rewrite') share the
 * table but are one bounded request each: every build-run lookup filters by these triggers
 * (M5 review B1), and claim_agent_run refuses other triggers (0900).
 */
export const BUILD_RUN_TRIGGERS = ["build", "rebuild"] as const;
export type BuildRunTrigger = (typeof BUILD_RUN_TRIGGERS)[number];

export function isBuildRunTrigger(trigger: unknown): trigger is BuildRunTrigger {
  return trigger === "build" || trigger === "rebuild";
}

/** State of an in-flight rewrite run (0900): never 'queued', so it can't pass for a fresh build. */
export const REWRITE_RUN_STATE = "rewriting";

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

export type RunLimitKind = "daily_builds" | "rebuilds";

export type CreateRunCappedInput = CreateRunInput & {
  /** D-026 builds per user per rolling 24 h (live only). */
  dailyCap: number;
  /** Per-book maxRebuilds (src/lib/ai/limits.ts). */
  rebuildCap: number;
  /** true for live runs; replay / rule runs are never capped. */
  enforce: boolean;
};

export type CreateRunCappedResult =
  | { id: string }
  | { error: "already_running" }
  | { error: "limit"; limit: RunLimitKind };

/**
 * Atomic per-user "check caps + insert" (create_agent_run_capped, 0700): a
 * per-user advisory lock serialises starts, so two parallel starts on
 * different books can't both slip under the daily cap (T16 #4).
 *   daily_builds: live build/rebuild runs of the user in the last 24 h that
 *     cost something or are still active (cost is only known after calls);
 *   rebuilds: billed live rebuilds of the book that ended ok/partial;
 *   already_running: the book already has an active run.
 */
export async function createRunCapped(input: CreateRunCappedInput): Promise<CreateRunCappedResult> {
  if (!isUuid(input.bookId) || !isUuid(input.userId)) {
    throw new AgentRunsQueryError("create run", "invalid_id");
  }
  const cap = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
  const { data, error } = await createAdminClient().rpc("create_agent_run_capped", {
    p_book_id: input.bookId,
    p_user_id: input.userId,
    p_trigger: input.trigger,
    p_mode: input.mode,
    p_daily_cap: cap(input.dailyCap),
    p_rebuild_cap: cap(input.rebuildCap),
    p_enforce: input.enforce === true,
  });
  if (error) throw new AgentRunsQueryError("create run", error.code);
  return parseCappedResult(data);
}

/** Validates the RPC's jsonb (never trust an untyped Json). Exported for tests. */
export function parseCappedResult(data: unknown): CreateRunCappedResult {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    if (typeof o.id === "string" && isUuid(o.id)) return { id: o.id };
    if (o.error === "already_running") return { error: "already_running" };
    if (o.error === "limit" && (o.limit === "daily_builds" || o.limit === "rebuilds")) {
      return { error: "limit", limit: o.limit };
    }
  }
  throw new AgentRunsQueryError("create run", "bad_result");
}

/**
 * Takes the tick lease (claim_agent_run). Returns the new lease token, or null
 * when someone holds the lease or the run is done/failed/missing.
 */
export async function claimRun(runId: string, leaseSeconds: number): Promise<string | null> {
  if (!isUuid(runId)) return null;
  const { data, error } = await createAdminClient().rpc("claim_agent_run", {
    p_run_id: runId,
    p_lease_seconds: Math.floor(leaseSeconds),
  });
  if (error) throw new AgentRunsQueryError("claim run", error.code);
  // gen types says `string`, but the function returns NULL when not claimable.
  const token = data as string | null;
  return typeof token === "string" && isUuid(token) ? token : null;
}

/** Releases the tick lease so the next advance can claim at once. No-op when `token` isn't the current lease. */
export async function releaseRun(runId: string, token: string): Promise<void> {
  if (!isUuid(runId) || !isUuid(token)) return;
  const { error } = await createAdminClient().rpc("release_agent_run", { p_run_id: runId, p_token: token });
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

/**
 * Persists a tick's progress — only while `token` is still the run's lease
 * token (`UPDATE … WHERE id AND lease_token = token`). Returns false and writes
 * nothing for a stale tick (lease expired and re-claimed, or released). Only
 * the given keys are written; an empty patch just verifies the token.
 */
export async function checkpointRun(runId: string, token: string, patch: RunCheckpointPatch): Promise<boolean> {
  if (!isUuid(runId)) throw new AgentRunsQueryError("checkpoint run", "invalid_id");
  if (!isUuid(token)) return false;
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

  const admin = createAdminClient();
  if (Object.keys(update).length === 0) {
    const { data, error } = await admin
      .from("agent_runs")
      .select("id")
      .eq("id", runId)
      .eq("lease_token", token)
      .maybeSingle();
    if (error) throw new AgentRunsQueryError("checkpoint run", error.code);
    return data !== null;
  }

  const { data, error } = await admin
    .from("agent_runs")
    .update(update as Partial<Tables<"agent_runs">>)
    .eq("id", runId)
    .eq("lease_token", token)
    .select("id");
  if (error) throw new AgentRunsQueryError("checkpoint run", error.code);
  return data.length === 1;
}

/**
 * Settings "forget me" follow-up (D-032, M4 review SF8): removes the `memory`
 * snapshot from the cursor of the user's active (not done/failed) runs, so a
 * run started before the clear stops using the forgotten prefs. Other cursor
 * fields are kept. Returns how many runs were changed. Admin client — the
 * caller resolved `userId` from the session itself.
 *
 * Known race (accepted, memory is enum-only prefs in M4): a tick that holds
 * the lease already has the old cursor in memory and its next checkpointRun
 * writes it back, re-adding `memory` for the rest of that run. Each update is
 * still scoped to the user and to active states, so a run that finished in
 * between is left alone. Stale runs that never finish are an M9 reaper item.
 *
 * Every run is attempted; the first error (code only) is thrown afterwards.
 */
export async function clearMemoryFromActiveRuns(userId: string): Promise<number> {
  if (!isUuid(userId)) throw new AgentRunsQueryError("clear run memory", "invalid_id");
  const admin = createAdminClient();
  const excluded = `(${ACTIVE_RUN_EXCLUDED_STATES.join(",")})`;
  const { data, error } = await admin
    .from("agent_runs")
    .select("id, cursor")
    .eq("user_id", userId)
    .in("trigger", [...BUILD_RUN_TRIGGERS])
    .not("state", "in", excluded);
  if (error) throw new AgentRunsQueryError("clear run memory", error.code);

  let changed = 0;
  let firstErrorCode: string | undefined;
  let failed = false;
  for (const row of data ?? []) {
    const cursor = row.cursor;
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !("memory" in cursor)) continue;
    const { memory: _memory, ...rest } = cursor as Record<string, Json | undefined>;
    void _memory;
    const { data: updated, error: updateError } = await admin
      .from("agent_runs")
      .update({ cursor: rest as Json })
      .eq("id", row.id)
      .eq("user_id", userId)
      .not("state", "in", excluded)
      .select("id");
    if (updateError) {
      if (!failed) firstErrorCode = updateError.code;
      failed = true;
      continue;
    }
    changed += updated?.length ?? 0;
  }
  if (failed) throw new AgentRunsQueryError("clear run memory", firstErrorCode);
  return changed;
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

/** Extra attempts insertStep tries after a (run_id, step_key, attempt) conflict. */
export const STEP_INSERT_CONFLICT_RETRIES = 3;

/**
 * StepLogger bound to one run (admin client).
 *
 * insertStep: plain INSERT — every real call gets its own row (T16 #2: a
 *   resumed tick's re-run call is billed, so it must be logged). The
 *   orchestrator passes unique attempts (nextAttempt); defensively, on a
 *   (run_id, step_key, attempt) conflict the row is re-inserted with the next
 *   free attempt, up to STEP_INSERT_CONFLICT_RETRIES times.
 *
 * addRunTotals: recomputes the run totals from agent_steps (sum) and writes
 *   them, instead of incrementing by `delta` — idempotent and self-healing.
 *   Calls from one logger are serialised; across processes the run lease
 *   (claimRun) guarantees a single writer. `delta` is ignored.
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
      const admin = createAdminClient();
      const base = stepRow(row);
      let attempt = base.attempt;
      for (let i = 0; ; i++) {
        const { error } = await admin.from("agent_steps").insert({ ...base, attempt });
        if (!error) return;
        if (error.code !== UNIQUE_VIOLATION || i >= STEP_INSERT_CONFLICT_RETRIES) {
          throw new AgentRunsQueryError("insert step", error.code);
        }
        attempt = Math.max(attempt + 1, await nextAttempt(runId, base.step_key));
      }
    },

    async addRunTotals(totalsRunId: string, delta: RunTotalsDelta): Promise<void> {
      void delta;
      if (totalsRunId !== runId) throw new AgentRunsQueryError("add run totals", "run_mismatch");
      await serial(() => syncRunTotals(runId));
    },
  };
}

/** max(attempt) + 1 of a step of the run (1 when it has none). Admin client. */
export async function nextAttempt(runId: string, stepKey: string): Promise<number> {
  if (!isUuid(runId)) throw new AgentRunsQueryError("next attempt", "invalid_id");
  const { data, error } = await createAdminClient()
    .from("agent_steps")
    .select("attempt")
    .eq("run_id", runId)
    .eq("step_key", clipText(stepKey, STEP_LIMITS.stepKey, ""))
    .order("attempt", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AgentRunsQueryError("next attempt", error.code);
  const max = Number(data?.attempt);
  return Number.isFinite(max) && max >= 1 ? Math.floor(max) + 1 : 1;
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
  // numeric(12, 6) since 0700 → round to 6 decimals (total == sum of steps).
  const totals = { costUsd: Math.round(cost * 1_000_000) / 1_000_000, inputTokens: input, outputTokens: output };

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

/**
 * What the owner may see of a run (no cursor, no totals). Since 0700 these are
 * also the only columns authenticated has SELECT on — selecting anything else
 * with the RLS client fails with 42501.
 */
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

/**
 * The BUILD run (build / rebuild) if it belongs to the signed-in user (RLS agent_runs_select_own),
 * else null. Rewrite runs are never returned (M5 review B1): GET /api/ai/runs/[id] and /advance
 * answer 404 for them.
 */
export async function getRunForOwner(runId: string): Promise<OwnerRun | null> {
  if (!isUuid(runId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("agent_runs")
    .select(OWNER_RUN_COLUMNS)
    .eq("id", runId)
    .in("trigger", [...BUILD_RUN_TRIGGERS])
    .maybeSingle();
  if (error) throw new AgentRunsQueryError("load run", error.code);
  return data;
}

/**
 * The book's active (not done/failed) BUILD run visible to the signed-in user, or null. RLS
 * client. Rewrite runs are excluded (M5 review B1): an in-flight ✨ rewrite must not make the
 * build page resume it, the review page show "building", or Update album answer busy.
 */
export async function getActiveRunForBook(bookId: string): Promise<OwnerRun | null> {
  if (!isUuid(bookId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("agent_runs")
    .select(OWNER_RUN_COLUMNS)
    .eq("book_id", bookId)
    .in("trigger", [...BUILD_RUN_TRIGGERS])
    .not("state", "in", `(${ACTIVE_RUN_EXCLUDED_STATES.join(",")})`)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AgentRunsQueryError("load active run", error.code);
  return data;
}

/** Everything the orchestrator needs to run a tick (incl. cursor). Admin client — check ownership first. */
/** Admin read of any run (incl. rewrite runs) — callers must check `trigger` (isBuildRunTrigger). */
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

/** PostgREST `or` filter: billed, or still active (cost only known after the first call). */
const BILLED_OR_ACTIVE = `total_cost_usd.gt.0,state.not.in.(${ACTIVE_RUN_EXCLUDED_STATES.join(",")})`;

/**
 * Live runs a user started since `since` (ISO) that count toward the D-026
 * daily cap: billed (total_cost_usd > 0) or still active — the same rule as
 * create_agent_run_capped, so a failed run that cost nothing doesn't use up a
 * build (T16 #5). Default triggers: build + rebuild. Runs of deleted books
 * keep user_id, so they still count. Admin client.
 */
export async function countLiveRuns(input: {
  userId: string;
  since: string;
  triggers?: RunTrigger[];
}): Promise<number> {
  if (!isUuid(input.userId)) return 0;
  const triggers = input.triggers ?? [...BUILD_RUN_TRIGGERS];
  if (triggers.length === 0) return 0;
  const { count, error } = await createAdminClient()
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .eq("mode", "live")
    .in("trigger", triggers)
    .gte("started_at", input.since)
    .or(BILLED_OR_ACTIVE);
  if (error) throw new AgentRunsQueryError("count runs", error.code);
  return count ?? 0;
}

/** AI results that consume a rebuild / mark a book as AI-built. */
const SUCCESSFUL_AI_STATUSES = ["ok", "partial"] as const;

/**
 * Successful billed live rebuilds of the book, all time (per-book maxRebuilds):
 * total_cost_usd > 0 and ai_status ok/partial (T16 #5). Admin client.
 */
export async function countLiveRebuilds(bookId: string): Promise<number> {
  if (!isUuid(bookId)) return 0;
  const { count, error } = await createAdminClient()
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("mode", "live")
    .eq("trigger", "rebuild")
    .gt("total_cost_usd", 0)
    .in("ai_status", [...SUCCESSFUL_AI_STATUSES]);
  if (error) throw new AgentRunsQueryError("count rebuilds", error.code);
  return count ?? 0;
}

/**
 * True when the book has a finished live BUILD run with ai_status ok/partial — any
 * further run is a rebuild (T16 #3: the trigger is derived server-side). A successful
 * ✨ rewrite (trigger 'rewrite', ai_status ok) never counts (M5 review B1). Admin client.
 */
export async function hasFinishedLiveAiRun(bookId: string): Promise<boolean> {
  if (!isUuid(bookId)) return false;
  const { count, error } = await createAdminClient()
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .in("trigger", [...BUILD_RUN_TRIGGERS])
    .eq("mode", "live")
    .eq("state", "done")
    .in("ai_status", [...SUCCESSFUL_AI_STATUSES]);
  if (error) throw new AgentRunsQueryError("check finished runs", error.code);
  return (count ?? 0) > 0;
}

/**
 * True when the book has ANY agent_runs row (build, rebuild or rewrite; any state; rows whose
 * user_id was nulled by an account deletion still count), optionally ignoring one run id (the run
 * the caller just created). The single "an AI build has started" check: M13 T4 auto first build
 * and the D-070 setup lock (updateBookSetupAction, upload page). Admin client — callers must have
 * checked ownership first (getMyBook under RLS). Throws AgentRunsQueryError on a DB error or a
 * malformed id (callers fail closed).
 */
export async function hasAnyRunForBook(bookId: string, exceptRunId?: string): Promise<boolean> {
  if (!isUuid(bookId)) throw new AgentRunsQueryError("check runs", "invalid_id");
  let query = createAdminClient()
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId);
  if (exceptRunId !== undefined) {
    if (!isUuid(exceptRunId)) throw new AgentRunsQueryError("check runs", "invalid_id");
    query = query.neq("id", exceptRunId);
  }
  const { count, error } = await query;
  if (error) throw new AgentRunsQueryError("check runs", error.code);
  return (count ?? 0) > 0;
}

/**
 * M13 T4: removes a run the caller created a moment ago and must not keep (a concurrent
 * automatic start lost the race). Only an untouched run matches: still queued, never claimed
 * (attempts 0), of this book. Returns true when a row was deleted. Admin client.
 */
export async function deleteUnclaimedRun(runId: string, bookId: string): Promise<boolean> {
  if (!isUuid(runId) || !isUuid(bookId)) return false;
  const { count, error } = await createAdminClient()
    .from("agent_runs")
    .delete({ count: "exact" })
    .eq("id", runId)
    .eq("book_id", bookId)
    .eq("state", "queued")
    .eq("attempts", 0);
  if (error) throw new AgentRunsQueryError("delete run", error.code);
  return (count ?? 0) > 0;
}

/** Newest BUILD run of the book visible to the signed-in user (RLS, owner columns only), or null. */
export async function getLatestRunForBook(
  bookId: string,
): Promise<Pick<OwnerRun, "id" | "mode" | "state" | "started_at"> | null> {
  if (!isUuid(bookId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("agent_runs")
    .select("id, mode, state, started_at")
    .eq("book_id", bookId)
    .in("trigger", [...BUILD_RUN_TRIGGERS])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AgentRunsQueryError("load latest run", error.code);
  return data;
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

// ---------------------------------------------------------------------------
// ✨ Caption rewrite runs (M5, migration 0900, D-037 #6)

export type CreateRewriteRunResult =
  | { id: string }
  | { error: "already_running" }
  | { error: "limit" }
  | { error: "daily_limit" }
  | { error: "not_found" };

export type CreateRewriteRunInput = {
  bookId: string;
  userId: string;
  mode: Exclude<RunMode, "rule">;
  /** Per-book cap: successful rewrites (limits.ts maxCaptionRewrites). */
  cap: number;
  /** Per-user rolling-24 h ceiling over ALL rewrite runs, any outcome (limits.ts maxRewriteRunsPerUserPerDay). */
  dailyCap: number;
  enforce: boolean;
};

/** PostgREST "function not found in the schema cache" / Postgres undefined_function. */
const MISSING_RPC_CODES = new Set(["PGRST202", "42883"]);

/**
 * True when `err` says the rewrite RPC doesn't exist yet (code deployed before migration 0900):
 * the route answers 503 ai_unavailable instead of 500.
 */
export function isMissingRpcError(err: unknown): boolean {
  return err instanceof AgentRunsQueryError && err.code !== undefined && MISSING_RPC_CODES.has(err.code);
}

/**
 * Atomic "reap stale + check caps + insert" (create_rewrite_run_capped, 0900): an advisory lock
 * per USER serialises starts (so the per-user ceiling holds across that user's books).
 *   not_found: the book doesn't exist or isn't the user's (defence in depth);
 *   (reap): this book's unfinished rewrite runs older than 5 min → failed, error_code 'stale';
 *   already_running: a rewrite of this book is in flight;
 *   daily_limit (only when `enforce`): rewrite runs of the user in the last 24 h, ANY outcome,
 *     >= dailyCap — the cost ceiling for failed rewrites (they never count toward `cap`);
 *   limit (only when `enforce`): ok rewrites + in-flight ones of the book >= cap.
 * The run is inserted with state 'rewriting' (never 'queued'). Admin client — the caller checked
 * ownership (getMyBook) first.
 */
export async function createRewriteRun(input: CreateRewriteRunInput): Promise<CreateRewriteRunResult> {
  if (!isUuid(input.bookId) || !isUuid(input.userId)) {
    throw new AgentRunsQueryError("create rewrite run", "invalid_id");
  }
  if (input.mode !== "live" && input.mode !== "replay") {
    throw new AgentRunsQueryError("create rewrite run", "invalid_mode");
  }
  const cap = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
  const { data, error } = await createAdminClient().rpc("create_rewrite_run_capped", {
    p_book: input.bookId,
    p_user: input.userId,
    p_mode: input.mode,
    p_cap: cap(input.cap),
    p_daily_cap: cap(input.dailyCap),
    p_enforce: input.enforce === true,
  });
  if (error) throw new AgentRunsQueryError("create rewrite run", error.code);
  return parseRewriteRunResult(data);
}

/** Validates create_rewrite_run_capped's jsonb. Exported for tests. */
export function parseRewriteRunResult(data: unknown): CreateRewriteRunResult {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    if (typeof o.id === "string" && isUuid(o.id)) return { id: o.id };
    if (o.error === "already_running" || o.error === "limit" || o.error === "daily_limit" || o.error === "not_found") {
      return { error: o.error };
    }
  }
  throw new AgentRunsQueryError("create rewrite run", "bad_result");
}

/**
 * Finishes a rewrite run: first re-sums its agent_steps into total_cost_usd / tokens (so failed
 * and refused rewrites carry their cost too — M5 review S1; best effort, a failed sum never stops
 * the finish), then state done (ai_status ok) or failed, error code (clipped), finished_at.
 * Only touches an unfinished rewrite run, so it is safe to call twice. Rewrite runs have no lease
 * (one bounded request). Returns true when a row was updated. Admin client.
 */
export async function finishRewriteRun(
  runId: string,
  result: { ai_status: "ok" | "failed"; error_code?: string | null },
): Promise<boolean> {
  if (!isUuid(runId)) throw new AgentRunsQueryError("finish rewrite run", "invalid_id");
  await syncRunTotals(runId).catch(() => undefined);
  const ok = result.ai_status === "ok";
  const errorCode = ok || !result.error_code ? null : clipText(result.error_code, RUN_ERROR_CODE_MAX, "");
  const { data, error } = await createAdminClient()
    .from("agent_runs")
    .update({
      state: ok ? "done" : "failed",
      ai_status: ok ? "ok" : "failed",
      error_code: errorCode,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("trigger", "rewrite")
    .not("state", "in", `(${ACTIVE_RUN_EXCLUDED_STATES.join(",")})`)
    .select("id");
  if (error) throw new AgentRunsQueryError("finish rewrite run", error.code);
  return (data?.length ?? 0) === 1;
}

/** The RLS server client (createClient) — getRewritesUsed may reuse a caller's instance. */
type RlsClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Successful ✨ rewrites of the book (rewrite runs with ai_status ok) — the count the rewrite
 * limit uses (D-037 #6; in-flight runs are not included). The ONE shared count (route `remaining`
 * and the editor loader's rewritesLeft). RLS client: returns 0 for a book that isn't the
 * signed-in user's. Pass `client` to reuse the caller's RLS client.
 * remaining = limitsFor(is_paid).maxCaptionRewrites − getRewritesUsed(bookId).
 */
export async function getRewritesUsed(bookId: string, client?: RlsClient): Promise<number> {
  if (!isUuid(bookId)) return 0;
  const supabase = client ?? (await createClient());
  const { count, error } = await supabase
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("trigger", "rewrite")
    .eq("ai_status", "ok");
  if (error) throw new AgentRunsQueryError("count rewrites", error.code);
  return count ?? 0;
}
