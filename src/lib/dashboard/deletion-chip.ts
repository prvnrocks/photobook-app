// Dashboard / publish-screen deletion notices (M9 T10, D-055). Pure: safe on client and server.
//
// - Free book whose link expired → "Deletes on 26 Dec" (expires_at + FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY,
//   same rule as cleanup_delete_expired_books — published or not).
// - Never-published free draft → "Inactive — deletes on 9 Jan", ONLY once the warning email was
//   claimed after the last activity (draft_warning_sent_at ≥ updated_at). Without a warning there is
//   no chip: the cron never deletes an emailable draft with photos before warning it.
//   Approximation: the SQL's last activity also counts photo uploads (max photos.created_at); the
//   list has only updated_at, so a photo added after the warning without a book update keeps the chip.
// - Owner who can't be emailed (reminders OFF, no email, or the setting couldn't be loaded): the
//   cron deletes the draft at updated_at + DRAFT_IDLE_DAYS with NO warning email (review S2), so the
//   chip "Inactive — deletes on <updated_at + 45 d>" shows from DRAFT_WARNING_DAYS idle days on,
//   whatever draft_warning_sent_at says. (Unknown setting → this rule too: its date is never later
//   than the real one.)
//
// Dates: en-GB short date in Asia/Dubai (formatShortDate adds the year when it differs). The cron runs
// once a day after the date passes, so the shown date is never later than the real deletion.

import { DRAFT_IDLE_DAYS, DRAFT_WARNING_DAYS, draftDeleteAfter, freeBookDeleteAfter } from "@/lib/cleanup/rules";
import { isExpired } from "@/lib/publish/rules";
import { formatShortDate } from "@/lib/publish/ui";

export interface BookDeletionInfo {
  is_paid: boolean;
  published: boolean;
  published_at: string | null;
  expires_at: string | null;
  updated_at: string;
  photo_count: number;
  draft_warning_sent_at: string | null;
}

export type DeletionChip = { kind: "expired" | "inactive"; label: string; date: Date };

const validDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * expired: "Deletes on 26 Dec" · inactive: "Inactive — deletes on 9 Jan". Once the date has passed
 * (the daily cron hasn't run yet): "Deleting soon" / "Inactive — deleting soon". null for invalid input.
 */
export function deletesOnLabel(date: Date, now: Date = new Date(), kind: DeletionChip["kind"] = "expired"): string | null {
  if (Number.isNaN(date.getTime())) return null;
  const lead = kind === "inactive" ? "Inactive — d" : "D";
  if (date.getTime() <= now.getTime()) return `${lead}eleting soon`;
  const text = formatShortDate(date.toISOString(), now);
  return text ? `${lead}eletes on ${text}` : null;
}

/** Deletion date of an expired free book, or null when it isn't scheduled for deletion. */
export function expiredBookDeleteDate(b: { is_paid: boolean; expires_at: string | null }, now: Date = new Date()): Date | null {
  if (b.is_paid) return null;
  const expires = validDate(b.expires_at);
  if (!expires || !isExpired({ isPaid: false, expiresAt: b.expires_at, now })) return null;
  return freeBookDeleteAfter(expires);
}

const DAY_MS = 86_400_000;

export interface DeletionChipOptions {
  /**
   * Whether the viewer gets warning emails (profiles.email_reminders AND an email address).
   * true → chip only after a warning; false / null (unknown) → chip from day DRAFT_WARNING_DAYS.
   * Default true (existing behaviour).
   */
  emailable?: boolean | null;
}

export function bookDeletionChip(
  b: BookDeletionInfo,
  now: Date = new Date(),
  opts: DeletionChipOptions = {},
): DeletionChip | null {
  if (b.is_paid) return null;

  const expiredDate = expiredBookDeleteDate(b, now);
  if (expiredDate) {
    const label = deletesOnLabel(expiredDate, now);
    return label ? { kind: "expired", label, date: expiredDate } : null;
  }

  // Idle never-published draft with photos.
  if (b.published || b.published_at !== null || b.expires_at !== null || !(b.photo_count > 0)) return null;
  const updated = validDate(b.updated_at);
  if (!updated) return null;

  if (opts.emailable === false || opts.emailable === null) {
    // No warning email will come: deleted at updated_at + DRAFT_IDLE_DAYS; show from day 38.
    if (now.getTime() < updated.getTime() + DRAFT_WARNING_DAYS * DAY_MS) return null;
    const date = new Date(updated.getTime() + DRAFT_IDLE_DAYS * DAY_MS);
    const label = deletesOnLabel(date, now, "inactive");
    return label ? { kind: "inactive", label, date } : null;
  }

  const warned = validDate(b.draft_warning_sent_at);
  if (!warned || warned.getTime() < updated.getTime()) return null;
  const date = draftDeleteAfter(updated, warned);
  const label = deletesOnLabel(date, now, "inactive");
  return label ? { kind: "inactive", label, date } : null;
}
