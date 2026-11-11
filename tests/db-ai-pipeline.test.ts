import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error: { code?: string; statusCode?: string; message?: string } | null; count?: number };

const JPEG_SOI = vi.hoisted(() => new Uint8Array([0xff, 0xd8, 0xff]));

// Records every query chain (client, table, op, payload, options, filters) and
// resolves to the next queued result. Storage calls are recorded separately.
const fake = vi.hoisted(() => {
  const state = {
    chains: [] as {
      client: "user" | "admin";
      table: string;
      op: string;
      payload?: unknown;
      options?: unknown;
      calls: unknown[][];
    }[],
    rpcs: [] as { client: "user" | "admin"; fn: string; args: unknown }[],
    results: [] as Result[],
    downloads: [] as string[],
    downloadResults: new Map<string, Result>(),
    signCalls: [] as { client: "user" | "admin"; paths: string[]; ttl: number }[],
    signResults: [] as Result[],
    inFlight: 0,
    maxInFlight: 0,
  };
  function builder(client: "user" | "admin", table: string, op: string, payload?: unknown, options?: unknown) {
    const entry = { client, table, op, payload, options, calls: [] as unknown[][] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "in", "is", "not", "gt", "gte", "or", "filter", "order", "select", "limit", "single", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(state.results.shift() ?? { data: [], error: null }).then(resolve, reject);
    return b;
  }
  const make = (kind: "user" | "admin") => ({
    from: (table: string) => ({
      select: (cols: string, opts?: unknown) => {
        const b = builder(kind, table, "select", undefined, opts);
        (b.select as (c: string) => unknown)(cols);
        return b;
      },
      insert: (payload: unknown) => builder(kind, table, "insert", payload),
      upsert: (payload: unknown, opts?: unknown) => builder(kind, table, "upsert", payload, opts),
      update: (payload: unknown) => builder(kind, table, "update", payload),
    }),
    rpc: async (fn: string, args: unknown) => {
      state.rpcs.push({ client: kind, fn, args });
      return state.results.shift() ?? { data: null, error: null };
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          state.downloads.push(path);
          state.inFlight++;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          await new Promise((r) => setTimeout(r, 1));
          state.inFlight--;
          return (
            state.downloadResults.get(path) ?? {
              data: new Blob([JPEG_SOI, new TextEncoder().encode(`img:${path}`)]),
              error: null,
            }
          );
        },
        createSignedUrls: async (paths: string[], ttl: number) => {
          state.signCalls.push({ client: kind, paths, ttl });
          return (
            state.signResults.shift() ?? {
              data: paths.map((p) => ({ path: p, signedUrl: `https://s/${p}`, error: null })),
              error: null,
            }
          );
        },
      }),
    },
  });
  return { state, client: make("user"), admin: make("admin") };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => ({ id: "u" }) }));

const runs = await import("@/lib/db/agent-runs");
const photos = await import("@/lib/db/photos");
const books = await import("@/lib/db/books");

const U = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const R = "44444444-4444-4444-8444-444444444444";
const T1 = "55555555-5555-4555-8555-555555555555";
const T2 = "66666666-6666-4666-8666-666666666666";
const TS = "2026-11-08T10:00:00.123456+00:00";
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

const step = (o: Partial<Parameters<ReturnType<typeof runs.stepLogger>["insertStep"]>[0]> = {}) => ({
  runId: R,
  agent: "curator" as const,
  stepKey: "curator:1",
  attempt: 1,
  retries: 2,
  status: "ok" as const,
  inputSummary: { photoIds: ["p1", "p2"], batch: 1 },
  output: { photos: [{ id: "p1", keep: true }] },
  model: "claude-opus-5-5",
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
  costUsd: 0.0081,
  latencyMs: 1234,
  stopReason: "end_turn",
  error: null,
  ...o,
});

beforeEach(() => {
  Object.assign(fake.state, {
    chains: [],
    rpcs: [],
    results: [],
    downloads: [],
    downloadResults: new Map(),
    signCalls: [],
    signResults: [],
    inFlight: 0,
    maxInFlight: 0,
  });
});

// ---------------------------------------------------------------------------

