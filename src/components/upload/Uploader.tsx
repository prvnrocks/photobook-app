"use client";
// Upload screen client: picker → resumable queue (T11) → finalize (T9) → summary.
// The queue (+ supabase-js) is loaded on the first selection; processPhoto and
// with it exifr / heic2any are loaded one level deeper, on the first photo.
// Nothing about the photos (names, dates, places) is logged or sent anywhere
// except the user's own Supabase rows/files.
import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ChangeEvent } from "react";
import { deleteUnfinishedAction } from "@/app/books/actions";
import { Button } from "@/components/ui/button";
import {
  finalizeWithPlaces,
  type FinalizeError,
  type FinalizeResult,
} from "@/lib/upload/finalize-client";
import type {
  ExistingPhoto,
  QueueEvent,
  QueueProgress,
  QueueSummary,
  UploadQueue,
} from "@/lib/upload/queue";
import { plural } from "@/lib/upload/summary-text";
import { UploadProgress } from "./UploadProgress";
import { UploadSummary } from "./UploadSummary";
import { useWakeLock, useWarnOnLeave } from "./use-keep-awake";

export type UploaderProps = {
  bookId: string;
  userId: string;
  isPaid: boolean;
  /** All photo rows of the book (pending + ready), for resume / de-dup. */
  existing: ExistingPhoto[];
  maxUpload: number;
  readyCount: number;
  pendingCount: number;
  /** Book already has an album doc (finalize wrote one before). */
  hasDoc: boolean;
};

type Phase = "idle" | "running" | "finalizing" | "finalize_error" | "done";

const FINALIZE_MESSAGES: Record<FinalizeError, string> = {
  signed_out: "You've been signed out. Please sign in again to finish your album.",
  not_found: "We couldn't find this book. It may have been deleted.",
  failed: "We couldn't finish setting up your album. Your photos are safe — please try again.",
  rate_limited: "We're still finishing your album. Your photos are safe — please try again in a moment.",
};

const noticeClass = "rounded-xl border p-4 text-base break-words";

