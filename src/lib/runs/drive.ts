// Client-driven run loop (D-022): call advance until the run is done. Pure apart from the
// injected advance/sleep, so it is unit-tested without a browser.
//   200 tick      → report, continue (immediately; tiny gap guards a tight loop)
//   202 leased    → another tab/tick holds the lease: wait Retry-After, retry (not a failure)
//   network / 5xx → back off 2 s, 4 s, 8 s, 16 s; after MAX_TRANSIENT_TRIES in a row → error
//   401 / 403 / 404 → stop at once
// Phones sleep: a request in flight while the device sleeps can hang forever, and timers are
// frozen. So each advance gets its own deadline (REQUEST_TIMEOUT_MS → retried at once, not shown
// as a connection problem), and `wake` (tab visible again / back online) ends a back-off wait
// at once and replaces a request that has been in flight for WAKE_STALE_MS or more.
// Exactly one advance request is outstanding at any time (no duplicate concurrent ticks): a
// replaced request is aborted before the next one starts, and if the server is still running
// the abandoned tick the new one just gets 202 (lease held) and waits.
import type { AdvanceOutcome, RunTick } from "./client";

export type DriveError = "signed_out" | "not_found" | "unavailable";

export type DriveResult =
  | { kind: "done"; tick: RunTick }
  | { kind: "aborted" }
  | { kind: "error"; error: DriveError };

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Consecutive transient failures (network / 5xx) before giving up. */
export const MAX_TRANSIENT_TRIES = 5;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 16_000;
/** Pause between two successful, not-done ticks. */
export const TICK_GAP_MS = 250;
/**
 * Client deadline per advance request. Ticks are budgeted at 40 s (a Storyteller tick may hold
 * the lease longer — then the retry gets 202 and waits for it).
 */
export const REQUEST_TIMEOUT_MS = 90_000;
/** Consecutive request timeouts before giving up (≈ 12 min without a single answer). */
export const MAX_TIMEOUTS = 8;
/** On wake, a request in flight at least this long is treated as lost and replaced. */
export const WAKE_STALE_MS = 10_000;

