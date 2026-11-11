"use client";

// Publish / share screen body (M6 T8, D-039 / D-040). Renders from the server's PublishState
// (getPublishState) and calls the bound publish actions; after every successful action the page
// refreshes so the state always comes from the server. Copy lives in src/lib/publish/ui.ts.
//
// <PublishPanel> wires next/navigation; <PublishPanelView> takes `refresh` so it renders without
// an app router (unit tests, dev fixture).

import { Check, ExternalLink, FileText, Info, Loader2, Send, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useId, useState, useTransition, type ReactNode } from "react";
import type {
  PublishBookResult,
  PublishState,
  SetBookPasswordResult,
  UnpublishBookResult,
} from "@/app/books/[id]/publish/actions";
import { BTN } from "@/components/app/button-classes";
import { Notice } from "@/components/app/Notice";
import { UpgradeButtonView } from "@/components/upgrade/UpgradeButton";
import { track } from "@/lib/analytics/client";
import { deletesOnLabel, expiredBookDeleteDate } from "@/lib/dashboard/deletion-chip";
import type { PdfTransport } from "@/lib/pdf/ui";
import { SHARE_SECONDARY_CLASS, ShareButtons } from "@/components/viewer/ShareButtons";
import type { PublishCompare } from "@/lib/publish/compare";
import {
  blockReasonCopy,
  EXPIRED_COPY,
  expiryLabel,
  publishErrorCopy,
  publishWithRetry,
  unpublishErrorCopy,
} from "@/lib/publish/ui";
import { PasswordField } from "./PasswordField";
import { PdfDownloadView } from "./PdfDownload";

export type PublishActions = {
  publish: () => Promise<PublishBookResult>;
  unpublish: () => Promise<UnpublishBookResult>;
  setPassword: (password: string | null) => Promise<SetBookPasswordResult>;
};

export type PublishPanelProps = {
  bookId: string;
  /** Book title for the share message (owner's own title). */
  title: string;
  state: PublishState;
  actions: PublishActions;
  /** isPaymentsEnabled() from the server page (Stripe keys configured). */
  paymentsEnabled: boolean;
  /** Free vs upgraded card data, built on the server with publishCompare() (src/lib/publish/compare.ts). */
  compare: PublishCompare;
};

type Message = { tone: "ok" | "error"; text: string; signIn?: boolean };

// Shared looks (M11, D-067): cards on paper, 44/48 px buttons with a visible focus ring. Precomputed
// strings (BTN, CARD_*) instead of buttonVariants + cn keep ~14 kB gzip off this route; CARD_WARN /
// CARD_INFO are exactly cn(CARD, "<tone classes>").
const CARD = "flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-5";
const CARD_WARN = "flex flex-col gap-4 rounded-2xl border p-4 shadow-card sm:p-5 border-warning-border bg-warning-soft";
const CARD_INFO = "flex flex-col gap-4 rounded-2xl border p-4 shadow-card sm:p-5 border-info-border bg-info-soft shadow-none";
const PRIMARY = BTN.ctaPrimary;
const OUTLINE = BTN.touchOutlineCard;
const SPIN = "size-4 animate-spin motion-reduce:animate-none";

export function PublishPanel(props: PublishPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  return <PublishPanelView {...props} refresh={refresh} refreshing={pending} />;
}

