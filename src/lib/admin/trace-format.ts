// Pure formatting helpers for /admin/runs/[id] (D-027). No I/O.

/** "$0.0123" — 4 decimals; non-finite → "$0.0000". */
export function formatUsd(value: number | string | null | undefined): string {
  const n = Number(value);
  return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}

/** Integer with thousands separators ("12,345"); null → "—". */
export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

/** ISO → "2026-11-08 14:03:12 UTC"; null/invalid → "—". */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Duration between two ISO timestamps ("850 ms", "12.3 s", "4m 05s"); open run → "running". */
export function formatDuration(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): string {
  if (!startIso) return "—";
  if (!endIso) return "running";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** First 8 chars of a uuid; null → "—". */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

/** Sum of step costs, rounded to 4 decimals like agent_runs.total_cost_usd. */
export function sumStepCosts(steps: { cost_usd: number | string | null }[]): number {
  const total = steps.reduce((acc, s) => acc + (Number(s.cost_usd) || 0), 0);
  return Math.round(total * 10_000) / 10_000;
}

/** True when the run total differs from the step sum by more than 4-decimal rounding. */
export function costMismatch(runTotal: number | string | null, stepSum: number): boolean {
  const total = Number(runTotal) || 0;
  return Math.abs(total - stepSum) > 0.00005 + 1e-12;
}

const URL_LIKE = /^(https?:|data:|blob:)/i;

/**
 * Pretty-printed JSON for the trace view. Defence in depth for D-027: any
 * string value that looks like a URL / data URI is replaced, so photo links or
 * thumbnails never show up here even if a step logged one by mistake.
 */
export function prettyTraceJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(
      value,
      (_key, v: unknown) =>
        typeof v === "string" && URL_LIKE.test(v.trim()) ? "[url redacted]" : v,
      2,
    );
  } catch {
    return '"[unserialisable]"';
  }
}

export type ChipTone = "ok" | "warn" | "bad" | "neutral";

/** Colour family for a run state / ai_status / step status. */
export function statusTone(status: string | null | undefined): ChipTone {
  switch (status) {
    case "ok":
    case "done":
      return "ok";
    case "partial":
    case "skipped":
    case "refused":
    case "refusal":
    case "max_tokens":
      return "warn";
    case "failed":
    case "error":
      return "bad";
    default:
      return "neutral";
  }
}
