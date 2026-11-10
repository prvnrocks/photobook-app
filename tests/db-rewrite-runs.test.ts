// M5 Task 7: rewrite-run db helpers (agent-runs.ts) + page photo notes (photo-notes.ts) +
// pure request helpers (rewrite-request.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error: { code?: string } | null; count?: number };

const fake = vi.hoisted(() => {
  const state = {
    chains: [] as { client: "user" | "admin"; table: string; op: string; payload?: unknown; calls: unknown[][] }[],
    rpcs: [] as { fn: string; args: unknown }[],
    results: [] as Result[],
    /** When set (and no queued result), selects on agent_runs are EVALUATED against these rows. */
    rows: null as Record<string, unknown>[] | null,
  };
  /** Minimal PostgREST filter evaluation: eq, in, not.in, gte; select count/head, limit, maybeSingle. */
  function evaluate(calls: unknown[][]): Result {
    let rows = [...(state.rows ?? [])];
    let head = false;
    let single = false;
    for (const [m, ...a] of calls) {
      if (m === "select") head = (a[1] as { head?: boolean } | undefined)?.head === true;
      else if (m === "eq") rows = rows.filter((r) => r[a[0] as string] === a[1]);
      else if (m === "in") rows = rows.filter((r) => (a[1] as unknown[]).includes(r[a[0] as string]));
      else if (m === "not" && a[1] === "in") {
        const vals = String(a[2]).replace(/[()]/g, "").split(",");
        rows = rows.filter((r) => !vals.includes(String(r[a[0] as string])));
      } else if (m === "gte") rows = rows.filter((r) => String(r[a[0] as string]) >= String(a[1]));
      else if (m === "limit") rows = rows.slice(0, a[0] as number);
      else if (m === "maybeSingle") single = true;
    }
    if (head) return { count: rows.length, error: null };
    return { data: single ? (rows[0] ?? null) : rows, error: null };
  }
  function builder(client: "user" | "admin", table: string, op: string, payload?: unknown) {
    const entry = { client, table, op, payload, calls: [] as unknown[][] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "in", "not", "select", "maybeSingle", "order", "limit", "gte", "or"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(
        state.results.shift() ??
          (state.rows && table === "agent_runs" && op === "select" ? evaluate(entry.calls) : { data: [], error: null }),
      ).then(resolve, reject);
    return b;
  }
  const make = (kind: "user" | "admin") => ({
    from: (table: string) => ({
      select: (cols: string, opts?: unknown) => {
        const b = builder(kind, table, "select");
        (b.select as (c: string, o?: unknown) => unknown)(cols, opts);
        return b;
      },
      update: (payload: unknown) => builder(kind, table, "update", payload),
    }),
    rpc: async (fn: string, args: unknown) => {
      state.rpcs.push({ fn, args });
      return state.results.shift() ?? { data: null, error: null };
    },
  });
  return { state, client: make("user"), admin: make("admin") };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => ({ id: "u" }) }));

const runs = await import("@/lib/db/agent-runs");
const notes = await import("@/lib/db/photo-notes");
const req = await import("@/lib/ai/rewrite-request");

const U = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const R = "44444444-4444-4444-8444-444444444444";
const P1 = "55555555-5555-4555-8555-555555555551";
const P2 = "55555555-5555-4555-8555-555555555552";

beforeEach(() => {
  fake.state.chains = [];
  fake.state.rpcs = [];
  fake.state.results = [];
  fake.state.rows = null;
});

const input = (o: Partial<Parameters<typeof runs.createRewriteRun>[0]> = {}) => ({
  bookId: B,
  userId: U,
  mode: "live" as const,
  cap: 20,
  dailyCap: 60,
  enforce: true,
  ...o,
});