export function Uploader(props: UploaderProps) {
  const { bookId, userId, isPaid, maxUpload } = props;
  const loginHref = `/login?next=${encodeURIComponent(`/books/${bookId}/upload`)}`;

  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<UploadQueue | null>(null);
  const queueLoadRef = useRef<Promise<UploadQueue> | null>(null);
  const runningRef = useRef(false);
  /** Set on unmount: no finalize POST / state updates for a screen that's gone. */
  const unmountedRef = useRef(false);
  /** Aborted on unmount: stops finalize retries / follow-ups that are waiting. */
  const finalizeAbortRef = useRef<AbortController | null>(null);
  const addedRef = useRef(0);
  /** queue.uploaded at the last successful finalize. */
  const finalizedAtRef = useRef(0);
  const hasDocRef = useRef(props.hasDoc);
  /** props.readyCount when the current queue was created. */
  const baseReadyRef = useRef(props.readyCount);

  const [phase, setPhase] = useState<Phase>("idle");
  /** props.readyCount when the current queue was created; null = no queue. */
  const [baseReady, setBaseReady] = useState<number | null>(null);
  const [progress, setProgress] = useState<QueueProgress | null>(null);
  const [paused, setPaused] = useState(false);
  const [limitNotice, setLimitNotice] = useState<{ limit: number; skipped: number } | null>(null);
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [finalize, setFinalize] = useState<FinalizeResult | null>(null);
  const [finalizeError, setFinalizeError] = useState<FinalizeError | null>(null);
  /** Epoch ms before which "Try again" stays disabled (server Retry-After). */
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(props.pendingCount);
  const [loadFailed, setLoadFailed] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, startRemove] = useTransition();

  const uploading = phase === "running";
  const busy = uploading || phase === "finalizing";
  useWakeLock((uploading && !paused) || phase === "finalizing");
  // Also while finalizing: leaving then would skip places/duplicates until the next visit.
  useWarnOnLeave(busy);

  // Leaving the screen in-app (header link) stops the queue after the current photo;
  // unfinished rows stay pending and resume on the next visit. No finalize afterwards.
  useEffect(() => {
    unmountedRef.current = false; // StrictMode re-mounts
    return () => {
      unmountedRef.current = true;
      finalizeAbortRef.current?.abort();
      queueRef.current?.cancel();
    };
  }, []);

  // Countdown for a pending Retry-After on the "Try again" button.
  useEffect(() => {
    if (retryAt === null) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= retryAt) setRetryAt(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [retryAt]);
  const retryWaitSec = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));

  const readyCount = baseReady === null ? props.readyCount : baseReady + (progress?.uploaded ?? 0);
  const fatal = summary?.fatal === "not_allowed";

  function onEvent(e: QueueEvent) {
    if (e.type === "progress") setProgress(e);
    else if (e.type === "limit") {
      setLimitNotice((prev) => ({ limit: e.limit, skipped: (prev?.skipped ?? 0) + e.skipped }));
    }
  }

  function getQueue(): Promise<UploadQueue> {
    if (queueRef.current) return Promise.resolve(queueRef.current);
    queueLoadRef.current ??= import("@/lib/upload/browser-queue")
      .then(({ createBrowserUploadQueue }) => {
        const q = createBrowserUploadQueue({
          userId,
          bookId,
          isPaid,
          existing: props.existing,
          onEvent,
        });
        queueRef.current = q;
        addedRef.current = 0;
        finalizedAtRef.current = 0;
        baseReadyRef.current = props.readyCount;
        setBaseReady(props.readyCount);
        return q;
      })
      .catch((err: unknown) => {
        queueLoadRef.current = null;
        throw err;
      });
    return queueLoadRef.current;
  }

  async function runFinalize(uploadedMark: number) {
    setPhase("finalizing");
    setFinalizeError(null);
    setRetryAt(null);
    finalizeAbortRef.current?.abort();
    const controller = new AbortController();
    finalizeAbortRef.current = controller;
    // Waits on 429 (Retry-After) and spaces follow-ups inside; phase stays "finalizing".
    const outcome = await finalizeWithPlaces(bookId, undefined, { signal: controller.signal });
    if (unmountedRef.current || controller.signal.aborted) return;
    if (outcome.ok) {
      setFinalize(outcome.result);
      finalizedAtRef.current = uploadedMark;
      if (outcome.result.wroteDoc || outcome.result.pages > 0) hasDocRef.current = true;
      setPhase("done");
    } else {
      setFinalizeError(outcome.error);
      if (outcome.error === "rate_limited") setRetryAt(Date.now() + outcome.retryAfterMs);
      setPhase("finalize_error");
    }
  }

  async function afterRun(s: QueueSummary, base: number) {
    // Cancelled = screen left (unmount) or queue replaced: never POST finalize then.
    if (unmountedRef.current) return;
    setSummary(s);
    setPending(s.pendingLeft);
    setPaused(false);
    if (s.fatal || s.cancelled) {
      setPhase("done");
      return;
    }
    const ready = base + s.uploaded;
    if (s.uploaded > finalizedAtRef.current || (!hasDocRef.current && ready > 0)) {
      await runFinalize(s.uploaded);
    } else {
      setPhase("done");
    }
  }

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    setLoadFailed(false);
    setRemoveError(null);
    let q: UploadQueue;
    try {
      q = await getQueue();
    } catch {
      setLoadFailed(true);
      return;
    }
    q.add(files);
    addedRef.current += files.length;
    if (runningRef.current) return; // the running loop picks the new files up

    runningRef.current = true;
    setSummary(null);
    setFinalize(null);
    setFinalizeError(null);
    setLimitNotice(null);
    setPaused(false);
    setPhase("running");
    let s: QueueSummary;
    try {
      // Files added just as a run ended are picked up by another run.
      do {
        s = await q.start();
      } while (!s.cancelled && !s.fatal && (s.notStarted > 0 || addedRef.current > s.total));
    } finally {
      runningRef.current = false;
    }
    if (queueRef.current !== q) return; // replaced meanwhile (remove unfinished)
    await afterRun(s, baseReadyRef.current);
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // Reset so selecting the same photos again (resume) fires change again.
    e.target.value = "";
    void handleFiles(files);
  }

  function openPicker() {
    inputRef.current?.click();
  }

  function togglePause() {
    const q = queueRef.current;
    if (!q) return;
    if (paused) q.resume();
    else q.pause();
    setPaused(!paused);
  }

  function removeUnfinished() {
    setRemoveError(null);
    startRemove(async () => {
      // Stop the old queue: it still maps fingerprints to the rows we delete now.
      queueRef.current?.cancel();
      queueRef.current = null;
      queueLoadRef.current = null;
      const res = await deleteUnfinishedAction(bookId);
      if (res.ok) {
        setPending(0);
        // Fresh props (revalidated) seed the next queue.
        setBaseReady(null);
        setProgress(null);
      } else {
        setRemoveError(res.error);
      }
    });
  }

  const showResume = pending > 0 && !busy && !fatal;
  const showPicker = !busy && !fatal && summary === null;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,.heic,.heif"
        onChange={onInputChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="upload-input"
      />

      {showResume ? (
        <div
          className={`${noticeClass} border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50`}
          data-testid="upload-resume"
        >
          <p>
            {pending === 1
              ? "1 photo didn't finish uploading."
              : `${pending} photos didn't finish uploading.`}{" "}
            Select your photos again and we&apos;ll continue where you left off.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={removeUnfinished}
            disabled={removing}
            aria-busy={removing}
            className="mt-3 h-11 w-full text-base"
            data-testid="remove-unfinished"
          >
            {removing ? "Removing…" : "Remove unfinished"}
          </Button>
          {removeError ? (
            <p className="mt-2 text-sm text-destructive" role="alert" data-testid="remove-unfinished-error">
              {removeError}
            </p>
          ) : null}
        </div>
      ) : null}

      {showPicker ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            onClick={openPicker}
            className="h-16 w-full text-lg"
            data-testid="upload-pick"
          >
            Choose photos
          </Button>
          <p className="text-center text-sm text-muted-foreground" data-testid="upload-capacity">
            Up to {maxUpload} photos in this book · {readyCount} added
          </p>
        </div>
      ) : null}

      {loadFailed ? (
        <p
          className={`${noticeClass} border-destructive/30 bg-destructive/10 text-destructive`}
          role="alert"
          data-testid="upload-error"
        >
          We couldn&apos;t start the upload. Check your connection and choose your photos again.
        </p>
      ) : null}

      {limitNotice ? (
        <p
          className={`${noticeClass} border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50`}
          data-testid="upload-limit"
        >
          {isPaid ? "This book holds" : "Free books hold"} {limitNotice.limit} photos —{" "}
          {limitNotice.skipped === 1 ? "1 wasn't added." : `${limitNotice.skipped} weren't added.`}
        </p>
      ) : null}

      {uploading && progress ? (
        <UploadProgress progress={progress} paused={paused} onTogglePause={togglePause} />
      ) : uploading ? (
        <p className="text-base" role="status" data-testid="upload-preparing">
          Getting ready…
        </p>
      ) : null}

      {phase === "finalizing" ? (
        <p
          className="rounded-xl border bg-card p-4 text-base"
          role="status"
          data-testid="upload-finalizing"
        >
          Finding places and duplicates…
        </p>
      ) : null}

      {fatal ? (
        <div
          className={`${noticeClass} border-destructive/30 bg-destructive/10 text-destructive`}
          role="alert"
          data-testid="upload-signed-out"
        >
          <p>Please sign in again. Your photos so far are saved.</p>
          <Link href={loginHref} className="mt-2 inline-flex min-h-11 items-center font-medium underline">
            Sign in
          </Link>
        </div>
      ) : null}

      {phase === "finalize_error" && finalizeError ? (
        <div
          className={`${noticeClass} border-destructive/30 bg-destructive/10 text-destructive`}
          data-testid="finalize-error"
        >
          <p>{FINALIZE_MESSAGES[finalizeError]}</p>
          {finalizeError === "signed_out" ? (
            <Link href={loginHref} className="mt-2 inline-flex min-h-11 items-center font-medium underline">
              Sign in
            </Link>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => void runFinalize(summary?.uploaded ?? 0)}
              disabled={retryWaitSec > 0}
              className="mt-3 h-11 w-full text-base"
              data-testid="finalize-retry"
            >
              {retryWaitSec > 0 ? `Try again in ${retryWaitSec}s` : "Try again"}
            </Button>
          )}
        </div>
      ) : null}

      {summary && !fatal && (phase === "done" || phase === "finalize_error") ? (
        <UploadSummary bookId={bookId} summary={summary} finalize={finalize} onAddMore={openPicker} />
      ) : null}

      {summary && phase === "done" && !fatal ? (
        <p className="sr-only" role="status">
          Upload finished: {plural(summary.uploaded, "photo")} added.
        </p>
      ) : null}
    </div>
  );
}
