// /api/email/unsubscribe?t=<token> — reminder-email opt-out (D-057).
//
// GET  → confirmation page with a POST button. Never mutates: mail scanners and link previewers
//        prefetch every URL in an email.
// POST → RFC 8058 one-click (mail clients send the form body `List-Unsubscribe=One-Click`; the
//        confirmation page posts the same) → verify the HMAC token → profiles.email_reminders =
//        false via the admin client → 200 page.
// Invalid / expired token → 400 page. All responses: noindex, no-store, no-referrer, no cookies.
// Excluded from the middleware matcher (no session work). Logs codes only.
import { z } from "zod";
import { setEmailReminders } from "@/lib/db/profiles";
import { UNSUBSCRIBE_PAGE_HEADERS, unsubscribePage } from "@/lib/email/unsubscribe-page";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { readBodyWithLimit } from "@/lib/http/body";
import { UNAVAILABLE_RETRY_AFTER_S } from "@/lib/http/json";
import { isSupabaseTimeout } from "@/lib/supabase/deadline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024;

const OneClickBody = z.object({ "List-Unsubscribe": z.literal("One-Click") });

function html(kind: Parameters<typeof unsubscribePage>[0], status: number, formAction?: string): Response {
  return new Response(unsubscribePage(kind, formAction), { status, headers: UNSUBSCRIBE_PAGE_HEADERS });
}

function tokenOf(request: Request): string | null {
  const t = new URL(request.url).searchParams.get("t");
  return t && t.length <= 256 ? t : null;
}

/** RFC 8058 allows urlencoded or multipart bodies; anything else is treated as urlencoded. */
async function formFields(text: string, contentType: string | null): Promise<Record<string, unknown>> {
  const ct = contentType?.toLowerCase() ?? "";
  if (ct.startsWith("multipart/form-data")) {
    try {
      const form = await new Response(text, { headers: { "content-type": contentType as string } }).formData();
      const out: Record<string, unknown> = {};
      for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export async function GET(request: Request) {
  const token = tokenOf(request);
  if (!token || !verifyUnsubscribeToken(token, Date.now())) return html("invalid", 400);
  return html("confirm", 200, `/api/email/unsubscribe?t=${encodeURIComponent(token)}`);
}

export async function POST(request: Request) {
  const token = tokenOf(request);
  const userId = token ? verifyUnsubscribeToken(token, Date.now()) : null;
  if (!userId) return html("invalid", 400);

  const body = await readBodyWithLimit(request, MAX_BODY_BYTES).catch(() => null);
  if (!body?.ok) return html("invalid", 400);
  const parsed = OneClickBody.safeParse(await formFields(body.text, request.headers.get("content-type")));
  if (!parsed.success) return html("invalid", 400);

  try {
    // false = the account no longer exists: nothing left to email, same answer.
    await setEmailReminders(userId, false);
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unknown";
    console.error(`[email] unsubscribe failed code=${code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown"}`);
    // M12: a Supabase timeout is temporary → 503 + Retry-After (one-click senders may retry).
    if (isSupabaseTimeout(e)) {
      return new Response(unsubscribePage("error"), {
        status: 503,
        headers: { ...UNSUBSCRIBE_PAGE_HEADERS, "retry-after": String(UNAVAILABLE_RETRY_AFTER_S) },
      });
    }
    return html("error", 500);
  }
  console.info("[email] unsubscribe ok=1");
  return html("done", 200);
}