describe("createRewriteRun", () => {
  it("calls create_rewrite_run_capped with floored caps and boolean enforce", async () => {
    fake.state.results.push({ data: { id: R }, error: null });
    expect(await runs.createRewriteRun(input({ mode: "replay", cap: 20.7, dailyCap: 60.9 }))).toEqual({ id: R });
    expect(fake.state.rpcs).toEqual([
      {
        fn: "create_rewrite_run_capped",
        args: { p_book: B, p_user: U, p_mode: "replay", p_cap: 20, p_daily_cap: 60, p_enforce: true },
      },
    ]);
  });

  it("non-finite / negative caps become 0", async () => {
    fake.state.results.push({ data: { error: "daily_limit" }, error: null });
    await runs.createRewriteRun(input({ cap: Number.NaN, dailyCap: -3 }));
    expect(fake.state.rpcs[0].args).toMatchObject({ p_cap: 0, p_daily_cap: 0 });
  });

  it.each(["already_running", "limit", "daily_limit", "not_found"] as const)("maps {error:%s}", async (e) => {
    fake.state.results.push({ data: { error: e, limit: "rewrites" }, error: null });
    expect(await runs.createRewriteRun(input({ cap: 200 }))).toEqual({ error: e });
  });

  it("throws on bad ids / mode / result / rpc error (code only)", async () => {
    await expect(runs.createRewriteRun(input({ bookId: "x" }))).rejects.toThrow("invalid_id");
    await expect(runs.createRewriteRun(input({ mode: "rule" as never }))).rejects.toThrow("invalid_mode");
    fake.state.results.push({ data: { id: "nope" }, error: null });
    await expect(runs.createRewriteRun(input())).rejects.toThrow("bad_result");
    fake.state.results.push({ data: null, error: { code: "42501" } });
    await expect(runs.createRewriteRun(input())).rejects.toThrow("(42501)");
    expect(fake.state.rpcs).toHaveLength(2);
  });

  it("isMissingRpcError: PGRST202 / 42883 from the RPC (before migration 0900), nothing else", async () => {
    for (const code of ["PGRST202", "42883"]) {
      fake.state.results.push({ data: null, error: { code } });
      const err = await runs.createRewriteRun(input()).catch((e: unknown) => e);
      expect(runs.isMissingRpcError(err)).toBe(true);
    }
    fake.state.results.push({ data: null, error: { code: "42501" } });
    expect(runs.isMissingRpcError(await runs.createRewriteRun(input()).catch((e: unknown) => e))).toBe(false);
    expect(runs.isMissingRpcError(Object.assign(new Error("x"), { code: "PGRST202" }))).toBe(false);
    expect(runs.isMissingRpcError(null)).toBe(false);
  });
});

describe("finishRewriteRun", () => {
  it("re-sums step costs into the run totals first (also for failed rewrites — M5 review S1)", async () => {
    fake.state.results.push(
      { data: [{ cost_usd: 0.0123, input_tokens: 900, output_tokens: 40 }, { cost_usd: "0.0100", input_tokens: 800, output_tokens: 0 }], error: null },
      { data: null, error: null },
      { data: [{ id: R }], error: null },
    );
    expect(await runs.finishRewriteRun(R, { ai_status: "failed", error_code: "refused" })).toBe(true);
    const [steps, totals, finish] = fake.state.chains;
    expect(steps).toMatchObject({ client: "admin", table: "agent_steps", op: "select" });
    expect(steps.calls).toContainEqual(["eq", "run_id", R]);
    expect(totals).toMatchObject({ client: "admin", table: "agent_runs", op: "update" });
    expect(totals.payload).toEqual({ total_cost_usd: 0.0223, total_input_tokens: 1700, total_output_tokens: 40 });
    expect(finish.payload).toMatchObject({ state: "failed", ai_status: "failed", error_code: "refused" });
  });

  it("a failing totals sum never stops the finish", async () => {
    fake.state.results.push({ data: null, error: { code: "08006" } }, { data: [{ id: R }], error: null });
    expect(await runs.finishRewriteRun(R, { ai_status: "ok" })).toBe(true);
    expect(fake.state.chains.at(-1)!.payload).toMatchObject({ state: "done", ai_status: "ok" });
  });

  it("ok → state done, ai_status ok, no error code; only unfinished rewrite runs", async () => {
    fake.state.results.push({ data: [], error: null }, { data: null, error: null }, { data: [{ id: R }], error: null });
    expect(await runs.finishRewriteRun(R, { ai_status: "ok", error_code: "ignored" })).toBe(true);
    const c = fake.state.chains.at(-1)!;
    expect(c).toMatchObject({ client: "admin", table: "agent_runs", op: "update" });
    expect(c.payload).toMatchObject({ state: "done", ai_status: "ok", error_code: null, finished_at: expect.any(String) });
    expect(c.calls).toEqual(
      expect.arrayContaining([
        ["eq", "id", R],
        ["eq", "trigger", "rewrite"],
        ["not", "state", "in", "(done,failed)"],
      ]),
    );
  });

  it("failed → state failed with a clipped error code; false when already finished", async () => {
    fake.state.results.push({ data: [], error: null }, { data: null, error: null }, { data: [], error: null });
    expect(await runs.finishRewriteRun(R, { ai_status: "failed", error_code: "x".repeat(100) })).toBe(false);
    expect(fake.state.chains.at(-1)!.payload).toMatchObject({ state: "failed", ai_status: "failed", error_code: "x".repeat(64) });
  });

  it("throws on bad id or db error", async () => {
    await expect(runs.finishRewriteRun("x", { ai_status: "ok" })).rejects.toThrow("invalid_id");
    fake.state.results.push({ data: [], error: null }, { data: null, error: null }, { data: null, error: { code: "08006" } });
    await expect(runs.finishRewriteRun(R, { ai_status: "ok" })).rejects.toThrow("(08006)");
  });
});

