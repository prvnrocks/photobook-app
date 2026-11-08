// Email link target (D-010): /auth/confirm?token_hash=…&type=email&next=…
// Uses verifyOtp, so it works even if the email opens in a different browser.
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_TYPES = ["email", "signup", "magiclink"] as const satisfies readonly EmailOtpType[];
type AllowedType = (typeof ALLOWED_TYPES)[number];

function isAllowedType(value: string | null): value is AllowedType {
  return value !== null && (ALLOWED_TYPES as readonly string[]).includes(value);
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeNextPath(searchParams.get("next"));

  if (tokenHash && isAllowedType(type)) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      if (!error) return NextResponse.redirect(`${origin}${next}`);
      console.error("[auth/confirm] verifyOtp failed:", error.code ?? error.status);
    } catch {
      console.error("[auth/confirm] verifyOtp threw");
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
