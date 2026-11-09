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
  };
  function builder(client: "user" | "admin", table: string, op: string, payload?: unknown) {
    const entry = { client, table, op, payload, calls: [] as unknown[][] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "in", "not", "select", "maybeSingle"]) {
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
});

describe("createRewriteRun", () => {
  it("calls create_rewrite_run_capped with floored cap and boolean enforce", async () => {
    fake.state.results.push({ data: { id: R }, error: null });
    expect(await runs.createRewriteRun(B, U, "replay", 20.7, true)).toEqual({ id: R });
    expect(fake.state.rpcs).toEqual([
      { fn: "create_rewrite_run_capped", args: { p_book: B, p_user: U, p_mode: "replay", p_cap: 20, p_enforce: true } },
    ]);
  });

  it.each(["already_running", "limit", "not_found"] as const)("maps {error:%s}", async (e) => {
    fake.state.results.push({ data: { error: e, limit: "rewrites" }, error: null });
    expect(await runs.createRewriteRun(B, U, "live", 200, true)).toEqual({ error: e });
  });

  it("throws on bad ids / mode / result / rpc error (code only)", async () => {
    await expect(runs.createRewriteRun("x", U, "live", 1, true)).rejects.toThrow("invalid_id");
    await expect(runs.createRewriteRun(B, U, "rule" as never, 1, true)).rejects.toThrow("invalid_mode");
    fake.state.results.push({ data: { id: "nope" }, error: null });
    await expect(runs.createRewriteRun(B, U, "live", 1, true)).rejects.toThrow("bad_result");
    fake.state.results.push({ data: null, error: { code: "42501" } });
    await expect(runs.createRewriteRun(B, U, "live", 1, true)).rejects.toThrow("(42501)");
    expect(fake.state.rpcs).toHaveLength(2);
  });
});

describe("finishRewriteRun", () => {
  it("ok → state done, ai_status ok, no error code; only unfinished rewrite runs", async () => {
    fake.state.results.push({ data: [{ id: R }], error: null });
    expect(await runs.finishRewriteRun(R, { ai_status: "ok", error_code: "ignored" })).toBe(true);
    const c = fake.state.chains[0];
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
    fake.state.results.push({ data: [], error: null });
    expect(await runs.finishRewriteRun(R, { ai_status: "failed", error_code: "x".repeat(100) })).toBe(false);
    expect(fake.state.chains[0].payload).toMatchObject({ state: "failed", ai_status: "failed", error_code: "x".repeat(64) });
  });

  it("throws on bad id or db error", async () => {
    await expect(runs.finishRewriteRun("x", { ai_status: "ok" })).rejects.toThrow("invalid_id");
    fake.state.results.push({ data: null, error: { code: "08006" } });
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

  it("0 for a bad id; throws on db error", async () => {
    expect(await runs.getRewritesUsed("x")).toBe(0);
    expect(fake.state.chains).toHaveLength(0);
    fake.state.results.push({ error: { code: "42501" } });
    await expect(runs.getRewritesUsed(B)).rejects.toThrow("(42501)");
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
