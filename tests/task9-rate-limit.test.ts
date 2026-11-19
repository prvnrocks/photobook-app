// Task 9: Postgres-backed rate limiting (hashed bucket keys, 429 + Retry-After, fail-open) and the
// storybook routes' new answers (402 preview_limit, 429 rate_limited, no client-chosen tier).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as { id: string } | null,
  startStoryRun: vi.fn(),
  advanceStoryRun: vi.fn(),
  getStoryRunForOwner: vi.fn(),
  rewritePageText: vi.fn(),
  limited: null as { route: string; retryAfter: number } | null,
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/ai/story/run", () => ({ startStoryRun: mocks.startStoryRun, advanceStoryRun: mocks.advanceStoryRun, STORY_TICK_BUDGET_MS: 40_000 }));
vi.mock("@/lib/db/agent-runs", () => ({ AgentRunsQueryError: class extends Error {}, getStoryRunForOwner: mocks.getStoryRunForOwner, getLatestStoryRunForBook: vi.fn(async () => null) }));
vi.mock("@/lib/ai/story/rewrite-page-text", () => ({ rewritePageText: mocks.rewritePageText }));
vi.mock("@/lib/ai/story/service", () => ({ StoryError: class extends Error {} }));

const rl = await import("@/lib/http/rate-limit");
const startRoute = await import("@/app/api/ai/story-runs/route");
const advanceRoute = await import("@/app/api/ai/story-runs/[id]/advance/route");
const rewriteRoute = await import("@/app/api/books/[id]/story-rewrite/route");

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const post = (url: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  mocks.user = { id: USER };
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: 0, error: null });
  mocks.startStoryRun.mockReset();
  mocks.advanceStoryRun.mockReset();
  mocks.getStoryRunForOwner.mockReset();
});
afterEach(() => vi.restoreAllMocks());
const logLines = () => logs.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.join(" ")));

describe("rate limiter (private.rate_limit_windows via rate_limit_hit)", () => {
  it("bucket keys never contain the user id: '<route>:<32 hex>', keyed by RATE_LIMIT_SECRET when set", () => {
    const a = rl.rateLimitBucket("story_runs", USER, undefined);
    expect(a).toMatch(/^story_runs:[0-9a-f]{32}$/);
    expect(a).not.toContain(USER.slice(0, 8));
    expect(rl.rateLimitBucket("story_runs", USER, "s3cret")).not.toBe(a);
    expect(rl.rateLimitBucket("story_runs", USER, "s3cret")).toBe(rl.rateLimitBucket("story_runs", USER, "s3cret"));
  });

  it("passes the route's limit and window; 0 = allowed, n > 0 = refused with Retry-After n (capped to the window)", async () => {
    const hit = vi.fn(async () => 0);
    expect(await rl.checkRateLimit("story_rewrite", USER, { hit })).toEqual({ allowed: true });
    expect(hit).toHaveBeenCalledWith(expect.stringMatching(/^story_rewrite:/), rl.RATE_LIMITS.story_rewrite.limit, rl.RATE_LIMITS.story_rewrite.windowSeconds);
    expect(await rl.checkRateLimit("story_rewrite", USER, { hit: async () => 17.2 })).toEqual({ allowed: false, retryAfterSeconds: 18 });
    expect(await rl.checkRateLimit("story_rewrite", USER, { hit: async () => 99_999 })).toEqual({ allowed: false, retryAfterSeconds: rl.RATE_LIMITS.story_rewrite.windowSeconds });
    const res = await rl.rateLimitResponse("checkout", USER, { hit: async () => 42 });
    expect(res!.status).toBe(429);
    expect(res!.headers.get("retry-after")).toBe("42");
    expect(await res!.json()).toEqual({ error: "rate_limited" });
  });

  it("fails OPEN on a database error (logged as a code) and while migration 2900 is missing", async () => {
    expect(await rl.checkRateLimit("ai_runs", USER, { hit: async () => Promise.reject(Object.assign(new Error("x"), { code: "08006" })) })).toEqual({ allowed: true });
    expect(await rl.checkRateLimit("ai_runs", USER, { hit: async () => Promise.reject(Object.assign(new Error("x"), { code: "PGRST202" })) })).toEqual({ allowed: true });
    expect(logLines()[0]).toBe("[rate-limit] check_failed (08006)");
    expect(logLines().join(" ")).not.toContain(USER);
  });

  it("calls the rate_limit_hit RPC with the hashed bucket (admin client)", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 5, error: null });
    expect(await rl.checkRateLimit("finalize", USER)).toEqual({ allowed: false, retryAfterSeconds: 5 });
    expect(mocks.rpc).toHaveBeenCalledWith("rate_limit_hit", { p_bucket: expect.stringMatching(/^finalize:[0-9a-f]{32}$/), p_limit: 30, p_window_seconds: 60 });
  });
});

describe("storybook routes (Task 9)", () => {
  it("POST /api/ai/story-runs: too many starts → 429 + Retry-After before any work", async () => {
    mocks.rpc.mockResolvedValue({ data: 120, error: null });
    const res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(mocks.startStoryRun).not.toHaveBeenCalled();
  });

  it("POST /api/ai/story-runs: free previews used up → 402 preview_limit", async () => {
    mocks.startStoryRun.mockResolvedValue({ ok: false, error: "preview_limit" });
    const res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "preview_limit" });
  });

  it("the client can't choose a tier, page count or 'complete' mode: unknown body keys are rejected", async () => {
    for (const extra of [{ tier: "full" }, { previewPages: 50 }, { complete: true }, { isPaid: true }]) {
      const res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK, ...extra }));
      expect(res.status).toBe(400);
    }
    expect(mocks.startStoryRun).not.toHaveBeenCalled();
  });

  it("advance: a runaway tick loop gets 429 + Retry-After (the client waits like a lease)", async () => {
    mocks.rpc.mockResolvedValue({ data: 7, error: null });
    const res = await advanceRoute.POST(post(`/api/ai/story-runs/${RUN}/advance`), ctx(RUN));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(mocks.advanceStoryRun).not.toHaveBeenCalled();
    const { advanceStory } = await import("@/lib/storybook/run/client");
    const out = await advanceStory(RUN, { fetchImpl: async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "7" } }) });
    expect(out).toEqual({ kind: "leased", retryAfterMs: 7000 });
  });

  it("story-rewrite: 429 before any model call; the start client shows plain copy for 402 / 429", async () => {
    mocks.rpc.mockResolvedValue({ data: 30, error: null });
    const res = await rewriteRoute.POST(post(`/api/books/${BOOK}/story-rewrite`, { blockRef: "b1", kind: "shorter", text: "x", source: "ai" }), ctx(BOOK));
    expect(res.status).toBe(429);
    expect(mocks.rewritePageText).not.toHaveBeenCalled();
    const { startStory, storyStartErrorCopy } = await import("@/lib/storybook/run/client");
    const limit = await startStory(BOOK, { fetchImpl: async () => new Response(JSON.stringify({ error: "preview_limit" }), { status: 402 }) });
    expect(limit).toEqual({ kind: "preview_limit" });
    expect(storyStartErrorCopy(limit)).toMatch(/free previews/);
    const busy = await startStory(BOOK, { fetchImpl: async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }) });
    expect(busy).toEqual({ kind: "rate_limited", retryAfterMs: 60_000 });
  });

  it("signed out → 401 and the limiter is never asked (no anonymous buckets)", async () => {
    mocks.user = null;
    expect((await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
