import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except the Stripe webhook (raw-body, signature-verified, no cookies/session),
    // the cleanup cron (bearer secret, no session), the email unsubscribe endpoint (HMAC token,
    // no session, must not set cookies), static assets, image optimiser, favicon and
    // image files.
    "/((?!api/stripe/webhook|api/cron/cleanup|api/email/unsubscribe|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|heic)$).*)",
  ],
};
