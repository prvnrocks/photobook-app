// POST /api/ai/story-runs (Task 8): start the storybook generation job of one of the caller's books
// — the wizard's Create step (automatic first draft), its "Try again" (a new run that resumes the
// finished stages of the stopped one) and the editor's "Regenerate story".
// Body: { bookId: uuid }. One active job per book (create_agent_run_capped + the unique index):
// a repeated click / a second tab gets 409 already_running with the running job's id — never a
// second job. AI off, over the daily budget or out of AI builds today → the job still runs, without
// AI (mode 'rule'); the finished book says so.
// Responses (all no-store):
//   201 { runId, mode, view }                              — view = StoryRunView (progress, no %)
//   400 { error: 'invalid_body' } | 401 | 403 | 404 { error: 'not_found' }
//   409 { error: 'already_running', runId | null }          — runId null: an album build is running
//   409 { error: 'user_edited' } | 409 { error: 'no_photos' }
//   422 { error: 'unsupported_design' }
//   503 { error: 'story_unavailable' }                      — migration 2800 missing (nothing written)
//   500 { error: 'server_error' }
// Logs carry error codes only.
import { type NextRequest } from "next/server";
import { z } from "zod";
import { startStoryRun } from "@/lib/ai/story/run";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { AgentRunsQueryError, getLatestStoryRunForBook } from "@/lib/db/agent-runs";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 512;
const BodySchema = z.strictObject({ bookId: z.string().max(64) });
/** check_violation / undefined column-value: the database doesn't know trigger 'storybook' yet. */
const MISSING_MIGRATION_CODES = new Set(["23514"]);

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "invalid_body" }, 400);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) return json({ error: "invalid_body" }, 400);
    const { bookId } = parsed.data;
    if (!isUuid(bookId)) return json({ error: "not_found" }, 404);

    const result = await startStoryRun({ bookId, userId: user.id });
    if (result.ok) return json({ runId: result.runId, mode: result.mode, view: result.view }, 201);
    switch (result.error) {
      case "already_running": {
        const latest = await getLatestStoryRunForBook(bookId);
        const active = latest && latest.state !== "done" && latest.state !== "failed" ? latest.id : null;
        return json({ error: "already_running", runId: active }, 409);
      }
      case "user_edited":
      case "no_photos":
        return json({ error: result.error }, 409);
      case "unsupported_design":
        return json({ error: "unsupported_design" }, 422);
      default:
        return json({ error: "not_found" }, 404);
    }
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "story-runs" });
    if (unavailable) return unavailable;
    if (err instanceof AgentRunsQueryError && err.code && MISSING_MIGRATION_CODES.has(err.code)) {
      console.error("[story-runs] start refused (migration_missing)");
      return json({ error: "story_unavailable" }, 503);
    }
    console.error(`[story-runs] start failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
