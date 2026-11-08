// Session refresh for Next.js middleware. Runs on every matched request.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isProtectedPath } from "@/lib/auth/redirect";
import { getSupabasePublishableKey, getSupabaseUrl } from "./env";

function readEnv(): { url: string; key: string } | null {
  try {
    return { url: getSupabaseUrl(), key: getSupabasePublishableKey() };
  } catch {
    return null;
  }
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const protectedPath = isProtectedPath(request.nextUrl.pathname);
  const env = readEnv();

  if (!env) {
    // Public pages (landing, /b/[slug]) must keep working without Supabase.
    if (!protectedPath) return NextResponse.next({ request });
    console.error(
      "[auth] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY missing — see .env.example",
    );
    return new NextResponse("Sign-in is not configured on this server.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  let response = NextResponse.next({ request });
  let cacheHeaders: Record<string, string> = {};

  const supabase = createServerClient(env.url, env.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        cacheHeaders = { ...cacheHeaders, ...headers };
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Do not put code between createServerClient and getUser().
  // getUser() validates the JWT with Supabase Auth (getSession() does not).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (protectedPath && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);

    const redirect = NextResponse.redirect(loginUrl);
    // Keep any cookie changes (e.g. cleared expired session) and cache headers.
    for (const cookie of response.cookies.getAll()) {
      redirect.cookies.set(cookie);
    }
    for (const [key, value] of Object.entries(cacheHeaders)) {
      redirect.headers.set(key, value);
    }
    return redirect;
  }

  return response;
}