describe("getRewritesUsed", () => {
  it("counts ok rewrite runs of the book with the RLS client", async () => {
    fake.state.results.push({ count: 7, error: null });
    expect(await runs.getRewritesUsed(B)).toBe(7);
    const c = fake.state.chains[0];
    expect(c.client).toBe("user");
    expect(c.calls).toEqual([
      ["select", "id", { count: "exact", head: true }],
      ["eq", "book_id", B],
      ["eq", "trigger", "rewrite"],
      ["eq", "ai_status", "ok"],
    ]);
  });

  it("reuses a caller's RLS client when given (editor loader, M5 review S5)", async () => {
    fake.state.results.push({ count: 3, error: null });
    expect(await runs.getRewritesUsed(B, fake.client as never)).toBe(3);
    expect(fake.state.chains[0].client).toBe("user");
  });

  it("0 for a bad id; throws on db error", async () => {
    expect(await runs.getRewritesUsed("x")).toBe(0);
    expect(fake.state.chains).toHaveLength(0);
    fake.state.results.push({ error: { code: "42501" } });
    await expect(runs.getRewritesUsed(B)).rejects.toThrow("(42501)");
  });
});

describe("build-run lookups never see rewrite runs (M5 review B1)", () => {
  const TRIGGER_FILTER = ["in", "trigger", ["build", "rebuild"]];
  const run = (o: Record<string, unknown> = {}) => ({
    id: R,
    book_id: B,
    user_id: U,
    mode: "live",
    trigger: "rewrite",
    state: "rewriting",
    ai_status: null,
    started_at: "2026-11-10T08:00:00Z",
    ...o,
  });

  it("isBuildRunTrigger", () => {
    expect(runs.isBuildRunTrigger("build")).toBe(true);
    expect(runs.isBuildRunTrigger("rebuild")).toBe(true);
    expect(runs.isBuildRunTrigger("rewrite")).toBe(false);
    expect(runs.isBuildRunTrigger(null)).toBe(false);
  });

  it("getActiveRunForBook / getLatestRunForBook / getRunForOwner filter by build triggers", async () => {
    await runs.getActiveRunForBook(B);
    await runs.getLatestRunForBook(B);
    await runs.getRunForOwner(R);
    expect(fake.state.chains).toHaveLength(3);
    for (const c of fake.state.chains) {
      expect(c.client).toBe("user");
      expect(c.calls).toContainEqual(TRIGGER_FILTER);
    }
  });

  it("hasFinishedLiveAiRun: a successful live rewrite doesn't make the next build a rebuild", async () => {
    fake.state.rows = [run({ trigger: "rewrite", state: "done", ai_status: "ok" })];
    expect(await runs.hasFinishedLiveAiRun(B)).toBe(false);
    expect(fake.state.chains[0].client).toBe("admin");
    expect(fake.state.chains[0].calls).toContainEqual(TRIGGER_FILTER);
    // ...while a finished live build does.
    fake.state.rows.push(run({ id: "b1", trigger: "build", state: "done", ai_status: "partial" }));
    expect(await runs.hasFinishedLiveAiRun(B)).toBe(true);
  });

  it("an in-flight rewrite is invisible to the build page / review busy check / runs 409 lookup", async () => {
    // getActiveRunForBook backs: build page resume, review page "building", updateAlbumAction busy,
    // POST /api/ai/runs 409 runId. getLatestRunForBook backs the rule-run rate guard.
    fake.state.rows = [run({ trigger: "rewrite", state: "rewriting" })];
    expect(await runs.getActiveRunForBook(B)).toBeNull();
    expect(await runs.getLatestRunForBook(B)).toBeNull();
    expect(await runs.getRunForOwner(R)).toBeNull();
    // A real build run is still found.
    fake.state.rows.push(run({ id: "b1", trigger: "build", state: "curating" }));
    expect(await runs.getActiveRunForBook(B)).toMatchObject({ id: "b1" });
    expect(await runs.getLatestRunForBook(B)).toMatchObject({ id: "b1" });
  });

  it("countLiveRuns defaults to build triggers; clearMemoryFromActiveRuns only touches build runs", async () => {
    fake.state.results.push({ count: 0, error: null });
    await runs.countLiveRuns({ userId: U, since: "2026-11-10T00:00:00Z" });
    expect(fake.state.chains[0].calls).toContainEqual(TRIGGER_FILTER);
    fake.state.results.push({ data: [], error: null });
    await runs.clearMemoryFromActiveRuns(U);
    expect(fake.state.chains[1].calls).toContainEqual(TRIGGER_FILTER);
  });
});

