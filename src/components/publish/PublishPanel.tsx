"use client";

// Publish / share screen body (M6 T8, D-039 / D-040; split in M21 T3). Orchestration only: holds
// the action state, calls the bound publish actions and places the cards — every card renders from
// the server's PublishState (getPublishState); after every successful action the page refreshes so
// the state always comes from the server. Copy lives in src/lib/publish/ui.ts.
//   message slot → [preview tile] → PrimaryActionCard (draft / changes / pending / live / expired)
//   → ShareLinkCard (while live) → plan card (free) → PDF (paid) → password → stop sharing.
// Celebration (publish success or ?shared=): data-celebrate on the panel, the live card and the
// preview tile; nothing moves under reduced motion (share-motion.css).
//
// <PublishPanel> wires next/navigation; <PublishPanelView> takes `refresh` so it renders without
// an app router (unit tests, dev fixture). No cn/buttonVariants/next/link here (lesson 2026-11-14).

import { ExternalLink, FileText } from "lucide-react";
import type { PublishBookResult, PublishState, SetBookPasswordResult, UnpublishBookResult } from "@/app/books/[id]/publish/actions";
import { Notice } from "@/components/app/Notice";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { UpgradeButtonView } from "@/components/upgrade/UpgradeButton";
import type { PdfTransport } from "@/lib/pdf/ui";
import type { PublishCompare } from "@/lib/publish/compare";
import { shareStatus } from "@/lib/publish/status";
import { LIVE_TEXT, SHARE_COPY } from "@/lib/publish/ui";
import { PasswordField } from "./PasswordField";
import { PdfDownloadView } from "./PdfDownload";
import { PlanCompareCard } from "./PlanCompareCard";
import { PrimaryActionCard, primaryActionKind } from "./PrimaryActionCard";
import { SHARE_CTA_EMERALD, SHARE_OPEN_LINK } from "./share-classes";
import { ShareLinkCard } from "./ShareLinkCard";
import { SharePreview, type SharePreviewData } from "./SharePreview";
import { UnpublishSection } from "./UnpublishSection";
import { usePublishPanel, type PanelMessage } from "./use-publish-panel";
import "./share-motion.css";

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
  /** The editor's Share just published (`?shared=`, M13 T9): shown once as the success message. */
  shared?: "live" | "changes" | null;
  /**
   * getPublishState().preview (M21): when given, the panel shows the SharePreview tile first (it
   * carries "Open flipbook" and the celebration burst). Omitted → no tile; the link card carries
   * "Open book" and the live card bursts.
   */
  preview?: SharePreviewData | null;
};

// Old-style cards for the PDF section until T4 restyles it.
const CARD = "flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-5";

export function PublishPanel(props: PublishPanelProps) {
  // Not startTransition(router.refresh): that can stay pending forever under publish/loading.tsx.
  const [pending, refresh] = useRefreshTransition();
  return <PublishPanelView {...props} refresh={refresh} refreshing={pending} />;
}

/**
 * Heading of the live card: "Your book is live" — unless the notice above already says exactly
 * that (just published), then the card names the next step instead (M13 polish: shown once).
 */
export function liveHeading(message: { text: string } | null): string {
  return message?.text === LIVE_TEXT ? "Share your link" : LIVE_TEXT;
}

