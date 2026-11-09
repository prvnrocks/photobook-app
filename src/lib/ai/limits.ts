// Free / paid limits per book. Pure data, no secrets — imported client-side too
// (upload cap check) and mirrored by the photos trigger in supabase/migrations (D-014).

export const LIMITS = {
  free: {
    maxUploadPhotos: 150,
    maxAnalyzedPhotos: 150,
    maxRebuilds: 2,
    maxCaptionRewrites: 20,
    maxPages: 20,
    /** D-026: live AI builds + rebuilds per user per rolling 24 h (all books). */
    maxLiveBuildsPerUserPerDay: 3,
    /** D-034: internal caps for build captions (not the user-facing rewrite limit above). */
    maxCaptionBatchesPerBuild: 10,
    maxCaptionRepairsPerBatch: 1,
  },
  paid: {
    maxUploadPhotos: 500,
    maxAnalyzedPhotos: 500,
    maxRebuilds: 10,
    maxCaptionRewrites: 200,
    maxPages: 100,
    maxLiveBuildsPerUserPerDay: 20,
    maxCaptionBatchesPerBuild: 10,
    maxCaptionRepairsPerBatch: 1,
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
