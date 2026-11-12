// Session refresh for Next.js middleware. Runs on every matched request.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isProtectedPath } from "@/lib/auth/redirect";
import { isAuthUnavailableError } from "@/lib/auth/unavailable";
import { MIDDLEWARE_AUTH_MS, createGatedAuthFetch } from "./deadline";
import { getSupabasePublishableKey, getSupabaseUrl } from "./env";

/**
 * Hard cap on the whole getUser() in middleware (M12, D-069). One auth request has the 5 s
 * MIDDLEWARE_AUTH_MS budget, but auth-js retries a failed token refresh with backoff for up to
 * 30 s (≈ 35 s worst case) — far too long for every page view. After this cap the request is
 * answered as "auth unavailable" and the auth gate below stops any further network attempts.
 */
export const MIDDLEWARE_AUTH_TOTAL_MS = MIDDLEWARE_AUTH_MS + 1_000;

/** Seconds a client should wait before retrying a 503 "temporarily unavailable". */
export const MIDDLEWARE_RETRY_AFTER_S = 3;

const AUTH_CAP = Symbol("auth-cap");

/** Copy cookie changes (e.g. a refresh that rotated the session) and cache headers onto `to`. */
function carrySessionChanges(from: NextResponse, cacheHeaders: Record<string, string>, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  for (const [key, value] of Object.entries(cacheHeaders)) {
    to.headers.set(key, value);
  }
  return to;
}

/** 503 page for a protected path while Supabase Auth does not answer — never a login redirect. */
function unavailableResponse(): NextResponse {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Temporarily unavailable</title></head>' +
    '<body style="font-family:system-ui,sans-serif;margin:0;padding:2rem 1.25rem;max-width:28rem;line-height:1.5">' +
    '<h1 style="font-size:1.25rem">Temporarily unavailable</h1>' +
    "<p>We couldn&#39;t check your sign-in just now. Your books are safe &mdash; please try again in a moment.</p>" +
    '<p><a href="" style="display:inline-block;padding:.6rem 1rem;border-radius:.5rem;background:#111;color:#fff;text-decoration:none">Try again</a></p>' +
    "</body></html>";
  return new NextResponse(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(MIDDLEWARE_RETRY_AFTER_S),
    },
  });
}

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

  // Runs on every matched request: auth gets the tighter middleware budget + the auth gate.
  // Auth gate (deadline.ts): after one auth timeout or the total cap, later auth requests of this
  // run answer the synthetic 504 at once (auth-js only sleeps its backoff, after the response).
  const gate = createGatedAuthFetch("server", { authMs: MIDDLEWARE_AUTH_MS });
  const supabase = createServerClient(env.url, env.key, {
    global: { fetch: gate.fetch },
    db: { retry: false },
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<typeof AUTH_CAP>((resolve) => {
    timer = setTimeout(() => resolve(AUTH_CAP), MIDDLEWARE_AUTH_TOTAL_MS);
  });
  const getUser = supabase.auth.getUser();
  let user: Awaited<typeof getUser>["data"]["user"] = null;
  let unavailable = false;
  try {
    const outcome = await Promise.race([getUser, cap]);
    if (outcome === AUTH_CAP) {
      unavailable = true;
      getUser.catch(() => {}); // finishes (or not) after the response; never unhandled
    } else if (outcome.error) {
      unavailable = isAuthUnavailableError(outcome.error);
    } else {
      user = outcome.data.user;
    }
  } catch (err) {
    if (!isAuthUnavailableError(err)) throw err;
    unavailable = true;
  } finally {
    clearTimeout(timer);
  }

  if (unavailable) {
    gate.close();
    // M12 (D-069): Auth did not answer — that is not "signed out". Public pages render as
    // signed out (as before). Protected pages get a 503 "try again", never a login redirect.
    // Server action POSTs pass through: the action's own getActionUser returns its generic error
    // (an HTML 503 would break the action response on the client).
    if (!protectedPath || request.headers.has("next-action")) return response;
    console.error("[auth] middleware session check unavailable (SUPABASE_TIMEOUT)");
    // A token refresh may have succeeded (rotated cookies) before /user timed out: keep its
    // Set-Cookie, or the browser keeps a refresh token that was already used.
    return carrySessionChanges(response, cacheHeaders, unavailableResponse());
  }

  if (protectedPath && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);

    // Keep any cookie changes (e.g. cleared expired session) and cache headers.
    return carrySessionChanges(response, cacheHeaders, NextResponse.redirect(loginUrl));
  }

  return response;
}
