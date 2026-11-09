// POST /api/books/[id]/photo-urls (M5 Task 4): fresh signed web + thumb URLs for the
// owner's photos, used by the editor when an image 403s after its URL expired.
// Body: { ids?: string[] } (≤ 500 uuids; omitted = all upload-finished photos).
// Responses (JSON, no-store): 200 { photos: [{ id, webUrl, thumbUrl }], ttlSeconds }
// | 400 invalid_body | 401 | 403 (cross-site) | 404 (not the user's book) | 413 | 500.
// Logs carry error codes only — never ids or paths.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { EDITOR_URL_TTL_SECONDS, getPhotoUrls, MAX_PHOTO_URL_IDS } from "@/lib/db/editor";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 500 uuids as JSON ≈ 20 KB; anything far above is not a legitimate request. */
const MAX_BODY_BYTES = 32 * 1024;

const BodySchema = z
  .object({
    ids: z.array(z.string().refine(isUuid)).max(MAX_PHOTO_URL_IDS).optional(),
  })
  .strict();

type ErrorCode =
  | "forbidden"
  | "unauthenticated"
  | "not_found"
  | "invalid_body"
  | "payload_too_large"
  | "server_error";

const MESSAGES: Record<ErrorCode, string> = {
  forbidden: "Cross-site request rejected.",
  unauthenticated: "Please sign in.",
  not_found: "Book not found.",
  invalid_body: "Invalid request.",
  payload_too_large: "Request too large.",
  server_error: "Something went wrong. Please try again.",
};

function fail(status: number, code: ErrorCode) {
  return NextResponse.json(
    { error: code, message: MESSAGES[code] },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
  }
  return "unknown";
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return fail(403, "forbidden");

  try {
    const user = await getCurrentUser();
    if (!user) return fail(401, "unauthenticated");

    const { id } = await params;
    if (!isUuid(id)) return fail(404, "not_found");

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, "payload_too_large");
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return fail(413, "payload_too_large");

    let json: unknown = {};
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        return fail(400, "invalid_body");
      }
    }
    const body = BodySchema.safeParse(json);
    if (!body.success) return fail(400, "invalid_body");

    const photos = await getPhotoUrls(id, body.data.ids);
    if (!photos) return fail(404, "not_found");

    return NextResponse.json(
      { photos, ttlSeconds: EDITOR_URL_TTL_SECONDS },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error(`[photo-urls] failed (${codeOf(err)})`);
    return fail(500, "server_error");
  }
}
