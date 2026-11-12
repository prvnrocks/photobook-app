// GET /api/ai/runs/[id] (D-025): progress of one of the caller's build / rebuild runs (RLS
// owner-scoped). Rewrite runs (M5 ✨) are 404 (M5 review B1).
// Responses (all no-store): 200 ProgressView { state, progress, aiStatus, errorCode, mode, done }
// | 401 { error: 'unauthenticated' } | 404 { error: 'not_found' } | 500 { error: 'server_error' }.
// Never returns the cursor, totals or step outputs.
import { type NextRequest } from "next/server";
import { getProgress } from "@/lib/ai/orchestrator";
import { getCurrentUser } from "@/lib/auth/current-user";
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

    const view = await getProgress(id);
    if (!view) return json({ error: "not_found" }, 404);
    return json({
      state: view.state,
      progress: view.progress,
      aiStatus: view.aiStatus,
      errorCode: view.errorCode,
      mode: view.mode,
      done: view.done,
    });
  } catch (err) {
    const unavailable = unavailableIfTimeout(err);
    if (unavailable) return unavailable;
    console.error(`[ai-runs] progress failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
