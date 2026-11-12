// POST /api/ai/runs/[id]/advance (D-022): run one resumable tick (≤40 s budget) of the caller's run.
// The progress screen loops this until `done`. Responses (all no-store):
//   200 { state, progress, done, aiStatus, errorCode }
//   202 { leased: true } + Retry-After: 2   — another tick holds the lease; poll again
//   401 | 403 | 404 { error: 'not_found' } (also for rewrite runs) | 500 { error: 'server_error' }
// Logs carry error codes only.
import { type NextRequest } from "next/server";
import { advance } from "@/lib/ai/orchestrator";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { getRunForOwner, isBuildRunTrigger } from "@/lib/db/agent-runs";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Ticks are soft-budgeted at 40 s, but a Storyteller tick can run up to LEASE_SECONDS (240 s);
// maxDuration (300) must stay ≥ LEASE_SECONDS. Requires Vercel Fluid compute.
export const maxDuration = 300;

const TICK_BUDGET_MS = 40_000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);

  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);

    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not_found" }, 404);

    // Ownership via RLS before advance(), which uses the admin client. Only build / rebuild runs
    // can be advanced: a ✨ rewrite run is 404 here (M5 review B1; advance() refuses it too).
    const owned = await getRunForOwner(id);
    if (!owned || !isBuildRunTrigger(owned.trigger)) return json({ error: "not_found" }, 404);

    const result = await advance(owned.id, { budgetMs: TICK_BUDGET_MS });
    if ("notFound" in result) return json({ error: "not_found" }, 404);
    if ("leased" in result) return json({ leased: true }, 202, { "retry-after": "2" });
    return json({
      state: result.state,
      progress: result.progress,
      done: result.done,
      aiStatus: result.aiStatus ?? null,
      errorCode: result.errorCode ?? null,
    });
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "ai-runs" });
    if (unavailable) return unavailable;
    console.error(`[ai-runs] advance failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
