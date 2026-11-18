// GET /api/books/[id]/wizard?step=3|6|7[&auto=1] (M20 T1, D-072; Task 5 order): data for the wizard's
// steps 3 Photos, 6 Create and 7 Preview, which run inside /books/new without a page jump.
// Responses (JSON, no-store): 200 WizardStepData (src/lib/books/wizard-data.ts)
// | 400 invalid_step | 401 unauthenticated | 404 not_found (missing / malformed / not the user's)
// | 500 server_error | 503 { error: 'unavailable' } + Retry-After (Supabase timeout, M12).
// Step 7 counts as opening the book (touchWarnedDraft), like the review page.
// Logs carry error codes only — never ids, photo content or descriptions.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { loadWizardStep, parseWizardDataStep } from "@/lib/books/wizard-data";
import { getMyBook } from "@/lib/db/books";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ErrorCode = "unauthenticated" | "invalid_step" | "not_found" | "server_error";

const MESSAGES: Record<ErrorCode, string> = {
  unauthenticated: "Please sign in.",
  invalid_step: "Invalid step.",
  not_found: "Book not found.",
  server_error: "Something went wrong. Please try again.",
};

function fail(status: number, code: ErrorCode): Response {
  return json({ error: code, message: MESSAGES[code] }, status);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return fail(401, "unauthenticated");

    const step = parseWizardDataStep(request.nextUrl.searchParams.get("step"));
    if (step === null) return fail(400, "invalid_step");

    const { id } = await params;
    if (!isUuid(id)) return fail(404, "not_found");
    // Ownership under RLS first; the admin-client helpers in the loader assume it was checked.
    const book = await getMyBook(id);
    if (!book) return fail(404, "not_found");

    const auto = request.nextUrl.searchParams.get("auto") === "1";
    // Awaited inside try (lesson: return await): a loader timeout must reach the catch → 503.
    const data = await loadWizardStep(id, step, { user, book, auto });
    if (!data) return fail(404, "not_found");
    return json(data);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "wizard" });
    if (unavailable) return unavailable;
    console.error(`[wizard] failed (${errorCodeOf(err)})`);
    return fail(500, "server_error");
  }
}
