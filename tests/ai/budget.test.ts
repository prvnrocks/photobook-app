// D-059 AI daily budget breaker: env parsing, the pure comparison, the spend reader (mocked admin
// client — no DB), the per-process cache and the fail-open check.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mocks.rpc }),
}));

const { readDailyBudgetUsd, isOverDailyBudget } = await import("@/lib/ai/limits");
const spend = await import("@/lib/db/ai-spend");
const { checkDailyAiBudget, isAiBudgetExhausted } = await import("@/lib/ai/budget");

// 2026-11-10 21:30 UTC = 2026-11-11 01:30 in Dubai.
const NOW = Date.parse("2026-11-10T21:30:00Z");

const row = (day: string, usd: unknown, o: Record<string, unknown> = {}) => ({
  day,
  usd,
  runs: 3,
  failed: 1,
  build_usd: 1.25,
  rewrite_usd: 0.05,
  null_book_runs: 0,
  ...o,
});

let errors: string[];
beforeEach(() => {
  mocks.rpc.mockReset();
  spend.resetTodaySpendCacheForTests();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("readDailyBudgetUsd", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["  ", null],
    ["abc", null],
    ["-1", null],
    ["1e3", null],
    ["0x10", null],
    ["Infinity", null],
    ["10$", null],
    ["10", 10],
    [" 12.5 ", 12.5],
    ["0", 0],
  ])("%j → %j", (raw, expected) => {
    expect(readDailyBudgetUsd({ AI_DAILY_BUDGET_USD: raw })).toBe(expected);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("AI_DAILY_BUDGET_USD", "7");
    expect(readDailyBudgetUsd()).toBe(7);
  });
});

describe("isOverDailyBudget", () => {
  it("null budget → never over", () => {
    expect(isOverDailyBudget(1_000_000, null)).toBe(false);
  });
  it("reaching the budget counts; 0 refuses everything", () => {
    expect(isOverDailyBudget(9.99, 10)).toBe(false);
    expect(isOverDailyBudget(10, 10)).toBe(true);
    expect(isOverDailyBudget(10.01, 10)).toBe(true);
    expect(isOverDailyBudget(0, 0)).toBe(true);
  });
  it("garbage spend is treated as 0; garbage budget as none", () => {
    expect(isOverDailyBudget(Number.NaN, 10)).toBe(false);
    expect(isOverDailyBudget(-5, 10)).toBe(false);
    expect(isOverDailyBudget(5, Number.NaN)).toBe(false);
    expect(isOverDailyBudget(5, -1)).toBe(false);
  });
});

describe("getAiSpendDaily", () => {
  it("calls the RPC with clamped days and maps rows (numeric strings / nulls tolerated)", async () => {
    mocks.rpc.mockResolvedValue({
      data: [row("2026-11-11", "2.500000"), row("2026-11-10", null, { runs: null, build_usd: "x" })],
      error: null,
    });
    const days = await spend.getAiSpendDaily(14);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_ai_spend_daily", { p_days: 14 });
    expect(days).toEqual([
      { day: "2026-11-11", usd: 2.5, runs: 3, failed: 1, buildUsd: 1.25, rewriteUsd: 0.05, nullBookRuns: 0 },
      { day: "2026-11-10", usd: 0, runs: 0, failed: 1, buildUsd: 0, rewriteUsd: 0.05, nullBookRuns: 0 },
    ]);
    await spend.getAiSpendDaily(0);
    await spend.getAiSpendDaily(9999);
    await spend.getAiSpendDaily(Number.NaN);
    expect(mocks.rpc.mock.calls.map((c) => c[1].p_days)).toEqual([14, 1, 366, 1]);
  });

  it("throws AiSpendError with the Postgres code only", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function does not exist" } });
    await expect(spend.getAiSpendDaily(1)).rejects.toMatchObject({ name: "AiSpendError", code: "42883" });
  });
});

describe("dubaiDay", () => {
  it("is UTC+4", () => {
    expect(spend.dubaiDay(NOW)).toBe("2026-11-11");
    expect(spend.dubaiDay(Date.parse("2026-11-10T19:59:59Z"))).toBe("2026-11-10");
    expect(spend.dubaiDay(Date.parse("2026-11-10T20:00:00Z"))).toBe("2026-11-11");
  });
});

