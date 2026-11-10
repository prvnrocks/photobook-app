// M5 review fix: the build loop must not stall after a phone sleeps. Per-request deadline,
// wake on visible/online, and never two advance requests outstanding at once.
import { describe, expect, it } from "vitest";
import type { AdvanceOutcome } from "@/lib/runs/client";
import {
  DriveWaker,
  driveRun,
  MAX_TIMEOUTS,
  MAX_TRANSIENT_TRIES,
  REQUEST_TIMEOUT_MS,
  WAKE_STALE_MS,
  type DriveTimers,
  type SleepFn,
} from "@/lib/runs/drive";

const RUN = "22222222-2222-4222-8222-222222222222";

class FakeTimers implements DriveTimers {
  t = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + ms, fn });
    return id;
  };
  clear = (h: unknown) => {
    this.tasks.delete(h as number);
  };
  now = () => this.t;
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.tasks) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.tasks.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

const tick = (done: boolean): AdvanceOutcome =>
  ({
    kind: "tick",
    tick: {
      state: done ? "done" : "curating",
      progress: {
        phase: done ? "done" : "curating",
        photosTotal: 0,
        photosDone: 0,
        batchesTotal: 0,
        batchesDone: 0,
        photosCapped: 0,
        captionsTotal: 0,
        captionsDone: 0,
      },
      done,
      aiStatus: done ? "ok" : null,
      errorCode: null,
    },
  }) as AdvanceOutcome;

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Advance requests that stay pending until resolved — or forever if the signal is ignored. */
function harness(opts: { honourAbort?: boolean } = {}) {
  const timers = new FakeTimers();
  const waker = new DriveWaker();
  const requests: { signal: AbortSignal; resolve: (o: AdvanceOutcome) => void; aborted: boolean }[] = [];
  let outstanding = 0;
  let maxOutstanding = 0;
  const advance = (_id: string, signal?: AbortSignal) =>
    new Promise<AdvanceOutcome>((resolve) => {
      outstanding++;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      const r = { signal: signal!, resolve: (o: AdvanceOutcome) => resolve(o), aborted: false };
      signal?.addEventListener("abort", () => {
        r.aborted = true;
        outstanding--;
        if (opts.honourAbort !== false) resolve({ kind: "network" });
      });
      r.resolve = (o) => {
        if (!r.aborted) outstanding--;
        resolve(o);
      };
      requests.push(r);
    });
  // Sleep on the fake clock, cut short by abort.
  const sleeps: number[] = [];
  const sleep: SleepFn = (ms, signal) =>
    new Promise((resolve) => {
      sleeps.push(ms);
      if (signal?.aborted) return resolve();
      const h = timers.set(resolve, ms);
      signal?.addEventListener("abort", () => {
        timers.clear(h);
        resolve();
      });
    });
  return { timers, waker, requests, advance, sleep, sleeps, maxOutstanding: () => maxOutstanding };
}

describe("driveRun — sleep / wake resilience", () => {
  it("a hung request times out after REQUEST_TIMEOUT_MS and is retried at once (not a failure)", async () => {
    const h = harness({ honourAbort: false }); // the hung fetch never settles
    const retries: number[] = [];
    const p = driveRun({ runId: RUN, advance: h.advance, sleep: h.sleep, timers: h.timers, waker: h.waker, onRetry: (n) => retries.push(n) });
    await settle();
    expect(h.requests).toHaveLength(1);
    h.timers.advance(REQUEST_TIMEOUT_MS - 1);
    await settle();
    expect(h.requests).toHaveLength(1);
    h.timers.advance(1);
    await settle();
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.requests).toHaveLength(2);
    expect(retries).toEqual([]); // no "reconnecting" for a slow tick
    h.requests[1].resolve(tick(true));
    expect(await p).toMatchObject({ kind: "done" });
  });

  it("gives up after MAX_TIMEOUTS timeouts in a row", async () => {
    const h = harness();
    const p = driveRun({ runId: RUN, advance: h.advance, sleep: h.sleep, timers: h.timers, waker: h.waker });
    for (let i = 0; i < MAX_TIMEOUTS; i++) {
      await settle();
      h.timers.advance(REQUEST_TIMEOUT_MS);
    }
    expect(await p).toEqual({ kind: "error", error: "unavailable" });
    expect(h.requests).toHaveLength(MAX_TIMEOUTS);
  });

  it("wake replaces a request in flight for ≥ WAKE_STALE_MS; never two requests at once", async () => {
    const h = harness({ honourAbort: false });
    const p = driveRun({ runId: RUN, advance: h.advance, sleep: h.sleep, timers: h.timers, waker: h.waker });
    await settle();
    h.timers.advance(WAKE_STALE_MS - 1);
    h.waker.wake(); // young request: left alone
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].signal.aborted).toBe(false);
    h.timers.advance(1);
    h.waker.wake(); // stale: aborted and replaced
    await settle();
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.requests).toHaveLength(2);
    // The abandoned request finally answering changes nothing.
    h.requests[0].resolve(tick(false));
    await settle();
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve(tick(true));
    expect(await p).toMatchObject({ kind: "done" });
    expect(h.maxOutstanding()).toBe(1);
  });

  it("wake ends a back-off wait at once and resets the failure budget", async () => {
    const h = harness();
    const p = driveRun({ runId: RUN, advance: h.advance, sleep: h.sleep, timers: h.timers, waker: h.waker });
    // Fail MAX_TRANSIENT_TRIES - 1 times (offline), each followed by a back-off wait.
    for (let i = 0; i < MAX_TRANSIENT_TRIES - 1; i++) {
      await settle();
      h.requests[i].resolve({ kind: "network" });
      await settle();
      if (i < MAX_TRANSIENT_TRIES - 2) h.timers.advance(h.sleeps[h.sleeps.length - 1]);
    }
    expect(h.requests).toHaveLength(MAX_TRANSIENT_TRIES - 1);
    // Now in a 16 s wait. Back online → advance immediately, failures reset.
    h.waker.wake();
    await settle();
    expect(h.requests).toHaveLength(MAX_TRANSIENT_TRIES);
    // One more failure no longer gives up (budget was reset).
    h.requests[MAX_TRANSIENT_TRIES - 1].resolve({ kind: "network" });
    await settle();
    h.timers.advance(2_000);
    await settle();
    h.requests[MAX_TRANSIENT_TRIES].resolve(tick(true));
    expect(await p).toMatchObject({ kind: "done" });
  });

  it("abort while a request hangs returns aborted without waiting for it", async () => {
    const h = harness({ honourAbort: false });
    const c = new AbortController();
    const p = driveRun({ runId: RUN, advance: h.advance, sleep: h.sleep, timers: h.timers, waker: h.waker, signal: c.signal });
    await settle();
    c.abort();
    expect(await p).toEqual({ kind: "aborted" });
  });

  it("wake listeners are removed when the loop ends", async () => {
    const h = harness();
    const p = driveRun({ runId: RUN, advance: h.advance, sleep: h.sleep, timers: h.timers, waker: h.waker });
    await settle();
    h.requests[0].resolve(tick(true));
    await p;
    const listeners = (h.waker as unknown as { listeners: Set<unknown> }).listeners;
    expect(listeners.size).toBe(0);
  });
});
