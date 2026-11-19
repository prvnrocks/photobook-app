// GET /api/ai/story-runs/[id] (Task 8): the caller's storybook job as StoryRunView (RLS
// owner-scoped; progress counts + state + error code, never the cursor or costs). Other run kinds
// are 404. Responses (no-store): 200 view | 401 | 404 { error: 'not_found' } | 503 | 500.
import { type NextRequest } from "next/server";
import { storyRunView } from "@/lib/ai/story/run";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getStoryRunForOwner } from "@/lib/db/agent-runs";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not_found" }, 404);
    const run = await getStoryRunForOwner(id);
    if (!run) return json({ error: "not_found" }, 404);
    return json(storyRunView(run));
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "story-runs" });
    if (unavailable) return unavailable;
    console.error(`[story-runs] status failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
