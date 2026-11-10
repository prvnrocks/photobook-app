// Internal AI spend dashboard (D-059). Only for users listed in ADMIN_USER_IDS; everyone else
// (signed out included) gets a plain 404 so the page's existence is never revealed.
// Shows aggregated per-day numbers only — no book titles, ids or emails.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isAdminUser } from "@/lib/auth/is-admin";
import { readDailyBudgetUsd } from "@/lib/ai/limits";
import {
  buildAiSpendView,
  formatCount,
  formatSpendUsd,
  type AiSpendView,
  type BudgetState,
  type SpendTotals,
} from "@/lib/admin/ai-spend-view";
import { dubaiDay, getAiSpendDaily, type AiSpendDay } from "@/lib/db/ai-spend";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI spend",
  robots: { index: false, follow: false },
};

const BAR_CLASS: Record<BudgetState, string> = {
  none: "bg-muted-foreground/40",
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  over: "bg-red-600",
};

function TodayCard({ view }: { view: AiSpendView }) {
  const { todayUsd, budgetUsd, bar, today } = view;
  return (
    <section className="mb-6 rounded-xl border p-4" aria-labelledby="ai-spend-today">
      <h2 id="ai-spend-today" className="text-sm text-muted-foreground">
        Today ({today}, Dubai)
      </h2>
      <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="ai-spend-today">
        {formatSpendUsd(todayUsd)}
        <span className="ml-2 text-base font-normal text-muted-foreground">
          {budgetUsd === null ? "· no budget set" : `of ${formatSpendUsd(budgetUsd)}`}
        </span>
      </p>
      {budgetUsd !== null ? (
        <>
          <div
            className="mt-3 h-3 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Today's spend against the daily budget"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={bar.percent}
            data-testid="ai-spend-bar"
            data-state={bar.state}
          >
            <div className={`h-full ${BAR_CLASS[bar.state]}`} style={{ width: `${bar.percent}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {bar.state === "over"
              ? budgetUsd === 0
                ? "Budget is 0 — new AI runs and rewrites are switched off."
                : "Budget reached — new AI runs and rewrites are refused until Dubai midnight."
              : `${bar.percent}% of today's budget used.`}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          AI_DAILY_BUDGET_USD is not set (or invalid), so AI spend is unlimited.
        </p>
      )}
    </section>
  );
}

function TotalCard({ label, totals, testId }: { label: string; totals: SpendTotals; testId: string }) {
  return (
    <div className="rounded-xl border p-4" data-testid={testId}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{formatSpendUsd(totals.usd)}</p>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        {formatCount(totals.runs)} runs · {formatCount(totals.failed)} failed
      </p>
    </div>
  );
}

const COLUMNS: { label: string; cell: (r: AiSpendDay) => string }[] = [
  { label: "USD", cell: (r) => formatSpendUsd(r.usd) },
  { label: "Runs", cell: (r) => formatCount(r.runs) },
  { label: "Failed", cell: (r) => formatCount(r.failed) },
  { label: "Build USD", cell: (r) => formatSpendUsd(r.buildUsd) },
  { label: "Rewrite USD", cell: (r) => formatSpendUsd(r.rewriteUsd) },
  { label: "Runs without book", cell: (r) => formatCount(r.nullBookRuns) },
];

function DailyTable({ rows }: { rows: AiSpendDay[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data for the last 30 days.</p>;
  }
  return (
    <>
      {/* ≥ sm: a real table */}
      <div className="hidden overflow-x-auto rounded-xl border sm:block">
        <table className="w-full text-sm tabular-nums" data-testid="ai-spend-table">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Date
              </th>
              {COLUMNS.map((c) => (
                <th key={c.label} scope="col" className="px-3 py-2 text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.day} className="border-t">
                <th scope="row" className="px-3 py-2 text-left font-mono font-normal">
                  {r.day}
                </th>
                {COLUMNS.map((c) => (
                  <td key={c.label} className="px-3 py-2 text-right">
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* < sm (375 px): one card per day */}
      <ul className="space-y-2 sm:hidden" data-testid="ai-spend-cards">
        {rows.map((r) => (
          <li key={r.day} className="rounded-xl border p-3">
            <p className="mb-2 font-mono text-sm font-semibold">{r.day}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
              {COLUMNS.map((c) => (
                <div key={c.label} className="flex min-w-0 justify-between gap-2">
                  <dt className="text-muted-foreground">{c.label}</dt>
                  <dd className="text-right">{c.cell(r)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function AdminAiSpendPage() {
  const user = await getCurrentUser();
  if (!user || !isAdminUser(user.id)) notFound();

  const today = dubaiDay(Date.now());
  const budgetUsd = readDailyBudgetUsd();
  let rows: AiSpendDay[] | null = null;
  let errorCode: string | null = null;
  try {
    rows = await getAiSpendDaily(30);
  } catch (err) {
    errorCode = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "unknown";
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-xl font-semibold" data-testid="ai-spend-heading">
        AI spend
      </h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Sum of AI run costs per Asia/Dubai day (all users, all books).
      </p>

      {rows === null ? (
        <div
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
          data-testid="ai-spend-error"
        >
          Couldn&apos;t load AI spend ({errorCode}). Try reloading the page.
        </div>
      ) : (
        <AiSpendContent view={buildAiSpendView(rows, today, budgetUsd)} />
      )}

      <p className="mt-6 text-sm">
        <Link href="/dashboard" className="inline-flex min-h-11 items-center underline">
          Back to dashboard
        </Link>
      </p>
    </main>
  );
}

function AiSpendContent({ view }: { view: AiSpendView }) {
  return (
    <>
      <TodayCard view={view} />
      <div className="mb-6 grid grid-cols-2 gap-3">
        <TotalCard label="Last 7 days" totals={view.last7} testId="ai-spend-7d" />
        <TotalCard label="Last 30 days" totals={view.last30} testId="ai-spend-30d" />
      </div>
      <h2 className="mb-3 text-lg font-semibold">Last 30 days</h2>
      <DailyTable rows={view.rows} />
    </>
  );
}
