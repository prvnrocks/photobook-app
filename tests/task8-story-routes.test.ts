// Task 8: the storybook job routes and the editor's story routes (mocked job / service / DB).
//   POST /api/ai/story-runs            201 / 409 already_running + the running job's id / 409 user_edited,
//                                      no_photos / 422 / 503 story_unavailable (migration missing) / 401 / 403
//   GET  /api/ai/story-runs/[id]       owner view (other run kinds → 404)
//   POST /api/ai/story-runs/[id]/advance  200 view / 202 leased + Retry-After / 404
//   POST /api/ai/story-runs/[id]/cancel   200 view (idempotent)
//   POST /api/books/[id]/story-rewrite    200 { text, lang, proposal } / error mapping
//   GET  /api/books/[id]/story-doc        { doc, rev }
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as { id: string } | null,
  startStoryRun: vi.fn(),
  advanceStoryRun: vi.fn(),
  cancelStoryRun: vi.fn(),
  getStoryRunForOwner: vi.fn(),
  getLatestStoryRunForBook: vi.fn(),
  rewritePageText: vi.fn(),
  getMyBook: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/ai/story/run", async () => {
  const { storyRunViewOf } = await import("@/lib/storybook/run/progress");
  return { startStoryRun: mocks.startStoryRun, advanceStoryRun: mocks.advanceStoryRun, cancelStoryRun: mocks.cancelStoryRun, storyRunView: storyRunViewOf, STORY_TICK_BUDGET_MS: 40_000 };
});
vi.mock("@/lib/db/agent-runs", async () => {
  class AgentRunsQueryError extends Error {
    constructor(
      op: string,
      public readonly code?: string,
    ) {
      super(op);
    }
  }
  return { AgentRunsQueryError, getStoryRunForOwner: mocks.getStoryRunForOwner, getLatestStoryRunForBook: mocks.getLatestStoryRunForBook };
});
vi.mock("@/lib/ai/story/rewrite-page-text", () => ({ rewritePageText: mocks.rewritePageText }));
vi.mock("@/lib/ai/story/service", () => {
  class StoryError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return { StoryError };
});
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook }));

const startRoute = await import("@/app/api/ai/story-runs/route");
const statusRoute = await import("@/app/api/ai/story-runs/[id]/route");
const advanceRoute = await import("@/app/api/ai/story-runs/[id]/advance/route");
const cancelRoute = await import("@/app/api/ai/story-runs/[id]/cancel/route");
const rewriteRoute = await import("@/app/api/books/[id]/story-rewrite/route");
const docRoute = await import("@/app/api/books/[id]/story-doc/route");
const { AgentRunsQueryError } = await import("@/lib/db/agent-runs");
const { StoryError } = await import("@/lib/ai/story/service");

const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const ORIGIN = { origin: "http://localhost:3000" };
const post = (url: string, body?: unknown, headers: Record<string, string> = ORIGIN) =>
  new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (url: string) => new NextRequest(`http://localhost:3000${url}`, { headers: { host: "localhost:3000" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const row = (state: string, over: Record<string, unknown> = {}) => ({ id: RUN, book_id: BOOK, state, ai_status: null, progress: {}, error_code: null, mode: "live", trigger: "storybook", started_at: "", finished_at: null, ...over });
const VIEW = { runId: RUN, state: "discovering", progress: {}, done: false, aiStatus: null, errorCode: null, mode: "live" };

let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  for (const m of Object.values(mocks)) if (typeof m === "function" && "mockReset" in m) (m as ReturnType<typeof vi.fn>).mockReset();
  logs = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => logs.mockRestore());

describe("POST /api/ai/story-runs", () => {
  it("201 with the run id and its first view", async () => {
    mocks.startStoryRun.mockResolvedValue({ ok: true, runId: RUN, mode: "live", view: VIEW });
    const res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: RUN, mode: "live", view: VIEW });
    expect(mocks.startStoryRun).toHaveBeenCalledWith({ bookId: BOOK, userId: mocks.user!.id });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("a second start while one runs → 409 already_running with the running job's id (an album build → null)", async () => {
    mocks.startStoryRun.mockResolvedValue({ ok: false, error: "already_running" });
    mocks.getLatestStoryRunForBook.mockResolvedValue(row("writing"));
    let res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_running", runId: RUN });
    mocks.getLatestStoryRunForBook.mockResolvedValue(row("done"));
    res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }));
    expect(await res.json()).toEqual({ error: "already_running", runId: null });
  });

  it("refusals map to plain codes; nothing about the book leaks", async () => {
    for (const [error, status] of [["user_edited", 409], ["no_photos", 409], ["unsupported_design", 422], ["not_found", 404]] as const) {
      mocks.startStoryRun.mockResolvedValueOnce({ ok: false, error });
      const res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });

  it("migration 2800 missing (trigger check) → 503 story_unavailable; other errors → 500; logs carry codes only", async () => {
    mocks.startStoryRun.mockRejectedValueOnce(new AgentRunsQueryError("create run", "23514"));
    let res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "story_unavailable" });
    mocks.startStoryRun.mockRejectedValueOnce(new Error(`boom ${BOOK}`));
    res = await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(BOOK);
  });

  it("401 signed out, 403 cross-origin, 400 bad body, 404 bad id — no job started", async () => {
    mocks.user = null;
    expect((await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }))).status).toBe(401);
    mocks.user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    expect((await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await startRoute.POST(post("/api/ai/story-runs", { bookId: BOOK, extra: 1 }))).status).toBe(400);
    expect((await startRoute.POST(post("/api/ai/story-runs", { bookId: "nope" }))).status).toBe(404);
    expect(mocks.startStoryRun).not.toHaveBeenCalled();
  });
});

