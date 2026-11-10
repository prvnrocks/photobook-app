// Pure view helpers for /admin/ai-spend (D-059). No I/O, no ids/titles/emails — only the
// aggregated per-day numbers from getAiSpendDaily (src/lib/db/ai-spend.ts).
import type { AiSpendDay } from "@/lib/db/ai-spend";

export type SpendTotals = {
  usd: number;
  runs: number;
  failed: number;
  buildUsd: number;
  rewriteUsd: number;
  nullBookRuns: number;
};

export type BudgetState = "none" | "ok" | "warn" | "over";

export type BudgetBar = {
  state: BudgetState;
  /** Bar fill 0..100 (0 when there is no budget). */
  percent: number;
};

export type AiSpendView = {
  today: string;
  todayUsd: number;
  budgetUsd: number | null;
  bar: BudgetBar;
  last7: SpendTotals;
  last30: SpendTotals;
  /** Rows within the 30-day window, newest first. */
  rows: AiSpendDay[];
};

/** Fraction of the budget at which the bar turns amber. */
export const BUDGET_WARN_RATIO = 0.8;

const DAY_MS = 86_400_000;

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** "$0.00", "$0.0123", "$12.5", "$1,234.5678" — 2 to 4 decimals; non-finite → "$0.00". */
export function formatSpendUsd(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  return n < 0 && s !== "0.00" ? `-$${s}` : `$${s}`;
}

/** Integer count with thousands separators; non-finite → "0". */
export function formatCount(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  return n.toLocaleString("en-US");
}

/** YYYY-MM-DD shifted by `delta` calendar days; invalid input → "". */
export function shiftDay(day: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return "";
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + delta * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Rows whose day lies in the `days`-day window ending on `today` (inclusive), newest first. */
export function rowsInWindow(rows: readonly AiSpendDay[], today: string, days: number): AiSpendDay[] {
  const from = shiftDay(today, -(Math.max(1, Math.floor(days)) - 1));
  if (!from) return [];
  return rows
    .filter((r) => r.day >= from && r.day <= today)
    .slice()
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** Sum of the given rows. */
export function sumSpend(rows: readonly AiSpendDay[]): SpendTotals {
  const t: SpendTotals = { usd: 0, runs: 0, failed: 0, buildUsd: 0, rewriteUsd: 0, nullBookRuns: 0 };
  for (const r of rows) {
    t.usd += finite(r.usd);
    t.runs += finite(r.runs);
    t.failed += finite(r.failed);
    t.buildUsd += finite(r.buildUsd);
    t.rewriteUsd += finite(r.rewriteUsd);
    t.nullBookRuns += finite(r.nullBookRuns);
  }
  // Avoid float noise like 0.30000000000000004 in totals (costs are stored to 6 decimals).
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  t.usd = round(t.usd);
  t.buildUsd = round(t.buildUsd);
  t.rewriteUsd = round(t.rewriteUsd);
  return t;
}

/**
 * Budget bar for today's spend. Mirrors isOverDailyBudget: spend ≥ budget is "over", so a budget
 * of 0 (kill switch) is always over and full. No budget → "none", empty bar.
 */
export function budgetBar(spendUsd: number, budgetUsd: number | null): BudgetBar {
  if (budgetUsd === null || !Number.isFinite(budgetUsd) || budgetUsd < 0) {
    return { state: "none", percent: 0 };
  }
  const spend = Number.isFinite(spendUsd) && spendUsd > 0 ? spendUsd : 0;
  if (spend >= budgetUsd) return { state: "over", percent: 100 };
  const ratio = spend / budgetUsd;
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 1000) / 10));
  return { state: ratio >= BUDGET_WARN_RATIO ? "warn" : "ok", percent };
}

/** Everything the page renders, from the 30-day rows, today's Dubai day and the budget. */
export function buildAiSpendView(
  rows: readonly AiSpendDay[],
  today: string,
  budgetUsd: number | null,
): AiSpendView {
  const last30Rows = rowsInWindow(rows, today, 30);
  const todayUsd = finite(last30Rows.find((r) => r.day === today)?.usd ?? 0);
  return {
    today,
    todayUsd,
    budgetUsd,
    bar: budgetBar(todayUsd, budgetUsd),
    last7: sumSpend(rowsInWindow(rows, today, 7)),
    last30: sumSpend(last30Rows),
    rows: last30Rows,
  };
}
