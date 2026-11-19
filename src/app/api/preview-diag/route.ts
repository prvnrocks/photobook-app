// TEMPORARY (preview sign-in debugging): reports which auth env vars are present (booleans only, never
// values) and the verifyOtp error code for a token. Answers 404 outside Vercel preview builds.
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview") return new NextResponse(null, { status: 404 });
  const env = {
    url: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    urlRef: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^https:\/\/([a-z0-9]{4}).*$/, "$1"),
    publishable: Boolean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
    publishablePrefix: (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "").slice(0, 15),
    secret: Boolean(process.env.SUPABASE_SECRET_KEY),
    bookAccess: Boolean(process.env.BOOK_ACCESS_SECRET),
  };
  const token = request.nextUrl.searchParams.get("t");
  let verify: string | null = null;
  if (token) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: token });
      verify = error ? `failed:${error.code ?? error.status ?? "unknown"}:${error.message.slice(0, 80)}` : "ok";
    } catch (e) {
      verify = `threw:${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`;
    }
  }
  return NextResponse.json({ env, verify });
}