export function PublishPanelView({
  bookId,
  title,
  state,
  actions,
  paymentsEnabled,
  compare,
  shared = null,
  preview = null,
  refresh,
  refreshing = false,
  now,
  wait,
  pdfTransport,
}: PublishPanelProps & {
  refresh: () => void;
  refreshing?: boolean;
  /** Clock for the expiry label / share status (tests). */
  now?: Date;
  /** Conflict retry delay (tests). */
  wait?: (ms: number) => Promise<void>;
  /** PDF API transport (dev fixture); defaults to same-origin fetch. */
  pdfTransport?: PdfTransport;
}) {
  const { busy, message, celebrate, publishedOn, confirmUnpublish, setConfirmUnpublish, onPublish, onUnpublish, onPasswordChanged } =
    usePublishPanel({ state, actions, shared, refresh, wait });
  const locked = busy !== null || refreshing;

  const status = shareStatus(state, now ?? new Date());
  const expired = status.kind === "expired";
  const live = state.published && !expired;
  const kind = primaryActionKind(status, !state.published && publishedOn === state);
  const celebrating = celebrate && kind === "live";
  const openHref = `/b/${state.slug}`;
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
    <div
      className="flex flex-col gap-stack"
      data-testid="publish-panel"
      data-state={expired ? "expired" : live ? "published" : "unpublished"}
      data-celebrate={celebrating ? "on" : undefined}
    >
      {/* Same position in every branch so the message survives router.refresh(). */}
      <div aria-live="polite" data-testid="publish-message-slot">
        {message ? <PanelNotice message={message} bookId={bookId} /> : null}
      </div>

      {preview ? (
        <SharePreview
          preview={preview}
          title={title}
          pageCount={state.pageCount}
          celebrate={celebrating}
          open={live && state.slug ? <OpenLink href={openHref} className={SHARE_OPEN_LINK} label={SHARE_COPY.openFlipbook} /> : undefined}
        />
      ) : null}

      <PrimaryActionCard
        key={kind}
        kind={kind}
        state={state}
        liveHeading={liveHeading(message)}
        busy={busy === "publish"}
        locked={locked}
        onPublish={onPublish}
        upgrade={upgrade("primary")}
        celebrate={celebrating}
        burst={!preview}
        now={now}
      />

      {live && state.url ? (
        <ShareLinkCard
          url={state.url}
          title={title}
          open={preview ? undefined : <OpenLink href={openHref} className={SHARE_CTA_EMERALD} label={SHARE_COPY.openBook} />}
        />
      ) : null}

      {!state.isPaid && !expired ? <PlanCompareCard compare={compare}>{upgrade("outline")}</PlanCompareCard> : null}

      {state.isPaid ? (
        <PdfSection bookId={bookId} paymentsEnabled={paymentsEnabled} refresh={refresh} transport={pdfTransport} />
      ) : null}

      {!expired ? <PasswordField hasPassword={state.hasPassword} setPassword={actions.setPassword} onChanged={onPasswordChanged} disabled={locked} /> : null}

      {state.published ? (
        <UnpublishSection
          isPaid={state.isPaid}
          confirming={confirmUnpublish}
          onConfirmChange={setConfirmUnpublish}
          onUnpublish={onUnpublish}
          busy={busy === "unpublish"}
          locked={locked}
        />
      ) : null}
    </div>
  );
}

/** The live book in a new tab (testid publish-open): a plain <a> — the viewer is its own app. */
function OpenLink({ href, className, label }: { href: string; className: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} data-testid="publish-open">
      <ExternalLink className="size-4" aria-hidden="true" />
      {label}
    </a>
  );
}

/** The one-time message above the cards; the testid sits on the text (Notice adds an sr-only tone). */
function PanelNotice({ message, bookId }: { message: PanelMessage; bookId: string }) {
  return (
    <Notice tone={message.tone === "error" ? "error" : "success"}>
      <p data-testid="publish-message">
        {message.text}
        {message.signIn ? (
          <>
            {" "}
            <a href={`/login?next=${encodeURIComponent(`/books/${bookId}/publish`)}`} className="font-medium underline underline-offset-4">
              {SHARE_COPY.signIn}
            </a>
          </>
        ) : null}
      </p>
    </Notice>
  );
}

/** Paid books: the PDF download (old card look until T4's PdfCard). Never rendered for free books. */
function PdfSection(props: { bookId: string; paymentsEnabled: boolean; refresh: () => void; transport?: PdfTransport }) {
  return (
    <section id="pdf" className={CARD} data-testid="publish-pdf">
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
        bookId={props.bookId}
        isPaid
        paymentsEnabled={props.paymentsEnabled}
        returnTo={`/books/${props.bookId}/publish`}
        refresh={props.refresh}
        transport={props.transport}
      />
    </section>
  );
}
