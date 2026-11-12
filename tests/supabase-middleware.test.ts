import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };
type CookieMethods = {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: CookieToSet[], headers: Record<string, string>) => void;
};

const state: {
  user: { id: string } | null;
  cookiesToSet: CookieToSet[];
  headers: Record<string, string>;
  calls: number;
  /** M12: getUser answers this error (AuthRetryableFetchError / AuthApiError shapes). */
  authError: unknown;
  /** M12: getUser never settles (hung refresh loop). */
  hang: boolean;
  fetch: typeof fetch | null;
} = { user: null, cookiesToSet: [], headers: {}, calls: 0, authError: null, hang: false, fetch: null };

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: { cookies: CookieMethods; global?: { fetch?: typeof fetch } },
  ) => {
    state.calls++;
    state.fetch = opts.global?.fetch ?? null;
    return {
      auth: {
        getUser: async () => {
          if (state.hang) return new Promise(() => {});
          if (state.cookiesToSet.length) opts.cookies.setAll(state.cookiesToSet, state.headers);
          if (state.authError) return { data: { user: null }, error: state.authError };
          return { data: { user: state.user }, error: null };
        },
      },
    };
  },
}));

/** auth-js shapes (recognised by name, like auth-js's own guards). */
function authRetryableFetchError(message: string, status: number) {
  return Object.assign(new Error(message), { name: "AuthRetryableFetchError", status, __isAuthError: true });
}
function authApiError(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { name: "AuthApiError", status, code, __isAuthError: true });
}

const { updateSession } = await import("@/lib/supabase/middleware");

const req = (path: string) => new NextRequest(new URL(path, "http://localhost:3000"));

