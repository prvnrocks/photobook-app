// Task 10: production monitoring — pure aggregation, alert lines, admin-only route, no content.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ user: null as { id: string } | null, admin: false, tables: {} as Record<string, { data: unknown[] | null; error: { code: string } | null }> }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/auth/is-admin", () => ({ isAdminUser: () => mocks.admin }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "order", "limit"]) q[m] = () => q;
      q.then = (r: (v: unknown) => unknown) => r(mocks.tables[table] ?? { data: [], error: null });
      return q;
    },
  }),
}));

import { alertLogLines, dubaiDay, percentile, summarize, type ExportRow, type LedgerRow, type StoryRunRow } from "@/lib/monitoring/aggregate";
const { getMonitoringSummary, logMonitoringAlerts, clampDays } = await import("@/lib/monitoring/summary");
const route = await import("@/app/api/admin/monitoring/route");

const NOW = new Date("2026-11-19T08:00:00Z");
const ledger = (over: Partial<LedgerRow> = {}): LedgerRow => ({ operation: "plan", status: "ok", error: null, cost_usd: "0.0100", cost_bucket: "paid", latency_ms: 4000, priced: true, created_at: "2026-11-19T06:00:00Z", ...over });
const run = (over: Partial<StoryRunRow> = {}): StoryRunRow => ({ state: "done", error_code: null, mode: "live", started_at: "2026-11-19T06:00:00Z", finished_at: "2026-11-19T06:01:30Z", ...over });
const exp = (over: Partial<ExportRow> = {}): ExportRow => ({ status: "ready", error_code: null, created_at: "2026-11-19T06:00:00Z", finished_at: "2026-11-19T06:00:20Z", page_count: 21, ...over });

describe("aggregate (pure)", () => {
  it("percentile is nearest-rank; empty → null", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });

  it("Dubai day is UTC+4", () => {
    expect(dubaiDay("2026-11-18T20:30:00Z")).toBe("2026-11-19");
    expect(dubaiDay("2026-11-18T19:30:00Z")).toBe("2026-11-18");
  });

  it("AI rates, per-operation latency, stage times, cost per day by bucket", () => {
    const rows = [
      ledger({ operation: "photo_analysis", latency_ms: 1000, cost_bucket: "preview", cost_usd: 0.002 }),
      ledger({ operation: "photo_analysis", latency_ms: 3000, cost_bucket: "preview", cost_usd: 0.002 }),
      ledger({ operation: "write", status: "retried", error: "rate_limited", latency_ms: 500 }),
      ledger({ operation: "write", latency_ms: 9000, cost_usd: "0.05" }),
      ledger({ operation: "compose", status: "refused", error: "refusal", latency_ms: 2000, cost_usd: 0 }),
      ledger({ operation: "critic", status: "failed", error: "timeout", cost_bucket: "other", created_at: "2026-11-18T10:00:00Z", priced: false }),
    ];
    const s = summarize({ windowDays: 7, now: NOW, ledger: rows, runs: [], exports: [] });
    expect(s.ai).toMatchObject({ attempts: 6, ok: 3, failed: 1, refused: 1, retried: 1, failureRate: 0.3333, refusalRate: 0.1667, unpriced: 1 });
    expect(s.ai!.errors).toEqual({ rate_limited: 1, refusal: 1, timeout: 1 });
    expect(s.ai!.byOperation.photo_analysis).toMatchObject({ attempts: 2, p50Ms: 1000, p95Ms: 3000, usd: 0.004 });
    expect(s.stages!.discovering).toEqual({ n: 2, p50Ms: 1000, p95Ms: 3000 });
    expect(s.stages!.writing.n).toBe(2);
    expect(s.costPerDay).toEqual([
      { day: "2026-11-18", preview: 0, paid: 0, other: 0.01, total: 0.01 },
      { day: "2026-11-19", preview: 0.004, paid: 0.06, other: 0, total: 0.064 },
    ]);
    expect(s.alerts.map((a) => a.code)).toEqual(["ai_refusals", "ai_unpriced_model"]); // < 20 attempts: no rate alert
  });

  it("story runs and exports: rates exclude user stops; durations of finished work; codes sanitised", () => {
    const s = summarize({
      windowDays: 7,
      now: NOW,
      ledger: null,
      runs: [run(), run({ finished_at: "2026-11-19T06:03:00Z" }), run({ state: "failed", error_code: "cancelled" }), run({ state: "failed", error_code: "stale" }), run({ state: "writing", finished_at: null })],
      exports: [exp(), exp({ status: "superseded", finished_at: "2026-11-19T06:01:00Z" }), exp({ status: "failed", error_code: "render_timeout" }), exp({ status: "failed", error_code: "Bad Code!" }), exp({ status: "queued", finished_at: null })],
    });
    expect(s.ai).toBeNull();
    expect(s.notes).toContain("ledger_unavailable");
    expect(s.runs).toMatchObject({ started: 5, done: 2, failed: 1, cancelled: 1, active: 1, failureRate: 0.3333, failureCodes: { stale: 1 } });
    expect(s.runs.duration).toEqual({ n: 2, p50Ms: 90_000, p95Ms: 180_000 });
    expect(s.exports).toMatchObject({ started: 5, ready: 1, superseded: 1, failed: 2, active: 1, failureRate: 0.5, failureCodes: { render_timeout: 1, unknown: 1 } });
    expect(s.exports.duration).toEqual({ n: 2, p50Ms: 20_000, p95Ms: 60_000 });
  });

  it("rate alerts need a minimum sample; cost alert at 80 % of the daily budget; slow exports", () => {
    const many = Array.from({ length: 30 }, (_, i) => ledger({ status: i < 5 ? "failed" : "ok", error: i < 5 ? "timeout" : null, cost_usd: 0.2 }));
    const runs = Array.from({ length: 20 }, (_, i) => run(i < 4 ? { state: "failed", error_code: "stale" } : {}));
    const exports = Array.from({ length: 20 }, (_, i) => exp(i < 3 ? { status: "failed", error_code: "too_large" } : { finished_at: "2026-11-19T06:04:00Z" }));
    const s = summarize({ windowDays: 1, now: NOW, ledger: many, runs, exports, dailyBudgetUsd: 5 });
    expect(s.alerts).toEqual([
      { code: "ai_failure_rate_high", value: 0.1667 },
      { code: "ai_cost_today_high", value: 6 },
      { code: "story_run_failure_rate_high", value: 0.2 },
      { code: "export_failure_rate_high", value: 0.15 },
      { code: "export_slow", value: 240_000 },
    ]);
    expect(alertLogLines(s)[0]).toBe("[monitor] alert=ai_failure_rate_high value=0.1667");
    for (const l of alertLogLines(s)) expect(l).toMatch(/^\[monitor\] alert=[a-z_]+ value=[\d.]+$/);
  });

  it("the aggregate module has no imports (shared with the CLI script via Node type stripping)", () => {
    const src = readFileSync("src/lib/monitoring/aggregate.ts", "utf8");
    expect(src).not.toMatch(/^import\s/m);
  });
});

