// POST /api/ai/story-runs/[id]/cancel (Task 8): "Stop". The caller's running storybook job becomes
// failed with error_code 'cancelled' at once; a tick still running loses its lease and stops before
// any further model call or doc write (the composed doc is saved only while the job holds its
// lease). Finished stages stay stored, so "Try again" continues from where it stopped. A finished
// job is returned unchanged (idempotent: a double tap is harmless).
//   200 StoryRunView | 401 | 403 | 404 { error: 'not_found' } | 503 | 500
import { type NextRequest } from "next/server";
import { cancelStoryRun } from "@/lib/ai/story/run";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { getStoryRunForOwner } from "@/lib/db/agent-runs";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not_found" }, 404);
    const owned = await getStoryRunForOwner(id);
    if (!owned) return json({ error: "not_found" }, 404);
    const result = await cancelStoryRun(owned.id);
    if ("notFound" in result) return json({ error: "not_found" }, 404);
    return json(result.view);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "story-runs" });
    if (unavailable) return unavailable;
    console.error(`[story-runs] cancel failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
