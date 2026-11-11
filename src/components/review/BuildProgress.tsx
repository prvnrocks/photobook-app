"use client";
// AI build progress (D-022): resumes `activeRunId` or starts a run, then loops advance until
// done and replaces the URL with the review screen. Never blocks the user: every stop state
// links to the review screen, where the rule album already exists.
// Only ids and counts are sent; nothing about photos is logged.
import { Check, Circle, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWakeLock, useWarnOnLeave } from "@/components/upload/use-keep-awake";
import { useThrottledValue } from "@/components/upload/use-throttled-value";
import { Notice } from "@/components/app/Notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { track } from "@/lib/analytics/client";
import { msBucket } from "@/lib/analytics/events";
import {
  advanceRun,
  getRun,
  startRun,
  type RunLimit,
  type RunTrigger,
  type StartOutcome,
} from "@/lib/runs/client";
import { abortableSleep, DriveWaker, driveRun } from "@/lib/runs/drive";
import { limitCopy, newerSnapshot, stageCopy, type ProgressSnapshot } from "@/lib/runs/stage-copy";
import { buildChecklist, type ChecklistStepState } from "@/lib/runs/build-checklist";
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
  run_failed: "We couldn't finish with AI. Your photos are safe — open the review to continue.",
};

const STEP_STATE_SR: Record<ChecklistStepState, string> = {
  done: "done",
  current: "in progress",
  todo: "not started",
};

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
  /** Tab visible again / back online → resume a stalled loop (see src/lib/runs/drive.ts). */
  const [waker] = useState(() => new DriveWaker());

  const [status, setStatus] = useState<Status>({ kind: "running", reconnecting: false });
  const [snap, setSnap] = useState<ProgressSnapshot>({ state: "queued", progress: null });

  const running = status.kind === "running";
  useWakeLock(running);
  useWarnOnLeave(running);

  const report = useCallback((next: ProgressSnapshot) => {
    setSnap((cur) => newerSnapshot(cur, next));
  }, []);

  // analytics (M9 T14): time on this screen, bucketed; sent once per visit.
  const [mountedAt] = useState(() => Date.now());
  const sentRef = useRef(false);
  const trackDone = useCallback(
    (mode: "ai" | "rules", outcome: "ok" | "failed") => {
      if (sentRef.current) return;
      sentRef.current = true;
      track("ai_build_done", { mode, outcome, ms_bucket: msBucket(Date.now() - mountedAt) });
    },
    [mountedAt],
  );

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
            if (out.state === "done") {
              trackDone("rules", "ok");
              return goToReview(); // rule mode: album written already
            }
            if (out.state === "failed") {
              trackDone("ai", "failed");
              return setStatus({ kind: "error", error: "run_failed" });
            }
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
          waker,
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
            trackDone("ai", "failed");
            return setStatus({ kind: "error", error: "run_failed" });
          }
          trackDone("ai", "ok");
          return goToReview();
        }
        if (res.error === "not_found") runIdRef.current = null; // "Try again" starts a new run
        setStatus({ kind: "error", error: res.error });
      } finally {
        clearInterval(poll);
      }
    },
    [bookId, trigger, goToReview, report, waker, trackDone],
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

  // Phones: after the device slept or lost the network, carry on as soon as the user is back.
  // A running loop is woken (one request at a time — drive.ts replaces a stale one); a loop that
  // gave up on the connection meanwhile is restarted (same run: runIdRef is kept).
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      const st = statusRef.current;
      if (st.kind === "running") waker.wake();
      else if (st.kind === "error" && st.error === "unavailable" && navigator.onLine !== false) begin();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [waker, begin]);

  const copy = stageCopy(snap.state, snap.progress);
  const liveText = running
    ? status.reconnecting
      ? "Reconnecting…"
      : [copy.text, copy.detail].filter(Boolean).join(" ")
    : "";
  const announced = useThrottledValue(liveText, LIVE_THROTTLE_MS);

  if (status.kind === "user_edited") {
    return (
      <div data-testid="build-user-edited">
        <Notice
          tone="info"
          title="You've edited this album, so we won't replace it."
          action={
            <Link href={reviewHref} className={cn(buttonVariants({ size: "cta" }))} data-testid="build-to-review">
              Back to your album
            </Link>
          }
        />
      </div>
    );
  }

  if (status.kind === "limit") {
    return (
      <div data-testid="build-limit" data-limit={status.limit}>
        <Notice
          tone="warn"
          title={limitCopy(status.limit, isPaid, dailyCap)}
          action={
            <Link href={reviewHref} className={cn(buttonVariants({ size: "cta" }))} data-testid="build-to-review">
              See your album
            </Link>
          }
        >
          Your draft album is ready to look at and change.
        </Notice>
      </div>
    );
  }

  if (status.kind === "error") {
    const { error } = status;
    return (
      <div data-testid="build-error" data-error={error}>
        <Notice
          tone="error"
          title={ERROR_COPY[error]}
          action={
            error === "signed_out" ? (
              <Link href={loginHref} className={cn(buttonVariants({ size: "cta" }))} data-testid="build-sign-in">
                Sign in
              </Link>
            ) : (
              <>
                <Button type="button" size="cta" onClick={begin} data-testid="build-retry">
                  Try again
                </Button>
                <Link
                  href={reviewHref}
                  className={cn(buttonVariants({ variant: "outline", size: "cta" }))}
                  data-testid="build-to-review"
                >
                  See your album
                </Link>
              </>
            )
          }
        />
      </div>
    );
  }

  // running | leaving
  const leaving = status.kind === "leaving";
  const percent = leaving ? 100 : copy.percent;
  const steps = buildChecklist(snap.state, snap.progress, leaving);
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-gutter shadow-card sm:p-6"
      data-testid="build-progress"
      data-state={snap.state}
      aria-labelledby="build-stage"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p id="build-stage" className="type-h2 break-words text-foreground" data-testid="build-stage">
          {leaving ? "Your album is ready" : copy.text}
        </p>
        {copy.detail && !leaving ? (
          <p className="type-small text-muted-foreground" data-testid="build-capped">
            {copy.detail}
          </p>
        ) : null}
      </div>
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
          className="h-full rounded-full bg-accent-strong transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Stages the server has reported — never a timer (src/lib/runs/build-checklist.ts). */}
      <ol className="flex flex-col gap-1" aria-label="Build steps" data-testid="build-checklist">
        {steps.map((s) => (
          <li
            key={s.id}
            className="flex min-h-11 min-w-0 items-center gap-3"
            data-testid={`build-step-${s.id}`}
            data-state={s.state}
            aria-current={s.state === "current" ? "step" : undefined}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full",
                s.state === "done" && "bg-primary text-primary-foreground",
                s.state === "current" && "bg-accent-strong/10 text-accent-strong",
                s.state === "todo" && "text-input",
              )}
            >
              {s.state === "done" ? (
                <Check className="size-4" />
              ) : s.state === "current" ? (
                <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Circle className="size-5" />
              )}
            </span>
            <span
              className={cn(
                "type-small min-w-0 flex-1 break-words",
                s.state === "todo" ? "text-muted-foreground" : "font-medium text-foreground",
              )}
            >
              {s.label}
              <span className="sr-only"> ({STEP_STATE_SR[s.state]})</span>
            </span>
            {s.count ? (
              <span className="type-small shrink-0 tabular-nums text-muted-foreground">{s.count}</span>
            ) : null}
          </li>
        ))}
      </ol>

      {status.kind === "running" && status.reconnecting ? (
        <p className="type-small text-warning" data-testid="build-reconnecting">
          Connection lost — reconnecting…
        </p>
      ) : null}
      <Notice tone="info" title="Keep this screen open">
        If you leave, we&apos;ll carry on when you come back.
      </Notice>
      <p className="sr-only" role="status" aria-live="polite">
        {announced}
      </p>
    </section>
  );
}
