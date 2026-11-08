// POST /api/ai/runs (D-022, D-025): start an AI build/rebuild for one of the caller's books.
// Body: { bookId: uuid, trigger?: 'build' | 'rebuild' } (default 'build').
// Responses (all no-store):
//   201 { runId, mode, state }                     — mode 'rule' runs synchronously (state done|failed)
//   400 { error: 'invalid_body' } | 401 | 403 | 404 { error: 'not_found' }
//   409 { error: 'already_running', runId | null } | 409 { error: 'user_edited' }
//   429 { error: 'limit', limit: 'daily_builds' | 'rebuilds' | 'analysed_photos' }
//   500 { error: 'server_error' }
// Logs carry error codes only — never ids, run data or photo data.
import { type NextRequest } from "next/server";
import { z } from "zod";
import { startRun } from "@/lib/ai/orchestrator";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { getActiveRunForBook } from "@/lib/db/agent-runs";
import { getMyBook } from "@/lib/db/books";
import { errorCodeOf, json } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Rule mode (AI off) curates + lays out synchronously inside this request.
export const maxDuration = 60;

const MAX_BODY_BYTES = 1024;

const BodySchema = z.object({
  bookId: z.string().max(64),
  trigger: z.enum(["build", "rebuild"]).default("build"),
});

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
    const { bookId, trigger } = parsed.data;

    if (!isUuid(bookId)) return json({ error: "not_found" }, 404);
    const book = await getMyBook(bookId);
    if (!book) return json({ error: "not_found" }, 404);

    const result = await startRun({ bookId: book.id, userId: user.id, trigger });
    if (result.ok) {
      return json({ runId: result.runId, mode: result.mode, state: result.state }, 201);
    }
    switch (result.error) {
      case "already_running": {
        const active = await getActiveRunForBook(book.id);
        return json({ error: "already_running", runId: active?.id ?? null }, 409);
      }
      case "user_edited":
        return json({ error: "user_edited" }, 409);
      case "limit":
        return json({ error: "limit", limit: result.limit ?? "daily_builds" }, 429);
      case "not_found":
      default:
        return json({ error: "not_found" }, 404);
    }
  } catch (err) {
    console.error(`[ai-runs] start failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