export function PublishPanelView({
  bookId,
  title,
  state,
  actions,
  paymentsEnabled,
  compare,
  refresh,
  refreshing = false,
  now,
  wait,
  pdfTransport,
}: PublishPanelProps & {
  refresh: () => void;
  refreshing?: boolean;
  /** Clock for the expiry label (tests). */
  now?: Date;
  /** Conflict retry delay (tests). */
  wait?: (ms: number) => Promise<void>;
  /** PDF API transport (dev fixture); defaults to same-origin fetch. */
  pdfTransport?: PdfTransport;
}) {
  const [busy, setBusy] = useState<"publish" | "unpublish" | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // The state a first publish succeeded on: until the refresh brings the live state, the draft
  // card (disabled Publish) would sit under "Your book is live" — show a link placeholder instead.
  const [publishedOn, setPublishedOn] = useState<PublishState | null>(null);
  const locked = busy !== null || refreshing;
  const urlId = useId();
  const unpublishHeadingId = useId();

  const onPublish = async () => {
    setBusy("publish");
    setMessage(null);
    let r: PublishBookResult;
    try {
      r = await publishWithRetry(actions.publish, wait);
    } catch {
      r = { ok: false, error: "failed" };
    }
    setBusy(null);
    if (r.ok) {
      // analytics (M9 T14): flags + page count only.
      track("published", {
        is_paid: state.isPaid,
        has_password: state.hasPassword,
        pages: state.pageCount,
        first: state.publishedAt === null,
      });
      setMessage({ tone: "ok", text: state.published ? "Changes published" : "Your book is live" });
      if (!state.published) setPublishedOn(state);
      refresh();
    } else {
      setMessage({ tone: "error", text: publishErrorCopy(r.error, state.maxPages), signIn: r.error === "signed_out" });
      if (r.error === "expired") refresh();
    }
  };

  const onUnpublish = async () => {
    setBusy("unpublish");
    setMessage(null);
    let r: UnpublishBookResult;
    try {
      r = await actions.unpublish();
    } catch {
      r = { ok: false, error: "failed" };
    }
    setBusy(null);
    setConfirmUnpublish(false);
    if (r.ok) {
      setMessage({ tone: "ok", text: "Unpublished — the link no longer works" });
      refresh();
    } else {
      setMessage({ tone: "error", text: unpublishErrorCopy(r.error), signIn: r.error === "signed_out" });
    }
  };

  const onPasswordChanged = (text: string) => {
    setMessage({ tone: "ok", text });
    refresh();
  };

  const live = state.published && !state.expired;
  const awaitingLink = !state.published && publishedOn === state;
  const expiry = expiryLabel({ isPaid: state.isPaid, expiresAt: state.expiresAt, expired: state.expired, now });
  const blocked = state.canPublishReason;
  const deleteDate = state.expired ? expiredBookDeleteDate({ is_paid: state.isPaid, expires_at: state.expiresAt }, now) : null;
  const deletesOn = deleteDate ? deletesOnLabel(deleteDate, now) : null;
  const publishLabel = state.published ? "Publish changes" : "Publish";
  const upgrade = (variant: "primary" | "outline") => (
    <UpgradeButtonView
      bookId={bookId}
      returnTo={`/books/${bookId}/publish`}
      isPaid={state.isPaid}
      paymentsEnabled={paymentsEnabled}
      variant={variant}
      testId="publish-upgrade"
      refresh={refresh}
    />
  );

  return (
    <div className="flex flex-col gap-stack" data-testid="publish-panel" data-state={state.expired ? "expired" : live ? "published" : "unpublished"}>
      {/* Same position in every branch so the message survives router.refresh(). */}
      <div aria-live="polite" data-testid="publish-message-slot">
        {message ? (
          <Notice tone={message.tone === "error" ? "error" : "success"}>
            {/* The testid sits on the text itself (Notice adds a screen-reader tone prefix). */}
            <p data-testid="publish-message">
              {message.text}
              {message.signIn ? (
                <>
                  {" "}
                  <Link href={`/login?next=${encodeURIComponent(`/books/${bookId}/publish`)}`} className="font-medium underline underline-offset-4">
                    Sign in
                  </Link>
                </>
              ) : null}
            </p>
          </Notice>
        ) : null}
      </div>

      {state.expired ? (
        <section className={CARD_WARN} data-testid="publish-expired">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="type-h2 text-foreground">{EXPIRED_COPY}</h2>
              <p className="type-small mt-1 text-foreground/85">You can still edit your book. Upgrading makes the link permanent.</p>
              {deletesOn ? (
                <p className="type-small mt-2 font-medium text-foreground" data-testid="publish-deletes-on">
                  {deletesOn}. Upgrade to keep it.
                </p>
              ) : null}
            </div>
          </div>
          {upgrade("primary")}
        </section>
      ) : live && state.url ? (
        <section className={CARD} data-testid="publish-live">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h2 className="type-h2 flex items-center gap-2 text-foreground">
              <span className="size-2.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
              Your book is live
            </h2>
            {expiry ? (
              <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground" data-testid="publish-expiry">
                {expiry}
              </span>
            ) : null}
          </div>
          <p className="type-small -mt-2 text-muted-foreground">Send the link to family and friends. It opens as a flipbook on any phone.</p>
          <ShareButtons
            url={state.url}
            title={title}
            layout="stack"
            secondary={
              <a href={`/b/${state.slug}`} target="_blank" rel="noopener noreferrer" className={SHARE_SECONDARY_CLASS} data-testid="publish-open">
                <ExternalLink className="size-4" aria-hidden="true" />
                Open book
              </a>
            }
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlId} className="type-eyebrow">
              Book link
            </label>
            <input
              id={urlId}
              readOnly
              value={state.url}
              dir="ltr"
              onFocus={(e) => e.currentTarget.select()}
              className="h-11 w-full min-w-0 truncate rounded-lg border border-border bg-muted px-3 font-mono text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              data-testid="publish-url"
            />
          </div>
        </section>
      ) : awaitingLink ? (
        <section className={CARD} data-testid="publish-pending" aria-busy="true">
          <p className="type-small flex items-center gap-2 text-muted-foreground">
            <Loader2 className={SPIN} aria-hidden="true" />
            Getting your link ready…
          </p>
        </section>
      ) : (
        <section className={CARD} data-testid="publish-draft">
          <div>
            <h2 className="type-h2 text-foreground">Ready to share?</h2>
            <p className="type-small mt-1 text-muted-foreground">
              Publishing creates a link you can send on WhatsApp. Later edits stay private until you publish them.
            </p>
          </div>
          {blocked ? <BlockNotice text={blockReasonCopy(blocked, state.maxPages)} /> : null}
          <button type="button" onClick={onPublish} disabled={locked || blocked !== null} className={PRIMARY} data-testid="publish-button">
            {busy === "publish" ? <Loader2 className={SPIN} aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            {publishLabel}
          </button>
          {state.publishedAt ? (
            <p className="text-xs text-muted-foreground">Your book keeps the same link{state.isPaid ? "" : " and expiry date"}.</p>
          ) : null}
        </section>
      )}

      {live && state.hasChanges ? (
        <section className={CARD_INFO} data-testid="publish-changes">
          <p className="type-small flex items-start gap-3 text-foreground">
            <Info className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
            <span className="min-w-0">You have edits that aren&apos;t in the shared book yet.</span>
          </p>
          {blocked ? <BlockNotice text={blockReasonCopy(blocked, state.maxPages)} /> : null}
          <button type="button" onClick={onPublish} disabled={locked || blocked !== null} className={PRIMARY} data-testid="publish-changes-button">
            {busy === "publish" ? <Loader2 className={SPIN} aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            Publish changes
          </button>
        </section>
      ) : null}

      {!state.isPaid && !state.expired ? <PlanCompareCard compare={compare}>{upgrade("outline")}</PlanCompareCard> : null}

      {state.isPaid ? (
        <section className={CARD} data-testid="publish-pdf">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-primary">
              <FileText className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="type-h2 text-foreground">PDF</h2>
              <p className="type-small mt-0.5 text-muted-foreground">Download your book as a print-ready PDF.</p>
            </div>
          </div>
          <PdfDownloadView
            bookId={bookId}
            isPaid={state.isPaid}
            paymentsEnabled={paymentsEnabled}
            returnTo={`/books/${bookId}/publish`}
            refresh={refresh}
            transport={pdfTransport}
          />
        </section>
      ) : null}

      {!state.expired ? <PasswordField hasPassword={state.hasPassword} setPassword={actions.setPassword} onChanged={onPasswordChanged} disabled={locked} /> : null}

      {state.published ? (
        // Quiet, at the bottom: turning the link off is rare and should never sit next to Share.
        <section className="mt-4 flex flex-col gap-3 border-t border-border pt-stack" data-testid="unpublish-section" aria-labelledby={unpublishHeadingId}>
          <div>
            <h2 id={unpublishHeadingId} className="type-eyebrow">
              Stop sharing
            </h2>
            <p className="type-small mt-1 text-muted-foreground">Unpublishing turns the link off for everyone.</p>
          </div>
          {confirmUnpublish ? (
            <div className="flex flex-col gap-3 rounded-xl border border-destructive-border bg-destructive-soft p-4" data-testid="unpublish-confirm">
              <p className="type-small text-foreground">
                Unpublish this book? The link stops working for everyone.
                {state.isPaid ? "" : " Publishing again keeps the same link and expiry date."}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onUnpublish}
                  disabled={locked}
                  className={BTN.touchDestructiveSolid}
                  data-testid="unpublish-confirm-button"
                >
                  {busy === "unpublish" ? <Loader2 className={SPIN} aria-hidden="true" /> : null}
                  Unpublish
                </button>
                <button type="button" onClick={() => setConfirmUnpublish(false)} disabled={busy === "unpublish"} className={OUTLINE}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmUnpublish(true)}
              disabled={locked}
              className={BTN.touchGhostDanger}
              data-testid="unpublish-button"
            >
              Unpublish
            </button>
          )}
        </section>
      ) : null}
    </div>
  );
}

