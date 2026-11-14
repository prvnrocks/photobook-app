// Books screen card logic (M18): status chip and quick actions per book. Pure (client- and
// server-safe) but imports the publish rules, so only server components use it — the client island
// gets the computed status via LibraryEntry (./library.ts).

import { bookCardStep, type BookCardState } from "@/lib/dashboard/card-target";
import type { LibraryStatus } from "@/lib/dashboard/library";
import { isExpired } from "@/lib/publish/rules";

export interface LibraryStatusInput {
  published: boolean;
  is_paid: boolean;
  expires_at: string | null;
}

export function libraryStatus(b: LibraryStatusInput, now: Date = new Date()): LibraryStatus {
  if (!b.published) return "draft";
  return isExpired({ isPaid: b.is_paid, expiresAt: b.expires_at, now }) ? "expired" : "live";
}

const DAY_MS = 86_400_000;

/** Whole days until the link expires, rounded up (≥ 1 while not expired); null without a date. */
export function daysLeft(expiresAt: string | null, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / DAY_MS));
}

export type LibraryChip = { status: LibraryStatus; label: string };

/**
 * The card's status chip: "Draft" · "Live · 12 days left" (free) · "Live · Permanent" (paid) ·
 * "Live" (free, no expiry yet) · "Expired". The separate "Paid" chip is rendered by the card.
 */
export function libraryChip(b: LibraryStatusInput, now: Date = new Date()): LibraryChip {
  const status = libraryStatus(b, now);
  if (status === "draft") return { status, label: "Draft" };
  if (status === "expired") return { status, label: "Expired" };
  if (b.is_paid) return { status, label: "Live · Permanent" };
  const days = daysLeft(b.expires_at, now);
  if (days === null || days <= 0) return { status, label: "Live" };
  return { status, label: `Live · ${days} ${days === 1 ? "day" : "days"} left` };
}

// --- Quick actions ------------------------------------------------------------------------------

export type QuickActionKind = "open" | "share" | "publish" | "upgrade" | "pdf";

export type QuickAction = { kind: QuickActionKind; href: string; label: string };

export interface QuickActionInput extends BookCardState, LibraryStatusInput {}

/**
 * The card's quick actions (links only; the Options menu is added by the card):
 * - Open → the step the book is at (card-target).
 * - Share → live/expired books' share screen; for a built draft the same screen is the publish
 *   entry (D-070: Share = publish), with its own testid ("book-publish").
 * - Upgrade (free, built, payments on) → the publish screen's upgrade card; PDF (paid, built) →
 *   the publish screen's PDF section.
 */
export function quickActions(b: QuickActionInput, opts: { paymentsEnabled: boolean }): QuickAction[] {
  const step = bookCardStep(b);
  const publish = `/books/${b.id}/publish`;
  const out: QuickAction[] = [{ kind: "open", href: `/books/${b.id}/${step}`, label: "Open" }];
  if (b.published) out.push({ kind: "share", href: publish, label: "Share" });
  else if (step === "edit") out.push({ kind: "publish", href: publish, label: "Share" });
  if (step === "edit" || b.published) {
    if (b.is_paid) out.push({ kind: "pdf", href: `${publish}#pdf`, label: "PDF" });
    else if (opts.paymentsEnabled) out.push({ kind: "upgrade", href: `${publish}#upgrade`, label: "Upgrade" });
  }
  return out;
}
