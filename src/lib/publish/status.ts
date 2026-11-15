// Share-page status (M21). Pure + isomorphic: PublishState facts + now in, labels out.
// Two separate answers so the UI can show both:
// - `kind` drives the primary action card (what to do next). Paid books with unpublished edits
//   are "changes" here — the action matters more than the plan.
// - `chip` is the status badge (plan / link lifetime): paid wins over everything except
//   "Draft" / "Expired", so a paid book with changes shows kind "changes" + chip "Paid · permanent".
// Paid status comes only from server state (books.is_paid, set by the Stripe webhook).
// No imports on purpose: this ships in the share-page client island (rules.ts pulls in zod via
// parseBookDoc), so the expiry check below mirrors rules.isExpired (unparsable → expired).

const DAY_MS = 24 * 60 * 60 * 1000;

/** A live free link within this many days of expiresAt is "expiring". */
export const EXPIRING_SOON_DAYS = 7;

/** The PublishState fields shareStatus reads (structural, so client islands can pass the state). */
export type ShareStatusInput = {
  published: boolean;
  hasChanges: boolean;
  expiresAt: string | null;
  expired: boolean;
  isPaid: boolean;
};

export type ShareStatusKind = "draft" | "live" | "changes" | "expiring" | "expired" | "paid";

export type ShareStatusChip = "Draft" | "Live" | `Expires in ${number} day${"" | "s"}` | "Expired" | "Paid · permanent";

export type ShareStatus = {
  /**
   * Primary-card state. Order: expired (free link past its date, published or not) → draft (no
   * live snapshot) → changes (live, saved doc moved on; paid or free) → paid (live, up to date) →
   * expiring (free, live, ≤ 7 days left) → live.
   */
  kind: ShareStatusKind;
  /** Status badge: Expired → Draft → Paid · permanent → Expires in N days (≤ 7) → Live. */
  chip: ShareStatusChip;
  /** Share step of the 3-step mini bar: "done" once a link is live (not expired), else "current". */
  step: "current" | "done";
  /** Whole days left on a live free link (ceil, ≥ 1); null when paid / no expiry / expired / draft. */
  daysLeft: number | null;
};

/** rules.isExpired for a free book: no expiry → false; unparsable → true (fail closed). */
function freeLinkExpired(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null || expiresAt === "") return false;
  const ms = Date.parse(expiresAt);
  return !Number.isFinite(ms) || ms <= now.getTime();
}

function msLeft(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  const left = ms - now.getTime();
  return left > 0 ? left : null;
}

export function shareStatus(state: ShareStatusInput, now: Date): ShareStatus {
  const expired = !state.isPaid && (state.expired || freeLinkExpired(state.expiresAt, now));
  if (expired) return { kind: "expired", chip: "Expired", step: "current", daysLeft: null };
  if (!state.published) return { kind: "draft", chip: "Draft", step: "current", daysLeft: null };

  if (state.isPaid) {
    return { kind: state.hasChanges ? "changes" : "paid", chip: "Paid · permanent", step: "done", daysLeft: null };
  }

  const leftMs = msLeft(state.expiresAt, now);
  const daysLeft = leftMs === null ? null : Math.max(1, Math.ceil(leftMs / DAY_MS));
  const expiring = leftMs !== null && leftMs <= EXPIRING_SOON_DAYS * DAY_MS;
  const chip: ShareStatusChip =
    expiring && daysLeft !== null ? `Expires in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}` : "Live";
  const kind: ShareStatusKind = state.hasChanges ? "changes" : expiring ? "expiring" : "live";
  return { kind, chip, step: "done", daysLeft };
}