describe("updateSession (src/lib/supabase/middleware.ts)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    state.user = null;
    state.cookiesToSet = [];
    state.headers = {};
    state.calls = 0;
    state.authError = null;
    state.hang = false;
    state.fetch = null;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("redirects a protected path with no user to /login?next=<path+search>", async () => {
    const res = await updateSession(req("/books/abc?tab=2"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("http://localhost:3000");
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/books/abc?tab=2");
    expect([...loc.searchParams.keys()]).toEqual(["next"]);
  });

  it("copies cookies and cache headers set by setAll onto the redirect", async () => {
    state.cookiesToSet = [
      { name: "sb-x-auth-token", value: "", options: { path: "/", maxAge: 0 } },
      { name: "sb-x-auth-token.1", value: "abc", options: { path: "/", httpOnly: true } },
    ];
    state.headers = { "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0" };
    const res = await updateSession(req("/dashboard"));
    expect(res.status).toBe(307);
    const names = res.cookies.getAll().map((c) => c.name).sort();
    expect(names).toEqual(["sb-x-auth-token", "sb-x-auth-token.1"]);
    expect(res.cookies.get("sb-x-auth-token.1")?.value).toBe("abc");
    expect(res.headers.get("set-cookie")).toContain("sb-x-auth-token.1=abc");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("passes through a protected path when the user is signed in", async () => {
    state.user = { id: "u1" };
    const res = await updateSession(req("/dashboard"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("passes through public paths when signed out", async () => {
    for (const p of ["/", "/login", "/b/some-slug", "/booksfoo"]) {
      const res = await updateSession(req(p));
      expect(res.headers.get("location"), p).toBeNull();
    }
  });

  it("without env: public paths pass, protected paths get 503 and no Supabase client", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await updateSession(req("/"))).headers.get("x-middleware-next")).toBe("1");
    expect((await updateSession(req("/dashboard"))).status).toBe(503);
    expect(state.calls).toBe(0);
    err.mockRestore();
  });
  describe("M12: Supabase Auth timeouts are not sign-outs", () => {
    const TIMEOUT = authRetryableFetchError("Supabase auth request timed out after 5000 ms (SUPABASE_TIMEOUT)", 504);

    it("protected path + auth timeout → 503 'temporarily unavailable' + Retry-After, never a login redirect", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      state.authError = TIMEOUT;
      const res = await updateSession(req("/books/abc/edit"));
      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("retry-after")).toBe("3");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Temporarily unavailable");
      expect(body).toContain('name="viewport"');
      expect(body).not.toContain("/login");
      expect(err.mock.calls.map((c) => String(c[0]))).toEqual(["[auth] middleware session check unavailable (SUPABASE_TIMEOUT)"]);
      err.mockRestore();
    });

    it("any AuthRetryableFetchError (network failure, Auth 502/503) on a protected path → 503", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      state.authError = authRetryableFetchError("fetch failed", 0);
      expect((await updateSession(req("/dashboard"))).status).toBe(503);
      state.authError = authRetryableFetchError("Service Unavailable", 503);
      expect((await updateSession(req("/settings"))).status).toBe(503);
      err.mockRestore();
    });

    it("a real auth error (invalid JWT / missing session) still redirects to /login", async () => {
      state.authError = authApiError("invalid JWT", 401, "bad_jwt");
      const res = await updateSession(req("/dashboard"));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
      state.authError = Object.assign(new Error("Auth session missing!"), { name: "AuthSessionMissingError", status: 400 });
      expect((await updateSession(req("/books/x"))).status).toBe(307);
    });

    it("public paths pass through on an auth timeout (rendered as signed out, as before)", async () => {
      state.authError = TIMEOUT;
      for (const p of ["/", "/login", "/b/some-slug"]) {
        const res = await updateSession(req(p));
        expect(res.status, p).toBe(200);
        expect(res.headers.get("x-middleware-next"), p).toBe("1");
      }
    });

    it("server action POSTs on a protected path pass through (the action returns its generic error)", async () => {
      state.authError = TIMEOUT;
      const action = new NextRequest(new URL("/books/abc/review", "http://localhost:3000"), {
        method: "POST",
        headers: { "next-action": "abc123" },
      });
      const res = await updateSession(action);
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("location")).toBeNull();
    });

    it("caps the whole getUser (auth-js refresh retry loop ≈ 35 s) at MIDDLEWARE_AUTH_TOTAL_MS → 503", async () => {
      const { MIDDLEWARE_AUTH_TOTAL_MS } = await import("@/lib/supabase/middleware");
      expect(MIDDLEWARE_AUTH_TOTAL_MS).toBe(6_000);
      vi.useFakeTimers();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      state.hang = true;
      let settled: Response | null = null;
      const pending = updateSession(req("/dashboard")).then((r) => (settled = r));
      await vi.advanceTimersByTimeAsync(MIDDLEWARE_AUTH_TOTAL_MS - 1);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled!.status).toBe(503);
      err.mockRestore();
    });

    it("the auth gate: after one auth timeout, later auth requests answer the synthetic 504 without a network call", async () => {
      const { supabaseTimeoutResponse, isSupabaseTimeout } = await import("@/lib/supabase/deadline");
      await updateSession(req("/"));
      const gated = state.fetch!;
      expect(gated).toBeTypeOf("function");
      const net = vi.fn(async () => supabaseTimeoutResponse("auth", 5000));
      vi.stubGlobal("fetch", net);
      const url = "https://example.supabase.co/auth/v1/token?grant_type=refresh_token";
      const r1 = await gated(url, { method: "POST" });
      expect(r1.status).toBe(504);
      expect(net).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) {
        const r = await gated(url, { method: "POST" });
        expect(r.status).toBe(504);
        expect(isSupabaseTimeout(await r.json())).toBe(true);
      }
      expect(net).toHaveBeenCalledTimes(1); // the refresh retry loop made no further network calls
      // Non-auth requests are not gated.
      net.mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
      expect((await gated("https://example.supabase.co/rest/v1/books?select=id")).status).toBe(200);
      expect(net).toHaveBeenCalledTimes(2);
    });

    it("the auth gate stays open while auth answers normally", async () => {
      await updateSession(req("/"));
      const gated = state.fetch!;
      const net = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", net);
      for (let i = 0; i < 3; i++) await gated("https://example.supabase.co/auth/v1/user");
      expect(net).toHaveBeenCalledTimes(3);
    });
  });
});
