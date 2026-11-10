// T9 (M9) — /admin/ai-spend view helpers (D-059): totals, budget bar, USD formatting, windows.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  budgetBar,
  buildAiSpendView,
  formatCount,
  formatSpendUsd,
  rowsInWindow,
  shiftDay,
  sumSpend,
} from "@/lib/admin/ai-spend-view";
import type { AiSpendDay } from "@/lib/db/ai-spend";

function day(d: string, usd = 0, extra: Partial<AiSpendDay> = {}): AiSpendDay {
  return { day: d, usd, runs: 0, failed: 0, buildUsd: 0, rewriteUsd: 0, nullBookRuns: 0, ...extra };
}

/** 30 rows newest first ending on `today`, usd = 1 each unless overridden. */
function month(today: string, usd = 1): AiSpendDay[] {
  return Array.from({ length: 30 }, (_, i) => day(shiftDay(today, -i), usd, { runs: 2, failed: 1 }));
}

describe("formatSpendUsd", () => {
  it("uses 2 to 4 decimals", () => {
    expect(formatSpendUsd(0)).toBe("$0.00");
    expect(formatSpendUsd(1)).toBe("$1.00");
    expect(formatSpendUsd(12.5)).toBe("$12.50");
    expect(formatSpendUsd(0.0123)).toBe("$0.0123");
    expect(formatSpendUsd(0.123456)).toBe("$0.1235");
    expect(formatSpendUsd(0.00004)).toBe("$0.00");
    expect(formatSpendUsd(1234.5678)).toBe("$1,234.5678");
  });
  it("handles garbage and negatives", () => {
    expect(formatSpendUsd(NaN)).toBe("$0.00");
    expect(formatSpendUsd(Infinity)).toBe("$0.00");
    expect(formatSpendUsd(null)).toBe("$0.00");
    expect(formatSpendUsd(undefined)).toBe("$0.00");
    expect(formatSpendUsd(-0.5)).toBe("-$0.50");
    expect(formatSpendUsd(-0.00001)).toBe("$0.00");
  });
});

describe("formatCount", () => {
  it("formats integers", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(NaN)).toBe("0");
    expect(formatCount(null)).toBe("0");
  });
});

describe("shiftDay / rowsInWindow", () => {
  it("shifts across month and year boundaries", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2026-11-10", -6)).toBe("2026-11-04");
    expect(shiftDay("nope", 1)).toBe("");
  });

  it("keeps the inclusive window, newest first, and drops future/older rows", () => {
    const rows = [
      day("2026-11-11", 9), // future (clock skew) — excluded
      day("2026-11-03", 5), // 8 days back — outside 7
      day("2026-11-04", 4),
      day("2026-11-10", 1),
      day("2026-11-07", 2),
    ];
    expect(rowsInWindow(rows, "2026-11-10", 7).map((r) => r.day)).toEqual([
      "2026-11-10",
      "2026-11-07",
      "2026-11-04",
    ]);
    expect(rowsInWindow(rows, "bad", 7)).toEqual([]);
  });
});

describe("sumSpend", () => {
  it("sums every column without float noise", () => {
    const t = sumSpend([
      day("2026-11-10", 0.1, { runs: 1, failed: 1, buildUsd: 0.1, rewriteUsd: 0, nullBookRuns: 1 }),
      day("2026-11-09", 0.2, { runs: 3, failed: 0, buildUsd: 0.15, rewriteUsd: 0.05, nullBookRuns: 0 }),
    ]);
    expect(t).toEqual({ usd: 0.3, runs: 4, failed: 1, buildUsd: 0.25, rewriteUsd: 0.05, nullBookRuns: 1 });
  });
  it("treats non-finite values as 0 and empty as zeros", () => {
    expect(sumSpend([day("2026-11-10", NaN)]).usd).toBe(0);
    expect(sumSpend([])).toEqual({ usd: 0, runs: 0, failed: 0, buildUsd: 0, rewriteUsd: 0, nullBookRuns: 0 });
  });
});

describe("budgetBar", () => {
  it("no budget → none, empty", () => {
    expect(budgetBar(5, null)).toEqual({ state: "none", percent: 0 });
    expect(budgetBar(5, NaN)).toEqual({ state: "none", percent: 0 });
    expect(budgetBar(5, -1)).toEqual({ state: "none", percent: 0 });
  });
  it("ok / warn / over thresholds mirror isOverDailyBudget (spend ≥ budget is over)", () => {
    expect(budgetBar(0, 10)).toEqual({ state: "ok", percent: 0 });
    expect(budgetBar(2.5, 10)).toEqual({ state: "ok", percent: 25 });
    expect(budgetBar(7.99, 10)).toEqual({ state: "ok", percent: 79.9 });
    expect(budgetBar(8, 10)).toEqual({ state: "warn", percent: 80 });
    expect(budgetBar(10, 10)).toEqual({ state: "over", percent: 100 });
    expect(budgetBar(25, 10)).toEqual({ state: "over", percent: 100 });
  });
  it("budget 0 is the kill switch: always over", () => {
    expect(budgetBar(0, 0)).toEqual({ state: "over", percent: 100 });
  });
  it("negative / non-finite spend counts as 0", () => {
    expect(budgetBar(-3, 10)).toEqual({ state: "ok", percent: 0 });
    expect(budgetBar(NaN, 10)).toEqual({ state: "ok", percent: 0 });
  });
});

describe("buildAiSpendView", () => {
  it("computes today, 7-day and 30-day totals", () => {
    const rows = month("2026-11-10");
    rows[0] = day("2026-11-10", 3.5, { runs: 4 });
    const v = buildAiSpendView(rows, "2026-11-10", 10);
    expect(v.todayUsd).toBe(3.5);
    expect(v.bar).toEqual({ state: "ok", percent: 35 });
    expect(v.last7.usd).toBe(3.5 + 6);
    expect(v.last7.runs).toBe(4 + 12);
    expect(v.last30.usd).toBe(3.5 + 29);
    expect(v.last30.failed).toBe(29);
    expect(v.rows).toHaveLength(30);
    expect(v.rows[0].day).toBe("2026-11-10");
  });
  it("missing today row → $0 today; no budget → none", () => {
    const rows = month("2026-11-09");
    const v = buildAiSpendView(rows, "2026-11-10", null);
    expect(v.todayUsd).toBe(0);
    expect(v.bar.state).toBe("none");
    expect(v.rows).toHaveLength(29); // the 30th-oldest day falls out of the window
  });
  it("empty rows", () => {
    const v = buildAiSpendView([], "2026-11-10", 0);
    expect(v.todayUsd).toBe(0);
    expect(v.bar.state).toBe("over");
    expect(v.last30.usd).toBe(0);
  });
});

describe("page wiring", () => {
  const page = readFileSync(join(process.cwd(), "src/app/admin/ai-spend/page.tsx"), "utf8");
  it("404s non-admins before any data read, is dynamic and noindex", () => {
    expect(page).toMatch(/if \(!user \|\| !isAdminUser\(user\.id\)\) notFound\(\);/);
    expect(page.indexOf("notFound()")).toBeLessThan(page.indexOf("getAiSpendDaily(30)"));
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(page.startsWith('"use client"')).toBe(false);
  });
  it("view helpers stay pure (no server-only / db runtime import)", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/admin/ai-spend-view.ts"), "utf8");
    expect(src).not.toContain("server-only");
    expect(src).toMatch(/import type \{ AiSpendDay \} from "@\/lib\/db\/ai-spend"/);
    expect(src).not.toMatch(/^import \{[^}]*\} from "@\/lib\/db/m);
  });
});
