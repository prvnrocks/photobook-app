// runAgentStep(): the ONLY way an agent calls the model. One call (with retries) → exactly one
// agent_steps row + run totals. Model/transport failures never throw: they return a typed result
// so the orchestrator can fall back to the rule-based album. Logger (DB) errors do propagate —
// a call that cannot be logged must not look like a success ("no silent calls").
//
// Privacy (D-027): `output` in the row is `toLogOutput(data)` — compact, no descriptions or captions
// of photo content. Error strings carry codes and issue counts only. Nothing here console.logs.

import type { z } from "zod";
import { AI_MODEL } from "./client";
import { costUsd } from "./cost";
import {
  isTransportError,
  TransportError,
  ZERO_USAGE,
  type AgentName,
  type AgentRequest,
  type AgentResponse,
  type AgentTransport,
  type TokenUsage,
} from "./transport";

export type StepStatus = "ok" | "error" | "refused";
/** agent_steps.status; "skipped" rows are written by the orchestrator only (no model call). */
export type StepRowStatus = StepStatus | "skipped";

export type StepErrorCode =
  | "refusal"
  | "max_tokens"
  | "context_window_exceeded"
  | "parse_failed"
  | "schema_invalid"
  | TransportError["code"];

/** One agent_steps row (camelCase; the DB adapter maps it to columns). */
export interface AgentStepRecord {
  runId: string;
  agent: AgentName;
  /** Idempotency key within the run, e.g. "curator:3" or "storyteller". */
  stepKey: string;
  /** Step-level attempt (orchestrator re-runs), 1-based. */
  attempt: number;
  /** Transport-level retries used inside this step (0 = first try succeeded/failed). */
  retries: number;
  status: StepRowStatus;
  inputSummary: Record<string, unknown>;
  output: unknown | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number;
  stopReason: string | null;
  /** Error code (+ short detail like issue count / refusal category); null when ok. */
  error: string | null;
}

