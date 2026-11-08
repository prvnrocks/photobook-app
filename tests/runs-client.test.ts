import { describe, expect, it, vi } from "vitest";
import {
  advanceRun,
  DEFAULT_LEASE_WAIT_MS,
  getRun,
  startRun,
  type AdvanceOutcome,
  type FetchLike,
} from "@/lib/runs/client";
import { backoffMs, driveRun, MAX_TRANSIENT_TRIES } from "@/lib/runs/drive";

const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

function res(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const fetchOnce = (r: Response | Error): FetchLike & { calls: [string, RequestInit | undefined][] } => {
  const calls: [string, RequestInit | undefined][] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    if (r instanceof Error) throw r;
    return r;
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
};

const progress = { phase: "curating", photosTotal: 40, photosDone: 10, batchesTotal: 4, batchesDone: 1, photosCapped: 0 };

describe("startRun", () => {
  it("201 → started; sends bookId + trigger as JSON, same-origin, no-store", async () => {
    const f = fetchOnce(res(201, { runId: RUN, mode: "live", state: "queued" }));
    expect(await startRun(BOOK, "rebuild", { fetchImpl: f })).toEqual({
      kind: "started",
      runId: RUN,
      mode: "live",
      state: "queued",
    });
    const [url, init] = f.calls[0];
    expect(url).toBe("/api/ai/runs");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.cache).toBe("no-store");
    expect(JSON.parse(String(init?.body))).toEqual({ bookId: BOOK, trigger: "rebuild" });
  });

  it("201 rule mode done", async () => {
    const f = fetchOnce(res(201, { runId: RUN, mode: "rule", state: "done" }));
    expect(await startRun(BOOK, "build", { fetchImpl: f })).toMatchObject({ kind: "started", mode: "rule", state: "done" });
  });

  it("201 with a malformed body → server_error", async () => {
    expect(await startRun(BOOK, "build", { fetchImpl: fetchOnce(res(201, { runId: "x", mode: "live", state: "queued" })) })).toEqual({ kind: "server_error" });
    expect(await startRun(BOOK, "build", { fetchImpl: fetchOnce(res(201, { runId: RUN, mode: "nope", state: "queued" })) })).toEqual({ kind: "server_error" });
  });

  it.each([
    [409, { error: "already_running", runId: RUN }, { kind: "already_running", runId: RUN }],
    [409, { error: "already_running", runId: null }, { kind: "already_running", runId: null }],
    [409, { error: "already_running", runId: "not-a-uuid" }, { kind: "already_running", runId: null }],
    [409, { error: "user_edited" }, { kind: "user_edited" }],
    [429, { error: "limit", limit: "daily_builds" }, { kind: "limit", limit: "daily_builds" }],
    [429, { error: "limit", limit: "rebuilds" }, { kind: "limit", limit: "rebuilds" }],
    [429, { error: "limit", limit: "weird" }, { kind: "limit", limit: "daily_builds" }],
    [400, { error: "invalid_body" }, { kind: "invalid" }],
    [401, { error: "unauthenticated" }, { kind: "signed_out" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [404, { error: "not_found" }, { kind: "not_found" }],
    [500, { error: "server_error" }, { kind: "server_error" }],
    [502, undefined, { kind: "server_error" }],
  ])("%i %j → %j", async (status, body, expected) => {
    expect(await startRun(BOOK, "build", { fetchImpl: fetchOnce(res(status, body)) })).toEqual(expected);
  });

  it("network error → network; malformed book id never fetches", async () => {
    expect(await startRun(BOOK, "build", { fetchImpl: fetchOnce(new TypeError("offline")) })).toEqual({ kind: "network" });
    const f = fetchOnce(res(201, {}));
    expect(await startRun("../x", "build", { fetchImpl: f })).toEqual({ kind: "not_found" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("advanceRun", () => {
  it("200 → tick (lenient progress, strict state/done)", async () => {
    const f = fetchOnce(res(200, { state: "curating", progress, done: false, aiStatus: null, errorCode: null }));
    expect(await advanceRun(RUN, { fetchImpl: f })).toEqual({
      kind: "tick",
      tick: { state: "curating", progress, done: false, aiStatus: null, errorCode: null },
    });
    expect(f.calls[0][0]).toBe(`/api/ai/runs/${RUN}/advance`);
    expect(f.calls[0][1]?.method).toBe("POST");
  });

  it("200 with missing progress fields → zeros; phase falls back to state", async () => {
    const out = await advanceRun(RUN, {
      fetchImpl: fetchOnce(res(200, { state: "done", progress: { photosDone: -1 }, done: true, aiStatus: "partial" })),
    });
    expect(out).toEqual({
      kind: "tick",
      tick: {
        state: "done",
        progress: { phase: "done", photosTotal: 0, photosDone: 0, batchesTotal: 0, batchesDone: 0, photosCapped: 0 },
        done: true,
        aiStatus: "partial",
        errorCode: null,
      },
    });
  });

  it("200 with an unknown state → server_error", async () => {
    expect(await advanceRun(RUN, { fetchImpl: fetchOnce(res(200, { state: "zzz", done: false })) })).toEqual({ kind: "server_error" });
  });

  it("202 → leased with Retry-After in ms", async () => {
    expect(await advanceRun(RUN, { fetchImpl: fetchOnce(res(202, { leased: true }, { "retry-after": "2" })) })).toEqual({
      kind: "leased",
      retryAfterMs: 2000,
    });
    expect(await advanceRun(RUN, { fetchImpl: fetchOnce(res(202, { leased: true }, { "retry-after": "0" })) })).toEqual({
      kind: "leased",
      retryAfterMs: 1000, // clamped to ≥ 1 s
    });
    expect(await advanceRun(RUN, { fetchImpl: fetchOnce(res(202, { leased: true })) })).toEqual({
      kind: "leased",
      retryAfterMs: DEFAULT_LEASE_WAIT_MS,
    });
  });

  it.each([
    [401, "signed_out"],
    [403, "forbidden"],
    [404, "not_found"],
    [500, "server_error"],
    [503, "server_error"],
  ])("%i → %s", async (status, kind) => {
    expect(await advanceRun(RUN, { fetchImpl: fetchOnce(res(status, { error: "x" })) })).toEqual({ kind });
  });

  it("network → network; bad run id → not_found without fetch", async () => {
    expect(await advanceRun(RUN, { fetchImpl: fetchOnce(new Error("boom")) })).toEqual({ kind: "network" });
    const f = fetchOnce(res(200, {}));
    expect(await advanceRun("nope", { fetchImpl: f })).toEqual({ kind: "not_found" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("getRun", () => {
  it("200 → view with mode", async () => {
    const f = fetchOnce(res(200, { state: "storytelling", progress, aiStatus: null, errorCode: null, mode: "replay", done: false }));
    expect(await getRun(RUN, { fetchImpl: f })).toMatchObject({ kind: "view", view: { state: "storytelling", mode: "replay", done: false } });
    expect(f.calls[0][0]).toBe(`/api/ai/runs/${RUN}`);
    expect(f.calls[0][1]?.method).toBe("GET");
  });

  it("missing mode → server_error; 401/404/500 mapped", async () => {
    expect(await getRun(RUN, { fetchImpl: fetchOnce(res(200, { state: "done", done: true })) })).toEqual({ kind: "server_error" });
    expect(await getRun(RUN, { fetchImpl: fetchOnce(res(401)) })).toEqual({ kind: "signed_out" });
    expect(await getRun(RUN, { fetchImpl: fetchOnce(res(404)) })).toEqual({ kind: "not_found" });
    expect(await getRun(RUN, { fetchImpl: fetchOnce(res(500)) })).toEqual({ kind: "server_error" });
  });
});

describe("driveRun", () => {
  const tick = (state: string, done: boolean): AdvanceOutcome =>
    ({ kind: "tick", tick: { state, progress: { ...progress, phase: state }, done, aiStatus: done ? "ok" : null, errorCode: null } }) as AdvanceOutcome;

  function script(outs: AdvanceOutcome[]) {
    const advance = vi.fn(async () => outs.shift() ?? ({ kind: "server_error" } as AdvanceOutcome));
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    return { advance, sleeps, sleep };
  }

  it("loops ticks until done, reporting each", async () => {
    const { advance, sleep } = script([tick("curating", false), tick("storytelling", false), tick("done", true)]);
    const seen: string[] = [];
    const out = await driveRun({ runId: RUN, advance, sleep, onTick: (t) => seen.push(t.state) });
    expect(out).toMatchObject({ kind: "done", tick: { state: "done" } });
    expect(seen).toEqual(["curating", "storytelling", "done"]);
    expect(advance).toHaveBeenCalledTimes(3);
  });

  it("waits Retry-After on 202 without counting a failure", async () => {
    const outs: AdvanceOutcome[] = [];
    for (let i = 0; i < MAX_TRANSIENT_TRIES + 2; i++) outs.push({ kind: "leased", retryAfterMs: 2000 });
    outs.push(tick("done", true));
    const { advance, sleeps, sleep } = script(outs);
    expect(await driveRun({ runId: RUN, advance, sleep })).toMatchObject({ kind: "done" });
    expect(sleeps.slice(0, MAX_TRANSIENT_TRIES + 2).every((ms) => ms === 2000)).toBe(true);
  });

  it("backs off 2/4/8/16 s on network + 5xx and gives up after 5 tries", async () => {
    const { advance, sleeps, sleep } = script([
      { kind: "network" },
      { kind: "server_error" },
      { kind: "network" },
      { kind: "network" },
      { kind: "network" },
    ]);
    const retries: number[] = [];
    const out = await driveRun({ runId: RUN, advance, sleep, onRetry: (n) => retries.push(n) });
    expect(out).toEqual({ kind: "error", error: "unavailable" });
    expect(advance).toHaveBeenCalledTimes(MAX_TRANSIENT_TRIES);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
    expect(retries).toEqual([1, 2, 3, 4]);
  });

  it("a successful tick resets the failure count", async () => {
    const { advance, sleep } = script([
      { kind: "network" },
      { kind: "network" },
      { kind: "network" },
      { kind: "network" },
      tick("curating", false),
      { kind: "network" },
      { kind: "network" },
      tick("done", true),
    ]);
    expect(await driveRun({ runId: RUN, advance, sleep })).toMatchObject({ kind: "done" });
  });

  it.each([
    ["signed_out", "signed_out"],
    ["not_found", "not_found"],
    ["forbidden", "not_found"],
  ] as const)("%s stops at once → %s", async (kind, error) => {
    const { advance, sleep } = script([{ kind }]);
    expect(await driveRun({ runId: RUN, advance, sleep })).toEqual({ kind: "error", error });
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("stops when aborted (before and during a call)", async () => {
    const c = new AbortController();
    c.abort();
    const { advance, sleep } = script([tick("done", true)]);
    expect(await driveRun({ runId: RUN, advance, sleep, signal: c.signal })).toEqual({ kind: "aborted" });
    expect(advance).not.toHaveBeenCalled();

    const c2 = new AbortController();
    const advance2 = vi.fn(async () => {
      c2.abort();
      return tick("done", true);
    });
    expect(await driveRun({ runId: RUN, advance: advance2, sleep, signal: c2.signal })).toEqual({ kind: "aborted" });
  });

  it("backoffMs: 2, 4, 8, 16, then capped", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([2000, 2000, 4000, 8000, 16000, 16000, 16000]);
  });
});