/** Wake-up signal for the loop: tab visible again, back online. */
export class DriveWaker {
  private listeners = new Set<() => void>();
  wake(): void {
    for (const fn of [...this.listeners]) fn();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export interface DriveTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const defaultTimers: DriveTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Wait after the n-th consecutive transient failure (1-based): 2 s, 4 s, 8 s, 16 s, … */
export function backoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

export const abortableSleep: SleepFn = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export type DriveOptions = {
  runId: string;
  advance: (runId: string, signal?: AbortSignal) => Promise<AdvanceOutcome>;
  onTick?: (tick: RunTick) => void;
  /** Called before each back-off wait (e.g. to show "Reconnecting…"). */
  onRetry?: (failures: number, waitMs: number) => void;
  signal?: AbortSignal;
  sleep?: SleepFn;
  /** Ends back-off waits early and replaces a stale in-flight request (see top of file). */
  waker?: DriveWaker;
  timers?: DriveTimers;
  requestTimeoutMs?: number;
};

/** An AbortController that also aborts when `parent` does. */
function childController(parent?: AbortSignal): { ctrl: AbortController; dispose(): void } {
  const ctrl = new AbortController();
  if (!parent) return { ctrl, dispose: () => {} };
  if (parent.aborted) ctrl.abort();
  const onAbort = () => ctrl.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  return { ctrl, dispose: () => parent.removeEventListener("abort", onAbort) };
}

type Attempt = { kind: "outcome"; out: AdvanceOutcome } | { kind: "timeout" } | { kind: "woken" };

/**
 * One advance request with a deadline and wake-replacement. Resolves as soon as the request
 * answers, times out or is replaced — never waits on an advance that ignores its signal.
 */
function attemptAdvance(
  runId: string,
  advance: DriveOptions["advance"],
  signal: AbortSignal | undefined,
  timers: DriveTimers,
  timeoutMs: number,
  waker: DriveWaker | undefined,
): Promise<Attempt> {
  const { ctrl, dispose } = childController(signal);
  const startedAt = timers.now();
  return new Promise<Attempt>((resolve) => {
    let settled = false;
    const finish = (a: Attempt, abort: boolean) => {
      if (settled) return;
      settled = true;
      timers.clear(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onOuterAbort);
      if (abort) ctrl.abort();
      dispose();
      resolve(a);
    };
    const timer = timers.set(() => finish({ kind: "timeout" }, true), timeoutMs);
    const unsubscribe =
      waker?.subscribe(() => {
        if (timers.now() - startedAt >= WAKE_STALE_MS) finish({ kind: "woken" }, true);
      }) ?? (() => {});
    // Outer abort: stop waiting; the caller's abort check returns "aborted".
    const onOuterAbort = () => finish({ kind: "woken" }, false);
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    let p: Promise<AdvanceOutcome>;
    try {
      p = advance(runId, ctrl.signal);
    } catch {
      p = Promise.resolve({ kind: "network" });
    }
    p.then(
      (out) => finish({ kind: "outcome", out }, false),
      () => finish({ kind: "outcome", out: { kind: "network" } }, false),
    );
  });
}

/** A sleep that `waker` cuts short. */
async function wakeableSleep(sleep: SleepFn, ms: number, signal: AbortSignal | undefined, waker?: DriveWaker): Promise<void> {
  if (!waker) return sleep(ms, signal);
  const { ctrl, dispose } = childController(signal);
  const unsubscribe = waker.subscribe(() => ctrl.abort());
  try {
    await sleep(ms, ctrl.signal);
  } finally {
    unsubscribe();
    dispose();
  }
}

export async function driveRun(opts: DriveOptions): Promise<DriveResult> {
  const { runId, advance, onTick, onRetry, signal, sleep: rawSleep = abortableSleep, waker } = opts;
  const timers = opts.timers ?? defaultTimers;
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep: SleepFn = (ms, s) => wakeableSleep(rawSleep, ms, s, waker);
  let failures = 0;
  let timeouts = 0;
  // Coming back (visible / online) is a fresh start for the transient-failure budget.
  const unsubscribeReset = waker?.subscribe(() => {
    failures = 0;
  });
  try {
    for (;;) {
      if (signal?.aborted) return { kind: "aborted" };
      const attempt = await attemptAdvance(runId, advance, signal, timers, timeoutMs, waker);
      if (signal?.aborted) return { kind: "aborted" };
      if (attempt.kind === "woken") continue; // replaced a stale request: ask again now
      if (attempt.kind === "timeout") {
        timeouts++;
        if (timeouts >= MAX_TIMEOUTS) return { kind: "error", error: "unavailable" };
        continue;
      }
      const out = attempt.out;
      if (out.kind === "tick") timeouts = 0;
      const next = await step(out);
      if (next) return next;
    }
  } finally {
    unsubscribeReset?.();
  }

  async function step(out: AdvanceOutcome): Promise<DriveResult | null> {
    switch (out.kind) {
      case "tick":
        failures = 0;
        onTick?.(out.tick);
        if (out.tick.done) return { kind: "done", tick: out.tick };
        await sleep(TICK_GAP_MS, signal);
        return null;
      case "leased":
        await sleep(out.retryAfterMs, signal);
        return null;
      case "signed_out":
        return { kind: "error", error: "signed_out" };
      case "not_found":
      case "forbidden":
        return { kind: "error", error: "not_found" };
      case "network":
      case "server_error": {
        failures++;
        if (failures >= MAX_TRANSIENT_TRIES) return { kind: "error", error: "unavailable" };
        const wait = backoffMs(failures);
        onRetry?.(failures, wait);
        await sleep(wait, signal);
        return null;
      }
    }
  }
}
