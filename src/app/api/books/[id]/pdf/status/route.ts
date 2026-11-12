// /api/books/[id]/pdf/status (M8 review S3): lightweight poll for a PDF export. Same answers as
// GET /api/books/[id]/pdf, but this function never loads puppeteer, Chromium or sharp
// (src/lib/pdf/status.ts; tests/pdf-deploy-config.test.ts walks the import graph), so polls every
// 2 s stay cheap — on Vercel Hobby (1 vCPU / 2 GB per instance) they must not compete with renders.
//
// GET ?exportId=<uuid>
//   200 { status: 'queued' | 'rendering' } | { status: 'ready', exportId, url, filename, bytes,
//       pageCount } | { status: 'failed', error: <code> }  ('superseded' / 'missing_file': re-POST)
//   401 unauthenticated | 404 not the caller's export of this book | 500 server_error
// It never re-kicks a job: the client re-POSTs when a job stays queued (src/lib/pdf/ui.ts), and
// POST (the heavy route) schedules the render. All responses no-store; logs carry codes only.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { getExportState } from "@/lib/pdf/status";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { id } = await params;
    const exportId = request.nextUrl.searchParams.get("exportId") ?? "";
    if (!isUuid(id) || !isUuid(exportId)) return json({ error: "not_found" }, 404);

    const state = await getExportState(id, user.id, exportId);
    if (!state.found) return json({ error: "not_found" }, 404);
    return json(state.body, 200);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "pdf-export" });
    if (unavailable) return unavailable;
    console.error(`[pdf-export] status failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
