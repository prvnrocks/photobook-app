// M12 T2 (D-069): getCurrentUser throws SupabaseUnavailableError when Supabase Auth does not answer
// (deadline timeout → synthetic 504 → auth-js AuthRetryableFetchError), and still returns null for
// real auth answers. Runs the REAL server client (@supabase/ssr + auth-js + deadline fetch) over a
// fake global fetch; only next/headers is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const jar = vi.hoisted(() => ({ cookies: [] as { name: string; value: string }[] }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => jar.cookies,
    set: () => {},
  }),
}));
// React cache() would memoise across tests in this file; pass it through.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T>(fn: T) => fn }));

const { getCurrentUser } = await import("@/lib/auth/current-user");
const { getActionUser, AUTH_UNAVAILABLE } = await import("@/lib/auth/action-user");
const { SupabaseUnavailableError, isSupabaseTimeout, supabaseTimeoutResponse } = await import("@/lib/supabase/deadline");
const { unavailableIfTimeout } = await import("@/lib/http/json");

const REF = "abcdefghijklmnop";
const USER = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "x@example.com" };

function b64url(s: string) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fakeJwt(expSec: number) {
  return [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })), b64url(JSON.stringify({ sub: USER.id, exp: expSec, role: "authenticated", aud: "authenticated" })), "sig"].join(".");
}
function sessionCookie(expiresInSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    access_token: fakeJwt(now + expiresInSec),
    refresh_token: "refresh-token",
    token_type: "bearer",
    expires_in: expiresInSec,
    expires_at: now + expiresInSec,
    user: USER,
  };
  return { name: `sb-${REF}-auth-token`, value: `base64-${b64url(JSON.stringify(session))}` };
}
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${REF}.supabase.co`);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  jar.cookies = [sessionCookie(3600)];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getCurrentUser (M12)", () => {
  it("returns the user when Auth answers", async () => {
    fetchMock.mockImplementation(async () => jsonRes(USER));
    expect((await getCurrentUser())?.id).toBe(USER.id);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`https://${REF}.supabase.co/auth/v1/user`);
  });

  it("deadline timeout (synthetic 504 SUPABASE_TIMEOUT) → throws SupabaseUnavailableError, never null", async () => {
    fetchMock.mockImplementation(async () => supabaseTimeoutResponse("auth", 8000));
    const err = await getCurrentUser().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SupabaseUnavailableError);
    expect(isSupabaseTimeout(err)).toBe(true);
    // An API route's catch turns it into 503 + Retry-After.
    const res = unavailableIfTimeout(err)!;
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("3");
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("a hung Auth call is cut by the 8 s server budget and throws (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_u: unknown, init?: RequestInit) =>
        new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      );
      const settled = getCurrentUser().then(
        () => "resolved",
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await settled).toBeInstanceOf(SupabaseUnavailableError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("network failure (fetch throws) and Auth 503 → unavailable too", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(getCurrentUser()).rejects.toBeInstanceOf(SupabaseUnavailableError);
    fetchMock.mockImplementation(async () => jsonRes({ message: "upstream" }, 503));
    await expect(getCurrentUser()).rejects.toBeInstanceOf(SupabaseUnavailableError);
  });

  it("real auth errors still return null: invalid JWT (401/403) and no session cookie", async () => {
    fetchMock.mockImplementation(async () => jsonRes({ code: "bad_jwt", msg: "invalid JWT" }, 401));
    expect(await getCurrentUser()).toBeNull();
    fetchMock.mockImplementation(async () => jsonRes({ code: "bad_jwt", msg: "invalid JWT" }, 403));
    expect(await getCurrentUser()).toBeNull();
    jar.cookies = [];
    fetchMock.mockReset();
    expect(await getCurrentUser()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getActionUser: 'unavailable' on a timeout (logged as a code), user / null otherwise", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => supabaseTimeoutResponse("auth", 8000));
    expect(await getActionUser()).toBe(AUTH_UNAVAILABLE);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["[auth] session check unavailable (SUPABASE_TIMEOUT)"]);
    fetchMock.mockImplementation(async () => jsonRes(USER));
    expect(await getActionUser()).toMatchObject({ id: USER.id });
    fetchMock.mockImplementation(async () => jsonRes({ code: "bad_jwt" }, 401));
    expect(await getActionUser()).toBeNull();
  });
});
