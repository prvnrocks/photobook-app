import "server-only";
// createUsageMeter(ctx): writes one ai_usage_ledger ledger row per LIVE model attempt reported by
// runAgentStep (Task 9). Replay attempts cost nothing and are not recorded. The cost bucket is
// resolved once per meter from the book's entitlement (preview / paid / other).
//
// Never throws: a ledger write that fails is logged as a code and the call itself is unaffected
// (the per-call detail tables — agent_steps, photo_analyses, story_ai_calls — still record it).

import { getEntitlementTier } from "@/lib/entitlements";
import { insertUsageRow, isMissingUsageObject, AiUsageError, type UsageRow } from "@/lib/db/ai-usage";
import { AI_OPERATIONS, costBucketFor, type AiOperation, type CostBucket, type UsageEvent, type UsageFlow, type UsageMeter } from "./types";

export type UsageContext = {
  userId: string | null;
  bookId: string | null;
  flow: UsageFlow;
  /** Fixed operation for every event (photo_analysis, plan, write, …); absent → the event's agent. */
  operation?: AiOperation;
  /** Known tier (skips the entitlement lookup). */
  tier?: "preview" | "full";
};

export type UsageMeterDeps = {
  insert?: (row: UsageRow) => Promise<void>;
  tierOf?: (bookId: string) => Promise<"preview" | "full">;
};

let warnedMissing = false;

export function createUsageMeter(ctx: UsageContext, deps: UsageMeterDeps = {}): UsageMeter {
  let bucket: Promise<CostBucket> | null = null;
  const bucketOf = () => {
    bucket ??= (async () => {
      const tier = ctx.tier ?? (ctx.bookId ? await (deps.tierOf ?? getEntitlementTier)(ctx.bookId) : "preview");
      return costBucketFor(ctx.flow, tier);
    })().catch(() => costBucketFor(ctx.flow, "preview"));
    return bucket;
  };
  return {
    async record(ev: UsageEvent): Promise<void> {
      if (ev.mode !== "live") return;
      try {
        const operation: AiOperation = ctx.operation ?? ((AI_OPERATIONS as readonly string[]).includes(ev.agent) ? (ev.agent as AiOperation) : "curator");
        await (deps.insert ?? insertUsageRow)({
          userId: ctx.userId,
          bookId: ctx.bookId,
          runId: ev.runId,
          operation,
          model: ev.model,
          mode: ev.mode,
          status: ev.status,
          attempt: ev.attempt,
          error: ev.error,
          usage: ev.usage,
          costUsd: ev.costUsd,
          priced: ev.priced,
          latencyMs: ev.latencyMs,
          bucket: await bucketOf(),
        });
      } catch (err) {
        const code = err instanceof AiUsageError ? err.code : undefined;
        if (isMissingUsageObject(code)) {
          if (!warnedMissing) console.error("[ai-usage] ledger_unavailable (migration 2900 missing)");
          warnedMissing = true;
          return;
        }
        console.error(`[ai-usage] record_failed (${(code ?? "unknown").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16)})`);
      }
    },
  };
}

/** Combines meters (e.g. a test spy + the real ledger). */
export function teeMeters(...meters: (UsageMeter | null | undefined)[]): UsageMeter {
  const list = meters.filter((m): m is UsageMeter => !!m);
  return { record: async (ev) => void (await Promise.all(list.map((m) => m.record(ev).catch(() => undefined)))) };
}
