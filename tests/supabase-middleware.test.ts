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
} = { user: null, cookiesToSet: [], headers: {}, calls: 0 };

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: CookieMethods }) => {
    state.calls++;
    return {
      auth: {
        getUser: async () => {
          if (state.cookiesToSet.length) opts.cookies.setAll(state.cookiesToSet, state.headers);
          return { data: { user: state.user }, error: null };
        },
      },
    };
  },
}));

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
  });
  afterEach(() => vi.unstubAllEnvs());

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
});