describe("agent runs: create / lease / checkpoint", () => {
  it("claimRun returns the lease token (null when not claimable); releaseRun passes the token", async () => {
    fake.state.results.push({ data: T1, error: null }, { data: null, error: null }, { data: null, error: null });
    expect(await runs.claimRun(R, 45)).toBe(T1);
    expect(await runs.claimRun(R, 45)).toBeNull();
    await runs.releaseRun(R, T1);
    expect(fake.state.rpcs).toEqual([
      { client: "admin", fn: "claim_agent_run", args: { p_run_id: R, p_lease_seconds: 45 } },
      { client: "admin", fn: "claim_agent_run", args: { p_run_id: R, p_lease_seconds: 45 } },
      { client: "admin", fn: "release_agent_run", args: { p_run_id: R, p_token: T1 } },
    ]);
    expect(await runs.claimRun("bad", 45)).toBeNull();
    await runs.releaseRun(R, "not-a-token");
    await runs.releaseRun("bad", T1);
    expect(fake.state.rpcs).toHaveLength(3);
  });

  it("claimRun treats a non-uuid RPC result as not claimed; errors carry the code only", async () => {
    fake.state.results.push({ data: true, error: null });
    expect(await runs.claimRun(R, 45)).toBeNull();
    fake.state.results.push({ data: null, error: { code: "42501", message: `run ${R}` } });
    const err = await runs.claimRun(R, 45).catch((e) => e);
    expect(err).toBeInstanceOf(runs.AgentRunsQueryError);
    expect(err.code).toBe("42501");
    expect(err.message).not.toContain(R);
  });

  it("checkpointRun writes only the given keys, guarded by the lease token, and clips error_code", async () => {
    fake.state.results.push({ data: [{ id: R }], error: null });
    expect(
      await runs.checkpointRun(R, T1, { state: "storytelling", progress: { done: 3 }, error_code: "x".repeat(100) }),
    ).toBe(true);
    const [c] = fake.state.chains;
    expect(c).toMatchObject({ client: "admin", table: "agent_runs", op: "update" });
    expect(c.payload).toEqual({ state: "storytelling", progress: { done: 3 }, error_code: "x".repeat(64) });
    expect(c.calls).toEqual([
      ["eq", "id", R],
      ["eq", "lease_token", T1],
      ["select", "id"],
    ]);
  });

  it("checkpointRun with a stale token writes 0 rows → false", async () => {
    fake.state.results.push({ data: [], error: null });
    expect(await runs.checkpointRun(R, T2, { state: "done" })).toBe(false);
    expect(await runs.checkpointRun(R, "not-a-token", { state: "done" })).toBe(false);
    expect(fake.state.chains).toHaveLength(1);
  });

  it("checkpointRun with an empty patch only verifies the token (no write)", async () => {
    fake.state.results.push({ data: { id: R }, error: null }, { data: null, error: null });
    expect(await runs.checkpointRun(R, T1, {})).toBe(true);
    expect(await runs.checkpointRun(R, T2, {})).toBe(false);
    expect(fake.state.chains.every((c) => c.op === "select")).toBe(true);
    expect(fake.state.chains[0].calls).toEqual(
      expect.arrayContaining([
        ["eq", "id", R],
        ["eq", "lease_token", T1],
      ]),
    );
    await expect(runs.checkpointRun("bad", T1, {})).rejects.toMatchObject({ code: "invalid_id" });
  });
});

describe("agent runs: clearMemoryFromActiveRuns", () => {
  const R2 = "77777777-7777-4777-8777-777777777777";
  const R3 = "88888888-8888-4888-8888-888888888888";

  it("selects only the user's active runs and strips memory, keeping other cursor fields", async () => {
    fake.state.results.push(
      {
        data: [
          { id: R, cursor: { v: 1, phase: "captioning", memory: { v: 1, tonePreference: "fun" }, plan: { a: 1 } } },
          { id: R2, cursor: { v: 1, phase: "curating" } }, // no memory → untouched
          { id: R3, cursor: null },
        ],
        error: null,
      },
      { data: [{ id: R }], error: null },
    );
    expect(await runs.clearMemoryFromActiveRuns(U)).toBe(1);
    expect(fake.state.chains).toHaveLength(2);
    const [sel, upd] = fake.state.chains;
    expect(sel).toMatchObject({ client: "admin", table: "agent_runs", op: "select" });
    expect(sel.calls).toEqual([
      ["select", "id, cursor"],
      ["eq", "user_id", U],
      ["in", "trigger", ["build", "rebuild"]],
      ["not", "state", "in", "(done,failed)"],
    ]);
    expect(upd).toMatchObject({ client: "admin", table: "agent_runs", op: "update" });
    expect(upd.payload).toEqual({ cursor: { v: 1, phase: "captioning", plan: { a: 1 } } });
    expect(upd.calls).toEqual([
      ["eq", "id", R],
      ["eq", "user_id", U],
      ["not", "state", "in", "(done,failed)"],
      ["select", "id"],
    ]);
  });

  it("a run that finished in between (0 rows updated) is not counted", async () => {
    fake.state.results.push(
      { data: [{ id: R, cursor: { memory: {} } }, { id: R2, cursor: { memory: { v: 1 }, x: 1 } }], error: null },
      { data: [], error: null },
      { data: [{ id: R2 }], error: null },
    );
    expect(await runs.clearMemoryFromActiveRuns(U)).toBe(1);
  });

  it("no active runs → 0, no writes; invalid id → invalid_id without a query", async () => {
    fake.state.results.push({ data: [], error: null });
    expect(await runs.clearMemoryFromActiveRuns(U)).toBe(0);
    expect(fake.state.chains).toHaveLength(1);
    await expect(runs.clearMemoryFromActiveRuns("bad")).rejects.toMatchObject({ code: "invalid_id" });
    expect(fake.state.chains).toHaveLength(1);
  });

  it("errors carry the code only; an update error still tries the remaining runs", async () => {
    fake.state.results.push({ data: null, error: { code: "42501", message: `user ${U}` } });
    const err = await runs.clearMemoryFromActiveRuns(U).catch((e) => e);
    expect(err).toBeInstanceOf(runs.AgentRunsQueryError);
    expect(err.code).toBe("42501");
    expect(err.message).not.toContain(U);

    fake.state.chains = [];
    fake.state.results.push(
      { data: [{ id: R, cursor: { memory: {} } }, { id: R2, cursor: { memory: {} } }], error: null },
      { data: null, error: { code: "23514", message: `run ${R}` } },
      { data: [{ id: R2 }], error: null },
    );
    const err2 = await runs.clearMemoryFromActiveRuns(U).catch((e) => e);
    expect(err2).toMatchObject({ code: "23514" });
    expect(err2.message).not.toContain(R);
    expect(fake.state.chains.filter((c) => c.op === "update")).toHaveLength(2);
  });
});

