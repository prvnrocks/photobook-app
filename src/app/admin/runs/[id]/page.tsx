// Internal AI run trace (D-027). Only for users listed in ADMIN_USER_IDS;
// everyone else (signed out included) gets a plain 404 so the page's existence
// is never revealed. Shows ids, statuses, tokens, costs and the logged step
// JSON (which by D-027 holds ids/keep/reason/quality only) — never photo URLs
// or thumbnails.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isAdminUser } from "@/lib/auth/is-admin";
import {
  costMismatch,
  formatDuration,
  formatInt,
  formatTimestamp,
  formatUsd,
  prettyTraceJson,
  shortId,
  statusTone,
  sumStepCosts,
  type ChipTone,
} from "@/lib/admin/trace-format";
import { getRunTrace } from "@/lib/db/agent-runs";
import type { Tables } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Run trace",
  robots: { index: false, follow: false },
};

type PageProps = { params: Promise<{ id: string }> };

const TONE_CLASS: Record<ChipTone, string> = {
  ok: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  bad: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  neutral: "bg-muted text-muted-foreground",
};

function Chip({ value, testId }: { value: string | null; testId?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[statusTone(value)]}`}
      data-testid={testId}
    >
      {value ?? "—"}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-mono text-sm">{children}</dd>
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="rounded-lg border">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm">{label}</summary>
      <pre className="max-h-80 overflow-auto border-t bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {prettyTraceJson(value)}
      </pre>
    </details>
  );
}

function StepCard({ step }: { step: Tables<"agent_steps"> }) {
  return (
    <li className="rounded-xl border p-3" data-testid="trace-step">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold">{step.agent}</span>
        <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
          {step.step_key} #{step.attempt}
        </span>
        <span className="ml-auto">
          <Chip value={step.status} />
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="Stop reason">{step.stop_reason ?? "—"}</Field>
        <Field label="Model">{step.model ?? "—"}</Field>
        <Field label="Tokens in / out">
          {formatInt(step.input_tokens)} / {formatInt(step.output_tokens)}
        </Field>
        <Field label="Cache read / write">
          {formatInt(step.cache_read_tokens)} / {formatInt(step.cache_write_tokens)}
        </Field>
        <Field label="Cost">{formatUsd(step.cost_usd)}</Field>
        <Field label="Latency">
          {step.latency_ms === null ? "—" : `${formatInt(step.latency_ms)} ms`}
        </Field>
        <Field label="Error">{step.error ?? "—"}</Field>
        <Field label="Logged">{formatTimestamp(step.created_at)}</Field>
      </dl>
      <div className="mt-3 space-y-2">
        <JsonBlock label="input_summary" value={step.input_summary} />
        <JsonBlock label="output" value={step.output} />
      </div>
    </li>
  );
}

export default async function AdminRunTracePage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user || !isAdminUser(user.id)) notFound();

  const { id } = await params;
  if (!isUuid(id)) notFound();

  const trace = await getRunTrace(id);
  if (!trace) notFound();

  const { run, steps } = trace;
  const stepSum = sumStepCosts(steps);
  const mismatch = costMismatch(run.total_cost_usd, stepSum);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-xl font-semibold" data-testid="trace-heading">
        Run trace
      </h1>
      <p className="mb-4 break-all font-mono text-xs text-muted-foreground">{run.id}</p>

      <section className="mb-6 rounded-xl border p-4" aria-labelledby="run-summary">
        <h2 id="run-summary" className="sr-only">
          Run summary
        </h2>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Chip value={run.state} testId="trace-state" />
          <Chip value={run.ai_status} />
          <span className="text-sm text-muted-foreground">
            {run.mode} · {run.trigger}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Field label="Book">{shortId(run.book_id)}</Field>
          <Field label="Error code">{run.error_code ?? "—"}</Field>
          <Field label="Attempts">{formatInt(run.attempts)}</Field>
          <Field label="Started">{formatTimestamp(run.started_at)}</Field>
          <Field label="Finished">{formatTimestamp(run.finished_at)}</Field>
          <Field label="Duration">{formatDuration(run.started_at, run.finished_at)}</Field>
          <Field label="Total cost">{formatUsd(run.total_cost_usd)}</Field>
          <Field label="Input tokens">{formatInt(run.total_input_tokens)}</Field>
          <Field label="Output tokens">{formatInt(run.total_output_tokens)}</Field>
          <Field label="Critic score">{run.critic_score ?? "—"}</Field>
          <Field label="Steps">{formatInt(steps.length)}</Field>
          <Field label="Sum of step costs">{formatUsd(stepSum)}</Field>
        </dl>
        {mismatch ? (
          <p
            className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            data-testid="trace-cost-mismatch"
          >
            Run total {formatUsd(run.total_cost_usd)} differs from the sum of step costs{" "}
            {formatUsd(stepSum)}.
          </p>
        ) : null}
      </section>

      <h2 className="mb-3 text-lg font-semibold">Steps</h2>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No steps logged yet.</p>
      ) : (
        <ol className="space-y-3">
          {steps.map((step) => (
            <StepCard key={step.id} step={step} />
          ))}
        </ol>
      )}
    </main>
  );
}
