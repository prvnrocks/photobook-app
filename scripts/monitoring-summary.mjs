#!/usr/bin/env node
// Production monitoring summary from a terminal (Task 10) — the same numbers as /admin/monitoring.
//
//   node scripts/monitoring-summary.mjs [--days 7] [--alerts]
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY from the environment (or .env.local) and
// queries ai_usage_ledger (live attempts), agent_runs (trigger 'storybook') and exports with the
// service role — codes, counts, money and timestamps only. Aggregation is the app's own pure module
// (src/lib/monitoring/aggregate.ts — no imports, erasable TypeScript only — loaded with Node's own
// type stripping: Node ≥ 23.6 as is, Node 22 with --experimental-strip-types). Prints one JSON object; with --alerts only the
// `[monitor] alert=<code> value=<n>` lines (exit code 2 when there is at least one alert).
// Never prints ids, titles, text, paths or keys.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
try {
  process.loadEnvFile(path.join(repo, ".env.local"));
} catch {
  /* env from the shell */
}

const args = process.argv.slice(2);
const daysArg = Number(args[args.indexOf("--days") + 1]);
const days = args.includes("--days") && Number.isInteger(daysArg) ? Math.min(31, Math.max(1, daysArg)) : 7;
const alertsOnly = args.includes("--alerts");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const { summarize, alertLogLines } = await import(path.join(repo, "src/lib/monitoring/aggregate.ts"));

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const now = new Date();
const since = new Date(now.getTime() - days * 86_400_000).toISOString();
const CAP = 20_000;
const [ledger, runs, exps] = await Promise.all([
  db.from("ai_usage_ledger").select("operation, status, error, cost_usd, cost_bucket, latency_ms, priced, created_at").eq("mode", "live").gte("created_at", since).limit(CAP),
  db.from("agent_runs").select("state, error_code, mode, started_at, finished_at").eq("trigger", "storybook").gte("started_at", since).limit(CAP),
  db.from("exports").select("status, error_code, created_at, finished_at, page_count").gte("created_at", since).limit(CAP),
]);
for (const [name, r] of [["runs", runs], ["exports", exps]]) {
  if (r.error) {
    console.error(`read ${name} failed (${r.error.code ?? "unknown"})`);
    process.exit(1);
  }
}
const budget = Number(process.env.AI_DAILY_BUDGET_USD);
const summary = summarize({
  windowDays: days,
  now,
  ledger: ledger.error ? null : ledger.data,
  runs: runs.data ?? [],
  exports: exps.data ?? [],
  dailyBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
});
if (alertsOnly) {
  const lines = alertLogLines(summary);
  for (const l of lines) console.log(l);
  process.exit(lines.length > 0 ? 2 : 0);
}
console.log(JSON.stringify(summary, null, 2));
