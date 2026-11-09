// POST /api/ai/rewrite (M5 Task 7, D-037 #1/#6/#8): ✨ rewrite ONE caption.
// Body: { bookId: uuid, pageId: string, instruction: RewriteInstruction, text: 1..200 code points }
// (instruction: rewrite | shorter | translate | tone:<Tone>).
// The route never writes the doc: the editor shows the result and, if the user accepts it,
// saves it as a `user` caption through PUT /api/books/[id]/doc (D-037 #1).
//
// Server-side only: book ownership (getMyBook, RLS), paid status → cap (books.is_paid), the
// page's photo notes from the SAVED doc (admin read after the ownership check, never from the
// client; a page missing from the saved doc → no notes), the target language, and user memory.
// Limits (D-037 #6): one rewrite in flight per book; only successful rewrites count. The cap is
// a product limit, so it is enforced in replay mode too (replay in production is opt-in, D-024).
//
// Responses (all no-store):
//   200 { text, lang, remaining }   remaining = cap − successful rewrites (null if the count failed)
//   400 { error: 'invalid_body' }   401 { error: 'unauthenticated' }   403 { error: 'forbidden' }
//   404 { error: 'not_found' }      409 { error: 'already_running' }
//   429 { error: 'limit', remaining: 0 }
//   502 { error: <RewriteErrorCode>, retryable }  — not counted; run finished 'failed'
//   503 { error: 'ai_off' }         500 { error: 'server_error' }
// Privacy (D-027): logs and agent_runs carry error codes only — never caption text, photo
// notes, memory values or ids.
import { type NextRequest } from "next/server";
import { resolveAiMode } from "@/lib/ai/client";
import { rewriteCaption } from "@/lib/ai/agents/rewriter";
import { limitsFor } from "@/lib/ai/limits";
import { sanitizeMemory } from "@/lib/ai/memory";
import { analysisOf } from "@/lib/ai/orchestrator";
import { pagePhotoIds, REWRITE_MAX_BODY_BYTES, RewriteBodySchema, rewriteTargetLang } from "@/lib/ai/rewrite-request";
import type { UserMemory } from "@/lib/ai/schemas";
import { getTransport } from "@/lib/ai/transport-factory";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { CAPTION_LANGS, DEFAULT_TONE, OCCASIONS, TONES, type CaptionLang, type Occasion, type Tone } from "@/lib/book/options";
import { parseBookDoc } from "@/lib/book/schema";
import { createRewriteRun, finishRewriteRun, getRewritesUsed, stepLogger } from "@/lib/db/agent-runs";
import { getMyBook } from "@/lib/db/books";
import { getUserMemoryAdmin } from "@/lib/db/memory";
import { getPhotoNotesAdmin } from "@/lib/db/photo-notes";
import { errorCodeOf, json } from "@/lib/http/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Worst case inside rewriteCaption: attempt 1 (15 s timeout + 1 s backoff + 15 s retry) +
// attempt 2 (15 s; its transport retry is cut by the deadline) ≈ 46 s, plus a few DB calls.
export const maxDuration = 60;

/** Transport retries may only start while they can finish before this budget (ms from start). */
const RETRY_DEADLINE_MS = 45_000;

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);

  const startedAt = Date.now();
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);

    const raw = await request.text();
    if (raw.length > REWRITE_MAX_BODY_BYTES) return json({ error: "invalid_body" }, 400);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const parsed = RewriteBodySchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_body" }, 400);
    const { bookId, pageId, instruction, text } = parsed.data;

    const book = await getMyBook(bookId);
    if (!book) return json({ error: "not_found" }, 404);

    const mode = resolveAiMode();
    const transport = mode === "off" ? null : getTransport(mode);
    if (mode === "off" || !transport) return json({ error: "ai_off" }, 503);

    // Server-side context (never from the client).
    const savedDoc = parseBookDoc(book.doc);
    const doc = savedDoc.ok ? savedDoc.doc : null;
    const photoIds = pagePhotoIds(doc, pageId) ?? [];
    const occasion = pick<Occasion>(book.occasion, OCCASIONS, "other");
    const captionLang = pick<CaptionLang>(book.caption_lang, CAPTION_LANGS, "en");
    const [notes, memory] = await Promise.all([loadNotes(book.id, photoIds), loadMemory(user.id)]);
    const cap = limitsFor(book.is_paid === true).maxCaptionRewrites;

    const created = await createRewriteRun(book.id, user.id, mode, cap, true);
    if ("error" in created) {
      if (created.error === "limit") return json({ error: "limit", remaining: 0 }, 429);
      if (created.error === "already_running") return json({ error: "already_running" }, 409);
      return json({ error: "not_found" }, 404);
    }
    const runId = created.id;

    // The run is ALWAYS finished (finally), also when rewriteCaption or the logger throws.
    let ok = false;
    let errorCode = "server_error";
    let result: Awaited<ReturnType<typeof rewriteCaption>>;
    try {
      result = await rewriteCaption({
        ctx: {
          transport,
          logger: stepLogger(runId),
          retry: { retries: 1, deadline: startedAt + RETRY_DEADLINE_MS },
        },
        runId,
        input: {
          text,
          instruction,
          targetLang: rewriteTargetLang(text, instruction, captionLang),
          book: {
            occasion,
            tone: pick<Tone>(book.tone, TONES, DEFAULT_TONE[occasion]),
            captionLang,
            title: book.title,
          },
          doc: { chapters: doc?.chapters ?? [] },
          pagePhotos: notes,
          memory,
        },
      });
      ok = result.ok;
      if (!result.ok) errorCode = result.code;
    } finally {
      await finishSafely(runId, ok, ok ? null : errorCode);
    }

    if (!result.ok) {
      if (result.code === "bad_input") return json({ error: "invalid_body" }, 400);
      return json({ error: result.code, retryable: result.retryable }, 502);
    }
    let remaining: number | null = null;
    try {
      remaining = Math.max(0, cap - (await getRewritesUsed(book.id)));
    } catch (err) {
      console.error(`[ai-rewrite] count failed (${errorCodeOf(err)})`);
    }
    return json({ text: result.text, lang: result.lang, remaining }, 200);
  } catch (err) {
    console.error(`[ai-rewrite] failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback;
}

/** Page photo notes; a failed read degrades to "no notes" (the rewrite still works). */
async function loadNotes(bookId: string, photoIds: string[]) {
  if (photoIds.length === 0) return [];
  try {
    const rows = await getPhotoNotesAdmin(bookId, photoIds);
    return rows.map((r) => ({ takenAt: r.takenAt, place: r.place, analysis: analysisOf(r.ai) }));
  } catch (err) {
    console.error(`[ai-rewrite] notes failed (${errorCodeOf(err)})`);
    return [];
  }
}

/** User memory (sanitised); a failed read degrades to none. */
async function loadMemory(userId: string): Promise<UserMemory | null> {
  try {
    const row = await getUserMemoryAdmin(userId);
    return row ? sanitizeMemory(row.prefs) : null;
  } catch (err) {
    console.error(`[ai-rewrite] memory failed (${errorCodeOf(err)})`);
    return null;
  }
}

/** Never throws: an unfinished run only blocks the book for 5 minutes (in-flight window). */
async function finishSafely(runId: string, ok: boolean, errorCode: string | null): Promise<void> {
  try {
    await finishRewriteRun(runId, { ai_status: ok ? "ok" : "failed", error_code: ok ? null : errorCode });
  } catch (err) {
    console.error(`[ai-rewrite] finish failed (${errorCodeOf(err)})`);
  }
}
