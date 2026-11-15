"use client";
// Upload screen client: picker → resumable queue (T11) → finalize (T9) → summary.
// The queue (+ supabase-js) is loaded on the first selection; processPhoto and
// with it exifr / heic2any are loaded one level deeper, on the first photo.
// Nothing about the photos (names, dates, places) is logged or sent anywhere
// except the user's own Supabase rows/files.
// M11 T10 (D-067): a large drop-zone style "Choose photos" area (tap to pick; desktop can also drop
// files on it), status boxes as shared <Notice>s and "Keep this screen open" as an info notice.
// M13 T6 (D-070): when uploads + finalize settle with ≥ 5 photos the first AI build is asked for
// automatically (the server decides, src/lib/upload/auto-build-client.ts) and the screen moves on —
// "Make my book now" is the fallback.
// M19 T6 (D-071): the setup card and the /books/start hand-off are gone (setup = wizard steps 1–4).
// variant "wizard" (step 5 of a fresh book) = the wizard.png card: big pick area, then the progress
// card with the last three thumbnails, Pause/Resume and "Keep this tab open…"; Back (`onBack`, to
// step 4) shows only until the first photo is picked.
// M20 T6 (D-072): inside the one continuous /books/new wizard the wizard variant never navigates:
// `onAdvance` gets the auto-start answer instead of router.push (the wizard maps it with
// wizard-flow's autoStart action → step 6 / 7 / editor), `onBack` / `onBuildNow` replace the Back and
// "Make my book now" links, `onPhotosPicked` locks steps 1–4. The upload stage (UploadStage) stays
// mounted while finalizing and starting (`settled`), and the wizard moves on only after both the
// success burst (onSettled) and the auto-start answer. The classic screen is unchanged.
// M20b: step 5 shows upload progress only, never sorting / "starting your book": once the success
// burst has played the wizard moves on — with the answer when it's in (onAdvance), otherwise with the
// pending answer (onAdvancePending) for step 6 to follow. Fallback answers that arrive before the
// hand-over keep the "Make my book now" fallback here. ai_build_done { rules } is reported by step 6.
import { ImagePlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { deleteUnfinishedAction } from "@/app/books/actions";
import { LoadingState } from "@/components/app/LoadingState";
import { Notice } from "@/components/app/Notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { track } from "@/lib/analytics/client";
import { msBucket } from "@/lib/analytics/events";
import type { RunLimit } from "@/lib/runs/client";
import { limitCopy } from "@/lib/runs/stage-copy";
import {
  AUTO_BUILD_MIN_PHOTOS,
  autoStartNext,
  type AutoStartOutcome,
  buildHref,
  editorHref,
  requestAutoBuildSettled,
  shouldAutoStart,
  type FirstRunState,
} from "@/lib/upload/auto-build-client";
import {
  colorsBody,
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
import { cn } from "@/lib/utils";
import { WIZARD_BACK_CLASS } from "@/components/wizard/WizardNav";
import { UploadProgress } from "./UploadProgress";
import { UploadPickArt } from "./UploadStage";
import { HANDOVER_GRACE_MS, SETTLE_MS, UPLOAD_PICK_WIZARD_CLASS } from "./upload-stage-model";
import { UploadSummary, type SummaryNext } from "./UploadSummary";
import { UploadThumbs, useThumbStrip } from "./UploadThumbs";
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
  /** AI build state at page load: none = the automatic first build may start. */
  firstRun: FirstRunState;
  /** D-026 daily cap for the limit copy. */
  dailyCap: number;
  /** resolveAiMode() !== "off" from the page (D-024): false → neutral copy, no AI claims. Default true. */
  aiOn?: boolean;
  /** "wizard" = step 5 of the creation wizard (fresh book, M19 D-071). Default "default". */
  variant?: "default" | "wizard";
  /**
   * Wizard only (M20 T6): Back as a button, shown until the first photo is picked — the /books/new
   * wizard changes step in place.
   */
  onBack?: () => void;
  /** Wizard only (M20 T6): the first photos of this visit were picked (the wizard locks steps 1–4). */
  onPhotosPicked?: () => void;
  /**
   * Wizard only (M20 T6): replaces router.push after the automatic first build answered with a
   * "move on" outcome (started / already_running / not_first / user_edited). Called once, after the
   * upload stage's success burst. Fallback outcomes (not_ready twice, limit, error…) stay here.
   */
  onAdvance?: (outcome: AutoStartOutcome) => void;
  /**
   * Wizard only (M20b): the success burst played but the auto-start answer is still on its way →
   * called once with the pending answer instead of waiting here (step 5 never shows sorting).
   */
  onAdvancePending?: (answer: Promise<AutoStartOutcome>) => void;
  /** Wizard only (M20 T6): "Make my book now" calls this instead of linking to the build page. */
  onBuildNow?: () => void;
};

/** Wizard helper lines under the card (exported for tests). */
export const WIZARD_KEEP_OPEN_COPY = "Keep this tab open while your photos upload.";
export const WIZARD_FINALIZING_KEEP_OPEN_COPY = "Keep this tab open while we finish adding your photos.";

/** Shown when photos are picked while the automatic first build is starting (they aren't added). */
export const PICKS_WHILE_STARTING_COPY = "Your book is being made — add more photos from the editor.";

type AutoState =
  | { kind: "idle" }
  /** The automatic first build will be / is being asked for, or the screen is moving on. */
  | { kind: "starting" }
  /** It didn't start: show "Make my book now" (with the limit copy when that was the reason). */
  | { kind: "fallback"; limit?: RunLimit; few?: number };

type Phase = "idle" | "running" | "finalizing" | "finalize_error" | "done";

const FINALIZE_MESSAGES: Record<FinalizeError, string> = {
  signed_out: "You've been signed out. Please sign in again to finish your book.",
  not_found: "We couldn't find this book. It may have been deleted.",
  failed: "We couldn't finish setting up your book. Your photos are safe — please try again.",
  rate_limited: "We're still finishing your book. Your photos are safe — please try again in a moment.",
  // Neutral (M12 review): blame neither the server nor the phone; the "Try again in Ns" button shows the wait.
  unavailable: "This is taking longer than usual. Your photos are safe — please try again in a moment.",
};

const signInLinkClass =
  "inline-flex min-h-11 items-center rounded-md font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function Uploader(props: UploaderProps) {
  const { bookId, userId, isPaid, maxUpload, firstRun } = props;
  const aiOn = props.aiOn ?? true;
  const loginHref = `/login?next=${encodeURIComponent(`/books/${bookId}/upload`)}`;
  const router = useRouter();
  const wizard = props.variant === "wizard";
  const thumbs = useThumbStrip(wizard);
  const [auto, setAuto] = useState<AutoState>({ kind: "idle" });
  const autoBusyRef = useRef(false);
  /** Photos were picked on this visit (hides the wizard Back link so an upload can't be lost). */
  const [picked, setPicked] = useState(false);
  // M20 T6 / M20b: the wizard moves on after the stage's success burst — with the auto-start answer
  // when it's in, otherwise with the pending answer.
  const onAdvanceRef = useRef(props.onAdvance);
  const onAdvancePendingRef = useRef(props.onAdvancePending);
  useEffect(() => {
    onAdvanceRef.current = props.onAdvance;
    onAdvancePendingRef.current = props.onAdvancePending;
  });
  /** The auto-start request in flight (or answered with a "move on" outcome) — what the wizard gets. */
  const requestRef = useRef<Promise<AutoStartOutcome> | null>(null);
  /** Its answer, once in and "move on" (fallback answers never go to the wizard). */
  const advanceRef = useRef<AutoStartOutcome | null>(null);
  /** When the request started: a pending request is handed over only after HANDOVER_GRACE_MS. */
  const requestAtRef = useRef(0);
  const advancedRef = useRef(false);
  const burstDoneRef = useRef(false);
  /** Last queue progress (null = the stage never showed, so there's no burst to wait for). */
  const progressRef = useRef<QueueProgress | null>(null);

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
  /** Photos picked while the automatic build was starting: they were not added — say so. */
  const [picksIgnored, setPicksIgnored] = useState(false);
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

  // A file dropped beside the drop zone would make the browser open it, leaving the page and
  // aborting a running upload. While this screen is open, swallow file drags/drops the zone didn't
  // handle (the zone's own handlers call preventDefault first, so it keeps its "copy" effect).
  useEffect(() => {
    const hasFiles = (e: globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onWindowDragOver = (e: globalThis.DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    const onWindowDrop = (e: globalThis.DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
    };
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", onWindowDrop);
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
    thumbs.onQueueEvent(e);
    if (e.type === "progress") {
      progressRef.current = e;
      setProgress(e);
    }
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
        thumbs.reset(); // keys restart at 0 with a new queue
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

  async function runFinalize(uploadedMark: number): Promise<boolean> {
    setPhase("finalizing");
    setFinalizeError(null);
    setRetryAt(null);
    finalizeAbortRef.current?.abort();
    const controller = new AbortController();
    finalizeAbortRef.current = controller;
    // M10c: colours of this queue's uploads ride along (server-written photos.color).
    const queue = queueRef.current;
    const colors = colorsBody(queue?.colors()) ?? {};
    // Waits on 429 / 503 / a hung request (Retry-After) and spaces follow-ups inside; phase stays "finalizing".
    const outcome = await finalizeWithPlaces(bookId, undefined, { signal: controller.signal, colors });
    if (outcome.ok) queue?.forgetColors(Object.keys(colors));
    if (unmountedRef.current || controller.signal.aborted) return false;
    if (outcome.ok) {
      setFinalize(outcome.result);
      finalizedAtRef.current = uploadedMark;
      if (outcome.result.wroteDoc || outcome.result.pages > 0) hasDocRef.current = true;
      setPhase("done");
      return true;
    } else {
      setFinalizeError(outcome.error);
      if (outcome.error === "rate_limited" || outcome.error === "unavailable") {
        setRetryAt(Date.now() + outcome.retryAfterMs);
      }
      setPhase("finalize_error");
      return false;
    }
  }

  /**
   * The automatic first build (D-070 (3)) once uploads + finalize settled. The server decides; this
   * only maps its answer to the next screen (setup was saved by wizard steps 1–4, M19 D-071).
   */
  async function autoStart(ready: number, s: QueueSummary) {
    if (firstRun !== "none" || unmountedRef.current) return;
    if (!shouldAutoStart({ firstRun, ready, pendingLeft: s.pendingLeft, fatal: Boolean(s.fatal), cancelled: s.cancelled })) {
      setAuto({ kind: "fallback", few: ready < AUTO_BUILD_MIN_PHOTOS && s.pendingLeft === 0 ? ready : undefined });
      return;
    }
    if (autoBusyRef.current) return;
    autoBusyRef.current = true;
    setAuto({ kind: "starting" });
    const startedAt = Date.now();
    // One promise incl. the not_ready retry; it keeps going if this screen unmounts (step 6 may
    // be waiting for it — M20b).
    const request = requestAutoBuildSettled(bookId);
    // The wizard moves on after the success burst, answered or not (step 5 never shows sorting).
    if (wizard) queueAdvance(request);
    const outcome = await request;
    if (unmountedRef.current) return;
    const next = autoStartNext(bookId, outcome, { retried: true, activeAtLoad: false });
    if (next.kind === "go") {
      // The wizard variant never navigates: the /books/new flow maps the answer (onAdvance).
      if (wizard) {
        advanceRef.current = outcome;
        tryAdvance();
        return; // the wizard moves on (step 6 reports ai_build_done for a finished rule run)
      }
      if (next.rules) {
        // A rule run (AI off) finished inside the request; the build screen would start another.
        track("ai_build_done", {
          mode: "rules",
          outcome: next.rules.outcome,
          ms_bucket: msBucket(Date.now() - startedAt),
          auto: true,
        });
      }
      router.push(next.href);
      return; // stay "starting" until the next screen replaces this one
    }
    // Already handed to step 6 (pending): it follows this answer there.
    if (wizard && advancedRef.current) return;
    requestRef.current = null; // a fallback answer is never handed over
    setAuto({ kind: "fallback", limit: next.kind === "fallback" ? next.limit : undefined });
    autoBusyRef.current = false;
  }

  /**
   * Hands the auto-start request to the wizard once the success burst has played (or can't): its
   * answer when that's in (onAdvance), else the pending request itself (onAdvancePending, M20b).
   */
  function tryAdvance() {
    const request = requestRef.current;
    if (!request || advancedRef.current || unmountedRef.current) return;
    if (!burstDoneRef.current && progressRef.current !== null) return;
    const outcome = advanceRef.current;
    if (outcome) {
      const onAdvance = onAdvanceRef.current;
      if (!onAdvance) return;
      advancedRef.current = true;
      onAdvance(outcome);
      return;
    }
    const onPending = onAdvancePendingRef.current;
    if (!onPending) return;
    // A quick answer (run created, or a fallback that stays here) gets a moment to arrive first.
    if (Date.now() - requestAtRef.current < HANDOVER_GRACE_MS) return;
    advancedRef.current = true;
    onPending(request);
  }

  function queueAdvance(request: Promise<AutoStartOutcome>) {
    requestRef.current = request;
    requestAtRef.current = Date.now();
    advanceRef.current = null;
    advancedRef.current = false;
    tryAdvance();
    setTimeout(tryAdvance, HANDOVER_GRACE_MS);
    // Safety net: the burst normally ends within SETTLE_MS; never strand the user on a lost callback.
    setTimeout(() => {
      burstDoneRef.current = true;
      tryAdvance();
    }, SETTLE_MS + 1000);
  }

  function onStageSettled() {
    burstDoneRef.current = true;
    tryAdvance();
  }

  async function retryFinalize() {
    const s = summary;
    if (!s) return;
    if (await runFinalize(s.uploaded)) await autoStart(baseReadyRef.current + s.uploaded, s);
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
    // Show "Starting your book…" from the start of finalize (no flash of the fallback button).
    if (shouldAutoStart({ firstRun, ready, pendingLeft: s.pendingLeft, fatal: false, cancelled: false })) {
      setAuto({ kind: "starting" });
    }
    let settled = true;
    if (s.uploaded > finalizedAtRef.current || (!hasDocRef.current && ready > 0)) {
      settled = await runFinalize(s.uploaded);
    } else {
      setPhase("done");
    }
    if (unmountedRef.current) return;
    if (settled) await autoStart(ready, s);
    else if (firstRun === "none") setAuto({ kind: "fallback" });
  }

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    if (autoBusyRef.current) {
      // The build is starting with the photos already added: don't drop the new picks silently.
      setPicksIgnored(true);
      return;
    }
    setPicksIgnored(false);
    burstDoneRef.current = false;
    advanceRef.current = null;
    requestRef.current = null;
    if (!picked) props.onPhotosPicked?.();
    setPicked(true);
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
    thumbs.track(addedRef.current, files);
    addedRef.current += files.length;
    if (runningRef.current) return; // the running loop picks the new files up

    runningRef.current = true;
    setSummary(null);
    setFinalize(null);
    setFinalizeError(null);
    setLimitNotice(null);
    setPaused(false);
    setAuto({ kind: "idle" });
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

  // dragleave also fires when the pointer moves onto the zone's own icon/text — only reset when it
  // really left the zone (relatedTarget outside it, or null when leaving the window).
  function onDragLeave(e: DragEvent<HTMLButtonElement>) {
    const to = e.relatedTarget;
    if (to instanceof Node && e.currentTarget.contains(to)) return;
    setDragOver(false);
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
  const starting = auto.kind === "starting";

  // Next step under the results (and on a return visit before any new upload).
  const fewNote =
    auto.kind === "fallback" && auto.few !== undefined
      ? `Add ${plural(AUTO_BUILD_MIN_PHOTOS - auto.few, "more photo")} and we'll start your book by itself — or start it now.`
      : undefined;
  const summaryNext: SummaryNext =
    firstRun === "active"
      ? { kind: "continue", href: buildHref(bookId, false), label: "See your book being made" }
      : firstRun === "done"
        ? { kind: "continue", href: `/books/${bookId}/review`, label: "Add them to your book" }
        : starting
          ? { kind: "starting" }
          : {
              kind: "build",
              note: auto.kind === "fallback" && auto.limit ? limitCopy(auto.limit, isPaid, props.dailyCap) : fewNote,
            };
  const showIdleNext = showPicker && readyCount > 0 && pending === 0;
  // Wizard: the upload stage stays up through finalize and the auto start (no summary flash).
  const stageShown =
    wizard && progress !== null && (uploading || phase === "finalizing" || (phase === "done" && starting));

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
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            aria-describedby={capacityId}
            data-drag={dragOver ? "over" : undefined}
            className={
              wizard
                ? UPLOAD_PICK_WIZARD_CLASS
                : "group flex min-h-40 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-input bg-card px-6 py-8 text-center shadow-card transition-colors outline-none hover:border-accent-strong hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[drag=over]:border-accent-strong data-[drag=over]:bg-secondary"
            }
            data-testid="upload-pick"
          >
            {wizard ? (
              // M20 T5: open book with a dashed "drop photos here" page + the big "Choose photos" pill.
              <UploadPickArt />
            ) : (
              <>
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
              </>
            )}
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

      {wizard && props.onBack && !picked && !busy ? (
        <div className="flex justify-center" data-testid="upload-wizard-back">
          <button type="button" onClick={props.onBack} className={WIZARD_BACK_CLASS} data-testid="wizard-back">
            Back
          </button>
        </div>
      ) : null}

      {showIdleNext ? (
        firstRun === "none" && wizard ? (
          // The wizard variant: step 6 starts the build in place (no link to the build page).
          <button
            type="button"
            onClick={props.onBuildNow}
            className={cn(buttonVariants({ variant: "accent", size: "cta" }))}
            data-testid="build-album"
          >
            Make my book now
          </button>
        ) : firstRun === "none" ? (
          <Link
            href={buildHref(bookId, false)}
            className={cn(buttonVariants({ variant: "accent", size: "cta" }))}
            data-testid="build-album"
          >
            Make my book now
          </Link>
        ) : (
          <Link
            href={firstRun === "active" ? buildHref(bookId, false) : editorHref(bookId)}
            className={cn(buttonVariants({ variant: "outline", size: "cta" }))}
            data-testid="upload-continue"
          >
            {firstRun === "active" ? "See your book being made" : "Back to your book"}
          </Link>
        )
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

      {busy && !wizard ? (
        <Notice tone="info" title="Keep this screen open" data-testid="upload-keep-open">
          {phase === "finalizing"
            ? "We're finishing your book. Leaving now skips places and duplicates until your next visit."
            : "The upload stops if you leave. Choose the same photos again later and we'll continue where you left off."}
        </Notice>
      ) : null}

      {stageShown && progress ? (
        // Wizard: the stage stays mounted from the first photo until the wizard moves on — settled
        // (closed book + burst + "All photos are in") while finalizing; then step 6 (M20b).
        <UploadProgress
          progress={progress}
          paused={paused}
          onTogglePause={togglePause}
          variant="wizard"
          thumbs={<UploadThumbs items={thumbs.items} />}
          settled={uploading ? undefined : true}
          onSettled={onStageSettled}
        />
      ) : uploading && progress ? (
        <UploadProgress progress={progress} paused={paused} onTogglePause={togglePause} variant="default" />
      ) : uploading ? (
        <LoadingState label="Getting ready…" data-testid="upload-preparing" />
      ) : null}

      {phase === "finalizing" && !stageShown ? (
        <LoadingState
          label="Finding places and duplicates…"
          className="rounded-2xl border border-border bg-card p-4 shadow-card"
          data-testid="upload-finalizing"
        />
      ) : null}

      {busy && wizard ? (
        // wizard.png: a plain centred line under the card (the classic screen uses a Notice).
        <p className="type-small text-center text-muted-foreground" data-testid="upload-keep-open">
          {phase === "finalizing" ? WIZARD_FINALIZING_KEEP_OPEN_COPY : WIZARD_KEEP_OPEN_COPY}
        </p>
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
        <div className="flex flex-col gap-2">
          <Notice tone="error" data-testid="finalize-error">
            <p>{FINALIZE_MESSAGES[finalizeError]}</p>
            {finalizeError === "signed_out" ? (
              <Link href={loginHref} className={`mt-1 ${signInLinkClass}`}>
                Sign in
              </Link>
            ) : null}
          </Notice>
          {finalizeError !== "signed_out" ? (
            // Outside the role="alert" notice, so the per-second countdown text is never announced.
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => void retryFinalize()}
              disabled={retryWaitSec > 0}
              className="w-full text-base"
              data-testid="finalize-retry"
            >
              {retryWaitSec > 0 ? `Try again in ${retryWaitSec}s` : "Try again"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {picksIgnored && starting ? (
        <Notice tone="info" data-testid="upload-picks-ignored">
          {PICKS_WHILE_STARTING_COPY}
        </Notice>
      ) : null}

      {summary && !fatal && (phase === "done" || phase === "finalize_error") && !stageShown && !(wizard && starting) ? (
        // Wizard (M20b): never the "Starting your book…" bar — step 6 shows the sorting.
        <UploadSummary
          bookId={bookId}
          summary={summary}
          finalize={finalize}
          onAddMore={openPicker}
          next={summaryNext}
          aiOn={aiOn}
          onBuild={wizard ? props.onBuildNow : undefined}
        />
      ) : null}

      {summary && phase === "done" && !fatal ? (
        <p className="sr-only" role="status">
          Upload finished: {plural(summary.uploaded, "photo")} added.
        </p>
      ) : null}
    </div>
  );
}
