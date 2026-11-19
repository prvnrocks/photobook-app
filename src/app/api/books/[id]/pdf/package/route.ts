// POST /api/books/[id]/pdf/package (Task 10) — the print package of a paid book: its front cover and
// its interior pages as two separate PDFs, cut from the ready PDF of the saved book (one render, so
// all files match). No body; same-origin only.
//   200 { cover: {url, filename, pages}, interior: {url, filename, pages}, spec, expiresInSeconds }
//       (10-min signed URLs on the private exports bucket)
//   401 unauthenticated | 403 forbidden (cross-site) | 404 not_found | 402 not_paid
//   409 pdf_first (no ready PDF of the current saved book — make the PDF first)
//   429 rate_limited (+ Retry-After) | 503 unavailable | 500 server_error
// All responses no-store. Logs carry codes only.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { rateLimitResponse } from "@/lib/http/rate-limit";
import { requestPrintPackage } from "@/lib/pdf/package";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Download ≤ 50 MB + split + 2 uploads; well inside a minute. */
export const maxDuration = 60;

const STATUS = { not_found: 404, not_paid: 402, pdf_first: 409, unavailable: 503 } as const;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not_found" }, 404);
    const limited = await rateLimitResponse("print_package", user.id);
    if (limited) return limited;
    const r = await requestPrintPackage(id, user.id);
    if (!r.ok) return json({ error: r.error }, STATUS[r.error]);
    return json(r.body, 200);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "pdf-package" });
    if (unavailable) return unavailable;
    console.error(`[pdf-package] failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
