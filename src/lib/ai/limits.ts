// Free / paid limits per book. Pure data, no secrets — imported client-side too
// (upload cap check) and mirrored by the photos trigger in supabase/migrations (D-014).

export const LIMITS = {
  free: {
    maxUploadPhotos: 150,
    maxAnalyzedPhotos: 150,
    maxRebuilds: 2,
    maxCaptionRewrites: 20,
    maxPages: 20,
  },
  paid: {
    maxUploadPhotos: 500,
    maxAnalyzedPhotos: 500,
    maxRebuilds: 10,
    maxCaptionRewrites: 200,
    maxPages: 100,
  },
} as const;

export type Limits = (typeof LIMITS)[keyof typeof LIMITS];

export function limitsFor(isPaid: boolean): Limits {
  return isPaid ? LIMITS.paid : LIMITS.free;
}