describe("GET / advance / cancel", () => {
  it("status: the owner's storybook run as a view; anything else 404", async () => {
    mocks.getStoryRunForOwner.mockResolvedValueOnce(row("writing", { progress: { stages: { writing: { status: "running", done: 1, chapters: 3 } } } }));
    const res = await statusRoute.GET(get(`/api/ai/story-runs/${RUN}`), ctx(RUN));
    const body = await res.json();
    expect(body).toMatchObject({ runId: RUN, state: "writing", done: false });
    expect(body.progress.stages.writing).toEqual({ status: "running", done: 1, chapters: 3 });
    expect(JSON.stringify(body)).not.toMatch(/cursor|cost|token/);
    mocks.getStoryRunForOwner.mockResolvedValueOnce(null);
    expect((await statusRoute.GET(get(`/api/ai/story-runs/${RUN}`), ctx(RUN))).status).toBe(404);
  });

  it("advance: 200 view, 202 leased with Retry-After, 404 for a run that isn't the caller's", async () => {
    mocks.getStoryRunForOwner.mockResolvedValue(row("writing"));
    mocks.advanceStoryRun.mockResolvedValueOnce({ view: VIEW });
    let res = await advanceRoute.POST(post(`/api/ai/story-runs/${RUN}/advance`), ctx(RUN));
    expect(res.status).toBe(200);
    // the route hands the user and the run row it already read to the tick (no second read)
    expect(mocks.advanceStoryRun).toHaveBeenCalledWith(RUN, { budgetMs: 40_000, owner: { userId: mocks.user!.id, run: row("writing") } });
    mocks.advanceStoryRun.mockResolvedValueOnce({ leased: true });
    res = await advanceRoute.POST(post(`/api/ai/story-runs/${RUN}/advance`), ctx(RUN));
    expect(res.status).toBe(202);
    expect(res.headers.get("retry-after")).toBe("2");
    mocks.getStoryRunForOwner.mockResolvedValueOnce(null);
    res = await advanceRoute.POST(post(`/api/ai/story-runs/${RUN}/advance`), ctx(RUN));
    expect(res.status).toBe(404);
    expect(advanceRoute.maxDuration).toBe(300);
  });

  it("cancel: 200 with the stopped view; not the caller's → 404; cross-origin → 403", async () => {
    mocks.getStoryRunForOwner.mockResolvedValue(row("writing"));
    mocks.cancelStoryRun.mockResolvedValue({ view: { ...VIEW, state: "failed", done: true, errorCode: "cancelled" } });
    let res = await cancelRoute.POST(post(`/api/ai/story-runs/${RUN}/cancel`), ctx(RUN));
    expect(await res.json()).toMatchObject({ errorCode: "cancelled", done: true });
    expect((await cancelRoute.POST(post(`/api/ai/story-runs/${RUN}/cancel`, undefined, { origin: "https://evil.test" }), ctx(RUN))).status).toBe(403);
    mocks.getStoryRunForOwner.mockResolvedValueOnce(null);
    res = await cancelRoute.POST(post(`/api/ai/story-runs/${RUN}/cancel`), ctx(RUN));
    expect(res.status).toBe(404);
  });
});

describe("editor story routes", () => {
  it("story-rewrite: passes block ref, text, source and the instruction; maps StoryError codes", async () => {
    mocks.rewritePageText.mockResolvedValueOnce({ text: "Shorter.", lang: "en", proposal: true });
    const body = { blockRef: "b3", kind: "tone", tone: "joyful", text: "Long words.", source: "user" };
    let res = await rewriteRoute.POST(post(`/api/books/${BOOK}/story-rewrite`, body), ctx(BOOK));
    expect(await res.json()).toEqual({ text: "Shorter.", lang: "en", proposal: true });
    expect(mocks.rewritePageText).toHaveBeenCalledWith({ bookId: BOOK, blockRef: "b3", text: "Long words.", source: "user", instruction: { kind: "tone", tone: "joyful" } });
    for (const [code, status] of [["not_found", 404], ["conflict", 409], ["ungrounded", 422], ["limit_reached", 429], ["budget_exhausted", 429], ["ai_off", 503], ["refused", 503]] as const) {
      mocks.rewritePageText.mockRejectedValueOnce(new StoryError(code));
      res = await rewriteRoute.POST(post(`/api/books/${BOOK}/story-rewrite`, body), ctx(BOOK));
      expect(res.status).toBe(status);
    }
    expect((await rewriteRoute.POST(post(`/api/books/${BOOK}/story-rewrite`, { ...body, blockRef: "x" }), ctx(BOOK))).status).toBe(400);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("Long words.");
  });

  it("story-doc: the owner's parsed doc + rev; nothing parsable → 404", async () => {
    mocks.getMyBook.mockResolvedValueOnce(null);
    expect((await docRoute.GET(get(`/api/books/${BOOK}/story-doc`), ctx(BOOK))).status).toBe(404);
    mocks.getMyBook.mockResolvedValueOnce({ id: BOOK, doc: {}, doc_rev: 3 });
    expect((await docRoute.GET(get(`/api/books/${BOOK}/story-doc`), ctx(BOOK))).status).toBe(404);
  });
});