describe("getTodaySpendUsd (cache)", () => {
  it("asks for p_days 1 and returns today's usd", async () => {
    mocks.rpc.mockResolvedValue({ data: [row("2026-11-11", 4.2)], error: null });
    expect(await spend.getTodaySpendUsd({ now: () => NOW })).toBe(4.2);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_ai_spend_daily", { p_days: 1 });
  });

  it("no rows → 0", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await spend.getTodaySpendUsd({ now: () => NOW })).toBe(0);
  });

  it("reuses the value for 60 s, then queries again", async () => {
    let t = NOW;
    const fetchDaily = vi
      .fn()
      .mockResolvedValueOnce([{ day: "2026-11-11", usd: 1 }])
      .mockResolvedValueOnce([{ day: "2026-11-11", usd: 2 }]);
    const opts = { now: () => t, fetchDaily };
    expect(await spend.getTodaySpendUsd(opts)).toBe(1);
    t += spend.TODAY_SPEND_CACHE_MS - 1;
    expect(await spend.getTodaySpendUsd(opts)).toBe(1);
    expect(fetchDaily).toHaveBeenCalledTimes(1);
    t += 1;
    expect(await spend.getTodaySpendUsd(opts)).toBe(2);
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(fetchDaily).toHaveBeenCalledWith(1);
  });

  it("concurrent callers share one query", async () => {
    let resolve!: (v: unknown) => void;
    const fetchDaily = vi.fn(() => new Promise((r) => (resolve = r)));
    const opts = { now: () => NOW, fetchDaily: fetchDaily as unknown as typeof spend.getAiSpendDaily };
    const a = spend.getTodaySpendUsd(opts);
    const b = spend.getTodaySpendUsd(opts);
    resolve([{ day: "2026-11-11", usd: 3 }]);
    expect(await Promise.all([a, b])).toEqual([3, 3]);
    expect(fetchDaily).toHaveBeenCalledTimes(1);
  });

  it("a new Dubai day drops the cache", async () => {
    let t = Date.parse("2026-11-10T19:59:30Z"); // 23:59:30 Dubai
    const fetchDaily = vi
      .fn()
      .mockResolvedValueOnce([{ day: "2026-11-10", usd: 9 }])
      .mockResolvedValueOnce([{ day: "2026-11-11", usd: 0 }]);
    const opts = { now: () => t, fetchDaily };
    expect(await spend.getTodaySpendUsd(opts)).toBe(9);
    t += 31_000; // 00:00:01 Dubai, within the TTL
    expect(await spend.getTodaySpendUsd(opts)).toBe(0);
    expect(fetchDaily).toHaveBeenCalledTimes(2);
  });

  it("failures are not cached", async () => {
    const fetchDaily = vi
      .fn()
      .mockRejectedValueOnce(new spend.AiSpendError("admin_ai_spend_daily", "57014"))
      .mockResolvedValueOnce([{ day: "2026-11-11", usd: 5 }]);
    const opts = { now: () => NOW, fetchDaily };
    await expect(spend.getTodaySpendUsd(opts)).rejects.toMatchObject({ code: "57014" });
    expect(await spend.getTodaySpendUsd(opts)).toBe(5);
  });
});

describe("checkDailyAiBudget", () => {
  it("unset / invalid budget → allowed without any query", async () => {
    const q = vi.fn(async () => 999);
    expect(await checkDailyAiBudget({ env: {}, getTodaySpendUsd: q })).toEqual({ allowed: true, reason: "no_budget" });
    expect(await checkDailyAiBudget({ env: { AI_DAILY_BUDGET_USD: "ten" }, getTodaySpendUsd: q })).toEqual({
      allowed: true,
      reason: "no_budget",
    });
    expect(q).not.toHaveBeenCalled();
  });

  it("under / over budget", async () => {
    const env = { AI_DAILY_BUDGET_USD: "10" };
    expect(await checkDailyAiBudget({ env, getTodaySpendUsd: async () => 9.5 })).toEqual({ allowed: true, reason: "under_budget" });
    expect(await checkDailyAiBudget({ env, getTodaySpendUsd: async () => 10 })).toEqual({ allowed: false, reason: "budget_exhausted" });
    expect(await isAiBudgetExhausted({ env, getTodaySpendUsd: async () => 12 })).toBe(true);
    expect(await isAiBudgetExhausted({ env, getTodaySpendUsd: async () => 1 })).toBe(false);
  });

  it("spend query failure → fail open, logs the code only", async () => {
    const env = { AI_DAILY_BUDGET_USD: "10" };
    const err = Object.assign(new Error("secret detail user 1234"), { code: "PGRST301" });
    expect(
      await checkDailyAiBudget({
        env,
        getTodaySpendUsd: async () => {
          throw err;
        },
      }),
    ).toEqual({ allowed: true, reason: "spend_query_failed" });
    expect(errors).toEqual(["[ai-budget] spend_query_failed (PGRST301)"]);
  });

  it("real path: env + cached RPC (one query for two checks), and admin client errors fail open", async () => {
    vi.stubEnv("AI_DAILY_BUDGET_USD", "5");
    mocks.rpc.mockResolvedValue({ data: [row(spend.dubaiDay(Date.now()), 6)], error: null });
    expect(await isAiBudgetExhausted()).toBe(true);
    expect(await isAiBudgetExhausted()).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    spend.resetTodaySpendCacheForTests();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "08006" } });
    expect(await isAiBudgetExhausted()).toBe(false);
    expect(errors).toEqual(["[ai-budget] spend_query_failed (08006)"]);
  });
});
