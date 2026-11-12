// M12 T1: deadline fetch for every Supabase client (src/lib/supabase/deadline.ts).
// Fake timers + a never-resolving fake fetch; the real supabase-js / storage-js / auth-js
// code paths are exercised so the error shapes are the ones the app actually sees.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEADLINE_BUDGETS,
  MIDDLEWARE_AUTH_MS,
  RETRY_DELAY_MS,
  SUPABASE_TIMEOUT,
  SupabaseUnavailableError,
  classifySupabaseRequest,
  createDeadlineFetch,
  deadlineClientOptions,
  isSupabaseTimeout,
  measureBodyBytes,
  uploadBudgetMs,
} from "@/lib/supabase/deadline";

const BASE = "https://proj.supabase.co";
const MB = 1024 * 1024;

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function neverFetch() {
  // Ignores the abort signal on purpose: the wrapper must not rely on fetch honouring it.
  return vi.fn<(...args: FetchArgs) => Promise<Response>>(() => new Promise<Response>(() => {}));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Headers arrive, the body never finishes. */
function stalledBodyResponse(status = 200) {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("[{"));
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/json" } });
}

function track<T>(p: PromiseLike<T>) {
  const s: { done: boolean; at: number; value?: T; error?: unknown } = { done: false, at: -1 };
  Promise.resolve(p).then(
    (v) => Object.assign(s, { done: true, at: Date.now(), value: v }),
    (e) => Object.assign(s, { done: true, at: Date.now(), error: e }),
  );
  return s;
}

