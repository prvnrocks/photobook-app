// /api/books/[id]/pdf (M8 T7, D-047 / D-051 / D-052): PDF export of the saved doc, paid books only.
//
// POST (no body, same-origin) — start or reuse an export:
//   200 { status: 'ready', exportId, url, filename, bytes, pageCount }  ready PDF for the current
//       doc_rev + caption_lang (fresh 10-min signed URL, Content-Disposition attachment=filename)
//   202 { status: 'queued' | 'rendering', exportId }                     created / already running
//       (a queued job, or a rendering one whose lease expired, is re-kicked — re-POST to nudge)
//   401 unauthenticated | 403 forbidden (cross-site) | 404 not_found | 402 not_paid
//   409 invalid_doc | empty | page_limit | conflict (doc saved twice during the request)
//   429 daily_cap | 503 unavailable (BOOK_ACCESS_SECRET / Chromium / app URL not configured)
//   500 server_error
// GET ?exportId=<uuid> — poll (kept for compatibility; the client polls the lightweight
//   /api/books/[id]/pdf/status route, which answers the same but never re-kicks):
//   200 { status: 'queued' | 'rendering' } | { status: 'ready', exportId, url, filename, bytes,
//       pageCount } | { status: 'failed', error: <code> }  ('superseded' / 'missing_file': re-POST)
//   401 | 404 (not the caller's export of this book) | 500
// Rendering runs after the response via after() (same invocation, bounded by maxDuration).
// All responses no-store. Logs carry error codes only.
import { after, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { getExportState, requestExport, runExport, type RequestExportError } from "@/lib/pdf/job";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * = rules.PDF_MAX_DURATION_SECONDS (Next needs a literal here; tests assert they match, and
 * vercel.json's value too). Job deadline = this − 30 s. 300 s is the Hobby maximum WITH Fluid
 * compute (vercel.json "fluid": true); Hobby without Fluid caps at 60 s.
 */
export const maxDuration = 300;
// TODO(NEEDS-HUMAN): set `preferredRegion` to the Supabase project's region (Vercel defaults to
// iad1) — every print image is downloaded from Storage, so co-locating cuts render time.

const ERROR_STATUS: Record<RequestExportError, number> = {
  not_found: 404,
  not_paid: 402,
  invalid_doc: 409,
  empty: 409,
  page_limit: 409,
  conflict: 409,
  daily_cap: 429,
  unavailable: 503,
};

function schedule(exportId: string): void {
  after(() => runExport(exportId).then(() => undefined));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not_found" }, 404);

    const result = await requestExport(id, user.id, { schedule });
    if (!result.ok) return json({ error: result.error }, ERROR_STATUS[result.error]);
    return json(result.body, result.httpStatus);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "pdf-export" });
    if (unavailable) return unavailable;
    console.error(`[pdf-export] request failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { id } = await params;
    const exportId = request.nextUrl.searchParams.get("exportId") ?? "";
    if (!isUuid(id) || !isUuid(exportId)) return json({ error: "not_found" }, 404);

    const state = await getExportState(id, user.id, exportId, { schedule });
    if (!state.found) return json({ error: "not_found" }, 404);
    return json(state.body, 200);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "pdf-export" });
    if (unavailable) return unavailable;
    console.error(`[pdf-export] status failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