describe("agent runs: createRunCapped", () => {
  const input = { bookId: B, userId: U, trigger: "rebuild" as const, mode: "live" as const, dailyCap: 3, rebuildCap: 2, enforce: true };

  it("calls create_agent_run_capped with the admin client and returns the id", async () => {
    fake.state.results.push({ data: { id: R }, error: null });
    expect(await runs.createRunCapped(input)).toEqual({ id: R });
    expect(fake.state.rpcs).toEqual([
      {
        client: "admin",
        fn: "create_agent_run_capped",
        args: {
          p_book_id: B,
          p_user_id: U,
          p_trigger: "rebuild",
          p_mode: "live",
          p_daily_cap: 3,
          p_rebuild_cap: 2,
          p_enforce: true,
        },
      },
    ]);
  });

  it.each([
    [{ error: "already_running" }, { error: "already_running" }],
    [{ error: "limit", limit: "daily_builds" }, { error: "limit", limit: "daily_builds" }],
    [{ error: "limit", limit: "rebuilds" }, { error: "limit", limit: "rebuilds" }],
  ])("maps %j", async (data, expected) => {
    fake.state.results.push({ data, error: null });
    expect(await runs.createRunCapped(input)).toEqual(expected);
  });

  it("an unexpected RPC result throws bad_result (never treated as success)", async () => {
    for (const data of [null, true, { id: "nope" }, { error: "limit", limit: "other" }, [{ id: R }]]) {
      fake.state.results.push({ data, error: null });
      await expect(runs.createRunCapped(input)).rejects.toMatchObject({ code: "bad_result" });
    }
  });

  it("enforce false is passed through; caps are floored and never negative", async () => {
    fake.state.results.push({ data: { id: R }, error: null });
    await runs.createRunCapped({ ...input, mode: "replay", enforce: false, dailyCap: -1, rebuildCap: 2.7 });
    expect(fake.state.rpcs[0].args).toMatchObject({ p_enforce: false, p_daily_cap: 0, p_rebuild_cap: 2, p_mode: "replay" });
  });

  it("bad ids → invalid_id without a call; db errors → code only", async () => {
    await expect(runs.createRunCapped({ ...input, userId: "x" })).rejects.toMatchObject({ code: "invalid_id" });
    expect(fake.state.rpcs).toHaveLength(0);
    fake.state.results.push({ data: null, error: { code: "22023", message: `user ${U}` } });
    const err = await runs.createRunCapped(input).catch((e) => e);
    expect(err.code).toBe("22023");
    expect(err.message).not.toContain(U);
  });
});

