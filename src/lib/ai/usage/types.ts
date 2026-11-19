// AI usage ledger types (Task 9). Pure: no SDK, no DB, no secrets.
//
// One UsageEvent = one model ATTEMPT (runAgentStep records a "retried" event for every attempt it
// retries and one final event). It carries numbers and codes only — never a prompt, an answer, a
// description, a caption, narrative text, a path or a signed URL.

import type { TokenUsage } from "@/lib/ai/transport";

/** What the call was for (= public.ai_usage_ledger.operation, migration 2900). */
export const AI_OPERATIONS = ["curator", "storyteller", "caption_writer", "critic", "rewriter", "memory_keeper", "photo_analysis", "plan", "write", "repair", "rewrite", "compose"] as const;
export type AiOperation = (typeof AI_OPERATIONS)[number];

/**
 * Which budget the spend belongs to:
 *   preview  storybook AI work on a book without a full entitlement (the free preview)
 *   paid     any AI work on a book with a full entitlement (paid / comped / granted)
 *   other    the classic album pipeline on a free book (and anything unattributed)
 */
export const COST_BUCKETS = ["preview", "paid", "other"] as const;
export type CostBucket = (typeof COST_BUCKETS)[number];

export const USAGE_STATUSES = ["ok", "failed", "refused", "retried"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

export type UsageFlow = "storybook" | "album";
export type EntitlementTierLike = "preview" | "full";

export function costBucketFor(flow: UsageFlow, tier: EntitlementTierLike): CostBucket {
  if (tier === "full") return "paid";
  return flow === "storybook" ? "preview" : "other";
}

export type UsageEvent = {
  /** The runAgentStep agent (curator, storyteller, …); the meter maps it to an operation. */
  agent: string;
  /** runAgentStep's run id (agent run, photo id or story run id) — an id, never content. */
  runId: string | null;
  /** The model that answered (or was asked, when nothing came back). */
  model: string;
  mode: "live" | "replay";
  status: UsageStatus;
  /** 1-based attempt of this call (a retried attempt n is followed by attempt n + 1). */
  attempt: number;
  /** Error code (status ≠ ok), e.g. "rate_limited", "timeout", "refusal", "schema_invalid". */
  error: string | null;
  usage: TokenUsage;
  costUsd: number;
  /** False when the model had no configured price (costed at the highest known rate). */
  priced: boolean;
  latencyMs: number;
};

/** Receives usage events. Implementations must never throw (best effort, codes-only logging). */
export interface UsageMeter {
  record(ev: UsageEvent): Promise<void>;
}

/** A ledger error code: lower-case letters and underscores, 3–40 chars (DB check). */
export function usageErrorCode(code: string | null | undefined): string {
  const c = String(code ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z_]/g, "_")
    .slice(0, 40);
  return c.length >= 3 ? c : c.padEnd(3, "_");
}
