// Production monitoring (Task 10). Only for users listed in ADMIN_USER_IDS; everyone else (signed
// out included) gets a plain 404. Numbers and codes only: AI attempt failure / refusal / retry rates
// per operation, storybook stage + run times (p50 / p95), live AI cost per Dubai day by bucket,
// export failures and times, and the alert codes the daily cron logs. `?days=1..31` (default 7).
// The same data as JSON: /api/admin/monitoring; from a terminal: scripts/monitoring-summary.mjs.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isAdminUser } from "@/lib/auth/is-admin";
import type { MonitoringSummary, Pct } from "@/lib/monitoring/aggregate";
import { clampDays, getMonitoringSummary } from "@/lib/monitoring/summary";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Monitoring", robots: { index: false, follow: false } };

const ms = (v: number | null) => (v === null ? "–" : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);
const pctText = (p: Pct) => (p.n === 0 ? "no data" : `p50 ${ms(p.p50Ms)} · p95 ${ms(p.p95Ms)} (n=${p.n})`);
const rate = (r: number | null) => (r === null ? "–" : `${(r * 100).toFixed(1)} %`);
const money = (n: number) => `$${n.toFixed(2)}`;
const codes = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ×${v}`)
    .join(", ") || "none";

function Card({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="rounded-xl border p-4" data-testid={testId}>
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <div className="flex flex-col gap-1 text-sm break-words">{children}</div>
    </section>
  );
}

function Body({ s }: { s: MonitoringSummary }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Alerts" testId="monitor-alerts">
        {s.alerts.length === 0 ? <p>No alerts in this window.</p> : s.alerts.map((a) => <p key={a.code}>{`${a.code} — ${a.value}`}</p>)}
        {s.notes.length > 0 ? <p className="text-muted-foreground">Notes: {s.notes.join(", ")}</p> : null}
      </Card>
      <Card title="AI calls (live attempts)" testId="monitor-ai">
        {s.ai === null ? (
          <p>The usage ledger is not available (migration 2900).</p>
        ) : (
          <>
            <p>
              {s.ai.attempts} attempts · failed {s.ai.failed} · refused {s.ai.refused} · retried {s.ai.retried} · unpriced {s.ai.unpriced}
            </p>
            <p>
              Failure rate {rate(s.ai.failureRate)} · refusals {rate(s.ai.refusalRate)} · retries {rate(s.ai.retryRate)}
            </p>
            <p>Error codes: {codes(s.ai.errors)}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {Object.entries(s.ai.byOperation).map(([op, o]) => (
                <li key={op}>
                  <span className="font-medium">{op}</span>: {o.attempts} · failed {o.failed} · refused {o.refused} · {money(o.usd)} · {pctText(o)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <Card title="Storybook generation" testId="monitor-runs">
        <p>
          {s.runs.started} runs · done {s.runs.done} · failed {s.runs.failed} · stopped {s.runs.cancelled} · active {s.runs.active} · failure rate {rate(s.runs.failureRate)}
        </p>
        <p>Whole run: {pctText(s.runs.duration)}</p>
        {s.stages
          ? Object.entries(s.stages).map(([stage, p]) => (
              <p key={stage}>
                {stage} (per model call): {pctText(p)}
              </p>
            ))
          : null}
        <p>Failure codes: {codes(s.runs.failureCodes)}</p>
      </Card>
      <Card title="Live AI cost per day (Dubai)" testId="monitor-cost">
        {s.costPerDay === null || s.costPerDay.length === 0 ? (
          <p>No live AI cost in this window.</p>
        ) : (
          s.costPerDay.map((d) => (
            <p key={d.day} className="tabular-nums">
              {d.day}: {money(d.total)} (preview {money(d.preview)} · paid {money(d.paid)} · other {money(d.other)})
            </p>
          ))
        )}
      </Card>
      <Card title="PDF exports" testId="monitor-exports">
        <p>
          {s.exports.started} started · ready {s.exports.ready} · superseded {s.exports.superseded} · failed {s.exports.failed} · active {s.exports.active} · failure rate{" "}
          {rate(s.exports.failureRate)}
        </p>
        <p>Request → ready: {pctText(s.exports.duration)}</p>
        <p>Failure codes: {codes(s.exports.failureCodes)}</p>
      </Card>
    </div>
  );
}

export default async function MonitoringPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isAdminUser(user.id)) notFound();
  const days = clampDays((await searchParams).days);
  let summary: MonitoringSummary | null = null;
  try {
    summary = await getMonitoringSummary(days);
  } catch {
    summary = null;
  }
  return (
    <main className="mx-auto w-full max-w-3xl p-4" data-testid="admin-monitoring">
      <h1 className="mb-1 text-xl font-semibold">Monitoring</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Last {days} {days === 1 ? "day" : "days"}. Numbers and codes only.
      </p>
      {summary ? <Body s={summary} /> : <p data-testid="monitor-error">Could not load the numbers — try again.</p>}
    </main>
  );
}
