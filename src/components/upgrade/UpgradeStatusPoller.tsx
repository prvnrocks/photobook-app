"use client";

// Payment return page body (M7 T7). Polls the owner-only getUpgradeStatus action (bound to the
// book on the server) until the Stripe webhook has marked the book paid. Never trusts the
// session_id query param and never claims success unless isPaid came back true.
//
// <UpgradeStatusPoller> wires next/navigation (router.refresh once after paid);
// <UpgradeStatusFlow> runs the poller and takes `refresh`, so it renders without an app router;
// <UpgradeStatusView> is the pure per-phase markup (unit tests, dev fixture).
// Polling rules live in src/lib/upgrade/poller.ts.
//
// M26 (D-078) emerald restyle: every state is one cream card (upgrade-classes.ts) with a seal; links
// are plain <a> (no next/link, cn or Button in this island — they cost ~10 kB on this first-load
// route). Motion (seal ring, paid burst) is CSS in upgrade-motion.css, static under reduced motion.

import { AlertCircle, BookX, Check, Clock, ExternalLink, Gem, LogIn, RotateCw, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import {
  UP_ACTIONS,
  UP_BENEFIT,
  UP_BENEFIT_CHECK,
  UP_BENEFITS,
  UP_BODY,
  UP_CARD,
  UP_CTA_EMERALD,
  UP_CTA_GOLD,
  UP_CTA_OUTLINE,
  UP_HEADING,
  UP_REF,
  UP_SEAL_CALM,
  UP_SEAL_CONFIRMING,
  UP_SEAL_PAID,
  UP_SEAL_WARM,
  UP_SEAL_WRAP,
} from "@/components/upgrade/upgrade-classes";
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

export function UpgradeStatusPoller(props: UpgradeStatusPollerProps) {
  // Stable refresh that always settles (a bare router.refresh() can hang under a loading.tsx).
  const [, refresh] = useRefreshTransition();
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


type SealTone = "confirming" | "paid" | "calm" | "warm";

const SEAL: Record<Exclude<SealTone, "confirming" | "paid">, string> = {
  calm: UP_SEAL_CALM,
  warm: UP_SEAL_WARM,
};

/** Paid burst: 12 gold / emerald dots spread round the seal, distances varied so it isn't a ring. */
const BURST = Array.from({ length: 12 }, (_, i) => ({
  a: Math.round((i * 360) / 12 + (i % 2 ? 11 : -7)),
  d: 44 + ((i * 23) % 30),
}));

/** The state seal (decorative). Confirming: turning gold ring + breathing icon; paid: gold seal + burst. */
function Seal({ tone, icon: Icon }: { tone: SealTone; icon: LucideIcon }) {
  if (tone === "confirming") {
    return (
      <span className={UP_SEAL_WRAP} aria-hidden="true" data-seal="confirming">
        <span className="up-seal-track" />
        <span className="up-seal-arc" />
        <span className={UP_SEAL_CONFIRMING}>
          <Icon className="up-seal-icon size-7" />
        </span>
      </span>
    );
  }
  if (tone === "paid") {
    return (
      <span className={UP_SEAL_WRAP} aria-hidden="true" data-seal="paid">
        <span className="up-burst" data-testid="upgrade-burst">
          {BURST.map((p, i) => (
            <i key={i} style={{ "--a": `${p.a}deg`, "--d": `${p.d}px`, "--i": i } as CSSProperties} />
          ))}
        </span>
        <span className={`${UP_SEAL_PAID} up-seal-pop`}>
          <Icon className="size-8" strokeWidth={2.5} />
        </span>
      </span>
    );
  }
  return (
    <span className={UP_SEAL_WRAP} aria-hidden="true" data-seal={tone}>
      <span className={SEAL[tone]}>
        <Icon className="size-7" />
      </span>
    </span>
  );
}

/** One centred cream status card: seal, h1 title, body, actions. */
function StatusCard({
  tone,
  icon,
  title,
  children,
  actions,
  testId,
  phase,
  busy = false,
}: {
  tone: SealTone;
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  testId: string;
  phase?: string;
  busy?: boolean;
}) {
  return (
    <section className={UP_CARD} data-testid={testId} data-phase={phase} aria-busy={busy || undefined}>
      <Seal tone={tone} icon={icon} />
      <h1 className={UP_HEADING}>{title}</h1>
      {children}
      {actions ? <div className={UP_ACTIONS}>{actions}</div> : null}
    </section>
  );
}

/*
 * Links are plain <a> on purpose: next/link would ship in this first-load island (M26 guardrail);
 * these are exits from the payment page, so a full load is fine.
 */
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
      <StatusCard
        tone="confirming"
        icon={Gem}
        busy
        testId="upgrade-polling"
        phase={phase}
        title={phase === "processing" ? "Your payment is processing…" : "Confirming payment…"}
      >
        <p className={UP_BODY} role="status">
          This usually takes a few seconds. Please keep this page open.
        </p>
      </StatusCard>
    );
  }

  if (phase === "paid") {
    return (
      <section className={UP_CARD} data-testid="upgrade-paid">
        <Seal tone="paid" icon={Check} />
        <div className="flex flex-col items-center gap-2">
          <h1 className={UP_HEADING}>Your book is upgraded</h1>
          <p className={UP_BODY}>Thank you! Here&apos;s what you get:</p>
        </div>
        <ul className={UP_BENEFITS} data-testid="upgrade-benefits">
          {[
            "No watermark",
            "Permanent link: it never expires",
            `Up to ${LIMITS.paid.maxPages} pages`,
            "PDF download",
          ].map((text) => (
            <li key={text} className={UP_BENEFIT}>
              <span className={UP_BENEFIT_CHECK} aria-hidden="true">
                <Check className="size-3.5" strokeWidth={3} />
              </span>
              <span className="min-w-0 pt-0.5">{text}</span>
            </li>
          ))}
        </ul>
        <div className={UP_ACTIONS}>
          {liveSlug ? (
            <a
              href={`/b/${encodeURIComponent(liveSlug)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={UP_CTA_GOLD}
              data-testid="upgrade-open-live"
            >
              <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
              Open live link
            </a>
          ) : null}
          <a href={publishHref} className={liveSlug ? UP_CTA_OUTLINE : UP_CTA_GOLD} data-testid="upgrade-publish">
            {liveSlug ? "Publish screen" : "Publish your book"}
          </a>
          <a href={editHref} className={UP_CTA_OUTLINE} data-testid="upgrade-edit">
            Back to editor
          </a>
        </div>
      </section>
    );
  }

  if (phase === "failed") {
    return (
      <StatusCard
        tone="warm"
        icon={AlertCircle}
        testId="upgrade-failed"
        title="Payment didn't go through"
        actions={
          <a href={publishHref} className={UP_CTA_EMERALD} data-testid="upgrade-back-publish">
            Back to publish screen
          </a>
        }
      >
        <p className={UP_BODY}>The payment wasn&apos;t completed. You can try again from the publish screen.</p>
      </StatusCard>
    );
  }

  if (phase === "support") {
    return (
      <StatusCard
        tone="warm"
        icon={AlertCircle}
        testId="upgrade-support"
        title="We need to check this payment"
        actions={
          <a href={publishHref} className={UP_CTA_OUTLINE} data-testid="upgrade-support-publish">
            Back to publish screen
          </a>
        }
      >
        <p className={UP_BODY} role="status">
          Something went wrong with this payment. We&apos;ll sort it out — contact support and mention this book.
        </p>
        <p className={UP_REF} data-testid="upgrade-support-ref">
          Book reference: {bookId}
        </p>
      </StatusCard>
    );
  }

  if (phase === "timeout") {
    return (
      <StatusCard
        tone="calm"
        icon={Clock}
        testId="upgrade-timeout"
        title="Still confirming"
        actions={
          <>
            <button type="button" onClick={onRetry} className={UP_CTA_EMERALD} data-testid="upgrade-refresh">
              <RotateCw className="size-4 shrink-0" aria-hidden="true" />
              Refresh
            </button>
            <a href={publishHref} className={UP_CTA_OUTLINE} data-testid="upgrade-timeout-publish">
              Back to publish screen
            </a>
          </>
        }
      >
        <p className={UP_BODY}>
          We haven&apos;t had confirmation from Stripe yet. If you completed payment, this page will update
          shortly — you won&apos;t be charged twice.
        </p>
      </StatusCard>
    );
  }

  if (phase === "unauthenticated") {
    return (
      <StatusCard
        tone="calm"
        icon={LogIn}
        testId="upgrade-signed-out"
        title="You've been signed out"
        actions={
          <a href={`/login?next=${encodeURIComponent(upgradeSuccessPath(bookId))}`} className={UP_CTA_EMERALD} data-testid="upgrade-sign-in">
            Sign in
          </a>
        }
      >
        <p className={UP_BODY}>Sign in again to see your upgrade status.</p>
      </StatusCard>
    );
  }

  return (
    <StatusCard
      tone="calm"
      icon={BookX}
      testId="upgrade-not-found"
      title="We couldn't find this book"
      actions={
        <a href="/dashboard" className={UP_CTA_EMERALD} data-testid="upgrade-dashboard">
          Go to my books
        </a>
      }
    >
      <p className={UP_BODY}>It may have been deleted.</p>
    </StatusCard>
  );
}
