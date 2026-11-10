// Dashboard card publish chip + Share link (M6 T8, D-039). Pure: safe on client and server.

import { isExpired } from "@/lib/publish/rules";
import { formatShortDate } from "@/lib/publish/ui";

export interface BookPublishInfo {
  /** Live snapshot exists (published_doc is not null). */
  published: boolean;
  is_paid: boolean;
  expires_at: string | null;
}

export type PublishChip = { label: string; tone: "live" | "expired" | "draft" };

/**
 * "Published · expires 12 Dec" (free) · "Published" (paid, permanent) · "Expired" (free link past
 * its 30 days, still published) · "Draft" (not published / unpublished).
 */
export function bookPublishChip(b: BookPublishInfo, now: Date = new Date()): PublishChip {
  if (!b.published) return { label: "Draft", tone: "draft" };
  if (isExpired({ isPaid: b.is_paid, expiresAt: b.expires_at, now })) return { label: "Expired", tone: "expired" };
  if (b.is_paid || !b.expires_at) return { label: "Published", tone: "live" };
  const date = formatShortDate(b.expires_at, now);
  return { label: date ? `Published · expires ${date}` : "Published", tone: "live" };
}

/** Share link for published books (incl. expired: the publish screen offers the upgrade). */
export function bookShareHref(b: BookPublishInfo & { id: string }): string | null {
  return b.published ? `/books/${b.id}/publish` : null;
}
