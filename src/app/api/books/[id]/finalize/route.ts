// POST /api/books/[id]/finalize (T9, D-017): duplicate groups, places, fallback album.
// Called by the upload screen (same origin, fetch) after all uploads are ready.
// Responses are JSON: 200 FinalizeResult counts | 401 | 403 | 404 | 500 { error }.
// Logs carry error codes only — never ids, coordinates, places or dates.
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { finalizeBook } from "@/lib/photos/finalize";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

type ErrorCode = "forbidden" | "unauthenticated" | "not_found" | "server_error";

const MESSAGES: Record<ErrorCode, string> = {
  forbidden: "Cross-site request rejected.",
  unauthenticated: "Please sign in.",
  not_found: "Book not found.",
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

    const result = await finalizeBook(id);
    if (!result) return fail(404, "not_found");

    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error(`[finalize] failed (${codeOf(err)})`);
    return fail(500, "server_error");
  }
}
