import "server-only";
// public.ai_usage_ledger (migration 2900): one number-only row per model attempt, the source of the
// per-book / per-user spending caps and of the free-preview vs paid cost report.
//
// Service role only. Callers MUST have proved that userId owns bookId (or got both from a run row
// they own). Errors carry an operation and a Postgres code — never ids or content. Nothing here logs.

import { createAdminClient } from "@/lib/supabase/admin";
import { AI_OPERATIONS, COST_BUCKETS, usageErrorCode, type AiOperation, type CostBucket, type UsageStatus } from "@/lib/ai/usage/types";
import { isUuid } from "@/lib/uuid";

export class AiUsageError extends Error {
  constructor(
    what: string,
    public readonly code: string | undefined,
  ) {
    super(`${what} failed${code ? ` (${code})` : ""}`);
    this.name = "AiUsageError";
  }
}

/** True when the error means migration 2900 is not applied (table / function missing). */
export function isMissingUsageObject(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202";
}

export type UsageRow = {
  userId: string | null;
  bookId: string | null;
  runId: string | null;
  operation: AiOperation;
  model: string;
  mode: "live" | "replay";
  status: UsageStatus;
  attempt: number;
  error: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  priced: boolean;
  latencyMs: number;
  bucket: CostBucket;
};

const int = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** The DB row for `r` (validated / clamped so the table's checks always pass). */
export function usageInsertRow(r: UsageRow) {
  return {
    user_id: r.userId && isUuid(r.userId) ? r.userId : null,
    book_id: r.bookId && isUuid(r.bookId) ? r.bookId : null,
    run_id: r.runId && isUuid(r.runId) ? r.runId : null,
    operation: (AI_OPERATIONS as readonly string[]).includes(r.operation) ? r.operation : "curator",
    model: (r.model || "unknown").slice(0, 64),
    mode: r.mode === "live" ? "live" : "replay",
    status: r.status,
    attempt: Math.min(20, Math.max(1, Math.floor(Number.isFinite(r.attempt) ? r.attempt : 1))),
    error: r.status === "ok" ? null : usageErrorCode(r.error),
    input_tokens: int(r.usage.input),
    output_tokens: int(r.usage.output),
    cache_read_tokens: int(r.usage.cacheRead),
    cache_write_tokens: int(r.usage.cacheWrite),
    cost_usd: Number.isFinite(r.costUsd) && r.costUsd > 0 ? Math.round(r.costUsd * 1e6) / 1e6 : 0,
    priced: r.priced !== false,
    latency_ms: int(r.latencyMs),
    cost_bucket: (COST_BUCKETS as readonly string[]).includes(r.bucket) ? r.bucket : "other",
  };
}

export async function insertUsageRow(r: UsageRow): Promise<void> {
  const { error } = await createAdminClient().from("ai_usage_ledger").insert(usageInsertRow(r));
  if (error) throw new AiUsageError("insert ai usage", error.code);
}

export type AiUsageTotals = { bookUsd: number; userDayUsd: number; userMonthUsd: number };

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Live spend of the book (all time) and of the user today / this month (Asia/Dubai). */
export async function getAiUsageTotals(userId: string | null, bookId: string | null): Promise<AiUsageTotals> {
  const { data, error } = await createAdminClient().rpc("ai_usage_totals", {
    p_user: userId && isUuid(userId) ? userId : null,
    p_book: bookId && isUuid(bookId) ? bookId : null,
  });
  if (error) throw new AiUsageError("ai usage totals", error.code);
  const row = Array.isArray(data) ? data[0] : data;
  return { bookUsd: num(row?.book_usd), userDayUsd: num(row?.user_day_usd), userMonthUsd: num(row?.user_month_usd) };
}

export type UsageBucketDay = { day: string; bucket: CostBucket; usd: number; calls: number; failed: number; retried: number; unpriced: number };

/** Daily live spend per cost bucket for the last `days` days (admin report). */
export async function getUsageByBucket(days: number): Promise<UsageBucketDay[]> {
  const p_days = Math.min(366, Math.max(1, Math.floor(Number.isFinite(days) ? days : 1)));
  const { data, error } = await createAdminClient().rpc("admin_ai_usage_by_bucket", { p_days });
  if (error) throw new AiUsageError("ai usage by bucket", error.code);
  return (data ?? []).map((r) => ({
    day: String(r.day ?? ""),
    bucket: (COST_BUCKETS as readonly string[]).includes(String(r.cost_bucket)) ? (r.cost_bucket as CostBucket) : "other",
    usd: num(r.usd),
    calls: Math.trunc(num(r.calls)),
    failed: Math.trunc(num(r.failed)),
    retried: Math.trunc(num(r.retried)),
    unpriced: Math.trunc(num(r.unpriced)),
  }));
}
