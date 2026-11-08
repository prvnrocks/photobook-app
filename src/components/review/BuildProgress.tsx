"use client";
// AI build progress (D-022): resumes `activeRunId` or starts a run, then loops advance until
// done and replaces the URL with the review screen. Never blocks the user: every stop state
// links to the review screen, where the rule album already exists.
// Only ids and counts are sent; nothing about photos is logged.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWakeLock, useWarnOnLeave } from "@/components/upload/use-keep-awake";
import { useThrottledValue } from "@/components/upload/use-throttled-value";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  advanceRun,
  getRun,
  startRun,
  type RunLimit,
  type RunTrigger,
  type StartOutcome,
} from "@/lib/runs/client";
import { abortableSleep, driveRun } from "@/lib/runs/drive";
import { limitCopy, newerSnapshot, stageCopy, type ProgressSnapshot } from "@/lib/runs/stage-copy";
import { cn } from "@/lib/utils";

export type BuildProgressProps = {
  bookId: string;
  /** The book's not-finished run, if any — resumed instead of starting a new one. */
  activeRunId: string | null;
  trigger: RunTrigger;
  isPaid: boolean;
  /** D-026 daily cap for this book's plan (for the limit message). */
  dailyCap: number;
};

type StopError =
  | "signed_out" // 401
  | "not_found" // book or run gone
  | "unavailable" // network / 5xx after back-off (resume keeps the same run)
  | "run_failed"; // run finished in state 'failed'

type Status =
  | { kind: "running"; reconnecting: boolean }
  | { kind: "error"; error: StopError }
  | { kind: "user_edited" }
  | { kind: "limit"; limit: RunLimit }
  | { kind: "leaving" };

/** GET poll while an advance tick (up to ~40 s) is in flight, for a moving bar. */
const POLL_MS = 4_000;
const LIVE_THROTTLE_MS = 2_000;

const ERROR_COPY: Record<StopError, string> = {
  signed_out: "You've been signed out. Sign in again to finish building your album.",
  not_found: "We couldn't find this album build. It may have been removed.",
  unavailable:
    "We lost the connection while building your album. Your photos are safe — try again to pick up where we left off.",
  run_failed: "We couldn't finish the AI album. Your photos are safe and your draft album is ready.",
};

const boxClass = "rounded-xl border p-4 text-base break-words";
const warnBox = `${boxClass} border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50`;
const buttonClass = "h-11 w-full px-4 text-base";

