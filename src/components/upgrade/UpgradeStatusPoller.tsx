"use client";

// Payment return page body (M7 T7). Polls the owner-only getUpgradeStatus action (bound to the
// book on the server) until the Stripe webhook has marked the book paid. Never trusts the
// session_id query param and never claims success unless isPaid came back true.
//
// <UpgradeStatusPoller> wires next/navigation (router.refresh once after paid);
// <UpgradeStatusFlow> runs the poller and takes `refresh`, so it renders without an app router;
// <UpgradeStatusView> is the pure per-phase markup (unit tests, dev fixture).
// Polling rules live in src/lib/upgrade/poller.ts.

import { AlertCircle, BookX, Check, CheckCircle2, Clock, ExternalLink, Loader2, LogIn, RotateCw, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BTN } from "@/components/app/button-classes";
import { EmptyState } from "@/components/app/EmptyState";
import { LIMITS } from "@/lib/ai/limits";
import { createUpgradePoller, type UpgradePollPhase } from "@/lib/upgrade/poller";
import type { UpgradeStatusResult } from "@/lib/upgrade/types";

export type UpgradeStatusPollerProps = {
  bookId: string;
  /** Live books.is_paid at page load: true → success right away, no polling. */
  initialPaid: boolean;
  /** Public slug when a live snapshot exists (published), else null. */
  liveSlug: string | null;
  /** getUpgradeStatus bound to this book. */
  check: () => Promise<UpgradeStatusResult>;
};

// Shared Button looks (M11, D-067) on links and buttons alike, precomputed (BTN) so this route ships
// no cn/ui-button.
const PRIMARY = BTN.ctaPrimary;
const OUTLINE = BTN.ctaOutlineCard;

export function UpgradeStatusPoller(props: UpgradeStatusPollerProps) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  return <UpgradeStatusFlow {...props} refresh={refresh} />;
}