function BlockNotice({ text }: { text: string }) {
  return (
    <Notice tone="warn">
      <p data-testid="publish-blocked">{text}</p>
    </Notice>
  );
}

/** Free vs upgraded, numbers from publishCompare() (LIMITS / UPGRADE / FREE_LINK_DAYS). */
function PlanCompareCard({ compare, children }: { compare: PublishCompare; children: ReactNode }) {
  return (
    <section className={CARD} data-testid="publish-free-notice" aria-labelledby="publish-compare-title">
      <div>
        <h2 id="publish-compare-title" className="type-h2 text-foreground">
          Free or upgraded
        </h2>
        <p className="type-small mt-1 text-muted-foreground" data-testid="publish-compare-summary">
          {compare.summary}. Upgrade once for a permanent link, no watermark and PDF download.
        </p>
      </div>
      <table className="type-small w-full table-fixed border-collapse text-start" data-testid="publish-compare">
        <caption className="sr-only">Free book compared with an upgraded book</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="w-[28%] pb-2 text-start font-normal">
              <span className="sr-only">Feature</span>
            </th>
            <th scope="col" className="pb-2 text-start align-bottom font-semibold text-foreground">
              Free
            </th>
            <th scope="col" className="pb-2 text-start align-bottom font-semibold text-foreground">
              Upgraded
              <span className="block text-xs font-normal text-muted-foreground" data-testid="publish-compare-price">
                {compare.price} · {compare.priceNote}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {compare.rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-0" data-row={row.key}>
              <th scope="row" className="py-2.5 pe-2 text-start align-top font-normal text-muted-foreground">
                {row.label}
              </th>
              <td className="py-2.5 pe-2 align-top text-foreground">
                <span className="flex items-start gap-1.5">
                  {row.freeIncluded ? null : <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0">{row.free}</span>
                </span>
              </td>
              <td className="py-2.5 align-top font-medium text-foreground">
                <span className="flex items-start gap-1.5">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
                  <span className="min-w-0">{row.paid}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </section>
  );
}
