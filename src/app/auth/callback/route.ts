// OAuth (Google) PKCE callback: exchange ?code= for a session cookie.
import { NextResponse, type NextRequest } from "next/server";
import { authFlash, withAnalyticsFlash } from "@/lib/analytics/flash";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    try {
      const supabase = await createClient();
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      // analytics (M9 T14): one-shot ?_ev= code only when PostHog is configured.
      if (!error) return NextResponse.redirect(`${origin}${withAnalyticsFlash(next, authFlash(data.user, "google"))}`);
      console.error("[auth/callback] exchange failed:", error.code ?? error.status);
    } catch {
      console.error("[auth/callback] exchange threw");
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
