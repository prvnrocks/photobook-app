// Share page primary action card (M21 T3): the one thing to do next, from shareStatus() (+ the
// panel's "pending" while a first publish waits for the refresh).
// - draft: "Ready to share?" + the gold Publish CTA (blocked notice when canPublishReason).
// - changes: "Your edits aren't live yet" + last published date + gold "Update link" (shown above
//   the link card).
// - pending: "Getting your link ready…" between a first publish and the refreshed live state.
// - live (live / expiring / paid): calm "Your book is live" + the link lifetime; on `celebrate`
//   (just published, or ?shared=) the badge hops (the foil burst fires in the page's preview —
//   M21 T5). Reduced motion → static (share-motion.css).
// - expired: republish/upgrade copy + the upgrade button the panel passes in.
// Hook-free, no cn/buttonVariants/next/link. Paid copy reads only state.isPaid (server state).
// Copy lives in src/lib/publish/ui.ts.

import { Check, Loader2, Send, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { PublishState } from "@/app/books/[id]/publish/actions";
import { Notice } from "@/components/app/Notice";
import { cx } from "@/lib/cx";
import { deletesOnLabel, expiredBookDeleteDate } from "@/lib/dashboard/deletion-chip";
import type { ShareStatus } from "@/lib/publish/status";
import {
  blockReasonCopy,
  deletesOnSentence,
  EXPIRED_COPY,
  expiryLabel,
  lastPublishedLabel,
  sameLinkNote,
  SHARE_COPY,
} from "@/lib/publish/ui";
import { SHARE_BADGE, SHARE_CARD, SHARE_CTA_GOLD } from "./share-classes";

export type PrimaryActionKind = "draft" | "pending" | "changes" | "live" | "expired";

/** Card variant for a shareStatus() result; `awaitingLink` = a first publish is waiting for the refresh. */
export function primaryActionKind(status: ShareStatus, awaitingLink: boolean): PrimaryActionKind {
  if (status.kind === "expired") return "expired";
  if (status.kind === "draft") return awaitingLink ? "pending" : "draft";
  if (status.kind === "changes") return "changes";
  return "live";
}

export type PrimaryActionCardProps = {
  kind: PrimaryActionKind;
  state: Pick<PublishState, "isPaid" | "expiresAt" | "expired" | "publishedAt" | "lastPublishedAt" | "maxPages" | "canPublishReason">;
  /** Live heading: liveHeading(message) — "Share your link" when the notice already says it's live. */
  liveHeading: string;
  /** A publish is in flight (spinner on the CTA). */
  busy: boolean;
  /** Disable the CTA (busy / refreshing). Blocked reasons disable it too. */
  locked: boolean;
  onPublish: () => void;
  /** Expired card's upgrade button (UpgradeButtonView, testid publish-upgrade). */
  upgrade?: ReactNode;
  /** Fire the publish celebration (live card: the badge hop). */
  celebrate?: boolean;
  /** Clock for date labels (tests). */
  now?: Date;
};

const SPIN = "size-4 animate-spin motion-reduce:animate-none";
const CARD = cx(SHARE_CARD, "flex flex-col gap-4");
/** SHARE_CARD's shape in the warning tone (written out: cx can't override SHARE_CARD's colours). */
const CARD_WARN =
  "flex flex-col gap-4 rounded-[1.75rem] border border-warning-border bg-warning-soft p-4 shadow-[0_18px_40px_-28px_rgb(14_59_46/0.45)] sm:p-7";
const HEADING = "font-display text-xl leading-tight font-semibold text-[#0e3b2e] sm:text-2xl";
const BODY = "type-small text-muted-foreground";
const CTA = cx(SHARE_CTA_GOLD, "w-full sm:w-auto sm:self-start");

export function PrimaryActionCard(props: PrimaryActionCardProps) {
  const { kind, state, busy, locked, onPublish, now } = props;
  const blocked = state.canPublishReason;
  const blockNotice = blocked ? <BlockNotice text={blockReasonCopy(blocked, state.maxPages)} /> : null;
  const icon = busy ? <Loader2 className={SPIN} aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />;

  if (kind === "expired") {
    const deleteDate = expiredBookDeleteDate({ is_paid: state.isPaid, expires_at: state.expiresAt }, now);
    const deletesOn = deleteDate ? deletesOnLabel(deleteDate, now) : null;
    return (
      <section id="upgrade" className={CARD_WARN} data-testid="publish-expired">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className={HEADING}>{EXPIRED_COPY}</h2>
            <p className="type-small mt-1 text-foreground/85">{SHARE_COPY.expiredBody}</p>
            {deletesOn ? (
              <p className="type-small mt-2 font-medium text-foreground" data-testid="publish-deletes-on">
                {deletesOnSentence(deletesOn)}
              </p>
            ) : null}
          </div>
        </div>
        {props.upgrade}
      </section>
    );
  }

  if (kind === "pending") {
    return (
      <section className={CARD} data-testid="publish-pending" aria-busy="true">
        <p className="type-small flex items-center gap-2 text-muted-foreground">
          <Loader2 className={SPIN} aria-hidden="true" />
          {SHARE_COPY.pending}
        </p>
      </section>
    );
  }

  if (kind === "changes") {
    const last = lastPublishedLabel(state.lastPublishedAt, now);
    return (
      <section className={CARD} data-testid="publish-changes">
        <div>
          <h2 className={HEADING}>{SHARE_COPY.changesHeading}</h2>
          <p className={cx(BODY, "mt-1")}>{SHARE_COPY.changesBody}</p>
          {last ? (
            <p className="mt-1 text-xs font-medium text-muted-foreground" data-testid="publish-last-published">
              {last}
            </p>
          ) : null}
        </div>
        {blockNotice}
        <button type="button" onClick={onPublish} disabled={locked || blocked !== null} className={CTA} data-testid="publish-changes-button">
          {icon}
          {SHARE_COPY.updateLink}
        </button>
      </section>
    );
  }

  if (kind === "live") {
    const expiry = expiryLabel({ isPaid: state.isPaid, expiresAt: state.expiresAt, expired: state.expired, now });
    return (
      <section
        className={cx(CARD, "relative isolate overflow-hidden")}
        data-testid="publish-live-card"
        data-celebrate={props.celebrate ? "on" : undefined}
      >
        <div className="flex items-start gap-3">
          <span className={cx(SHARE_BADGE, "share-cover-hop home-foil-fill text-[#1b1b1d]")} aria-hidden="true">
            <Check strokeWidth={3} className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className={HEADING} data-testid="publish-live-heading">
              {props.liveHeading}
            </h2>
            <p className={cx(BODY, "mt-0.5")}>{SHARE_COPY.liveBody}</p>
            {expiry ? (
              <span
                className="mt-2 inline-block rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground"
                data-testid="publish-expiry"
              >
                {expiry}
              </span>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={CARD} data-testid="publish-draft">
      <div>
        <h2 className={HEADING}>{SHARE_COPY.draftHeading}</h2>
        <p className={cx(BODY, "mt-1")}>{SHARE_COPY.draftBody}</p>
      </div>
      {blockNotice}
      <button type="button" onClick={onPublish} disabled={locked || blocked !== null} className={CTA} data-testid="publish-button">
        {icon}
        {SHARE_COPY.publish}
      </button>
      {state.publishedAt ? <p className="text-xs text-muted-foreground">{sameLinkNote(state.isPaid)}</p> : null}
    </section>
  );
}

function BlockNotice({ text }: { text: string }) {
  return (
    <Notice tone="warn">
      <p data-testid="publish-blocked">{text}</p>
    </Notice>
  );
}
