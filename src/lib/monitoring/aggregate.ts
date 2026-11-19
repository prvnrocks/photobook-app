// Production monitoring summary (Task 10) — PURE aggregation over number-only rows: AI attempts
// (ai_usage_ledger), storybook runs (agent_runs trigger 'storybook') and PDF exports (exports).
// No imports on purpose: the server summary (summary.ts), the admin page / JSON route and
// scripts/monitoring-summary.mjs (loaded through jiti) all share this one file.
//
// Input rows carry codes, counts, money and timestamps only — never ids, titles, captions, photos,
// paths or prompts. Output is the same: rates, percentiles, per-day cost per bucket, failure codes
// and alert codes for log-based alerting ("[monitor] alert=<code> value=<n>").

export type LedgerRow = {
  operation: string;
  status: string; // ok | failed | refused | retried
  error: string | null;
  cost_usd: number | string;
  cost_bucket: string; // preview | paid | other
  latency_ms: number;
  priced: boolean;
  created_at: string;
};

export type StoryRunRow = { state: string; error_code: string | null; mode: string; started_at: string; finished_at: string | null };

export type ExportRow = { status: string; error_code: string | null; created_at: string; finished_at: string | null; page_count: number | null };

export type Pct = { n: number; p50Ms: number | null; p95Ms: number | null };

export type MonitoringSummary = {
  windowDays: number;
  generatedAt: string;
  ai: {
    attempts: number;
    ok: number;
    failed: number;
    refused: number;
    retried: number;
    /** (failed + refused) ÷ attempts (null with no attempts). */
    failureRate: number | null;
    refusalRate: number | null;
    retryRate: number | null;
    unpriced: number;
    byOperation: Record<string, { attempts: number; failed: number; refused: number; retried: number; usd: number } & Pct>;
    errors: Record<string, number>;
  } | null;
  /** Storybook stage time from the model calls that make each stage (latency per attempt). */
  stages: Record<StoryStage, Pct> | null;
  runs: { started: number; done: number; failed: number; cancelled: number; active: number; failureRate: number | null; duration: Pct; failureCodes: Record<string, number> };
  costPerDay: { day: string; preview: number; paid: number; other: number; total: number }[] | null;
  exports: { started: number; ready: number; failed: number; superseded: number; active: number; failureRate: number | null; duration: Pct; failureCodes: Record<string, number> };
  alerts: { code: AlertCode; value: number }[];
  notes: string[];
};

export const STORY_STAGES = ["discovering", "organizing", "writing", "designing"] as const;
export type StoryStage = (typeof STORY_STAGES)[number];

/** Which ledger operations make which storybook stage (src/lib/storybook/run/progress.ts). */
export const STAGE_OPERATIONS: Record<StoryStage, readonly string[]> = {
  discovering: ["photo_analysis"],
  organizing: ["plan"],
  writing: ["write", "repair"],
  designing: ["compose"],
};

export const ALERT_CODES = ["ai_failure_rate_high", "ai_refusals", "ai_unpriced_model", "story_run_failure_rate_high", "export_failure_rate_high", "export_slow", "ai_cost_today_high"] as const;
export type AlertCode = (typeof ALERT_CODES)[number];

/** Alert thresholds (rates need a minimum sample so one failure in three doesn't page anyone). */
export const ALERT_RULES = {
  minSample: 20,
  aiFailureRate: 0.1,
  storyRunFailureRate: 0.15,
  exportFailureRate: 0.1,
  /** p95 export time above this (ms) — close to the 270 s render deadline. */
  exportP95Ms: 200_000,
} as const;

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const usd = (v: number | string) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Nearest-rank percentile of `values` (ms), null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const rank = Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length)));
  return Math.round(v[rank - 1]!);
}

export function pct(values: readonly number[]): Pct {
  return { n: values.length, p50Ms: percentile(values, 50), p95Ms: percentile(values, 95) };
}

function durationMs(from: string, to: string | null): number | null {
  if (!to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

/** Asia/Dubai calendar day (fixed UTC+4, no DST) of an ISO timestamp. */
export function dubaiDay(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms + 4 * 3600_000).toISOString().slice(0, 10) : "unknown";
}

const safeCode = (c: string | null | undefined) => (typeof c === "string" && /^[a-z0-9_]{1,64}$/.test(c) ? c : "unknown");
const bump = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1);
const rate = (part: number, whole: number) => (whole > 0 ? round(part / whole) : null);

