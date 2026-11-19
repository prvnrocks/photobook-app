"use client";
// Drives one book's storybook generation job from the browser (Task 8): start (once), the shared
// resumable loop (src/lib/runs/drive.ts: one advance request at a time, back-off, wake on tab
// visible / back online), Stop and Try again. The run id always comes from the server (step-6 data
// on a refresh, the start answer otherwise), never from local state only.
//   phase "starting"  POST in flight (or about to be)
//   phase "running"   ticking; `view` is the last server answer (real counts only)
//   phase "stopping"  Stop pressed, cancel in flight
//   phase "stopped"   failed / cancelled run — `view.errorCode` says why; Try again = a NEW run
//                     that resumes the finished stages (server side)
//   phase "error"     no answer / refused start — `message`; Try again re-attaches to the same run
//                     when there is one, else starts
//   phase "done"      finished — the caller opens the editor
// Every action is guarded against repeated taps (one request in flight; buttons read `busy`).

import { useCallback, useEffect, useRef, useState } from "react";
import { useWakeLock, useWarnOnLeave } from "@/components/upload/use-keep-awake";
import { DriveWaker, driveRun, startWithRetry, type DriveResult } from "@/lib/runs/drive";
import type { StoryRunView } from "@/lib/storybook/run/progress";
import { advanceStory, cancelStory, getStory, startStory, storyStartErrorCopy, type StoryStartOutcome } from "@/lib/storybook/run/client";

export type StoryPhase =
  | { kind: "starting" }
  | { kind: "running"; view: StoryRunView; retrying: boolean }
  | { kind: "stopping"; view: StoryRunView }
  | { kind: "stopped"; view: StoryRunView }
  | { kind: "error"; message: string; runId: string | null; signedOut: boolean }
  | { kind: "done"; view: StoryRunView };

export type StoryRunApi = {
  start: typeof startStory;
  advance: typeof advanceStory;
  cancel: typeof cancelStory;
  get: typeof getStory;
};

const DEFAULT_API: StoryRunApi = { start: startStory, advance: advanceStory, cancel: cancelStory, get: getStory };

export const CONNECTION_LOST = "We lost the connection. Your story keeps its progress — try again when you're back online.";

/** The phase for a run the server already knows (step-6 data, a start answer). */
export function phaseOf(view: StoryRunView): StoryPhase {
  if (!view.done) return { kind: "running", view, retrying: false };
  return view.state === "done" ? { kind: "done", view } : { kind: "stopped", view };
}

export function useStoryRun(opts: {
  bookId: string;
  /** The book's newest storybook run from the server (null = none yet). */
  initial: StoryRunView | null;
  /** Start a run on mount when there is none (the wizard's automatic first draft). */
  autoStart: boolean;
  api?: StoryRunApi;
}): { phase: StoryPhase; busy: boolean; stop: () => void; tryAgain: () => void; startNow: () => void } {
  const { bookId, initial, autoStart } = opts;
  const api = opts.api ?? DEFAULT_API;
  const apiRef = useRef(api);
  apiRef.current = api;
  const [phase, setPhase] = useState<StoryPhase>(() => (initial ? phaseOf(initial) : { kind: "starting" }));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [waker] = useState(() => new DriveWaker());
  const ctrlRef = useRef<AbortController | null>(null);
  /** One start / cancel at a time (repeated taps, StrictMode double effects). */
  const actionRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  const running = phase.kind === "running" || phase.kind === "starting";
  useWakeLock(running);
  useWarnOnLeave(false);

  useEffect(() => {
    aliveRef.current = true;
    const wake = () => {
      if (document.visibilityState === "visible") waker.wake();
    };
    const online = () => waker.wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", online);
    return () => {
      aliveRef.current = false;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", online);
    };
  }, [waker]);

  const set = useCallback((p: StoryPhase) => {
    if (aliveRef.current) setPhase(p);
  }, []);

  const drive = useCallback(
    async (view: StoryRunView) => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      set(phaseOf(view));
      if (view.done) return;
      const result: DriveResult<StoryRunView> = await driveRun<StoryRunView>({
        runId: view.runId,
        advance: (id, signal) => apiRef.current.advance(id, { signal }),
        onTick: (tick) => {
          if (!ctrl.signal.aborted) set(phaseOf(tick));
        },
        onRetry: () => {
          const cur = phaseRef.current;
          if (!ctrl.signal.aborted && cur.kind === "running") set({ ...cur, retrying: true });
        },
        signal: ctrl.signal,
        waker,
      });
      if (ctrl.signal.aborted) return;
      if (result.kind === "done") return set(phaseOf(result.tick));
      if (result.kind === "error") {
        set({
          kind: "error",
          message: result.error === "signed_out" ? "You've been signed out. Sign in again to continue." : result.error === "not_found" ? "We couldn't find this book's story." : CONNECTION_LOST,
          runId: view.runId,
          signedOut: result.error === "signed_out",
        });
      }
    },
    [set, waker],
  );

  const start = useCallback(async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    set({ kind: "starting" });
    try {
      const out: StoryStartOutcome = await startWithRetry({ start: () => apiRef.current.start(bookId), shouldStop: () => !aliveRef.current });
      if (out.kind === "started") return void drive(out.view);
      if (out.kind === "already_running" && out.runId) {
        // a second tab / an earlier tap already started it: follow that run
        const got = await apiRef.current.get(out.runId);
        if (got.kind === "view") return void drive(got.view);
      }
      set({ kind: "error", message: out.kind === "already_running" ? "Your book is already being made in another window." : storyStartErrorCopy(out), runId: null, signedOut: out.kind === "signed_out" });
    } finally {
      actionRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }, [bookId, drive, set]);

  // Mount: follow the server's run, or start the first one.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    if (initial && !initial.done) void drive(initial);
    else if (!initial && autoStart) void start();
    // StrictMode: the loop keeps running across the dev double-mount (no abort in cleanup).
  }, [initial, autoStart, drive, start]);

  const stop = useCallback(async () => {
    const cur = phaseRef.current;
    if (actionRef.current || (cur.kind !== "running" && cur.kind !== "starting")) return;
    if (cur.kind === "starting") return; // nothing to stop yet (the button is disabled)
    actionRef.current = true;
    setBusy(true);
    set({ kind: "stopping", view: cur.view });
    ctrlRef.current?.abort();
    try {
      const out = await apiRef.current.cancel(cur.view.runId);
      if (out.kind === "view") set(phaseOf(out.view));
      else set({ kind: "error", message: out.kind === "signed_out" ? "You've been signed out. Sign in again to continue." : CONNECTION_LOST, runId: cur.view.runId, signedOut: out.kind === "signed_out" });
    } finally {
      actionRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }, [set]);

  const tryAgain = useCallback(async () => {
    const cur = phaseRef.current;
    if (actionRef.current) return;
    if (cur.kind === "error" && cur.runId) {
      // re-attach to the same run (it may have finished meanwhile)
      actionRef.current = true;
      setBusy(true);
      try {
        const got = await apiRef.current.get(cur.runId);
        if (got.kind === "view") {
          if (got.view.done && got.view.state === "failed") {
            actionRef.current = false;
            return void start();
          }
          return void drive(got.view);
        }
        set({ ...cur, message: CONNECTION_LOST });
      } finally {
        actionRef.current = false;
        if (aliveRef.current) setBusy(false);
      }
      return;
    }
    void start();
  }, [drive, set, start]);

  return { phase, busy, stop: () => void stop(), tryAgain: () => void tryAgain(), startNow: () => void start() };
}
