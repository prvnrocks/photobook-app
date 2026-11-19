import "server-only";
// Production monitoring (Task 10): reads number-only rows with the service role and hands them to the
// pure aggregator (aggregate.ts). Used by the admin page /admin/monitoring, the admin JSON route
// /api/admin/monitoring and the daily cron's alert lines. Callers gate on isAdminUser (or the cron
// secret) BEFORE calling. Selects codes, counts, money and timestamps only — never ids, titles,
// text, paths or prompts. Bounded: at most ROW_CAP rows per table per call.

import { readDailyBudgetUsd } from "@/lib/ai/limits";
import { createAdminClient } from "@/lib/supabase/admin";
import { alertLogLines, summarize, type ExportRow, type LedgerRow, type MonitoringSummary, type StoryRunRow } from "./aggregate";

export const MONITORING_DEFAULT_DAYS = 7;
export const MONITORING_MAX_DAYS = 31;
export const ROW_CAP = 20_000;

export class MonitoringError extends Error {
  constructor(
    what: string,
    readonly code: string,
  ) {
    super(`${what} failed (${code})`);
    this.name = "MonitoringError";
  }
}

const MISSING = new Set(["42P01", "PGRST205"]);

export function clampDays(raw: unknown): number {
  const n = typeof raw === "string" && /^\d{1,3}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : MONITORING_DEFAULT_DAYS;
  return Math.min(MONITORING_MAX_DAYS, Math.max(1, Math.floor(Number.isFinite(n) ? n : MONITORING_DEFAULT_DAYS)));
}

export async function getMonitoringSummary(days: number = MONITORING_DEFAULT_DAYS, now: Date = new Date()): Promise<MonitoringSummary> {
  const window = clampDays(days);
  const since = new Date(now.getTime() - window * 86_400_000).toISOString();
  const db = createAdminClient();
  const [ledger, runs, exps] = await Promise.all([
    db
      .from("ai_usage_ledger")
      .select("operation, status, error, cost_usd, cost_bucket, latency_ms, priced, created_at")
      .eq("mode", "live")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(ROW_CAP),
    db.from("agent_runs").select("state, error_code, mode, started_at, finished_at").eq("trigger", "storybook").gte("started_at", since).limit(ROW_CAP),
    db.from("exports").select("status, error_code, created_at, finished_at, page_count").gte("created_at", since).limit(ROW_CAP),
  ]);
  if (ledger.error && !MISSING.has(ledger.error.code)) throw new MonitoringError("read ledger", ledger.error.code);
  if (runs.error) throw new MonitoringError("read runs", runs.error.code);
  if (exps.error) throw new MonitoringError("read exports", exps.error.code);
  const summary = summarize({
    windowDays: window,
    now,
    ledger: ledger.error ? null : ((ledger.data ?? []) as LedgerRow[]),
    runs: (runs.data ?? []) as StoryRunRow[],
    exports: (exps.data ?? []) as ExportRow[],
    dailyBudgetUsd: readDailyBudgetUsd(),
  });
  if ((ledger.data?.length ?? 0) >= ROW_CAP || (runs.data?.length ?? 0) >= ROW_CAP || (exps.data?.length ?? 0) >= ROW_CAP) summary.notes.push("row_cap_reached");
  return summary;
}

/**
 * Daily alert pass (called by the cleanup cron): last 24 h → one `[monitor] alert=…` line per alert
 * (console.error so log drains / Vercel log filters can alert on it) plus one `[monitor] ok` summary
 * line. Never throws.
 */
export async function logMonitoringAlerts(now: Date = new Date()): Promise<number> {
  try {
    const s = await getMonitoringSummary(1, now);
    const lines = alertLogLines(s);
    for (const l of lines) console.error(l);
    console.info(
      `[monitor] daily ai_attempts=${s.ai?.attempts ?? -1} ai_fail_rate=${s.ai?.failureRate ?? -1} runs=${s.runs.started} run_fail=${s.runs.failed} exports=${s.exports.started} export_fail=${s.exports.failed} alerts=${lines.length}`,
    );
    return lines.length;
  } catch (err) {
    const code = err instanceof MonitoringError ? err.code : "unknown";
    console.error(`[monitor] summary_failed (${code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown"})`);
    return -1;
  }
}
