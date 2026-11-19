// POST /api/books/[id]/story-rewrite (Task 8): the editor's "Rewrite story" for one page text of a
// composed storybook (src/lib/ai/story/rewrite-page-text.ts → Task 6 rewriteNarrativeBlock).
// Body: { blockRef: "b12", kind: "regenerate"|"shorter"|"longer"|"simpler"|"tone", tone?, text, source: "ai"|"user" }.
// Responses (all no-store):
//   200 { text, lang, proposal }   — proposal true: show Accept / Discard (user text is never replaced)
//   400 { error: 'invalid_body' } | 401 | 403 | 404 { error: 'not_found' }
//   409 { error: 'conflict' }                       — the story changed meanwhile; try again
//   422 { error: 'ungrounded' | 'invalid_instruction' }
//   429 { error: 'limit_reached' | 'budget_exhausted' }
//   503 { error: 'ai_unavailable' }                 — AI off / usage table missing / model failed
//   500 { error: 'server_error' }
// Logs carry error codes only — never the text.
import { type NextRequest } from "next/server";
import { z } from "zod";
import { REWRITE_KINDS } from "@/lib/ai/story/prompts";
import { rewritePageText } from "@/lib/ai/story/rewrite-page-text";
import { StoryError } from "@/lib/ai/story/service";
import { getCurrentUser } from "@/lib/auth/current-user";
import { rateLimitResponse } from "@/lib/http/rate-limit";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { STORY_TONES } from "@/lib/story/questions";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 8 * 1024;
const BodySchema = z.strictObject({
  blockRef: z.string().regex(/^b[1-9]\d{0,3}$/),
  kind: z.enum(REWRITE_KINDS),
  tone: z.enum(STORY_TONES).optional(),
  text: z.string().max(2000),
  source: z.enum(["ai", "user"]),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    // Task 9: per-user rate limit (429 + Retry-After) before any work
    const limited = await rateLimitResponse("story_rewrite", user.id);
    if (limited) return limited;
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not_found" }, 404);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "invalid_body" }, 400);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_body" }, 400);
    const b = parsed.data;
    const result = await rewritePageText({ bookId: id, blockRef: b.blockRef, text: b.text, source: b.source, instruction: { kind: b.kind, ...(b.tone ? { tone: b.tone } : {}) } });
    return json(result);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "story-rewrite" });
    if (unavailable) return unavailable;
    if (err instanceof StoryError) {
      switch (err.code) {
        case "not_found":
          return json({ error: "not_found" }, 404);
        case "conflict":
          return json({ error: "conflict" }, 409);
        case "ungrounded":
        case "invalid_instruction":
        case "protected":
          return json({ error: err.code === "protected" ? "invalid_instruction" : err.code }, 422);
        case "limit_reached":
        case "budget_exhausted":
          return json({ error: err.code }, 429);
        default:
          console.error(`[story-rewrite] ai unavailable (${err.code})`);
          return json({ error: "ai_unavailable" }, 503);
      }
    }
    console.error(`[story-rewrite] failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
