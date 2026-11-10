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
