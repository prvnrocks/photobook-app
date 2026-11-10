"use client";

// Payment return page body (M7 T7). Polls the owner-only getUpgradeStatus action (bound to the
// book on the server) until the Stripe webhook has marked the book paid. Never trusts the
// session_id query param and never claims success unless isPaid came back true.
//
// <UpgradeStatusPoller> wires next/navigation (router.refresh once after paid);
// <UpgradeStatusFlow> runs the poller and takes `refresh`, so it renders without an app router;
// <UpgradeStatusView> is the pure per-phase markup (unit tests, dev fixture).
// Polling rules live in src/lib/upgrade/poller.ts.

import { AlertCircle, CheckCircle2, Clock, ExternalLink, Loader2, RotateCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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

const BTN = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors disabled:opacity-50";
const PRIMARY = `${BTN} bg-primary text-primary-foreground hover:bg-primary/90`;
const OUTLINE = `${BTN} border bg-background hover:bg-muted`;

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

  if (phase === "polling") {
    return (
      <section className="flex flex-col items-center gap-4 py-10 text-center" aria-busy="true" data-testid="upgrade-polling">
        <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">Confirming payment…</h1>
        <p className="text-base text-muted-foreground" role="status">
          This usually takes a few seconds. Please keep this page open.
        </p>
      </section>
    );
  }

  if (phase === "paid") {
    return (
      <section className="flex flex-col gap-5" data-testid="upgrade-paid">
        <div className="flex flex-col items-center gap-3 pt-6 text-center">
          <CheckCircle2 className="size-10 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">Your book is upgraded</h1>
          <p className="text-base text-muted-foreground">Thank you! Here&apos;s what you get:</p>
        </div>
        <ul className="flex flex-col gap-2 rounded-2xl border p-4 text-sm" data-testid="upgrade-benefits">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            No watermark
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            Permanent link: it never expires
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            Up to {LIMITS.paid.maxPages} pages
          </li>
        </ul>
        <div className="flex flex-col gap-2">
          {liveSlug ? (
            <a
              href={`/b/${encodeURIComponent(liveSlug)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`${PRIMARY} w-full`}
              data-testid="upgrade-open-live"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              Open live link
            </a>
          ) : null}
          <Link href={publishHref} className={`${liveSlug ? OUTLINE : PRIMARY} w-full`} data-testid="upgrade-publish">
            {liveSlug ? "Publish screen" : "Publish your book"}
          </Link>
          <Link href={editHref} className={`${OUTLINE} w-full`} data-testid="upgrade-edit">
            Back to editor
          </Link>
        </div>
      </section>
    );
  }

  if (phase === "failed") {
    return (
      <section className="flex flex-col items-center gap-4 py-10 text-center" data-testid="upgrade-failed">
        <AlertCircle className="size-10 text-destructive" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">Payment didn&apos;t go through</h1>
        <p className="text-base text-muted-foreground">The payment wasn&apos;t completed. You can try again from the publish screen.</p>
        <Link href={publishHref} className={`${PRIMARY} w-full`} data-testid="upgrade-back-publish">
          Back to publish screen
        </Link>
      </section>
    );
  }

  if (phase === "timeout") {
    return (
      <section className="flex flex-col items-center gap-4 py-10 text-center" data-testid="upgrade-timeout">
        <Clock className="size-10 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">Still confirming</h1>
        <p className="text-base text-muted-foreground">
          Payment received — confirmation is taking longer than usual. Refresh in a minute.
        </p>
        <button type="button" onClick={onRetry} className={`${PRIMARY} w-full`} data-testid="upgrade-refresh">
          <RotateCw className="size-4" aria-hidden="true" />
          Refresh
        </button>
        <Link href={publishHref} className={`${OUTLINE} w-full`} data-testid="upgrade-timeout-publish">
          Back to publish screen
        </Link>
      </section>
    );
  }

  if (phase === "unauthenticated") {
    return (
      <section className="flex flex-col items-center gap-4 py-10 text-center" data-testid="upgrade-signed-out">
        <h1 className="text-2xl font-semibold">You&apos;ve been signed out</h1>
        <p className="text-base text-muted-foreground">Sign in again to see your upgrade status.</p>
        <Link
          href={`/login?next=${encodeURIComponent(upgradeSuccessPath(bookId))}`}
          className={`${PRIMARY} w-full`}
          data-testid="upgrade-sign-in"
        >
          Sign in
        </Link>
      </section>
    );
  }

  return (
    <section className="flex flex-col items-center gap-4 py-10 text-center" data-testid="upgrade-not-found">
      <h1 className="text-2xl font-semibold">We couldn&apos;t find this book</h1>
      <p className="text-base text-muted-foreground">It may have been deleted.</p>
      <Link href="/dashboard" className={`${PRIMARY} w-full`} data-testid="upgrade-dashboard">
        Go to my books
      </Link>
    </section>
  );
}
