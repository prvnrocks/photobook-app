// M12 T5: the upload and build screens recover by themselves from 503s and hung requests.
//   finalize-client: 75 s request deadline (hung fetch / hung body → aborted + retried), 503 like 429
//   runs client + drive: 503 { error: "unavailable" } is transient (Retry-After), not a dead end
//   photo-urls refresh: 503 → retry later, old URLs kept, no refresh used up
//   upload adapter: a hung storage upload becomes a retryable 504 SUPABASE_TIMEOUT
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceRun,
  DEFAULT_UNAVAILABLE_WAIT_MS,
  getRun,
  startRun,
  type AdvanceOutcome,
  type StartOutcome,
} from "@/lib/runs/client";
import { backoffMs, driveRun, MAX_TRANSIENT_TRIES, startWithRetry } from "@/lib/runs/drive";
import {
  callFinalize,
  finalizeWithPlaces,
  MAX_WAITS,
  REQUEST_TIMEOUT_MS,
  TIMEOUT_RETRY_MS,
  type FinalizeResult,
} from "@/lib/upload/finalize-client";
import { MAX_REFRESHES_PER_PHOTO, PhotoUrlRefresher, type PhotoUrlsResult } from "@/lib/editor/photo-urls";
import { httpEditorTransport } from "@/lib/editor/transport";
import { createSupabaseUploadDeps } from "@/lib/upload/supabase-adapters";
import { deadlineClientOptions, SUPABASE_TIMEOUT } from "@/lib/supabase/deadline";

const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const unavailable = (retryAfter?: string) =>
  json({ error: "unavailable" }, 503, retryAfter === undefined ? {} : { "retry-after": retryAfter });

