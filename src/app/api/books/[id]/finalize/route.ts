// POST /api/books/[id]/finalize (T9, D-017): duplicate groups, places, fallback album.
// Called by the upload screen (same origin, fetch) after all uploads are ready.
// Responses are JSON: 200 FinalizeResult counts | 400 invalid_body | 401 | 403 | 404 |
// 413 too_large | 429 (+ Retry-After, one run per book per 10 s) | 500 { error } |
// 503 { error: 'unavailable' } + Retry-After: 10 (Supabase timeout, M12 — safe to retry).
// Body (optional, M10c): { colors?: { [photoId: uuid]: "#rrggbb" } } (≤ 500 entries) — photo
// colours computed by the uploader; finalize writes them only for this book's ready photos whose
// colour is still null (photos.color is server-only). Empty body = no colours.
// Logs carry error codes only — never ids, colours, coordinates, places or dates.
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { finalizeBook } from "@/lib/photos/finalize";
import { FinalizeBodySchema, MAX_BODY_BYTES, type FinalizeBody } from "@/lib/photos/finalize-body";
import { unavailableIfTimeout } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Retry-After for a Supabase timeout: matches the one-run-per-book-per-10-s rate limit. */
const FINALIZE_RETRY_AFTER_S = 10;

type ErrorCode =
  | "forbidden"
  | "unauthenticated"
  | "not_found"
  | "invalid_body"
  | "too_large"
  | "rate_limited"
  | "server_error";

const MESSAGES: Record<ErrorCode, string> = {
  invalid_body: "The request was not valid.",
  too_large: "The request was too large.",
  forbidden: "Cross-site request rejected.",
  unauthenticated: "Please sign in.",
  not_found: "Book not found.",
  rate_limited: "Please wait a few seconds and try again.",
  server_error: "Something went wrong. Please try again.",
};

function fail(status: number, code: ErrorCode, headers: Record<string, string> = {}) {
  return NextResponse.json(
    { error: code, message: MESSAGES[code] },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
  }
  return "unknown";
}

/** Empty body → {}. Never echoes the body back or logs it. */
async function readBody(request: NextRequest): Promise<FinalizeBody | "invalid" | "too_large"> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "too_large";
  let text: string;
  try {
    text = await request.text();
  } catch {
    return "invalid";
  }
  if (text.length > MAX_BODY_BYTES) return "too_large";
  if (text.trim() === "") return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "invalid";
  }
  const parsed = FinalizeBodySchema.safeParse(json);
  return parsed.success ? parsed.data : "invalid";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSameOrigin(request)) return fail(403, "forbidden");

  try {
    const user = await getCurrentUser();
    if (!user) return fail(401, "unauthenticated");

    const { id } = await params;
    if (!isUuid(id)) return fail(404, "not_found");

    const body = await readBody(request);
    if (body === "too_large") return fail(413, "too_large");
    if (body === "invalid") return fail(400, "invalid_body");

    const result = await finalizeBook(id, {}, { colors: body.colors });
    if (!result) return fail(404, "not_found");
    if ("rateLimited" in result) {
      const wait = Math.min(60, Math.max(1, Math.ceil(result.retryAfterSeconds)));
      return fail(429, "rate_limited", { "retry-after": String(wait) });
    }

    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    // M12: a Supabase timeout → 503 + Retry-After 10 (= the one-run-per-10-s limit); every
    // finalize step is safe to repeat, so the client simply retries.
    const unavailable = unavailableIfTimeout(err, { route: "finalize", retryAfterSeconds: FINALIZE_RETRY_AFTER_S });
    if (unavailable) return unavailable;
    console.error(`[finalize] failed (${codeOf(err)})`);
    return fail(500, "server_error");
  }
}
