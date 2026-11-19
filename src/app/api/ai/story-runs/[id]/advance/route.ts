// POST /api/ai/story-runs/[id]/advance (Task 8): one resumable tick of the caller's storybook job
// (src/lib/ai/story/run.ts). The Create step / regenerate sheet loops it until `done`.
//   200 StoryRunView
//   202 { leased: true } + Retry-After: 2 — another tick holds the lease (second tab, a slow tick)
//   429 { error: 'rate_limited' } + Retry-After — Task 9: too many ticks by this user
//   401 | 403 | 404 { error: 'not_found' } (also for other run kinds) | 503 | 500
// A tick does ONE unit of model work at most past its 40 s soft budget (one plan, one chapter, one
// composition, or analysis batches); the lease (240 s) is the hard bound, so maxDuration must stay
// ≥ it (Vercel Fluid compute). Logs carry error codes only.
import { type NextRequest } from "next/server";
import { advanceStoryRun, STORY_TICK_BUDGET_MS } from "@/lib/ai/story/run";
import { storyTimingOn } from "@/lib/ai/story/tick-timing";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { getStoryRunForOwner } from "@/lib/db/agent-runs";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { rateLimitResponse } from "@/lib/http/rate-limit";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);
  const t0 = performance.now();
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { id } = await params;
    // Task 9: a runaway client loop is cut off (429 + Retry-After); a normal job ticks far below it.
    // Ownership via RLS before the tick (which writes with the admin client). Both reads go out
    // together (one round trip less per tick); a limited call still never reaches the tick.
    const [limited, owned] = await Promise.all([rateLimitResponse("story_tick", user.id), isUuid(id) ? getStoryRunForOwner(id) : Promise.resolve(null)]);
    if (limited) return limited;
    if (!owned) return json({ error: "not_found" }, 404);
    // STORY_TICK_TIMING=1 (local measurement): auth + rate limit + ownership time before the tick.
    if (storyTimingOn()) console.info(`[story-timing] route prelude=${Math.round(performance.now() - t0)}`);
    const result = await advanceStoryRun(owned.id, { budgetMs: STORY_TICK_BUDGET_MS });
    if ("notFound" in result) return json({ error: "not_found" }, 404);
    if ("leased" in result) return json({ leased: true }, 202, { "retry-after": "2" });
    return json(result.view);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "story-runs" });
    if (unavailable) return unavailable;
    console.error(`[story-runs] advance failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
