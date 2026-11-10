// Data retention + clean-up rules (D-055 retention, D-056 daily cron, D-057 warning emails,
// D-051 amendment). Pure + isomorphic: no secrets, no server imports — the legal pages and the
// FAQ import it, so the published policy and the cron can never disagree.
//
// The SQL functions in supabase/migrations/20261114001600_cleanup.sql take every window as an
// argument; the cron passes these constants (tests/cleanup-rules.test.ts pins the values and the
// migration's argument checks).

import { FREE_LINK_DAYS } from "@/lib/publish/rules";

/** Free published book: deleted this many days AFTER its link expired (expires_at). */
export const FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY = 14;
/** Never-published free draft: deleted after this many days without activity. */
export const DRAFT_IDLE_DAYS = 45;
/** Never-published free draft: "will be deleted" email after this many idle days. */
export const DRAFT_WARNING_DAYS = 38;
/**
 * Minimum notice between the draft warning email and the deletion. A draft whose owner can be
 * emailed is deleted only once a warning was sent after its last activity AND at least this many
 * days ago — so drafts that were already older than DRAFT_IDLE_DAYS at launch, or a cron outage,
 * never delete a book without a full notice period.
 */
export const DRAFT_NOTICE_DAYS = DRAFT_IDLE_DAYS - DRAFT_WARNING_DAYS;
/** Photo rows still 'pending' (interrupted upload) after this many days are removed. */
export const PENDING_UPLOAD_DAYS = 7;
/** Storage objects with no matching row, older than this, are removed. */
export const ORPHAN_OBJECT_DAYS = 7;
/** Export rows that are superseded / failed and finished this many days ago are deleted (D-051 amended). */
export const OLD_EXPORT_ROW_DAYS = 30;
/** Password unlock attempts older than this are deleted (must cover the 24 h max rate-limit window). */
export const UNLOCK_ATTEMPT_HOURS = 24;
/** Unfinished AI runs with no activity (and no live lease) for this long are marked failed ('stale'). */
export const STALE_AGENT_RUN_HOURS = 1;
/** Free published book: "your link expires soon" email this many days before expires_at. */
export const EXPIRY_WARNING_DAYS_BEFORE = 3;

/** D-056: the daily cron stops starting new batches after this much wall time. */
export const CRON_TIME_BUDGET_MS = 240_000;

/** Rows / objects per SQL call. Storage remove() takes at most 1000 paths per request. */
export const CLEANUP_BATCH = {
  expiredBooks: 25,
  abandonedDrafts: 25,
  pendingUploads: 200,
  orphanObjects: 500,
  warningEmails: 50,
} as const;

/** Storage remove() limit per request (Supabase Storage API). */
export const STORAGE_REMOVE_MAX = 1000;

/** Buckets the orphan sweep visits (0200). */
export const CLEANUP_BUCKETS = ["photos", "exports"] as const;
export type CleanupBucket = (typeof CLEANUP_BUCKETS)[number];

/** Kinds accepted by public.release_warning. */
export const WARNING_KINDS = ["expiry", "draft"] as const;
export type WarningKind = (typeof WARNING_KINDS)[number];

const DAY_MS = 86_400_000;

/** Date after which a free published book is deleted (expires_at + grace). */
export function freeBookDeleteAfter(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY * DAY_MS);
}

/**
 * Earliest deletion date of an idle draft given its last activity and when (if) its warning was
 * sent — mirrors cleanup_delete_abandoned_drafts for an emailable owner.
 */
export function draftDeleteAfter(lastActivity: Date, warnedAt: Date | null): Date {
  const idle = lastActivity.getTime() + DRAFT_IDLE_DAYS * DAY_MS;
  if (!warnedAt || warnedAt.getTime() < lastActivity.getTime()) return new Date(idle);
  return new Date(Math.max(idle, warnedAt.getTime() + DRAFT_NOTICE_DAYS * DAY_MS));
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export interface RetentionRule {
  key: "paid" | "free_published" | "draft" | "pending_upload" | "pdf" | "ai_notes";
  title: string;
  text: string;
}

/** Plain-English retention policy for the privacy page / FAQ (rendered as a list). */
export function retentionSummary(): RetentionRule[] {
  return [
    {
      key: "paid",
      title: "Paid books",
      text: "Kept for as long as your account exists. The link never expires.",
    },
    {
      key: "free_published",
      title: "Free published books",
      text:
        `The share link expires ${plural(FREE_LINK_DAYS, "day")} after you first publish. We email you ${plural(EXPIRY_WARNING_DAYS_BEFORE, "day")} before it expires (unless you turned reminder emails off). ` +
        `If you don't upgrade, the book and its photos are deleted ${plural(FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY, "day")} after the link expires.`,
    },
    {
      key: "draft",
      title: "Unpublished drafts",
      text:
        `A free draft you never publish is deleted after ${plural(DRAFT_IDLE_DAYS, "day")} without changes. ` +
        `If it has photos, we email you at least ${plural(DRAFT_NOTICE_DAYS, "day")} before that (unless you turned reminder emails off). Any edit or upload restarts the clock.`,
    },
    {
      key: "pending_upload",
      title: "Unfinished uploads",
      text: `Photos whose upload never finished are removed after ${plural(PENDING_UPLOAD_DAYS, "day")}.`,
    },
    {
      key: "pdf",
      title: "PDF downloads",
      text: "We keep only the latest PDF of each paid book. Older PDFs are deleted when a new one is made.",
    },
    {
      key: "ai_notes",
      title: "AI notes about your photos",
      text: "Deleted together with the photo or book they describe.",
    },
  ];
}