function client(profile: "server" | "browser" = "server", overrides?: Parameters<typeof deadlineClientOptions>[1]) {
  return createClient(BASE, "sb_publishable_test", {
    ...deadlineClientOptions(profile, overrides),
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

let fake: ReturnType<typeof neverFetch>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  fake = neverFetch();
  vi.stubGlobal("fetch", fake);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("rest reads: one retry, then SUPABASE_TIMEOUT", () => {
  it("a hung GET returns error.code SUPABASE_TIMEOUT after exactly 2 tries, within 21 s", async () => {
    const s = track(client().from("books").select("id"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.done).toBe(true);
    expect(s.at).toBeLessThanOrEqual(21_000);
    expect(s.at).toBe(2 * DEADLINE_BUDGETS.server.restMs + RETRY_DELAY_MS);
    const res = s.value as { error: { code: string }; status: number };
    expect(res.error.code).toBe(SUPABASE_TIMEOUT);
    expect(res.status).toBe(504);
    expect(isSupabaseTimeout(res.error)).toBe(true);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("postgrest does not add its own retries on top (504 is not retried, retry disabled)", async () => {
    const s = track(client().from("books").select("id"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.done).toBe(true);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("browser profile: 20 s per try, worst case 40.5 s", async () => {
    const s = track(client("browser").from("books").select("id"));
    await vi.advanceTimersByTimeAsync(40_499);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
    expect((s.value as { error: { code: string } }).error.code).toBe(SUPABASE_TIMEOUT);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("a stalled response body times out (deadline covers the body read)", async () => {
    fake.mockImplementation(async () => stalledBodyResponse());
    const s = track(client().from("books").select("id"));
    await vi.advanceTimersByTimeAsync(21_000);
    expect(s.done).toBe(true);
    expect((s.value as { error: { code: string } }).error.code).toBe(SUPABASE_TIMEOUT);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("a timeout then a good answer succeeds on the retry", async () => {
    fake
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementationOnce(async () => jsonResponse([{ id: "b1" }]));
    const s = track(client().from("books").select("id"));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(s.done).toBe(true);
    expect((s.value as { data: unknown; error: unknown }).error).toBeNull();
    expect((s.value as { data: unknown }).data).toEqual([{ id: "b1" }]);
  });

  it("retries once on a network error and on 503/520, never more", async () => {
    fake
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async () => jsonResponse([{ id: "ok" }]));
    const a = track(client().from("books").select("id"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((a.value as { data: unknown }).data).toEqual([{ id: "ok" }]);
    expect(fake).toHaveBeenCalledTimes(2);

    fake.mockReset();
    fake.mockImplementation(async () => jsonResponse({ message: "schema cache" }, 503));
    const b = track(client().from("books").select("id"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.done).toBe(true);
    expect((b.value as { status: number }).status).toBe(503);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the request already carries X-Retry-Count", async () => {
    const f = createDeadlineFetch("server");
    const s = track(f(`${BASE}/rest/v1/books?select=id`, { method: "GET", headers: { "X-Retry-Count": "1" } }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.done).toBe(true);
    expect((s.value as Response).status).toBe(504);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("reads globalThis.fetch at call time", async () => {
    const f = createDeadlineFetch("server");
    const late = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", late);
    const res = await f(`${BASE}/rest/v1/books`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(late).toHaveBeenCalledTimes(1);
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("writes and RPCs are never retried", () => {
  it.each([
    ["insert (POST)", () => client().from("books").insert({ title: "x" } as never)],
    ["update (PATCH)", () => client().from("books").update({ title: "x" } as never).eq("id", "b1")],
    ["delete (DELETE)", () => client().from("books").delete().eq("id", "b1")],
  ])("%s: one try, SUPABASE_TIMEOUT at 10 s", async (_name, run) => {
    const s = track(run());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
    expect((s.value as { error: { code: string } }).error.code).toBe(SUPABASE_TIMEOUT);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("rpc: one try at 15 s; long maintenance RPCs get 60 s", async () => {
    const a = track(client().rpc("claim_export" as never));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(a.done).toBe(true);
    expect((a.value as { error: { code: string } }).error.code).toBe(SUPABASE_TIMEOUT);
    expect(fake).toHaveBeenCalledTimes(1);

    for (const name of ["cleanup_old_drafts", "delete_book_guarded", "reap_stale_agent_runs", "admin_ai_spend_daily"]) {
      fake.mockClear();
      const start = Date.now();
      const s = track(client().rpc(name as never));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(s.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.done).toBe(true);
      expect(s.at - start).toBe(60_000);
      expect(fake).toHaveBeenCalledTimes(1);
    }
  });

  it("a network error on a write is rethrown, not retried", async () => {
    fake.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    const f = createDeadlineFetch("server");
    await expect(f(`${BASE}/rest/v1/books`, { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
    expect(fake).toHaveBeenCalledTimes(1);
  });
});

describe("caller aborts win over the deadline", () => {
  it("rethrows an AbortError (never a timeout) and does not retry", async () => {
    const f = createDeadlineFetch("server");
    const ac = new AbortController();
    const s = track(f(`${BASE}/rest/v1/books`, { method: "GET", signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(3_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.done).toBe(true);
    expect((s.error as Error).name).toBe("AbortError");
    expect(isSupabaseTimeout(s.error)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("postgrest .abortSignal(): the error is an abort, not SUPABASE_TIMEOUT", async () => {
    const ac = new AbortController();
    const s = track(client().from("books").select("id").abortSignal(ac.signal));
    await vi.advanceTimersByTimeAsync(2_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    const res = s.value as { error: { code: string; message: string } };
    expect(res.error.message).toMatch(/^AbortError/);
    expect(res.error.code).not.toBe(SUPABASE_TIMEOUT);
    expect(isSupabaseTimeout(res.error)).toBe(false);
  });

  it("an already-aborted signal never calls fetch", async () => {
    const f = createDeadlineFetch("server");
    const ac = new AbortController();
    ac.abort();
    await expect(f(`${BASE}/rest/v1/books`, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fake).not.toHaveBeenCalled();
  });

  it("a caller abort during a stalled download body surfaces as AbortError", async () => {
    fake.mockImplementation(async () => stalledBodyResponse());
    const ac = new AbortController();
    const s = track(client().storage.from("photos").download("u/a.jpg", undefined, { signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(5_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.done).toBe(true);
    expect((s.error as Error).name).toBe("AbortError");
  });
});

describe("storage", () => {
  it("createSignedUrls is storage-json (15 s, StorageApiError.statusCode SUPABASE_TIMEOUT)", async () => {
    expect(classifySupabaseRequest(`${BASE}/storage/v1/object/sign/photos`, "POST").cls).toBe("storage-json");
    const s = track(client().storage.from("photos").createSignedUrls(["u/a.jpg", "u/b.jpg"], 60));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
    const err = (s.value as { error: { name: string; statusCode: string; status: number } }).error;
    expect(err.name).toBe("StorageApiError");
    expect(err.statusCode).toBe(SUPABASE_TIMEOUT);
    expect(err.status).toBe(504);
    expect(isSupabaseTimeout(err)).toBe(true);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("upload budget scales with size: a 50 MB Blob gets >= 80 s", async () => {
    const blob = new Blob([new Uint8Array(50 * MB)]);
    const s = track(client().storage.from("exports").upload("u/book.pdf", blob, { upsert: true }));
    await vi.advanceTimersByTimeAsync(80_000);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.done).toBe(true);
    const err = (s.value as { error: { statusCode: string } }).error;
    expect(err.statusCode).toBe(SUPABASE_TIMEOUT);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("upload budget formula and caps", () => {
    const sv = DEADLINE_BUDGETS.server;
    const br = DEADLINE_BUDGETS.browser;
    expect(uploadBudgetMs(sv, 50 * MB)).toBe(80_000);
    expect(uploadBudgetMs(sv, 0)).toBe(30_000);
    expect(uploadBudgetMs(sv, 500 * MB)).toBe(120_000);
    expect(uploadBudgetMs(sv, null)).toBe(120_000);
    expect(uploadBudgetMs(br, 1.6 * MB)).toBe(30_000 + 102_400);
    expect(uploadBudgetMs(br, null)).toBe(600_000);
  });

  it("measures Blob / ArrayBuffer / typed arrays / strings / FormData without reading; streams are unknown", () => {
    expect(measureBodyBytes(new Blob([new Uint8Array(1234)]))).toBe(1234);
    expect(measureBodyBytes(new ArrayBuffer(10))).toBe(10);
    expect(measureBodyBytes(new Uint8Array(7))).toBe(7);
    expect(measureBodyBytes(new DataView(new ArrayBuffer(5)))).toBe(5);
    expect(measureBodyBytes("abc")).toBe(9);
    expect(measureBodyBytes(undefined)).toBe(0);
    const fd = new FormData();
    fd.append("", new Blob([new Uint8Array(2000)]));
    expect(measureBodyBytes(fd)).toBe(2000 + 1024);
    expect(measureBodyBytes(new ReadableStream())).toBeNull();
    expect(measureBodyBytes({ pipe() {} })).toBeNull();
  });

  it("a stream upload body is never read or cloned and gets the max budget", async () => {
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const f = createDeadlineFetch("server");
    const init = { method: "POST", body, duplex: "half" } as RequestInit;
    const s = track(f(`${BASE}/storage/v1/object/exports/u/book.pdf`, init));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((s.value as Response).status).toBe(504);
    expect(pull).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect((fake.mock.calls[0][1] as RequestInit).body).toBe(body); // same object, not a clone

    // browser profile: 600 s for unknown bodies
    const g = createDeadlineFetch("browser");
    const t = track(g(`${BASE}/storage/v1/object/photos/u/a.jpg`, { method: "PUT", body: { pipe() {} } as never }));
    await vi.advanceTimersByTimeAsync(599_999);
    expect(t.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((t.value as Response).status).toBe(504);
  });

  it("a hung download (no headers) returns StorageApiError SUPABASE_TIMEOUT at 60 s", async () => {
    const s = track(client().storage.from("photos").download("u/a.jpg"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = (s.value as { error: { statusCode: string } }).error;
    expect(err.statusCode).toBe(SUPABASE_TIMEOUT);
  });

  it("a stalled download body aborts at the deadline with SupabaseUnavailableError", async () => {
    fake.mockImplementation(async () => stalledBodyResponse());
    const s = track(client().storage.from("photos").download("u/a.jpg"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
    expect(s.error).toBeInstanceOf(SupabaseUnavailableError);
    expect(isSupabaseTimeout(s.error)).toBe(true);
  });

  it("a download that completes keeps its bytes and clears the deadline", async () => {
    fake.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const s = track(client().storage.from("photos").download("u/a.jpg"));
    await vi.advanceTimersByTimeAsync(0);
    const blob = (s.value as { data: Blob }).data;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("auth", () => {
  it("getUser times out at 8 s as AuthRetryableFetchError recognised by isSupabaseTimeout", async () => {
    const s = track(client().auth.getUser("header.payload.sig"));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
    const err = (s.value as { error: { name: string; status: number } }).error;
    expect(err.name).toBe("AuthRetryableFetchError");
    expect(err.status).toBe(504);
    expect(isSupabaseTimeout(err)).toBe(true);
  });

  it("middleware budget: auth times out at 5 s", async () => {
    const s = track(client("server", { authMs: MIDDLEWARE_AUTH_MS }).auth.getUser("header.payload.sig"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isSupabaseTimeout((s.value as { error: unknown }).error)).toBe(true);
  });
});

describe("classification", () => {
  it.each([
    ["/auth/v1/user", "GET", "auth"],
    ["/auth/v1/token?grant_type=refresh_token", "POST", "auth"],
    ["/rest/v1/books?select=id", "GET", "rest"],
    ["/rest/v1/books", "PATCH", "rest"],
    ["/rest/v1/rpc/save_doc", "POST", "rpc"],
    ["/rest/v1/rpc/cleanup_expired_drafts", "POST", "rpc-long"],
    ["/storage/v1/object/sign/photos/u/a.jpg", "POST", "storage-json"],
    ["/storage/v1/object/upload/sign/photos/u/a.jpg", "POST", "storage-json"],
    ["/storage/v1/object/upload/sign/photos/u/a.jpg?token=t", "PUT", "storage-upload"],
    ["/storage/v1/object/list/photos", "POST", "storage-json"],
    ["/storage/v1/object/info/photos/u/a.jpg", "GET", "storage-json"],
    ["/storage/v1/object/move", "POST", "storage-json"],
    ["/storage/v1/object/photos", "DELETE", "storage-json"],
    ["/storage/v1/object/photos/u/a.jpg", "HEAD", "storage-json"],
    ["/storage/v1/object/photos/u/a.jpg", "POST", "storage-upload"],
    ["/storage/v1/object/photos/u/a.jpg", "PUT", "storage-upload"],
    ["/storage/v1/object/photos/u/a.jpg", "GET", "storage-download"],
    ["/storage/v1/render/image/authenticated/photos/a.jpg", "GET", "storage-download"],
    ["/storage/v1/bucket", "GET", "storage-json"],
    ["/functions/v1/x", "POST", "other"],
  ])("%s %s → %s", (path, method, cls) => {
    expect(classifySupabaseRequest(`${BASE}${path}`, method).cls).toBe(cls);
  });

  it("server budgets match the M12 table", () => {
    expect(DEADLINE_BUDGETS.server).toMatchObject({
      authMs: 8_000,
      restMs: 10_000,
      rpcMs: 15_000,
      rpcLongMs: 60_000,
      storageJsonMs: 15_000,
      uploadBaseMs: 30_000,
      uploadMaxMs: 120_000,
      downloadMs: 60_000,
    });
    expect(DEADLINE_BUDGETS.browser).toMatchObject({
      authMs: 20_000,
      restMs: 20_000,
      rpcMs: 20_000,
      storageJsonMs: 20_000,
      uploadMaxMs: 600_000,
      downloadMs: 60_000,
    });
    expect(MIDDLEWARE_AUTH_MS).toBe(5_000);
  });
});

describe("isSupabaseTimeout", () => {
  it("recognises every timeout shape and nothing else", () => {
    expect(isSupabaseTimeout({ code: SUPABASE_TIMEOUT, message: "x" })).toBe(true); // postgrest
    expect(isSupabaseTimeout({ name: "StorageApiError", status: 504, statusCode: SUPABASE_TIMEOUT })).toBe(true);
    expect(isSupabaseTimeout(new SupabaseUnavailableError())).toBe(true);
    expect(isSupabaseTimeout({ originalError: new SupabaseUnavailableError() })).toBe(true);
    expect(isSupabaseTimeout(new Error("wrapped", { cause: { code: SUPABASE_TIMEOUT } }))).toBe(true);

    expect(isSupabaseTimeout(null)).toBe(false);
    expect(isSupabaseTimeout("SUPABASE_TIMEOUT")).toBe(false);
    expect(isSupabaseTimeout({ code: "" })).toBe(false);
    expect(isSupabaseTimeout({ code: "PGRST116" })).toBe(false);
    expect(isSupabaseTimeout({ statusCode: "404" })).toBe(false);
    expect(isSupabaseTimeout(new Error("boom"))).toBe(false);
    // A real network failure in auth-js (status 0) is not a deadline timeout.
    expect(isSupabaseTimeout({ name: "AuthRetryableFetchError", status: 0, message: "fetch failed" })).toBe(false);
  });
});

describe("wiring and isomorphism", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("deadline.ts stays isomorphic: no server-only, node:, env, AbortSignal.any/timeout", () => {
    const src = read("src/lib/supabase/deadline.ts");
    expect(src).not.toMatch(/import\s+["']server-only["']|from\s+["']node:|process\.env/);
    expect(src).not.toMatch(/AbortSignal\.(any|timeout)\s*\(/);
  });

  it.each([
    ["src/lib/supabase/admin.ts", 'deadlineClientOptions("server")'],
    ["src/lib/supabase/server.ts", 'deadlineClientOptions("server")'],
    ["src/lib/supabase/client.ts", 'deadlineClientOptions("browser")'],
    ["src/lib/supabase/middleware.ts", 'deadlineClientOptions("server", { authMs: MIDDLEWARE_AUTH_MS })'],
  ])("%s uses the deadline fetch", (file, call) => {
    expect(read(file)).toContain(call);
  });

  it("client options disable postgrest's own retry loop", () => {
    const opts = deadlineClientOptions("server");
    expect(opts.db.retry).toBe(false);
    expect(typeof opts.global.fetch).toBe("function");
  });
});
