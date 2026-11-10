import "server-only";
// AI spend per Asia/Dubai day (D-059) from admin_ai_spend_daily(p_days) (migration 1600).
// Admin client only: the RPC is granted to service_role alone. Used by the daily budget breaker
// (src/lib/ai/budget.ts) and the admin AI spend page.
//
// Errors carry only the operation and a Postgres code — never ids. Nothing here logs.
import { createAdminClient } from "@/lib/supabase/admin";

/** One Asia/Dubai calendar day of agent_runs (by started_at). Newest first from getAiSpendDaily. */
export type AiSpendDay = {
  /** YYYY-MM-DD (Asia/Dubai). */
  day: string;
  /** Sum of agent_runs.total_cost_usd (all triggers). */
  usd: number;
  runs: number;
  failed: number;
  /** build + rebuild runs. */
  buildUsd: number;
  rewriteUsd: number;
  /** Runs whose book was deleted since (book_id null). */
  nullBookRuns: number;
};

export class AiSpendError extends Error {
  readonly code: string;
  constructor(op: string, code: string | undefined) {
    super(`${op} failed (${code ?? "unknown"})`);
    this.name = "AiSpendError";
    this.code = code ?? "unknown";
  }
}

/** Max days the RPC accepts (p_days 1..366). */
export const AI_SPEND_MAX_DAYS = 366;

/** numeric comes back as a JSON number (or a string for huge values); null/garbage → 0. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Daily spend for the last `days` days (today included, newest first, empty days as zero rows).
 * `days` is clamped to 1..366. Throws AiSpendError on a DB error (the admin page shows it).
 */
export async function getAiSpendDaily(days: number): Promise<AiSpendDay[]> {
  const p_days = Math.min(AI_SPEND_MAX_DAYS, Math.max(1, Math.floor(Number.isFinite(days) ? days : 1)));
  const { data, error } = await createAdminClient().rpc("admin_ai_spend_daily", { p_days });
  if (error) throw new AiSpendError("admin_ai_spend_daily", error.code);
  // `supabase gen types` marks RETURNS TABLE columns non-null — read them defensively.
  return (data ?? []).map((r) => ({
    day: String(r.day ?? ""),
    usd: num(r.usd),
    runs: Math.trunc(num(r.runs)),
    failed: Math.trunc(num(r.failed)),
    buildUsd: num(r.build_usd),
    rewriteUsd: num(r.rewrite_usd),
    nullBookRuns: Math.trunc(num(r.null_book_runs)),
  }));
}

// ---------------------------------------------------------------------------------------------
// Today's total, cached per process

/** How long one process reuses today's total (the breaker may overshoot by ≤ this much spend). */
export const TODAY_SPEND_CACHE_MS = 60_000;

const DUBAI_OFFSET_MS = 4 * 3_600_000; // UTC+4, no DST

/** YYYY-MM-DD of `nowMs` in Asia/Dubai. */
export function dubaiDay(nowMs: number): string {
  return new Date(nowMs + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
}

type CacheEntry = { day: string; at: number; usd: Promise<number> };
let cache: CacheEntry | null = null;

/**
 * Today's (Asia/Dubai) total AI spend in USD — one cheap query (p_days 1), reused for
 * TODAY_SPEND_CACHE_MS per process and dropped at Dubai midnight. Concurrent callers share one
 * in-flight query. Throws AiSpendError on a DB error; failures are not cached.
 */
export async function getTodaySpendUsd(opts: { now?: () => number; fetchDaily?: typeof getAiSpendDaily } = {}): Promise<number> {
  const now = (opts.now ?? Date.now)();
  const day = dubaiDay(now);
  if (cache && cache.day === day && now - cache.at >= 0 && now - cache.at < TODAY_SPEND_CACHE_MS) return cache.usd;

  const fetchDaily = opts.fetchDaily ?? getAiSpendDaily;
  const entry: CacheEntry = {
    day,
    at: now,
    usd: fetchDaily(1).then((rows) => {
      // p_days 1 → exactly today's row; match by day anyway in case of a clock skew vs the DB.
      const row = rows.find((r) => r.day === day) ?? rows[0];
      return row ? row.usd : 0;
    }),
  };
  cache = entry;
  entry.usd.catch(() => {
    if (cache === entry) cache = null;
  });
  return entry.usd;
}

/** Tests only. */
export function resetTodaySpendCacheForTests(): void {
  cache = null;
}
