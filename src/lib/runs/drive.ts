// Client-driven run loop (D-022): call advance until the run is done. Pure apart from the
// injected advance/sleep, so it is unit-tested without a browser.
//   200 tick      → report, continue (immediately; tiny gap guards a tight loop)
//   202 leased    → another tab/tick holds the lease: wait Retry-After, retry (not a failure)
//   network / 5xx → back off 2 s, 4 s, 8 s, 16 s; after MAX_TRANSIENT_TRIES in a row → error
//   401 / 403 / 404 → stop at once
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
};

export async function driveRun(opts: DriveOptions): Promise<DriveResult> {
  const { runId, advance, onTick, onRetry, signal, sleep = abortableSleep } = opts;
  let failures = 0;
  for (;;) {
    if (signal?.aborted) return { kind: "aborted" };
    const out = await advance(runId, signal);
    if (signal?.aborted) return { kind: "aborted" };

    switch (out.kind) {
      case "tick":
        failures = 0;
        onTick?.(out.tick);
        if (out.tick.done) return { kind: "done", tick: out.tick };
        await sleep(TICK_GAP_MS, signal);
        break;
      case "leased":
        await sleep(out.retryAfterMs, signal);
        break;
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
        break;
      }
    }
  }
}