export function UpgradeStatusFlow({
  bookId,
  initialPaid,
  liveSlug,
  check,
  refresh,
}: UpgradeStatusPollerProps & { refresh: () => void }) {
  const [phase, setPhase] = useState<UpgradePollPhase>(initialPaid ? "paid" : "polling");
  const [run, setRun] = useState(0);
  // The bound action may get a new identity on every server refresh; polling must not restart.
  const checkRef = useRef(check);
  const refreshRef = useRef(refresh);
  const refreshed = useRef(false);
  // Captured once: a server refresh after payment flips initialPaid but must not alter the run.
  const skipPolling = useRef(initialPaid);

  useEffect(() => {
    checkRef.current = check;
    refreshRef.current = refresh;
  }, [check, refresh]);

  useEffect(() => {
    if (skipPolling.current) return;
    const poller = createUpgradePoller({
      check: () => checkRef.current(),
      onPhase: setPhase,
      isHidden: () => document.visibilityState === "hidden",
    });
    const onVisibility = () => poller.setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    poller.start();
    return () => {
      poller.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [run]);

  useEffect(() => {
    if (phase !== "paid" || skipPolling.current || refreshed.current) return;
    refreshed.current = true;
    refreshRef.current();
  }, [phase]);

  const retry = useCallback(() => {
    setPhase("polling");
    setRun((r) => r + 1);
  }, []);

  return <UpgradeStatusView bookId={bookId} phase={phase} liveSlug={liveSlug} onRetry={retry} />;
}

export function upgradeSuccessPath(bookId: string): string {
  return `/books/${bookId}/upgrade/success`;
}

type Tone = "busy" | "success" | "error" | "neutral";

const TONE_RING: Record<Tone, string> = {
  busy: "bg-secondary text-accent-strong",
  success: "bg-success-soft text-success",
  error: "bg-destructive-soft text-destructive",
  neutral: "bg-secondary text-primary",
};

/** One centred status screen on the shared EmptyState: icon disc as its art, h1 title, body, actions. */
function StatusScreen({
  tone,
  icon: Icon,
  title,
  children,
  actions,
  testId,
  phase,
  busy = false,
}: {
  tone: Tone;
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  testId: string;
  phase?: string;
  busy?: boolean;
}) {
  return (
    <EmptyState
      headingLevel={1}
      title={title}
      action={actions}
      data-testid={testId}
      data-phase={phase}
      aria-busy={busy}
      art={
        <span className={`flex size-16 items-center justify-center rounded-full ${TONE_RING[tone]}`}>
          <Icon className={busy ? "size-8 animate-spin motion-reduce:animate-none" : "size-8"} aria-hidden="true" />
        </span>
      }
    >
      {children}
    </EmptyState>
  );
}

export function UpgradeStatusView({
  bookId,
  phase,
  liveSlug,
  onRetry,
}: {
  bookId: string;
  phase: UpgradePollPhase;
  liveSlug: string | null;
  onRetry: () => void;
}) {
  const publishHref = `/books/${bookId}/publish`;
  const editHref = `/books/${bookId}/edit`;

  if (phase === "polling" || phase === "processing") {
    return (
      <StatusScreen
        tone="busy"
        icon={Loader2}
        busy
        testId="upgrade-polling"
        phase={phase}
        title={phase === "processing" ? "Your payment is processing…" : "Confirming payment…"}
      >
        <p className="type-body text-muted-foreground" role="status">
          This usually takes a few seconds. Please keep this page open.
        </p>
      </StatusScreen>
    );
  }

  if (phase === "paid") {
    return (
      <section className="flex flex-col gap-stack" data-testid="upgrade-paid">
        <div className="flex flex-col items-center gap-3 pt-4 text-center">
          <span className={`flex size-16 items-center justify-center rounded-full ${TONE_RING.success}`}>
            <CheckCircle2 className="size-8" aria-hidden="true" />
          </span>
          <h1 className="type-h1 text-foreground">Your book is upgraded</h1>
          <p className="type-body text-muted-foreground">Thank you! Here&apos;s what you get:</p>
        </div>
        <ul className="type-small flex flex-col divide-y divide-border rounded-2xl border border-border bg-card px-4 shadow-card" data-testid="upgrade-benefits">
          {[
            "No watermark",
            "Permanent link: it never expires",
            `Up to ${LIMITS.paid.maxPages} pages`,
            "PDF download",
          ].map((text) => (
            <li key={text} className="flex items-start gap-3 py-3">
              <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2">
          {liveSlug ? (
            <a
              href={`/b/${encodeURIComponent(liveSlug)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={PRIMARY}
              data-testid="upgrade-open-live"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              Open live link
            </a>
          ) : null}
          <Link href={publishHref} className={liveSlug ? OUTLINE : PRIMARY} data-testid="upgrade-publish">
            {liveSlug ? "Publish screen" : "Publish your book"}
          </Link>
          <Link href={editHref} className={OUTLINE} data-testid="upgrade-edit">
            Back to editor
          </Link>
        </div>
      </section>
    );
  }

  if (phase === "failed") {
    return (
      <StatusScreen
        tone="error"
        icon={AlertCircle}
        testId="upgrade-failed"
        title="Payment didn't go through"
        actions={
          <Link href={publishHref} className={PRIMARY} data-testid="upgrade-back-publish">
            Back to publish screen
          </Link>
        }
      >
        <p className="type-body text-muted-foreground">The payment wasn&apos;t completed. You can try again from the publish screen.</p>
      </StatusScreen>
    );
  }

  if (phase === "support") {
    return (
      <StatusScreen
        tone="error"
        icon={AlertCircle}
        testId="upgrade-support"
        title="We need to check this payment"
        actions={
          <Link href={publishHref} className={OUTLINE} data-testid="upgrade-support-publish">
            Back to publish screen
          </Link>
        }
      >
        <p className="type-body text-muted-foreground" role="status">
          Something went wrong with this payment. We&apos;ll sort it out — contact support and mention this book.
        </p>
        <p className="w-full break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground" data-testid="upgrade-support-ref">
          Book reference: {bookId}
        </p>
      </StatusScreen>
    );
  }

  if (phase === "timeout") {
    return (
      <StatusScreen
        tone="neutral"
        icon={Clock}
        testId="upgrade-timeout"
        title="Still confirming"
        actions={
          <>
            <button type="button" onClick={onRetry} className={PRIMARY} data-testid="upgrade-refresh">
              <RotateCw className="size-4" aria-hidden="true" />
              Refresh
            </button>
            <Link href={publishHref} className={OUTLINE} data-testid="upgrade-timeout-publish">
              Back to publish screen
            </Link>
          </>
        }
      >
        <p className="type-body text-muted-foreground">
          We haven&apos;t had confirmation from Stripe yet. If you completed payment, this page will update
          shortly — you won&apos;t be charged twice.
        </p>
      </StatusScreen>
    );
  }

  if (phase === "unauthenticated") {
    return (
      <StatusScreen
        tone="neutral"
        icon={LogIn}
        testId="upgrade-signed-out"
        title="You've been signed out"
        actions={
          <Link href={`/login?next=${encodeURIComponent(upgradeSuccessPath(bookId))}`} className={PRIMARY} data-testid="upgrade-sign-in">
            Sign in
          </Link>
        }
      >
        <p className="type-body text-muted-foreground">Sign in again to see your upgrade status.</p>
      </StatusScreen>
    );
  }

  return (
    <StatusScreen
      tone="neutral"
      icon={BookX}
      testId="upgrade-not-found"
      title="We couldn't find this book"
      actions={
        <Link href="/dashboard" className={PRIMARY} data-testid="upgrade-dashboard">
          Go to my books
        </Link>
      }
    >
      <p className="type-body text-muted-foreground">It may have been deleted.</p>
    </StatusScreen>
  );
}
