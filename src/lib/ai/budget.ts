import "server-only";
// D-059: AI daily budget breaker. Checked before a LIVE build/rebuild run is created
// (orchestrator.startRun) and before a LIVE ✨ rewrite run is created (POST /api/ai/rewrite).
// Over budget → no run row, no model call, nothing counted; the caller answers with the typed
// 'budget_exhausted' and the user keeps the rule album ("AI is taking a break — try again later").
// Replay / off modes cost nothing and are never refused.
//
// Never throws. A failed spend query fails OPEN (AI allowed) and logs the error code only.
import { isOverDailyBudget, readDailyBudgetUsd } from "@/lib/ai/limits";
import { getTodaySpendUsd } from "@/lib/db/ai-spend";
import { errorCodeOf } from "@/lib/http/json";

export type DailyBudgetCheck =
  | { allowed: true; reason: "no_budget" | "under_budget" | "spend_query_failed" }
  | { allowed: false; reason: "budget_exhausted" };

export type DailyBudgetDeps = {
  env?: Record<string, string | undefined>;
  getTodaySpendUsd?: () => Promise<number>;
};

export async function checkDailyAiBudget(deps: DailyBudgetDeps = {}): Promise<DailyBudgetCheck> {
  try {
    const budget = readDailyBudgetUsd(deps.env ?? process.env);
    if (budget === null) return { allowed: true, reason: "no_budget" }; // no query at all
    let spend: number;
    try {
      spend = await (deps.getTodaySpendUsd ?? (() => getTodaySpendUsd()))();
    } catch (err) {
      console.error(`[ai-budget] spend_query_failed (${errorCodeOf(err)})`);
      return { allowed: true, reason: "spend_query_failed" };
    }
    return isOverDailyBudget(spend, budget)
      ? { allowed: false, reason: "budget_exhausted" }
      : { allowed: true, reason: "under_budget" };
  } catch (err) {
    console.error(`[ai-budget] spend_query_failed (${errorCodeOf(err)})`);
    return { allowed: true, reason: "spend_query_failed" };
  }
}

/** Convenience for callers that only need yes/no. Never throws. */
export async function isAiBudgetExhausted(deps?: DailyBudgetDeps): Promise<boolean> {
  return !(await checkDailyAiBudget(deps)).allowed;
}