export interface RunTotalsDelta {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StepLogger {
  insertStep(row: AgentStepRecord): Promise<void>;
  addRunTotals(runId: string, delta: RunTotalsDelta): Promise<void>;
}

export interface RetryOptions {
  /** Extra attempts after the first for retryable TransportErrors (default 2). */
  retries?: number;
  /**
   * Absolute deadline (same clock as `now`, ms). A retry starts only when
   * now + backoff + request timeout < deadline — the orchestrator passes the end of its tick
   * lease (minus a margin), so no request can outlive the lease. No deadline = unbounded.
   */
  deadline?: number;
  /** Delay before retry n (0-based). Default 1 s, 3 s, 9 s… capped at 10 s. */
  backoffMs?: (retry: number, err: TransportError) => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunAgentStepArgs<T, S> {
  runId: string;
  agent: AgentName;
  stepKey: string;
  attempt?: number;
  /** Ids/counts only — never photo content or descriptions. */
  inputSummary: Record<string, unknown>;
  request: AgentRequest<T>;
  /** Code-side validation of the parsed output (ranges, ids, clipping). */
  strictSchema: z.ZodType<S, unknown>;
  /** Compact, privacy-safe projection of the validated data for agent_steps.output. */
  toLogOutput: (data: S) => unknown;
  transport: AgentTransport;
  logger: StepLogger;
  retry?: RetryOptions;
  now?: () => number;
}

export type StepResult<S> =
  | { ok: true; data: S; usage: TokenUsage; costUsd: number; model: string; latencyMs: number }
  | {
      ok: false;
      status: "refused" | "error";
      code: StepErrorCode;
      /** Worth a later "Try AI again" (transient failure). */
      retryable: boolean;
      usage?: TokenUsage;
      costUsd: number;
      stopCategory?: string | null;
    };

export const defaultBackoffMs = (retry: number) => Math.min(10_000, 1000 * 3 ** retry);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Timeout used for retry budgeting when a request carries none (matches LiveTransport). */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export async function runAgentStep<T, S>(args: RunAgentStepArgs<T, S>): Promise<StepResult<S>> {
  const now = args.now ?? Date.now;
  const maxRetries = Math.max(0, args.retry?.retries ?? 2);
  const deadline = args.retry?.deadline;
  const requestTimeout = args.request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const backoff = args.retry?.backoffMs ?? defaultBackoffMs;
  const sleep = args.retry?.sleep ?? defaultSleep;
  const t0 = now();

  let response: AgentResponse<T> | null = null;
  let failure: TransportError | null = null;
  let retries = 0;

  for (;;) {
    try {
      response = await args.transport.parse(args.request);
      failure = null;
      break;
    } catch (e) {
      failure = isTransportError(e) ? e : new TransportError("unknown", "unexpected transport error");
      if (!failure.retryable || retries >= maxRetries) break;
      const wait = Math.max(0, backoff(retries, failure));
      if (deadline !== undefined && now() + wait + requestTimeout >= deadline) break;
      await sleep(wait);
      retries++;
    }
  }

  const base = {
    runId: args.runId,
    agent: args.agent,
    stepKey: args.stepKey,
    attempt: args.attempt ?? 1,
    retries,
    inputSummary: args.inputSummary,
  };

  const finish = async (
    row: Pick<AgentStepRecord, "status" | "output" | "stopReason" | "error">,
    usage: TokenUsage,
    model: string,
    latencyMs: number,
  ) => {
    const cost = costUsd(model, usage);
    await args.logger.insertStep({
      ...base,
      ...row,
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      costUsd: cost,
      latencyMs,
    });
    await args.logger.addRunTotals(args.runId, {
      costUsd: cost,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    });
    return cost;
  };

  const requestedModel = args.request.model ?? AI_MODEL;

  // Transport failure (after retries): logged with cost 0. Known under-count: a request that timed
  // out (or lost its connection) AFTER it was sent may still be billed by the API, but no usage
  // comes back, so the row says error "timeout" with 0 tokens / $0. The real figure is only in the
  // Anthropic console; the row's latency shows how long it ran.
  if (!response) {
    const err = failure ?? new TransportError("unknown", "no response");
    const cost = await finish(
      { status: "error", output: null, stopReason: null, error: err.code },
      { ...ZERO_USAGE },
      requestedModel,
      Math.max(0, now() - t0),
    );
    return { ok: false, status: "error", code: err.code, retryable: err.retryable, costUsd: cost };
  }

  const { usage, model, latencyMs, stopReason, stopCategory } = response;
  const fail = async (status: "refused" | "error", code: StepErrorCode, detail?: string): Promise<StepResult<S>> => {
    const cost = await finish(
      { status, output: null, stopReason, error: detail ? `${code}: ${detail}` : code },
      usage,
      model,
      latencyMs,
    );
    return { ok: false, status, code, retryable: false, usage, costUsd: cost, stopCategory: stopCategory ?? null };
  };

  // stop_reason FIRST — parsed output is meaningless on refusal / truncation.
  if (stopReason === "refusal") return fail("refused", "refusal", stopCategory ?? undefined);
  if (stopReason === "max_tokens") return fail("error", "max_tokens");
  if (stopReason === "model_context_window_exceeded") return fail("error", "context_window_exceeded");
  if (response.parsed === null || response.parsed === undefined) return fail("error", "parse_failed");

  const checked = args.strictSchema.safeParse(response.parsed);
  if (!checked.success) return fail("error", "schema_invalid", `${checked.error.issues.length} issue(s)`);

  let logOutput: unknown;
  try {
    logOutput = args.toLogOutput(checked.data);
  } catch {
    logOutput = { note: "toLogOutput failed" };
  }
  const cost = await finish({ status: "ok", output: logOutput, stopReason, error: null }, usage, model, latencyMs);
  return { ok: true, data: checked.data, usage, costUsd: cost, model, latencyMs };
}