describe("server summary, alerts and the admin route", () => {
  let logs: string[];
  beforeEach(() => {
    mocks.user = null;
    mocks.admin = false;
    mocks.tables = {
      ai_usage_ledger: { data: [ledger({ status: "refused", error: "refusal" })], error: null },
      agent_runs: { data: [run()], error: null },
      exports: { data: [exp()], error: null },
    };
    logs = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  it("clampDays: 1..31, default 7", () => {
    expect(clampDays(undefined)).toBe(7);
    expect(clampDays("0")).toBe(1);
    expect(clampDays("400")).toBe(31);
    expect(clampDays("abc")).toBe(7);
  });

  it("a database without the ledger still answers (ledger_unavailable)", async () => {
    mocks.tables.ai_usage_ledger = { data: null, error: { code: "42P01" } };
    const s = await getMonitoringSummary(7, NOW);
    expect(s.ai).toBeNull();
    expect(s.runs.done).toBe(1);
  });

  it("daily alert pass logs code-only lines", async () => {
    expect(await logMonitoringAlerts(NOW)).toBe(1);
    expect(logs[0]).toBe("[monitor] alert=ai_refusals value=1");
    expect(logs[1]).toMatch(/^\[monitor\] daily ai_attempts=1 ai_fail_rate=1 runs=1 run_fail=0 exports=1 export_fail=0 alerts=1$/);
    mocks.tables.exports = { data: null, error: { code: "XX000" } };
    expect(await logMonitoringAlerts(NOW)).toBe(-1);
    expect(logs.at(-1)).toBe("[monitor] summary_failed (XX000)");
  });

  it("route: 404 for signed-out and non-admin users; JSON summary for admins (no-store)", async () => {
    const get = () => route.GET(new NextRequest("http://localhost:3000/api/admin/monitoring?days=3"));
    expect((await get()).status).toBe(404);
    mocks.user = { id: "u1" };
    expect((await get()).status).toBe(404);
    mocks.admin = true;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { windowDays: number; ai: { refused: number } };
    expect(body.windowDays).toBe(3);
    expect(body.ai.refused).toBe(1);
  });
});
