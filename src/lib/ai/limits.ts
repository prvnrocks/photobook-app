// Free / paid limits per book. Pure data, no secrets — imported client-side too
// (upload cap check) and mirrored by the photos trigger in supabase/migrations (D-014).

export const LIMITS = {
  free: {
    maxUploadPhotos: 150,
    maxAnalyzedPhotos: 150,
    maxRebuilds: 2,
    maxCaptionRewrites: 20,
    /**
     * M5 review S1: cost ceiling for ✨ rewrites — ALL rewrite runs (any outcome: ok, failed,
     * refused, stale) a user may start per rolling 24 h, over all their books. Needed because
     * failed rewrites never count toward maxCaptionRewrites (D-037 #6), so without it a client
     * could retry failing rewrites forever. ≈ 3× the per-book cap: a user can use a whole book's
     * allowance even with many failures, but not loop. The tier is that of the book being
     * edited (like maxLiveBuildsPerUserPerDay). Enforced in create_rewrite_run_capped → 429
     * { error: 'daily_limit' }.
     */
    maxRewriteRunsPerUserPerDay: 60,
    maxPages: 20,
    /** D-026: live AI builds + rebuilds per user per rolling 24 h (all books). */
    maxLiveBuildsPerUserPerDay: 3,
    /** D-034: internal caps for build captions (not the user-facing rewrite limit above). */
    maxCaptionBatchesPerBuild: 10,
    maxCaptionRepairsPerBatch: 1,
    /**
     * D-035: USD ceiling per run (all agent_steps of the run). Checked before every Caption Writer,
     * Critic and repair call with a pessimistic estimate of that call; over → finish with the
     * captions so far (run ai_status partial, error_code run_budget).
     */
    maxRunCostUsd: 1.5,
  },
  paid: {
    maxUploadPhotos: 500,
    maxAnalyzedPhotos: 500,
    maxRebuilds: 10,
    maxCaptionRewrites: 200,
    maxRewriteRunsPerUserPerDay: 400,
    maxPages: 100,
    maxLiveBuildsPerUserPerDay: 20,
    maxCaptionBatchesPerBuild: 10,
    maxCaptionRepairsPerBatch: 1,
    maxRunCostUsd: 6.0,
  },
} as const;

/** D-029: captionable pages per Caption Writer call. */
export const MAX_CAPTION_PAGES_PER_BATCH = 12;

export type Limits = (typeof LIMITS)[keyof typeof LIMITS];

/**
 * Paid status is per book (books.is_paid). For the per-user daily build cap (D-026) the
 * orchestrator also uses the book being built: building a paid book allows 20/day, a free
 * book 3/day (counted over all of the user's live runs).
 */
export function limitsFor(isPaid: boolean): Limits {
  return isPaid ? LIMITS.paid : LIMITS.free;
}

// ---------------------------------------------------------------------------------------------
// D-059: AI daily budget breaker (all users, all books)

/**
 * Global USD ceiling per Asia/Dubai calendar day, from env AI_DAILY_BUDGET_USD (server only).
 * Compared against today's sum of agent_runs.total_cost_usd (admin_ai_spend_daily(1)).
 *
 * - unset / empty / not a finite number / negative → `null` = NO budget (unlimited). An invalid
 *   value deliberately fails open: a typo must never switch AI off for everyone.
 * - `0` → every new live AI run and ✨ rewrite is refused (a kill switch).
 * - otherwise the value in USD, e.g. `10` at launch.
 *
 * Pure: pass `env` in tests. Never call from client code (process.env is empty there anyway).
 */
export function readDailyBudgetUsd(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.AI_DAILY_BUDGET_USD;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  // Plain decimal only ("10", "12.5") — no hex / exponent / "Infinity" surprises from Number().
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Has today's spend reached the budget? `null` budget → never. Reaching it counts (spend ≥
 * budget), so a budget of 0 refuses everything. A non-finite / negative spend is treated as 0.
 */
export function isOverDailyBudget(spendUsd: number, budgetUsd: number | null): boolean {
  if (budgetUsd === null || !Number.isFinite(budgetUsd) || budgetUsd < 0) return false;
  const spend = Number.isFinite(spendUsd) && spendUsd > 0 ? spendUsd : 0;
  return spend >= budgetUsd;
}