function result(over: Partial<FinalizeResult> = {}): FinalizeResult {
  return {
    photos: 3,
    withDate: 3,
    withGps: 0,
    withPlace: 0,
    placesPending: 0,
    dupGroups: 0,
    dupPhotos: 0,
    pages: 2,
    wroteDoc: true,
    docStale: false,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("finalize-client: request deadline", () => {
  it("a hung fetch (ignores its signal) is aborted at 75 s and retried, then succeeds", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const f = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      // First call never settles (and never honours abort); the retry answers.
      return signals.length === 1 ? new Promise<Response>(() => {}) : Promise.resolve(json(result()));
    });
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    let settled = false;
    const p = finalizeWithPlaces(BOOK, f, { sleep, random: () => 0 }).finally(() => (settled = true));

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    expect(await p).toEqual({ ok: true, result: result() });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([TIMEOUT_RETRY_MS]);
  });

  it("a response whose body never finishes also hits the deadline", async () => {
    vi.useFakeTimers();
    const stalled = new Response(new ReadableStream({ start: () => {} }), { status: 200 });
    const p = callFinalize(BOOK, async () => stalled);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ ok: false, error: "unavailable", retryAfterMs: TIMEOUT_RETRY_MS });
  });

  it("hung on every try: gives up after MAX_WAITS retries with unavailable (Try again shown)", async () => {
    vi.useFakeTimers();
    const f = vi.fn(() => new Promise<Response>(() => {}));
    const p = finalizeWithPlaces(BOOK, f, { sleep: async () => {}, random: () => 0 });
    for (let i = 0; i <= MAX_WAITS; i++) await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ ok: false, error: "unavailable", retryAfterMs: TIMEOUT_RETRY_MS });
    expect(f).toHaveBeenCalledTimes(MAX_WAITS + 1);
  });

  it("leaving the screen aborts the in-flight request", async () => {
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    const f = vi.fn((_u: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) =>
        seen!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
      );
    });
    const p = finalizeWithPlaces(BOOK, f, { signal: ctrl.signal, sleep: async () => {} });
    ctrl.abort();
    expect(seen?.aborted).toBe(true);
    expect(await p).toEqual({ ok: false, error: "failed" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("finalize-client: 503 like 429", () => {
  it("503 + Retry-After: 10 → unavailable with a 10 s wait", async () => {
    expect(await callFinalize(BOOK, async () => unavailable("10"))).toEqual({
      ok: false,
      error: "unavailable",
      retryAfterMs: 10_000,
    });
  });

  it("503 then 200: waits Retry-After (+ jitter) and succeeds", async () => {
    const outs = [unavailable("10"), json(result())];
    const f = vi.fn(async () => outs.shift()!);
    const sleeps: number[] = [];
    const out = await finalizeWithPlaces(BOOK, f, { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    expect(out).toEqual({ ok: true, result: result() });
    expect(sleeps).toEqual([10_150]);
  });

  it("429 and 503 share the MAX_WAITS budget; the last answer is returned", async () => {
    const outs = [json({ error: "rate_limited" }, 429, { "retry-after": "2" }), unavailable("3"), unavailable("10")];
    const f = vi.fn(async () => outs.shift()!);
    const sleeps: number[] = [];
    const out = await finalizeWithPlaces(BOOK, f, { sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    expect(out).toEqual({ ok: false, error: "unavailable", retryAfterMs: 10_000 });
    expect(f).toHaveBeenCalledTimes(MAX_WAITS + 1);
    expect(sleeps).toEqual([2_000, 3_000]);
  });
});

describe("runs client: 503 is transient", () => {
  const fetchOnce = (r: Response) => vi.fn(async () => r);

  it("startRun / advanceRun / getRun map 503 to unavailable with the Retry-After wait", async () => {
    expect(await startRun(BOOK, "build", { fetchImpl: fetchOnce(unavailable("3")) })).toEqual({
      kind: "unavailable",
      retryAfterMs: 3_000,
    });
    expect(await advanceRun(RUN, { fetchImpl: fetchOnce(unavailable("7")) })).toEqual({
      kind: "unavailable",
      retryAfterMs: 7_000,
    });
    expect(await getRun(RUN, { fetchImpl: fetchOnce(unavailable()) })).toEqual({
      kind: "unavailable",
      retryAfterMs: DEFAULT_UNAVAILABLE_WAIT_MS,
    });
  });

  it("other 5xx stay server_error", async () => {
    expect(await advanceRun(RUN, { fetchImpl: fetchOnce(json({}, 502)) })).toEqual({ kind: "server_error" });
  });
});

describe("driveRun: 503 back-off", () => {
  const tick = (done: boolean): AdvanceOutcome =>
    ({
      kind: "tick",
      tick: { state: done ? "done" : "curating", progress: {}, done, aiStatus: null, errorCode: null },
    }) as unknown as AdvanceOutcome;

  it("waits max(back-off, Retry-After), reports cause 'server', then carries on", async () => {
    const outs: AdvanceOutcome[] = [
      { kind: "unavailable", retryAfterMs: 3_000 },
      { kind: "unavailable", retryAfterMs: 3_000 },
      tick(true),
    ];
    const advance = vi.fn(async () => outs.shift()!);
    const sleeps: number[] = [];
    const retries: [number, number, string][] = [];
    const out = await driveRun({
      runId: RUN,
      advance,
      sleep: async (ms) => void sleeps.push(ms),
      onRetry: (n, ms, cause) => retries.push([n, ms, cause]),
    });
    expect(out).toMatchObject({ kind: "done" });
    expect(sleeps).toEqual([3_000, backoffMs(2)]);
    expect(retries).toEqual([
      [1, 3_000, "server"],
      [2, 4_000, "server"],
    ]);
  });

  it(`after ${MAX_TRANSIENT_TRIES} 503s in a row → server_unavailable (manual Try again)`, async () => {
    const advance = vi.fn(async (): Promise<AdvanceOutcome> => ({ kind: "unavailable", retryAfterMs: 3_000 }));
    const out = await driveRun({ runId: RUN, advance, sleep: async () => {} });
    expect(out).toEqual({ kind: "error", error: "server_unavailable" });
    expect(advance).toHaveBeenCalledTimes(MAX_TRANSIENT_TRIES);
  });

  it("network failures keep the connection cause and the unavailable error", async () => {
    const advance = vi.fn(async (): Promise<AdvanceOutcome> => ({ kind: "network" }));
    const causes: string[] = [];
    const out = await driveRun({ runId: RUN, advance, sleep: async () => {}, onRetry: (_n, _ms, c) => causes.push(c) });
    expect(out).toEqual({ kind: "error", error: "unavailable" });
    expect(new Set(causes)).toEqual(new Set(["network"]));
  });
});

describe("startWithRetry", () => {
  it("503 then started: backs off with Retry-After and returns the run", async () => {
    const outs: StartOutcome[] = [
      { kind: "unavailable", retryAfterMs: 3_000 },
      { kind: "started", runId: RUN, mode: "live", state: "queued" },
    ];
    const start = vi.fn(async () => outs.shift()!);
    const sleeps: number[] = [];
    const causes: string[] = [];
    const out = await startWithRetry({
      start,
      sleep: async (ms) => void sleeps.push(ms),
      onRetry: (_n, _ms, c) => causes.push(c),
    });
    expect(out).toEqual({ kind: "started", runId: RUN, mode: "live", state: "queued" });
    expect(sleeps).toEqual([3_000]);
    expect(causes).toEqual(["server"]);
  });

  it("a start that landed behind a 503 resumes via already_running + runId", async () => {
    const outs: StartOutcome[] = [{ kind: "unavailable", retryAfterMs: 3_000 }, { kind: "already_running", runId: RUN }];
    const out = await startWithRetry({ start: async () => outs.shift()!, sleep: async () => {} });
    expect(out).toEqual({ kind: "already_running", runId: RUN });
  });

  it(`gives up after ${MAX_TRANSIENT_TRIES} transient answers; non-transient answers return at once`, async () => {
    const start = vi.fn(async (): Promise<StartOutcome> => ({ kind: "unavailable", retryAfterMs: 3_000 }));
    expect(await startWithRetry({ start, sleep: async () => {} })).toEqual({ kind: "unavailable", retryAfterMs: 3_000 });
    expect(start).toHaveBeenCalledTimes(MAX_TRANSIENT_TRIES);

    const limited = vi.fn(async (): Promise<StartOutcome> => ({ kind: "limit", limit: "rebuilds" }));
    expect(await startWithRetry({ start: limited, sleep: async () => {} })).toEqual({ kind: "limit", limit: "rebuilds" });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the screen is left", async () => {
    let stop = false;
    const start = vi.fn(async (): Promise<StartOutcome> => ({ kind: "network" }));
    const out = await startWithRetry({
      start,
      sleep: async () => {
        stop = true;
      },
      shouldStop: () => stop,
    });
    expect(out).toEqual({ kind: "network" });
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("photo-urls refresh: 503 → retry later, old URLs kept", () => {
  function fakeTimers() {
    const tasks: { fn: () => void; ms: number }[] = [];
    return {
      timers: {
        set: (fn: () => void, ms: number) => {
          const t = { fn, ms };
          tasks.push(t);
          return t;
        },
        clear: (h: unknown) => {
          const i = tasks.indexOf(h as (typeof tasks)[number]);
          if (i >= 0) tasks.splice(i, 1);
        },
      },
      tasks,
      runNext: () => tasks.shift()?.fn(),
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("re-asks after Retry-After without using up a refresh; fresh URLs merge only on success", async () => {
    const t = fakeTimers();
    const answers: PhotoUrlsResult[] = [{ retryAfterMs: 3_000 }, [{ id: "a", webUrl: "w-new", thumbUrl: null }]];
    const requests: string[][] = [];
    const fresh: unknown[] = [];
    const r = new PhotoUrlRefresher(
      async (ids) => {
        requests.push(ids);
        return answers.shift() ?? null;
      },
      (f) => fresh.push(f),
      t.timers,
    );
    expect(r.report("a")).toBe(true);
    t.runNext(); // debounce → request 1 (503)
    await flush();
    expect(fresh).toEqual([]); // nothing merged: the editor keeps the old URL
    expect(t.tasks.map((x) => x.ms)).toEqual([3_000]);
    expect(r.report("a")).toBe(true); // already waiting: no new attempt counted
    t.runNext(); // retry wait → debounce
    t.runNext(); // debounce → request 2
    await flush();
    expect(requests).toEqual([["a"], ["a"]]);
    expect(fresh).toEqual([[{ id: "a", webUrl: "w-new", thumbUrl: null }]]);
    // The 503 didn't count: one more refresh is still allowed.
    for (let i = 1; i < MAX_REFRESHES_PER_PHOTO; i++) expect(r.report("a")).toBe(true);
  });

  it("stops re-queuing after repeated 503s; dispose cancels a pending retry", async () => {
    const t = fakeTimers();
    const fetchUrls = vi.fn(async (): Promise<PhotoUrlsResult> => ({ retryAfterMs: 1_000 }));
    const r = new PhotoUrlRefresher(fetchUrls, () => {}, t.timers);
    r.report("a");
    for (let i = 0; i < 20 && t.tasks.length; i++) {
      t.runNext();
      await flush();
    }
    expect(fetchUrls.mock.calls.length).toBeLessThanOrEqual(6);
    expect(t.tasks).toHaveLength(0);

    const t2 = fakeTimers();
    const r2 = new PhotoUrlRefresher(fetchUrls, () => {}, t2.timers);
    r2.report("b");
    t2.runNext();
    await flush();
    expect(t2.tasks).toHaveLength(1);
    r2.dispose();
    expect(t2.tasks).toHaveLength(0);
  });

  it("the editor transport maps 503 + Retry-After to retry-later", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unavailable("4")));
    expect(await httpEditorTransport(BOOK).photoUrls(["a"])).toEqual({ retryAfterMs: 4_000 });
    vi.stubGlobal("fetch", vi.fn(async () => unavailable()));
    expect(await httpEditorTransport(BOOK).photoUrls(["a"])).toEqual({ retryAfterMs: 3_000 });
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 500)));
    expect(await httpEditorTransport(BOOK).photoUrls(["a"])).toBeNull();
  });

  it("the editor save maps 503 unavailable + Retry-After to retry; saving_unavailable stays terminal", async () => {
    const doc = {} as Parameters<ReturnType<typeof httpEditorTransport>["save"]>[0];
    vi.stubGlobal("fetch", vi.fn(async () => unavailable("5")));
    expect(await httpEditorTransport(BOOK).save(doc, 1, { keepalive: false })).toEqual({
      kind: "retry",
      reason: "server",
      minWaitMs: 5_000,
    });
    vi.stubGlobal("fetch", vi.fn(async () => unavailable()));
    expect(await httpEditorTransport(BOOK).save(doc, 1, { keepalive: false })).toEqual({
      kind: "retry",
      reason: "server",
      minWaitMs: 3_000,
    });
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "saving_unavailable" }, 503)));
    expect(await httpEditorTransport(BOOK).save(doc, 1, { keepalive: false })).toEqual({ kind: "unavailable" });
  });
});

describe("upload adapter: hung storage upload", () => {
  it("becomes a retryable 504 SUPABASE_TIMEOUT error; the retry succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls++;
        return calls === 1
          ? new Promise<Response>(() => {})
          : Promise.resolve(json({ Key: "photos/u/b/x-web.jpg", Id: "1" }));
      }),
    );
    const supabase = createClient("https://proj.supabase.co", "sb_publishable_test", {
      ...deadlineClientOptions("browser"),
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { storage } = createSupabaseUploadDeps(supabase as never, BOOK);
    const blob = new Blob([new Uint8Array(1024)], { type: "image/jpeg" });

    let first: Awaited<ReturnType<typeof storage.upload>> | undefined;
    void storage.upload("u/b/x-web.jpg", blob, "image/jpeg").then((r) => (first = r));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(first?.error).toMatchObject({ statusCode: SUPABASE_TIMEOUT, status: 504 });

    const second = storage.upload("u/b/x-web.jpg", blob, "image/jpeg");
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toEqual({ error: null });
  });
});
