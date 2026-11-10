"use client";

// Publish / share screen body (M6 T8, D-039 / D-040). Renders from the server's PublishState
// (getPublishState) and calls the bound publish actions; after every successful action the page
// refreshes so the state always comes from the server. Copy lives in src/lib/publish/ui.ts.
//
// <PublishPanel> wires next/navigation; <PublishPanelView> takes `refresh` so it renders without
// an app router (unit tests, dev fixture).

import { ExternalLink, Loader2, Send } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import type {
  PublishBookResult,
  PublishState,
  SetBookPasswordResult,
  UnpublishBookResult,
} from "@/app/books/[id]/publish/actions";
import { UpgradeButtonView } from "@/components/upgrade/UpgradeButton";
import { track } from "@/lib/analytics/client";
import { deletesOnLabel, expiredBookDeleteDate } from "@/lib/dashboard/deletion-chip";
import type { PdfTransport } from "@/lib/pdf/ui";
import { ShareButtons } from "@/components/viewer/ShareButtons";
import {
  blockReasonCopy,
  EXPIRED_COPY,
  expiryLabel,
  FREE_NOTICE_COPY,
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
};

type Message = { tone: "ok" | "error"; text: string; signIn?: boolean };

const BTN = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors disabled:opacity-50";
const PRIMARY = `${BTN} bg-primary text-primary-foreground hover:bg-primary/90`;
const OUTLINE = `${BTN} border bg-background hover:bg-muted`;

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
  const locked = busy !== null || refreshing;

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
    <div className="flex flex-col gap-4" data-testid="publish-panel" data-state={state.expired ? "expired" : live ? "published" : "unpublished"}>
      {/* Same position in every branch so the message survives router.refresh(). */}
      <div aria-live="polite" data-testid="publish-message-slot">
        {message ? (
          <p
            role={message.tone === "error" ? "alert" : "status"}
            className={
              message.tone === "error"
                ? "rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                : "rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            }
            data-testid="publish-message"
          >
            {message.text}
            {message.signIn ? (
              <>
                {" "}
                <Link href={`/login?next=${encodeURIComponent(`/books/${bookId}/publish`)}`} className="font-medium underline">
                  Sign in
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {state.expired ? (
        <section className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4" data-testid="publish-expired">
          <p className="text-base font-semibold text-amber-900">{EXPIRED_COPY}</p>
          <p className="text-sm text-amber-900/80">You can still edit your book. Upgrading makes the link permanent.</p>
          {deletesOn ? (
            <p className="text-sm font-medium text-amber-900" data-testid="publish-deletes-on">
              {deletesOn}. Upgrade to keep it.
            </p>
          ) : null}
          {upgrade("primary")}
        </section>
      ) : live && state.url ? (
        <section className="flex flex-col gap-3 rounded-xl border p-4" data-testid="publish-live">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Your book is live</h2>
            {expiry ? (
              <span className="shrink-0 text-xs text-muted-foreground" data-testid="publish-expiry">
                {expiry}
              </span>
            ) : null}
          </div>
          <input
            readOnly
            value={state.url}
            dir="ltr"
            aria-label="Book link"
            onFocus={(e) => e.currentTarget.select()}
            className="h-11 w-full min-w-0 truncate rounded-lg border bg-muted/40 px-3 font-mono text-sm"
            data-testid="publish-url"
          />
          <ShareButtons url={state.url} title={title} layout="stack" />
          <a
            href={`/b/${state.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`${OUTLINE} w-full`}
            data-testid="publish-open"
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            Open book
          </a>
        </section>
      ) : (
        <section className="flex flex-col gap-3 rounded-xl border p-4" data-testid="publish-draft">
          <h2 className="text-base font-semibold">Ready to share?</h2>
          <p className="text-sm text-muted-foreground">
            Publishing creates a link you can send on WhatsApp. Later edits stay private until you publish them.
          </p>
          {blocked ? <BlockNotice text={blockReasonCopy(blocked, state.maxPages)} /> : null}
          <button type="button" onClick={onPublish} disabled={locked || blocked !== null} className={`${PRIMARY} w-full`} data-testid="publish-button">
            {busy === "publish" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            {publishLabel}
          </button>
          {state.publishedAt ? (
            <p className="text-xs text-muted-foreground">Your book keeps the same link{state.isPaid ? "" : " and expiry date"}.</p>
          ) : null}
        </section>
      )}

      {live && state.hasChanges ? (
        <section className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4" data-testid="publish-changes">
          <p className="text-sm">You have edits that aren&apos;t in the shared book yet.</p>
          {blocked ? <BlockNotice text={blockReasonCopy(blocked, state.maxPages)} /> : null}
          <button type="button" onClick={onPublish} disabled={locked || blocked !== null} className={`${PRIMARY} w-full`} data-testid="publish-changes-button">
            {busy === "publish" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            Publish changes
          </button>
        </section>
      ) : null}

      {!state.isPaid && !state.expired ? (
        <section className="flex flex-col gap-3 rounded-xl bg-muted/50 p-4" data-testid="publish-free-notice">
          <p className="text-sm">{FREE_NOTICE_COPY}</p>
          {upgrade("outline")}
        </section>
      ) : null}

      {state.isPaid ? (
        <section className="flex flex-col gap-3 rounded-xl border p-4" data-testid="publish-pdf">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">PDF</h2>
            <p className="text-sm text-muted-foreground">Download your book as a print-ready PDF.</p>
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
        <section className="flex flex-col gap-2" data-testid="unpublish-section">
          {confirmUnpublish ? (
            <div className="flex flex-col gap-3 rounded-xl border border-destructive/30 p-4" data-testid="unpublish-confirm">
              <p className="text-sm">
                Unpublish this book? The link stops working for everyone.
                {state.isPaid ? "" : " Publishing again keeps the same link and expiry date."}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={onUnpublish} disabled={locked} className={`${BTN} bg-destructive text-white`} data-testid="unpublish-confirm-button">
                  {busy === "unpublish" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
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
              className="min-h-11 self-start px-1 text-sm font-medium text-destructive underline-offset-4 hover:underline disabled:opacity-50"
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
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="publish-blocked">
      {text}
    </p>
  );
}