export function BuildProgress({ bookId, activeRunId, trigger, isPaid, dailyCap }: BuildProgressProps) {
  const router = useRouter();
  const reviewHref = `/books/${bookId}/review`;
  const loginHref = `/login?next=${encodeURIComponent(`/books/${bookId}/build`)}`;

  const runIdRef = useRef<string | null>(activeRunId);
  /**
   * The POST start promise, shared across StrictMode's double mount so one visit starts one
   * run (the start request is not aborted on unmount; its result is just ignored).
   */
  const startRef = useRef<Promise<StartOutcome> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const [status, setStatus] = useState<Status>({ kind: "running", reconnecting: false });
  const [snap, setSnap] = useState<ProgressSnapshot>({ state: "queued", progress: null });

  const running = status.kind === "running";
  useWakeLock(running);
  useWarnOnLeave(running);

  const report = useCallback((next: ProgressSnapshot) => {
    setSnap((cur) => newerSnapshot(cur, next));
  }, []);

  const goToReview = useCallback(() => {
    setStatus({ kind: "leaving" });
    router.replace(reviewHref);
  }, [router, reviewHref]);

  const run = useCallback(
    async (signal: AbortSignal) => {
      setStatus({ kind: "running", reconnecting: false });

      let runId = runIdRef.current;
      if (!runId) {
        startRef.current ??= startRun(bookId, trigger);
        const out = await startRef.current;
        if (signal.aborted) return;
        startRef.current = null;
        switch (out.kind) {
          case "started":
            if (out.state === "done") return goToReview(); // rule mode: album written already
            if (out.state === "failed") return setStatus({ kind: "error", error: "run_failed" });
            runId = out.runId;
            break;
          case "already_running":
            if (!out.runId) return setStatus({ kind: "error", error: "unavailable" });
            runId = out.runId;
            break;
          case "user_edited":
            return setStatus({ kind: "user_edited" });
          case "limit":
            return setStatus({ kind: "limit", limit: out.limit });
          case "signed_out":
            return setStatus({ kind: "error", error: "signed_out" });
          case "not_found":
          case "forbidden":
          case "invalid":
            return setStatus({ kind: "error", error: "not_found" });
          case "network":
          case "server_error":
            return setStatus({ kind: "error", error: "unavailable" });
        }
        runIdRef.current = runId;
      }

      const id = runId;
      // Show the current progress at once (a resumed run may be far along).
      void getRun(id, { signal }).then((g) => {
        if (!signal.aborted && g.kind === "view") report(g.view);
      });
      const poll = setInterval(() => {
        void getRun(id, { signal }).then((g) => {
          if (!signal.aborted && g.kind === "view") report(g.view);
        });
      }, POLL_MS);

      try {
        const res = await driveRun({
          runId: id,
          advance: (rid, s) => advanceRun(rid, { signal: s }),
          signal,
          sleep: abortableSleep,
          onTick: (tick) => {
            report(tick);
            setStatus((s) => (s.kind === "running" && s.reconnecting ? { kind: "running", reconnecting: false } : s));
          },
          onRetry: () => setStatus({ kind: "running", reconnecting: true }),
        });
        if (signal.aborted || res.kind === "aborted") return;
        if (res.kind === "done") {
          if (res.tick.state === "failed") {
            runIdRef.current = null;
            return setStatus({ kind: "error", error: "run_failed" });
          }
          return goToReview();
        }
        if (res.error === "not_found") runIdRef.current = null; // "Try again" starts a new run
        setStatus({ kind: "error", error: res.error });
      } finally {
        clearInterval(poll);
      }
    },
    [bookId, trigger, goToReview, report],
  );

  const begin = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    void run(controller.signal);
  }, [run]);

  useEffect(() => {
    begin();
    return () => controllerRef.current?.abort();
  }, [begin]);

  const copy = stageCopy(snap.state, snap.progress);
  const liveText = running
    ? status.reconnecting
      ? "Reconnecting…"
      : [copy.text, copy.detail].filter(Boolean).join(" ")
    : "";
  const announced = useThrottledValue(liveText, LIVE_THROTTLE_MS);

  if (status.kind === "user_edited") {
    return (
      <div className={cn(boxClass, "flex flex-col gap-3 bg-card")} data-testid="build-user-edited">
        <p>You&apos;ve edited this album, so we won&apos;t replace it.</p>
        <Link href={reviewHref} className={cn(buttonVariants(), buttonClass)} data-testid="build-to-review">
          Back to your album
        </Link>
      </div>
    );
  }

  if (status.kind === "limit") {
    return (
      <div className={cn(warnBox, "flex flex-col gap-3")} data-testid="build-limit" data-limit={status.limit}>
        <p>{limitCopy(status.limit, isPaid, dailyCap)}</p>
        <p className="text-sm">Your draft album is ready to look at and change.</p>
        <Link href={reviewHref} className={cn(buttonVariants(), buttonClass)} data-testid="build-to-review">
          See your album
        </Link>
      </div>
    );
  }

  if (status.kind === "error") {
    const { error } = status;
    return (
      <div
        className={cn(boxClass, "flex flex-col gap-3 border-destructive/30 bg-destructive/10")}
        data-testid="build-error"
        data-error={error}
      >
        <p className="text-destructive">{ERROR_COPY[error]}</p>
        {error === "signed_out" ? (
          <Link href={loginHref} className={cn(buttonVariants(), buttonClass)} data-testid="build-sign-in">
            Sign in
          </Link>
        ) : (
          <>
            <Button type="button" onClick={begin} className={buttonClass} data-testid="build-retry">
              Try again
            </Button>
            <Link
              href={reviewHref}
              className={cn(buttonVariants({ variant: "outline" }), buttonClass)}
              data-testid="build-to-review"
            >
              See your album
            </Link>
          </>
        )}
      </div>
    );
  }

  // running | leaving
  const leaving = status.kind === "leaving";
  const percent = leaving ? 100 : copy.percent;
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4" data-testid="build-progress" data-state={snap.state}>
      <p className="text-base font-medium" data-testid="build-stage">
        {leaving ? "Your album is ready" : copy.text}
      </p>
      {copy.detail && !leaving ? (
        <p className="text-sm text-muted-foreground" data-testid="build-capped">
          {copy.detail}
        </p>
      ) : null}
      <div
        role="progressbar"
        aria-label="Building your album"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        data-testid="build-bar"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      {status.kind === "running" && status.reconnecting ? (
        <p className="text-sm text-muted-foreground" data-testid="build-reconnecting">
          Connection lost — reconnecting…
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Keep this screen open. If you leave, we&apos;ll carry on when you come back.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announced}
      </p>
    </section>
  );
}