describe("stepLogger", () => {
  it("maps the record to agent_steps columns, retries folded into input_summary", () => {
    const row = runs.stepRow(step());
    expect(row).toEqual({
      run_id: R,
      agent: "curator",
      step_key: "curator:1",
      attempt: 1,
      status: "ok",
      input_summary: { photoIds: ["p1", "p2"], batch: 1, retries: 2 },
      output: { photos: [{ id: "p1", keep: true }] },
      model: "claude-opus-5-5",
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 50,
      cache_write_tokens: 10,
      cost_usd: 0.0081,
      latency_ms: 1234,
      stop_reason: "end_turn",
      error: null,
    });
    expect(row).not.toHaveProperty("retries");
  });

  it("clips error / stop_reason to column limits and truncates huge input summaries", () => {
    const row = runs.stepRow(
      step({ error: "e".repeat(500), stopReason: "s".repeat(50), inputSummary: { big: "x".repeat(10_000) }, output: undefined }),
    );
    expect(row.error!.length).toBe(200);
    expect(row.stop_reason!.length).toBe(32);
    expect(row.input_summary).toEqual({ truncated: true, retries: 2 });
    expect(row.output).toBeNull();
  });

  it("insertStep is a plain insert (every real call gets a row)", async () => {
    await runs.stepLogger(R).insertStep(step());
    const [c] = fake.state.chains;
    expect(c).toMatchObject({ client: "admin", table: "agent_steps", op: "insert" });
    expect((c.payload as { attempt: number }).attempt).toBe(1);
    expect(fake.state.chains.filter((x) => x.op === "upsert")).toHaveLength(0);
  });

  it("a conflicting attempt is re-inserted with the next free attempt (resume re-run is logged)", async () => {
    fake.state.results.push(
      { data: null, error: { code: "23505" } }, // insert attempt 1 → conflict
      { data: { attempt: 2 }, error: null }, // nextAttempt → 3
      { data: null, error: null }, // insert attempt 3
    );
    await runs.stepLogger(R).insertStep(step());
    const inserts = fake.state.chains.filter((c) => c.op === "insert");
    expect(inserts.map((c) => (c.payload as { attempt: number }).attempt)).toEqual([1, 3]);
    const lookup = fake.state.chains.find((c) => c.op === "select")!;
    expect(lookup.calls).toEqual(
      expect.arrayContaining([
        ["eq", "run_id", R],
        ["eq", "step_key", "curator:1"],
        ["order", "attempt", { ascending: false }],
        ["limit", 1],
      ]),
    );
  });

  it("gives up after STEP_INSERT_CONFLICT_RETRIES conflicts with a 23505 error", async () => {
    for (let i = 0; i <= runs.STEP_INSERT_CONFLICT_RETRIES; i++) {
      fake.state.results.push({ data: null, error: { code: "23505" } });
      if (i < runs.STEP_INSERT_CONFLICT_RETRIES) fake.state.results.push({ data: null, error: null });
    }
    const err = await runs.stepLogger(R).insertStep(step()).catch((e) => e);
    expect(err).toBeInstanceOf(runs.AgentRunsQueryError);
    expect(err.code).toBe("23505");
    const inserts = fake.state.chains.filter((c) => c.op === "insert");
    expect(inserts.map((c) => (c.payload as { attempt: number }).attempt)).toEqual([1, 2, 3, 4]);
  });

  it("nextAttempt = max(attempt) + 1, or 1 when the step has no rows", async () => {
    fake.state.results.push({ data: { attempt: 4 }, error: null }, { data: null, error: null });
    expect(await runs.nextAttempt(R, "storyteller")).toBe(5);
    expect(await runs.nextAttempt(R, "storyteller")).toBe(1);
    await expect(runs.nextAttempt("bad", "x")).rejects.toMatchObject({ code: "invalid_id" });
  });

  it("totals are re-summed from steps, so re-syncing never doubles them", async () => {
    const logger = runs.stepLogger(R);
    const one = { cost_usd: 0.0081, input_tokens: 1000, output_tokens: 200 };
    fake.state.results.push(
      { data: null, error: null },
      { data: [one], error: null },
      { data: null, error: null },
      { data: [one], error: null },
      { data: null, error: null },
    );
    const delta = { costUsd: 0.0081, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await logger.insertStep(step());
    await logger.addRunTotals(R, delta);
    await logger.addRunTotals(R, delta);
    const totals = fake.state.chains.filter((c) => c.table === "agent_runs" && c.op === "update");
    expect(totals).toHaveLength(2);
    for (const t of totals) {
      expect(t.payload).toEqual({ total_cost_usd: 0.0081, total_input_tokens: 1000, total_output_tokens: 200 });
      expect(t.calls).toEqual([["eq", "id", R]]);
    }
  });

  it("totals keep 6 decimals (numeric(12, 6) since 0700)", async () => {
    fake.state.results.push({ data: [{ cost_usd: 0.000123, input_tokens: 1, output_tokens: 1 }, { cost_usd: "0.0000014", input_tokens: 1, output_tokens: 1 }], error: null });
    expect((await runs.syncRunTotals(R)).costUsd).toBe(0.000124);
  });

  it("totals sum every step of the run (numeric strings tolerated)", async () => {
    fake.state.results.push({
      data: [
        { cost_usd: "0.001", input_tokens: 10, output_tokens: 1 },
        { cost_usd: 0.00205, input_tokens: 20, output_tokens: 2 },
      ],
      error: null,
    });
    expect(await runs.syncRunTotals(R)).toEqual({ costUsd: 0.00305, inputTokens: 30, outputTokens: 3 });
    expect(fake.state.chains[0].calls).toContainEqual(["eq", "run_id", R]);
  });

  it("logger rejects records of another run; db errors carry codes only", async () => {
    const logger = runs.stepLogger(R);
    await expect(logger.insertStep(step({ runId: B }))).rejects.toMatchObject({ code: "run_mismatch" });
    fake.state.results.push({ data: null, error: { code: "23514", message: "output too big: description …" } });
    const err = await logger.insertStep(step()).catch((e) => e);
    expect(err).toBeInstanceOf(runs.AgentRunsQueryError);
    expect(err.code).toBe("23514");
    expect(err.message).not.toContain("description");
  });
});

describe("agent runs: reads and counters", () => {
  it("getRunForOwner uses the RLS client and never selects cursor", async () => {
    fake.state.results.push({ data: null, error: null });
    expect(await runs.getRunForOwner(R)).toBeNull();
    const [c] = fake.state.chains;
    expect(c.client).toBe("user");
    expect(String(c.calls[0][1])).not.toContain("cursor");
    expect(c.calls).toContainEqual(["eq", "id", R]);
    expect(await runs.getRunForOwner("bad")).toBeNull();
    expect(fake.state.chains).toHaveLength(1);
  });

  it("getActiveRunForBook filters out done/failed runs", async () => {
    fake.state.results.push({ data: null, error: null });
    await runs.getActiveRunForBook(B);
    const [c] = fake.state.chains;
    expect(c.client).toBe("user");
    expect(c.calls).toContainEqual(["eq", "book_id", B]);
    expect(c.calls).toContainEqual(["not", "state", "in", "(done,failed)"]);
    expect(String(c.calls[0][1])).not.toContain("cursor");
  });

  it("countLiveRuns counts live build+rebuild runs of the user since a time", async () => {
    fake.state.results.push({ data: null, error: null, count: 2 });
    expect(await runs.countLiveRuns({ userId: U, since: TS })).toBe(2);
    const [c] = fake.state.chains;
    expect(c.client).toBe("admin");
    expect(c.options).toEqual({ count: "exact", head: true });
    expect(c.calls).toEqual(
      expect.arrayContaining([
        ["eq", "user_id", U],
        ["eq", "mode", "live"],
        ["in", "trigger", ["build", "rebuild"]],
        ["gte", "started_at", TS],
        ["or", "total_cost_usd.gt.0,state.not.in.(done,failed)"],
      ]),
    );
  });

  it("countLiveRebuilds counts billed, successful live rebuilds of the book", async () => {
    fake.state.results.push({ data: null, error: null, count: 1 });
    expect(await runs.countLiveRebuilds(B)).toBe(1);
    expect(fake.state.chains[0].calls).toEqual(
      expect.arrayContaining([
        ["eq", "book_id", B],
        ["eq", "mode", "live"],
        ["eq", "trigger", "rebuild"],
        ["gt", "total_cost_usd", 0],
        ["in", "ai_status", ["ok", "partial"]],
      ]),
    );
  });

  it("hasFinishedLiveAiRun: a done live run with ai_status ok/partial", async () => {
    fake.state.results.push({ data: null, error: null, count: 2 }, { data: null, error: null, count: 0 });
    expect(await runs.hasFinishedLiveAiRun(B)).toBe(true);
    expect(await runs.hasFinishedLiveAiRun(B)).toBe(false);
    expect(await runs.hasFinishedLiveAiRun("bad")).toBe(false);
    const [c] = fake.state.chains;
    expect(c.client).toBe("admin");
    expect(c.calls).toEqual(
      expect.arrayContaining([
        ["eq", "book_id", B],
        ["eq", "mode", "live"],
        ["eq", "state", "done"],
        ["in", "ai_status", ["ok", "partial"]],
      ]),
    );
    expect(fake.state.chains).toHaveLength(2);
  });

  it("getLatestRunForBook: RLS client, owner-granted columns only, newest first", async () => {
    fake.state.results.push({ data: { id: R, mode: "rule", state: "done", started_at: TS }, error: null });
    expect(await runs.getLatestRunForBook(B)).toEqual({ id: R, mode: "rule", state: "done", started_at: TS });
    const [c] = fake.state.chains;
    expect(c.client).toBe("user");
    expect(c.calls[0]).toEqual(["select", "id, mode, state, started_at"]);
    expect(c.calls).toContainEqual(["eq", "book_id", B]);
    expect(c.calls).toContainEqual(["order", "started_at", { ascending: false }]);
    expect(await runs.getLatestRunForBook("bad")).toBeNull();
  });

  it("getRunTrace loads run + ordered steps with the admin client", async () => {
    fake.state.results.push({ data: { id: R }, error: null }, { data: [{ id: "s" }], error: null });
    expect(await runs.getRunTrace(R)).toEqual({ run: { id: R }, steps: [{ id: "s" }] });
    expect(fake.state.chains.every((c) => c.client === "admin")).toBe(true);
    expect(fake.state.chains[1].calls).toContainEqual(["order", "created_at", { ascending: true }]);
  });
});

// ---------------------------------------------------------------------------

describe("photos: curation", () => {
  it("listPhotosForCuration selects ready photos of the book", async () => {
    fake.state.results.push({ data: [], error: null });
    await photos.listPhotosForCuration(B);
    const [c] = fake.state.chains;
    expect(c.calls).toContainEqual(["eq", "book_id", B]);
    expect(c.calls).toContainEqual(["eq", "upload_state", "ready"]);
    for (const col of ["thumb_path", "user_override", "ai", "dup_group", "blur_score", "camera", "original_mime"]) {
      expect(String(c.calls[0][1])).toContain(col);
    }
  });

  it("writeCuration: ai on every row; status only where user_override = false; always by book_id", async () => {
    const [a, b2, c2, d] = ids(4);
    await photos.writeCuration(B, [
      { id: a, ai: { q: 1 }, status: "kept", dropReason: "ignored" },
      { id: b2, ai: { q: 2 }, status: "dropped", dropReason: "blurry" },
      { id: c2, ai: { q: 3 }, status: "dropped", dropReason: "blurry" },
      { id: d, ai: { q: 4 } },
    ]);
    const updates = fake.state.chains.filter((c) => c.op === "update");
    expect(updates.every((c) => c.client === "admin")).toBe(true);
    expect(updates.every((c) => c.calls.some((x) => x[0] === "eq" && x[1] === "book_id" && x[2] === B))).toBe(true);

    const aiWrites = updates.filter((c) => "ai" in (c.payload as object));
    expect(aiWrites).toHaveLength(4);
    for (const w of aiWrites) {
      expect(Object.keys(w.payload as object)).toEqual(["ai"]);
      expect(w.calls).not.toContainEqual(["eq", "user_override", false]);
    }

    const statusWrites = updates.filter((c) => "status" in (c.payload as object));
    expect(statusWrites).toHaveLength(2);
    for (const w of statusWrites) expect(w.calls).toContainEqual(["eq", "user_override", false]);
    const kept = statusWrites.find((w) => (w.payload as { status: string }).status === "kept")!;
    expect(kept.payload).toEqual({ status: "kept", drop_reason: null });
    expect(kept.calls).toContainEqual(["in", "id", [a]]);
    const dropped = statusWrites.find((w) => (w.payload as { status: string }).status === "dropped")!;
    expect(dropped.payload).toEqual({ status: "dropped", drop_reason: "blurry" });
    expect(dropped.calls).toContainEqual(["in", "id", [b2, c2]]);
  });

  it("writeCuration: rows without ai only get status (AI notes never overwritten)", async () => {
    const [a, b2] = ids(2);
    await photos.writeCuration(B, [
      { id: a, status: "dropped", dropReason: "blurry" },
      { id: b2, ai: { q: 2 }, status: "kept" },
    ]);
    const updates = fake.state.chains.filter((c) => c.op === "update");
    expect(updates.filter((c) => "ai" in (c.payload as object))).toHaveLength(1);
    expect(updates.filter((c) => "status" in (c.payload as object))).toHaveLength(2);
  });

  it("writeCuration batches status updates ≤100 ids and clips drop reasons", async () => {
    const rows = ids(150).map((id) => ({ id, ai: {}, status: "dropped" as const, dropReason: "😀".repeat(150) }));
    await photos.writeCuration(B, rows);
    const statusWrites = fake.state.chains.filter((c) => c.op === "update" && "status" in (c.payload as object));
    expect(statusWrites.map((w) => (w.calls.find((x) => x[0] === "in")![2] as string[]).length)).toEqual([100, 50]);
    const reason = (statusWrites[0].payload as { drop_reason: string }).drop_reason;
    expect(reason.length).toBeLessThanOrEqual(photos.DROP_REASON_MAX);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(reason)).toBe(false);
  });

  it("writeCuration: no rows / bad book id → no request; db error → code only", async () => {
    await photos.writeCuration(B, []);
    await photos.writeCuration("bad", [{ id: ids(1)[0], ai: {} }]);
    expect(fake.state.chains).toHaveLength(0);
    fake.state.results.push({ data: null, error: { code: "23514", message: "description: a beach" } });
    const err = await photos.writeCuration(B, [{ id: ids(1)[0], ai: { description: "a beach" } }]).catch((e) => e);
    expect(err).toBeInstanceOf(photos.PhotosQueryError);
    expect(err.code).toBe("23514");
    expect(err.message).not.toContain("beach");
  });

  it("loadThumbBase64 downloads each path once, ≤5 at a time, skipping failures", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `u/b/p${i}/thumb.jpg`);
    fake.state.downloadResults.set(paths[3], { data: null, error: { statusCode: "404" } });
    const map = await photos.loadThumbBase64([...paths, paths[0]]);
    expect(fake.state.downloads).toHaveLength(12);
    expect(fake.state.maxInFlight).toBeLessThanOrEqual(photos.THUMB_DOWNLOAD_CONCURRENCY);
    expect(map.size).toBe(11);
    expect(map.has(paths[3])).toBe(false);
    expect(Buffer.from(map.get(paths[0])!, "base64").subarray(3).toString()).toBe(`img:${paths[0]}`);
  });

  it("loadThumbBase64 skips thumbs over 1 MB or without the JPEG magic bytes (T16 #17)", async () => {
    const [ok, png, big, empty] = ["t/ok.jpg", "t/png.jpg", "t/big.jpg", "t/empty.jpg"];
    fake.state.downloadResults.set(png, {
      data: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])]),
      error: null,
    });
    fake.state.downloadResults.set(big, {
      data: new Blob([JPEG_SOI, new Uint8Array(photos.THUMB_MAX_BYTES)]),
      error: null,
    });
    fake.state.downloadResults.set(empty, { data: new Blob([new Uint8Array([0xff, 0xd8])]), error: null });
    const map = await photos.loadThumbBase64([ok, png, big, empty]);
    expect([...map.keys()]).toEqual([ok]);
    expect(photos.THUMB_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe("photos: user review", () => {
  it("setUserOverride (RLS) records the user's choice and sets user_override", async () => {
    const [p] = ids(1);
    fake.state.results.push({ data: [{ id: p }], error: null }, { data: [], error: null });
    expect(await photos.setUserOverride(B, p, false)).toBe(true);
    expect(await photos.setUserOverride(B, p, true)).toBe(false);
    const [drop, keep] = fake.state.chains;
    expect(drop.client).toBe("user");
    expect(drop.payload).toEqual({ status: "dropped", drop_reason: "user_removed", user_override: true });
    expect(keep.payload).toEqual({ status: "kept", drop_reason: null, user_override: true });
    expect(drop.calls).toContainEqual(["eq", "book_id", B]);
    expect(drop.calls).toContainEqual(["eq", "id", p]);
  });

  it("listReviewPhotos: small AI fields only, one createSignedUrls call (600 s)", async () => {
    const [a, b2, c2] = ids(3);
    fake.state.results.push({
      data: [
        { id: a, status: "kept", drop_reason: null, user_override: false, dup_group: 1, width: 1, height: 2, taken_at: TS, thumb_path: "t/a", quality: 8, scene: "group", coverWorthy: true },
        { id: b2, status: "dropped", drop_reason: "blurry", user_override: false, dup_group: 1, width: 1, height: 2, taken_at: null, thumb_path: "t/b", quality: "7", scene: null, coverWorthy: null },
        { id: c2, status: "kept", drop_reason: null, user_override: true, dup_group: null, width: null, height: null, taken_at: null, thumb_path: null, quality: null, scene: null, coverWorthy: null },
      ],
      error: null,
    });
    const out = await photos.listReviewPhotos(B);
    const [c] = fake.state.chains;
    expect(c.client).toBe("user");
    expect(c.calls).toContainEqual(["eq", "book_id", B]);
    const cols = String(c.calls[0][1]);
    expect(cols).not.toMatch(/description/);
    expect(cols).not.toMatch(/(^|[ ,])ai(,|$)/); // never the whole ai object
    expect(fake.state.signCalls).toEqual([{ client: "user", paths: ["t/a", "t/b"], ttl: 600 }]);
    expect(out[0]).toEqual({
      id: a,
      status: "kept",
      dropReason: null,
      userOverride: false,
      dupGroup: 1,
      quality: 8,
      scene: "group",
      coverWorthy: true,
      width: 1,
      height: 2,
      takenAt: TS,
      thumbUrl: "https://s/t/a",
    });
    expect(out[1].quality).toBeNull(); // non-number ignored
    expect(out[2].thumbUrl).toBeNull();
    expect(out[0]).not.toHaveProperty("thumb_path");
  });

  it("listReviewPhotos: signing error → PhotosQueryError with storage code only", async () => {
    fake.state.results.push({ data: [{ id: ids(1)[0], thumb_path: "t/a" }], error: null });
    fake.state.signResults.push({ data: null, error: { statusCode: "403", message: "t/a denied" } });
    const err = await photos.listReviewPhotos(B).catch((e) => e);
    expect(err).toBeInstanceOf(photos.PhotosQueryError);
    expect(err.code).toBe("403");
    expect(err.message).not.toContain("t/a");
  });
});

// ---------------------------------------------------------------------------

describe("books: AI pipeline writes", () => {
  const ruleDoc = { version: 1, pages: [] };

  it("writeDocIfReplaceable writes with the updated_at lock", async () => {
    fake.state.results.push({ data: { doc: {}, updated_at: TS }, error: null }, { data: [{ id: B }], error: null });
    expect(await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS })).toEqual({ ok: true });
    const [read, write] = fake.state.chains;
    expect(read).toMatchObject({ client: "admin", op: "select" });
    expect(write).toMatchObject({ client: "admin", op: "update", payload: { doc: ruleDoc, page_count: 4 } });
    expect(write.calls).toEqual([
      ["eq", "id", B],
      ["eq", "updated_at", TS],
      ["select", "id"],
    ]);
  });

  it("refuses a user-edited (or unparsable) doc without writing", async () => {
    fake.state.results.push({ data: { doc: { garbage: true }, updated_at: TS }, error: null });
    expect(await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS })).toEqual({
      ok: false,
      reason: "user_edited",
    });
    expect(fake.state.chains.filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("guard (D-031): a doc with a user caption is refused by default / 'ai', written with 'relayout'", async () => {
    const captioned = {
      version: 1,
      format: "A5_PORTRAIT",
      occasion: "travel",
      cover: { layout: "cover", photoId: "a", title: "T", subtitle: "" },
      chapters: [{ id: "c1", title: "Beach", dateLabel: "", place: null }],
      pages: [
        {
          id: "p1",
          chapterId: "c1",
          layout: "one-portrait",
          slots: [{ photoId: "a", crop: { x: 0.5, y: 0.5, zoom: 1 } }],
          caption: { text: "mine", font: "Playfair", align: "center", source: "user" },
        },
      ],
      style: { background: "#FFFFFF", font: "Playfair" },
      meta: { generator: "ai", generatorVersion: 1, runId: null, userEdited: false },
    };
    for (const opts of [undefined, { guard: "ai" as const }]) {
      fake.state.results.push({ data: { doc: captioned, updated_at: TS }, error: null });
      expect(await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS }, opts)).toEqual({
        ok: false,
        reason: "user_edited",
      });
    }
    expect(fake.state.chains.filter((c) => c.op === "update")).toHaveLength(0);
    fake.state.results.push({ data: { doc: captioned, updated_at: TS }, error: null }, { data: [{ id: B }], error: null });
    expect(await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS }, { guard: "relayout" })).toEqual({ ok: true });
    // relayout still refuses a userEdited doc
    fake.state.results.push({
      data: { doc: { ...captioned, meta: { ...captioned.meta, userEdited: true } }, updated_at: TS },
      error: null,
    });
    expect(await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS }, { guard: "relayout" })).toEqual({
      ok: false,
      reason: "user_edited",
    });
  });

  it("updated_at mismatch on read → conflict, no write", async () => {
    fake.state.results.push({ data: { doc: {}, updated_at: "2026-11-08T11:00:00+00:00" }, error: null });
    expect(await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(fake.state.chains.filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("0 rows updated (edit landed between read and write) → conflict", async () => {
    fake.state.results.push({ data: { doc: {}, updated_at: TS }, error: null }, { data: [], error: null });
    expect(await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS })).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("missing book / bad id → not_found; db error → code only", async () => {
    fake.state.results.push({ data: null, error: null });
    expect(await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS })).toEqual({ ok: false, reason: "not_found" });
    expect(await books.writeDocIfReplaceable("bad", ruleDoc, 4, { updatedAt: TS })).toEqual({
      ok: false,
      reason: "not_found",
    });
    fake.state.results.push({ data: null, error: { code: "42501", message: "doc …" } });
    const err = await books.writeDocIfReplaceable(B, ruleDoc, 4, { updatedAt: TS }).catch((e) => e);
    expect(err).toBeInstanceOf(books.BooksQueryError);
    expect(err.code).toBe("42501");
  });

  it("setBookAiStatus / getBookForRun use the admin client", async () => {
    await books.setBookAiStatus(B, "partial");
    fake.state.results.push({ data: null, error: null });
    expect(await books.getBookForRun(B)).toBeNull();
    const [set, get] = fake.state.chains;
    expect(set).toMatchObject({ client: "admin", table: "books", op: "update", payload: { ai_status: "partial" } });
    expect(set.calls).toEqual([["eq", "id", B]]);
    expect(get.client).toBe("admin");
    for (const col of ["user_id", "doc", "updated_at", "ai_status", "caption_lang", "max_pages"]) {
      expect(String(get.calls[0][1])).toContain(col);
    }
  });

  it("M10b A6: getBookForRun selects format + design_style; before 1900 retries without them (nulls)", async () => {
    fake.state.results.push({ data: { id: B }, error: null });
    await books.getBookForRun(B);
    expect(String(fake.state.chains[0].calls[0][1])).toMatch(/\bformat\b.*\bdesign_style\b/);
    fake.state.chains = [];
    fake.state.results.push(
      { data: null, error: { code: "42703", message: "column books.format does not exist" } },
      { data: { id: B, doc: {} }, error: null },
    );
    expect(await books.getBookForRun(B)).toEqual({ id: B, doc: {}, format: null, design_style: null });
    expect(String(fake.state.chains[1].calls[0][1])).not.toMatch(/format|design_style/);
    fake.state.results.push({ data: null, error: { code: "42703", message: "column books.other does not exist" } });
    await expect(books.getBookForRun(B)).rejects.toBeInstanceOf(books.BooksQueryError);
  });
});