describe("getPhotoNotesAdmin", () => {
  it("filters by book, drops non-uuids/dupes, returns rows in the given order", async () => {
    fake.state.results.push({
      data: [
        { id: P2, taken_at: null, place: "Abu Dhabi", ai: null },
        { id: P1, taken_at: "2026-07-01T10:00:00Z", place: null, ai: { v: 1 } },
      ],
      error: null,
    });
    const rows = await notes.getPhotoNotesAdmin(B, [P1, "bad", P2, P1]);
    expect(rows.map((r) => r.id)).toEqual([P1, P2]);
    expect(rows[1]).toEqual({ id: P2, takenAt: null, place: "Abu Dhabi", ai: null });
    const c = fake.state.chains[0];
    expect(c.client).toBe("admin");
    expect(c.calls).toEqual(expect.arrayContaining([["eq", "book_id", B], ["in", "id", [P1, P2]]]));
  });

  it("no ids → no query; bad book id → throws", async () => {
    expect(await notes.getPhotoNotesAdmin(B, [])).toEqual([]);
    expect(fake.state.chains).toHaveLength(0);
    await expect(notes.getPhotoNotesAdmin("x", [P1])).rejects.toThrow("invalid_id");
  });
});

describe("rewrite-request helpers", () => {
  it("rewriteTargetLang", () => {
    expect(req.rewriteTargetLang("A day at the beach", "translate", "en")).toBe("ar");
    expect(req.rewriteTargetLang("يوم على الشاطئ", "translate", "ar")).toBe("en");
    expect(req.rewriteTargetLang("يوم على الشاطئ", "shorter", "en")).toBe("ar");
    expect(req.rewriteTargetLang("A day", "tone:fun", "ar")).toBe("en");
    expect(req.rewriteTargetLang("🎉 2026", "rewrite", "ar")).toBe("ar");
    expect(req.rewriteTargetLang("🎉", "rewrite", "zz")).toBe("en");
  });

  it("pagePhotoIds: slot order, unique, nulls skipped; null for unknown page / no doc", () => {
    const crop = { x: 0.5, y: 0.5, zoom: 1 };
    const doc = {
      pages: [{ id: "p", chapterId: null, layout: "l", caption: null, slots: [{ photoId: P2, crop }, { photoId: null, crop }, { photoId: P1, crop }, { photoId: P2, crop }] }],
    };
    expect(req.pagePhotoIds(doc, "p")).toEqual([P2, P1]);
    expect(req.pagePhotoIds(doc, "q")).toBeNull();
    expect(req.pagePhotoIds(null, "p")).toBeNull();
  });

  it("RewriteBodySchema: strict, instruction list incl. tone:<Tone>, 1..200 code points", () => {
    const ok = { bookId: B, pageId: "p1", instruction: "tone:romantic", text: "Hi" };
    expect(req.RewriteBodySchema.safeParse(ok).success).toBe(true);
    expect(req.RewriteBodySchema.safeParse({ ...ok, instruction: "tone:sad" }).success).toBe(false);
    expect(req.RewriteBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(req.RewriteBodySchema.safeParse({ ...ok, text: "😀".repeat(200) }).success).toBe(true);
    expect(req.RewriteBodySchema.safeParse({ ...ok, text: "😀".repeat(201) }).success).toBe(false);
    expect(req.RewriteBodySchema.safeParse({ ...ok, pageId: "x".repeat(65) }).success).toBe(false);
  });
});
