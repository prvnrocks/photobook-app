"use client";
// Upload screen client: picker → resumable queue (T11) → finalize (T9) → summary.
// The queue (+ supabase-js) is loaded on the first selection; processPhoto and
// with it exifr / heic2any are loaded one level deeper, on the first photo.
// Nothing about the photos (names, dates, places) is logged or sent anywhere
// except the user's own Supabase rows/files.
// M11 T10 (D-067): a large drop-zone style "Choose photos" area (tap to pick; desktop can also drop
// files on it), status boxes as shared <Notice>s and "Keep this screen open" as an info notice.
import { ImagePlus } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition, type ChangeEvent, type DragEvent } from "react";
import { deleteUnfinishedAction } from "@/app/books/actions";
import { LoadingState } from "@/components/app/LoadingState";
import { Notice } from "@/components/app/Notice";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics/client";
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

const signInLinkClass =
  "inline-flex min-h-11 items-center rounded-md font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
  const [dragOver, setDragOver] = useState(false);
  const capacityId = useId();

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
    // analytics (M9 T14): counts only.
    track("upload_done", { photos: s.uploaded, failed: s.failed, skipped: s.skipped });
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

  // Desktop: dropping files on the picker area feeds the same queue (it skips non-photos itself).
  function onDragOver(e: DragEvent<HTMLButtonElement>) {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function onDrop(e: DragEvent<HTMLButtonElement>) {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDragOver(false);
    void handleFiles(Array.from(e.dataTransfer.files));
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
        <Notice tone="warn" data-testid="upload-resume">
          <p>
            {pending === 1
              ? "1 photo didn't finish uploading."
              : `${pending} photos didn't finish uploading.`}{" "}
            Select your photos again and we&apos;ll continue where you left off.
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={removeUnfinished}
            disabled={removing}
            aria-busy={removing}
            className="mt-3 w-full text-base"
            data-testid="remove-unfinished"
          >
            {removing ? "Removing…" : "Remove unfinished"}
          </Button>
          {removeError ? (
            <p className="mt-2 text-sm text-destructive" role="alert" data-testid="remove-unfinished-error">
              {removeError}
            </p>
          ) : null}
        </Notice>
      ) : null}

      {showPicker ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={openPicker}
            onDragOver={onDragOver}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            aria-describedby={capacityId}
            data-drag={dragOver ? "over" : undefined}
            className="group flex min-h-40 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-input bg-card px-6 py-8 text-center shadow-card transition-colors outline-none hover:border-accent-strong hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[drag=over]:border-accent-strong data-[drag=over]:bg-secondary"
            data-testid="upload-pick"
          >
            <span
              aria-hidden="true"
              className="flex size-14 items-center justify-center rounded-full bg-accent-strong text-accent-strong-foreground shadow-card"
            >
              <ImagePlus className="size-7" />
            </span>
            <span className="type-h2 text-foreground">Choose photos</span>
            <span className="type-small text-muted-foreground">
              Select as many as you like at once. iPhone photos (HEIC) work too.
            </span>
          </button>
          <p
            id={capacityId}
            className="text-center text-sm text-muted-foreground"
            data-testid="upload-capacity"
          >
            Up to {maxUpload} photos in this book · {readyCount} added
          </p>
        </div>
      ) : null}

      {loadFailed ? (
        <Notice tone="error" data-testid="upload-error">
          We couldn&apos;t start the upload. Check your connection and choose your photos again.
        </Notice>
      ) : null}

      {limitNotice ? (
        <Notice tone="warn" data-testid="upload-limit">
          {isPaid ? "This book holds" : "Free books hold"} {limitNotice.limit} photos —{" "}
          {limitNotice.skipped === 1 ? "1 wasn't added." : `${limitNotice.skipped} weren't added.`}
        </Notice>
      ) : null}

      {busy ? (
        <Notice tone="info" title="Keep this screen open" data-testid="upload-keep-open">
          {phase === "finalizing"
            ? "We're finishing your album. Leaving now skips places and duplicates until your next visit."
            : "The upload stops if you leave. Choose the same photos again later and we'll continue where you left off."}
        </Notice>
      ) : null}

      {uploading && progress ? (
        <UploadProgress progress={progress} paused={paused} onTogglePause={togglePause} />
      ) : uploading ? (
        <LoadingState label="Getting ready…" data-testid="upload-preparing" />
      ) : null}

      {phase === "finalizing" ? (
        <LoadingState
          label="Finding places and duplicates…"
          className="rounded-2xl border border-border bg-card p-4 shadow-card"
          data-testid="upload-finalizing"
        />
      ) : null}

      {fatal ? (
        <Notice tone="error" data-testid="upload-signed-out">
          <p>Please sign in again. Your photos so far are saved.</p>
          <Link href={loginHref} className={`mt-1 ${signInLinkClass}`}>
            Sign in
          </Link>
        </Notice>
      ) : null}

      {phase === "finalize_error" && finalizeError ? (
        <Notice tone="error" data-testid="finalize-error">
          <p>{FINALIZE_MESSAGES[finalizeError]}</p>
          {finalizeError === "signed_out" ? (
            <Link href={loginHref} className={`mt-1 ${signInLinkClass}`}>
              Sign in
            </Link>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => void runFinalize(summary?.uploaded ?? 0)}
              disabled={retryWaitSec > 0}
              // Inside a role="alert" notice: a fixed accessible name, so the per-second countdown
              // isn't re-announced.
              aria-label={retryWaitSec > 0 ? "Try again in a moment" : undefined}
              className="mt-3 w-full text-base"
              data-testid="finalize-retry"
            >
              {retryWaitSec > 0 ? `Try again in ${retryWaitSec}s` : "Try again"}
            </Button>
          )}
        </Notice>
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
