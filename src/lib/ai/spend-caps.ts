import "server-only";
// Spending caps per book and per user (Task 9), checked before every LIVE model call. Reads the
// ai_usage_ledger ledger (migration 2900) through ai_usage_totals — one query.
//
// Fails OPEN (allowed + a code-only log line) when the totals cannot be read, like the D-059 daily
// budget: a database hiccup or a missing migration must not switch AI off for everyone. The daily
// budget, the per-run ceiling, the per-book call limits and the daily run caps still apply.

import { SPEND_CAPS } from "@/lib/ai/limits";
import { AiUsageError, getAiUsageTotals, isMissingUsageObject, type AiUsageTotals } from "@/lib/db/ai-usage";

export type SpendCaps = { bookPreviewUsd: number; bookFullUsd: number; userDayUsd: number; userMonthUsd: number };
export type SpendCapReason = "book_cap" | "user_day_cap" | "user_month_cap";
export type SpendCapCheck = { allowed: true; reason: "under_caps" | "totals_unavailable" } | { allowed: false; reason: SpendCapReason };

type Env = Record<string, string | undefined>;

function usd(raw: string | undefined, fallback: number): number {
  const t = (raw ?? "").trim();
  if (!/^\d{1,6}(\.\d{1,4})?$/.test(t)) return fallback;
  return Number(t);
}

/** Caps from env over SPEND_CAPS. Invalid / empty → the default (never unlimited); "0" blocks all. */
export function readSpendCaps(env: Env = process.env): SpendCaps {
  return {
    bookPreviewUsd: usd(env.AI_CAP_BOOK_PREVIEW_USD, SPEND_CAPS.bookPreviewUsd),
    bookFullUsd: usd(env.AI_CAP_BOOK_FULL_USD, SPEND_CAPS.bookFullUsd),
    userDayUsd: usd(env.AI_CAP_USER_DAY_USD, SPEND_CAPS.userDayUsd),
    userMonthUsd: usd(env.AI_CAP_USER_MONTH_USD, SPEND_CAPS.userMonthUsd),
  };
}

/** Pure decision: reaching a cap counts (spend ≥ cap). */
export function spendCapDecision(totals: AiUsageTotals, caps: SpendCaps, tier: "preview" | "full"): SpendCapCheck {
  const bookCap = tier === "full" ? caps.bookFullUsd : caps.bookPreviewUsd;
  if (totals.bookUsd >= bookCap) return { allowed: false, reason: "book_cap" };
  if (totals.userDayUsd >= caps.userDayUsd) return { allowed: false, reason: "user_day_cap" };
  if (totals.userMonthUsd >= caps.userMonthUsd) return { allowed: false, reason: "user_month_cap" };
  return { allowed: true, reason: "under_caps" };
}

export type SpendCapDeps = { env?: Env; totals?: (userId: string, bookId: string | null) => Promise<AiUsageTotals> };

/** Never throws. */
export async function checkSpendCaps(input: { userId: string; bookId: string | null; tier: "preview" | "full" }, deps: SpendCapDeps = {}): Promise<SpendCapCheck> {
  try {
    const totals = await (deps.totals ?? getAiUsageTotals)(input.userId, input.bookId);
    return spendCapDecision(totals, readSpendCaps(deps.env ?? process.env), input.tier);
  } catch (err) {
    const code = err instanceof AiUsageError ? err.code : undefined;
    if (!isMissingUsageObject(code)) console.error(`[spend-caps] totals_unavailable (${(code ?? "unknown").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16)})`);
    return { allowed: true, reason: "totals_unavailable" };
  }
}

/** Convenience: true when a cap is reached. Never throws. */
export async function isOverSpendCap(input: { userId: string; bookId: string | null; tier: "preview" | "full" }, deps?: SpendCapDeps): Promise<boolean> {
  return !(await checkSpendCaps(input, deps)).allowed;
}
