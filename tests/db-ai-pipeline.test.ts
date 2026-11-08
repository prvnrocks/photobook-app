import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error: { code?: string; statusCode?: string; message?: string } | null; count?: number };

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
    for (const m of ["eq", "in", "is", "not", "gte", "filter", "order", "select", "limit", "single", "maybeSingle"]) {
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
              data: new Blob([new TextEncoder().encode(`img:${path}`)]),
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
  it("createRun inserts with the admin client and returns the id", async () => {
    fake.state.results.push({ data: { id: R }, error: null });
    expect(await runs.createRun({ bookId: B, userId: U, trigger: "build", mode: "replay" })).toEqual({ id: R });
    const [c] = fake.state.chains;
    expect(c).toMatchObject({
      client: "admin",
      table: "agent_runs",
      op: "insert",
      payload: { book_id: B, user_id: U, trigger: "build", mode: "replay" },
    });
  });

  it("createRun maps 23505 (one active run per book) to already_running", async () => {
    fake.state.results.push({ data: null, error: { code: "23505", message: "duplicate key ... secret" } });
    expect(await runs.createRun({ bookId: B, userId: U, trigger: "rebuild", mode: "live" })).toEqual({
      error: "already_running",
    });
  });

  it("other errors → AgentRunsQueryError with the code only (no message / ids)", async () => {
    fake.state.results.push({ data: null, error: { code: "42501", message: `row ${B} leaked` } });
    const err = await runs.createRun({ bookId: B, userId: U, trigger: "build", mode: "live" }).catch((e) => e);
    expect(err).toBeInstanceOf(runs.AgentRunsQueryError);
    expect(err.code).toBe("42501");
    expect(err.message).not.toContain(B);
    expect(err.message).not.toContain("leaked");
    await expect(runs.createRun({ bookId: "x", userId: U, trigger: "build", mode: "live" })).rejects.toMatchObject({
      code: "invalid_id",
    });
  });

  it("claimRun / releaseRun call the lease RPCs with the admin client", async () => {
    fake.state.results.push({ data: true, error: null }, { data: false, error: null }, { data: null, error: null });
    expect(await runs.claimRun(R, 45)).toBe(true);
    expect(await runs.claimRun(R, 45)).toBe(false);
    await runs.releaseRun(R);
    expect(fake.state.rpcs).toEqual([
      { client: "admin", fn: "claim_agent_run", args: { p_run_id: R, p_lease_seconds: 45 } },
      { client: "admin", fn: "claim_agent_run", args: { p_run_id: R, p_lease_seconds: 45 } },
      { client: "admin", fn: "release_agent_run", args: { p_run_id: R } },
    ]);
    expect(await runs.claimRun("bad", 45)).toBe(false);
    expect(fake.state.rpcs).toHaveLength(3);
  });

  it("checkpointRun writes only the given keys and clips error_code to 64", async () => {
    await runs.checkpointRun(R, { state: "storytelling", progress: { done: 3 }, error_code: "x".repeat(100) });
    const [c] = fake.state.chains;
    expect(c).toMatchObject({ client: "admin", table: "agent_runs", op: "update" });
    expect(c.payload).toEqual({ state: "storytelling", progress: { done: 3 }, error_code: "x".repeat(64) });
    expect(c.calls).toEqual([["eq", "id", R]]);
    await runs.checkpointRun(R, {});
    expect(fake.state.chains).toHaveLength(1);
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

  it("insertStep upserts with ON CONFLICT (run_id, step_key, attempt) DO NOTHING", async () => {
    await runs.stepLogger(R).insertStep(step());
    const [c] = fake.state.chains;
    expect(c).toMatchObject({ client: "admin", table: "agent_steps", op: "upsert" });
    expect(c.options).toEqual({ onConflict: "run_id,step_key,attempt", ignoreDuplicates: true });
  });

  it("a duplicate step (resume) is ignored and does not double the run totals", async () => {
    const logger = runs.stepLogger(R);
    const one = { cost_usd: 0.0081, input_tokens: 1000, output_tokens: 200 };
    // insert #1, totals (select steps, update run), insert #2 (ignored → no row), totals again
    fake.state.results.push(
      { data: null, error: null },
      { data: [one], error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: [one], error: null },
      { data: null, error: null },
    );
    const delta = { costUsd: 0.0081, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await logger.insertStep(step());
    await logger.addRunTotals(R, delta);
    await logger.insertStep(step());
    await logger.addRunTotals(R, delta);
    const totals = fake.state.chains.filter((c) => c.table === "agent_runs" && c.op === "update");
    expect(totals).toHaveLength(2);
    for (const t of totals) {
      expect(t.payload).toEqual({ total_cost_usd: 0.0081, total_input_tokens: 1000, total_output_tokens: 200 });
      expect(t.calls).toEqual([["eq", "id", R]]);
    }
  });

  it("totals sum every step of the run (numeric strings tolerated)", async () => {
    fake.state.results.push({
      data: [
        { cost_usd: "0.001", input_tokens: 10, output_tokens: 1 },
        { cost_usd: 0.00205, input_tokens: 20, output_tokens: 2 },
      ],
      error: null,
    });
    expect(await runs.syncRunTotals(R)).toEqual({ costUsd: 0.0031, inputTokens: 30, outputTokens: 3 });
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
      ]),
    );
  });

  it("countLiveRebuilds counts live rebuilds of the book", async () => {
    fake.state.results.push({ data: null, error: null, count: 1 });
    expect(await runs.countLiveRebuilds(B)).toBe(1);
    expect(fake.state.chains[0].calls).toEqual(
      expect.arrayContaining([
        ["eq", "book_id", B],
        ["eq", "mode", "live"],
        ["eq", "trigger", "rebuild"],
      ]),
    );
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
    expect(Buffer.from(map.get(paths[0])!, "base64").toString()).toBe(`img:${paths[0]}`);
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
});