export function summarize(input: {
  windowDays: number;
  now: Date;
  ledger: readonly LedgerRow[] | null;
  runs: readonly StoryRunRow[];
  exports: readonly ExportRow[];
  /** AI_DAILY_BUDGET_USD (null = none) — today's live cost over 80 % of it raises an alert. */
  dailyBudgetUsd?: number | null;
}): MonitoringSummary {
  const notes: string[] = [];
  const alerts: MonitoringSummary["alerts"] = [];

  // --- AI attempts -------------------------------------------------------------------------------
  let ai: MonitoringSummary["ai"] = null;
  let stages: MonitoringSummary["stages"] = null;
  let costPerDay: MonitoringSummary["costPerDay"] = null;
  if (input.ledger === null) {
    notes.push("ledger_unavailable");
  } else {
    const L = input.ledger;
    const count = (s: string) => L.filter((r) => r.status === s).length;
    const byOp: Record<string, { attempts: number; failed: number; refused: number; retried: number; usd: number; lat: number[] }> = {};
    const errors: Record<string, number> = {};
    for (const r of L) {
      const o = (byOp[r.operation] ??= { attempts: 0, failed: 0, refused: 0, retried: 0, usd: 0, lat: [] });
      o.attempts++;
      if (r.status === "failed") o.failed++;
      if (r.status === "refused") o.refused++;
      if (r.status === "retried") o.retried++;
      o.usd += usd(r.cost_usd);
      o.lat.push(r.latency_ms);
      if (r.status !== "ok") bump(errors, safeCode(r.error));
    }
    const attempts = L.length;
    const failed = count("failed");
    const refused = count("refused");
    const retried = count("retried");
    ai = {
      attempts,
      ok: count("ok"),
      failed,
      refused,
      retried,
      failureRate: rate(failed + refused, attempts),
      refusalRate: rate(refused, attempts),
      retryRate: rate(retried, attempts),
      unpriced: L.filter((r) => r.priced === false).length,
      byOperation: Object.fromEntries(
        Object.entries(byOp).map(([op, o]) => [op, { attempts: o.attempts, failed: o.failed, refused: o.refused, retried: o.retried, usd: round(o.usd), ...pct(o.lat) }]),
      ),
      errors,
    };
    stages = Object.fromEntries(STORY_STAGES.map((s) => [s, pct(L.filter((r) => STAGE_OPERATIONS[s].includes(r.operation)).map((r) => r.latency_ms))])) as Record<StoryStage, Pct>;
    const days = new Map<string, { preview: number; paid: number; other: number }>();
    for (const r of L) {
      const d = days.get(dubaiDay(r.created_at)) ?? { preview: 0, paid: 0, other: 0 };
      const b = r.cost_bucket === "preview" || r.cost_bucket === "paid" ? r.cost_bucket : "other";
      d[b] += usd(r.cost_usd);
      days.set(dubaiDay(r.created_at), d);
    }
    costPerDay = [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, d]) => ({ day, preview: round(d.preview), paid: round(d.paid), other: round(d.other), total: round(d.preview + d.paid + d.other) }));

    if (attempts >= ALERT_RULES.minSample && (ai.failureRate ?? 0) > ALERT_RULES.aiFailureRate) alerts.push({ code: "ai_failure_rate_high", value: ai.failureRate! });
    if (refused > 0) alerts.push({ code: "ai_refusals", value: refused });
    if (ai.unpriced > 0) alerts.push({ code: "ai_unpriced_model", value: ai.unpriced });
    const today = costPerDay.find((d) => d.day === dubaiDay(input.now.toISOString()));
    const budget = input.dailyBudgetUsd;
    if (today && typeof budget === "number" && budget > 0 && today.total > budget * 0.8) alerts.push({ code: "ai_cost_today_high", value: today.total });
  }

  // --- storybook runs ----------------------------------------------------------------------------
  const R = input.runs;
  const runFailed = R.filter((r) => r.state === "failed" && r.error_code !== "cancelled");
  const runCodes: Record<string, number> = {};
  for (const r of runFailed) bump(runCodes, safeCode(r.error_code));
  const finishedRuns = R.filter((r) => r.state === "done" || (r.state === "failed" && r.error_code !== "cancelled"));
  const runs = {
    started: R.length,
    done: R.filter((r) => r.state === "done").length,
    failed: runFailed.length,
    cancelled: R.filter((r) => r.state === "failed" && r.error_code === "cancelled").length,
    active: R.filter((r) => r.state !== "done" && r.state !== "failed").length,
    failureRate: rate(runFailed.length, finishedRuns.length),
    duration: pct(R.filter((r) => r.state === "done").map((r) => durationMs(r.started_at, r.finished_at)).filter((n): n is number => n !== null)),
    failureCodes: runCodes,
  };
  if (finishedRuns.length >= ALERT_RULES.minSample && (runs.failureRate ?? 0) > ALERT_RULES.storyRunFailureRate) alerts.push({ code: "story_run_failure_rate_high", value: runs.failureRate! });

  // --- exports -----------------------------------------------------------------------------------
  const E = input.exports;
  const expFailed = E.filter((e) => e.status === "failed");
  const expCodes: Record<string, number> = {};
  for (const e of expFailed) bump(expCodes, safeCode(e.error_code));
  const ready = E.filter((e) => e.status === "ready" || e.status === "superseded");
  const finishedExp = ready.length + expFailed.length;
  const exportsOut = {
    started: E.length,
    ready: E.filter((e) => e.status === "ready").length,
    failed: expFailed.length,
    superseded: E.filter((e) => e.status === "superseded").length,
    active: E.filter((e) => e.status === "queued" || e.status === "rendering").length,
    failureRate: rate(expFailed.length, finishedExp),
    duration: pct(ready.map((e) => durationMs(e.created_at, e.finished_at)).filter((n): n is number => n !== null)),
    failureCodes: expCodes,
  };
  if (finishedExp >= ALERT_RULES.minSample && (exportsOut.failureRate ?? 0) > ALERT_RULES.exportFailureRate) alerts.push({ code: "export_failure_rate_high", value: exportsOut.failureRate! });
  if ((exportsOut.duration.p95Ms ?? 0) > ALERT_RULES.exportP95Ms) alerts.push({ code: "export_slow", value: exportsOut.duration.p95Ms! });

  return { windowDays: input.windowDays, generatedAt: input.now.toISOString(), ai, stages, runs, costPerDay, exports: exportsOut, alerts, notes };
}

/** One log line per alert: `[monitor] alert=<code> value=<n>` (codes and numbers only). */
export function alertLogLines(s: Pick<MonitoringSummary, "alerts">): string[] {
  return s.alerts.map((a) => `[monitor] alert=${a.code} value=${a.value}`);
}
