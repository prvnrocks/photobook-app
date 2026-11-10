// POST /api/ai/rewrite (M5 Task 7). No live API calls: the real Rewriter runs on the
// ReplayTransport (D-024); the capped-run RPC is simulated in memory with the semantics of
// create_rewrite_run_capped (0900): in-flight → already_running; enforce && all runs >= dailyCap →
// daily_limit; enforce && ok + in-flight >= cap → limit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AgentStepRecord } from "@/lib/ai/run-step";
import type { AgentRequest, AgentTransport } from "@/lib/ai/transport";

vi.mock("server-only", () => ({}));

type SimRun = { id: string; bookId: string; mode: string; state: "queued" | "done" | "failed"; aiStatus: string | null; errorCode: string | null };

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  getMyBook: vi.fn(),
  getPhotoNotesAdmin: vi.fn(),
  getUserMemoryAdmin: vi.fn(),
  transport: null as AgentTransport | null,
  requests: [] as AgentRequest<unknown>[],
  runs: [] as SimRun[],
  createCalls: [] as unknown[][],
  createError: null as Error | null,
  finishCalls: [] as unknown[][],
  steps: [] as AgentStepRecord[],
  insertStepError: null as Error | null,
  countError: null as Error | null,
  todaySpend: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook }));
vi.mock("@/lib/db/photo-notes", () => ({ getPhotoNotesAdmin: mocks.getPhotoNotesAdmin }));
vi.mock("@/lib/db/memory", () => ({ getUserMemoryAdmin: mocks.getUserMemoryAdmin }));
vi.mock("@/lib/db/ai-spend", () => ({ getTodaySpendUsd: mocks.todaySpend }));
vi.mock("@/lib/ai/transport-factory", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/transport-factory")>();
  return {
    getTransport: (mode: Parameters<typeof real.getTransport>[0]) => {
      const inner = mocks.transport ?? real.getTransport(mode);
      if (!inner) return null;
      const spy: AgentTransport = {
        kind: inner.kind,
        parse: (req) => {
          mocks.requests.push(req as AgentRequest<unknown>);
          return inner.parse(req);
        },
      };
      return spy;
    },
  };
});
vi.mock("@/lib/db/agent-runs", async (orig) => {
  const real = await orig<typeof import("@/lib/db/agent-runs")>();
  let n = 0;
  return {
    ...real,
    createRewriteRun: vi.fn(async (input: Parameters<typeof real.createRewriteRun>[0]) => {
      const { bookId, userId, mode, cap, dailyCap, enforce } = input;
      mocks.createCalls.push([bookId, userId, mode, cap, enforce, dailyCap]);
      if (mocks.createError) throw mocks.createError;
      const mine = mocks.runs.filter((r) => r.bookId === bookId);
      if (mine.some((r) => r.state === "queued")) return { error: "already_running" };
      if (enforce && mocks.runs.length >= dailyCap) return { error: "daily_limit" };
      if (enforce && mine.filter((r) => r.aiStatus === "ok").length >= cap) return { error: "limit" };
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`;
      mocks.runs.push({ id, bookId, mode, state: "queued", aiStatus: null, errorCode: null });
      return { id };
    }),
    finishRewriteRun: vi.fn(async (runId: string, r: { ai_status: "ok" | "failed"; error_code?: string | null }) => {
      mocks.finishCalls.push([runId, r]);
      const run = mocks.runs.find((x) => x.id === runId && x.state === "queued");
      if (!run) return false;
      run.state = r.ai_status === "ok" ? "done" : "failed";
      run.aiStatus = r.ai_status;
      run.errorCode = r.error_code ?? null;
      return true;
    }),
    getRewritesUsed: vi.fn(async (bookId: string) => {
      if (mocks.countError) throw mocks.countError;
      return mocks.runs.filter((r) => r.bookId === bookId && r.aiStatus === "ok").length;
    }),
    stepLogger: (runId: string) => ({
      insertStep: async (row: AgentStepRecord) => {
        if (mocks.insertStepError) throw mocks.insertStepError;
        expect(row.runId).toBe(runId);
        mocks.steps.push(row);
      },
      addRunTotals: async () => {},
    }),
  };
});

const route = await import("@/app/api/ai/rewrite/route");
const { TransportError } = await import("@/lib/ai/transport");
const { CURATOR_PROMPT_VERSION } = await import("@/lib/ai/prompts/curator");

const BOOK = "11111111-1111-4111-8111-111111111111";
const P1 = "44444444-4444-4444-8444-444444444441";
const P2 = "44444444-4444-4444-8444-444444444442";
const ORIGIN = { origin: "http://localhost:3000" };
const SECRET_CAPTION = "Zebra picnic wonderland by the old pier";
const SECRET_NOTE = "SECRETNOTE grandmother holding a blue kite";
const SECRET_MEMORY = "Zubaida";

const crop = { x: 0.5, y: 0.5, zoom: 1 };
const DOC = {
  version: 1,
  format: "A5_PORTRAIT",
  occasion: "family",
  cover: { layout: "cover-full", photoId: null, title: "Our summer", subtitle: "" },
  chapters: [{ id: "c1", title: "Beach day", dateLabel: "July 2026", place: null }],
  pages: [
    { id: "pg1", chapterId: "c1", layout: "two-up", slots: [{ photoId: P1, crop }, { photoId: P2, crop }, { photoId: P1, crop }], caption: null },
    { id: "pg2", chapterId: "c1", layout: "one", slots: [{ photoId: null, crop }], caption: null },
  ],
  style: { background: "#ffffff", font: "Cairo" },
};
const bookRow = (o: Record<string, unknown> = {}) => ({
  id: BOOK,
  title: "Our summer",
  occasion: "family",
  tone: "nostalgic",
  caption_lang: "en",
  is_paid: false,
  max_pages: 20,
  page_count: 2,
  doc: DOC,
  updated_at: "2026-11-09T10:00:00Z",
  doc_rev: 3,
  ...o,
});

function post(body: unknown, headers: Record<string, string> = ORIGIN) {
  return new NextRequest("http://localhost:3000/api/ai/rewrite", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const BODY = { bookId: BOOK, pageId: "pg1", instruction: "rewrite", text: SECRET_CAPTION };
const call = (body: unknown = BODY, headers?: Record<string, string>) => route.POST(post(body, headers));

async function read(res: Response) {
  expect(res.headers.get("cache-control")).toBe("no-store");
  return { status: res.status, body: JSON.parse(await res.text()) };
}

let logs: string[];
beforeEach(() => {
  mocks.user = { id: "u1" };
  mocks.transport = null;
  mocks.requests = [];
  mocks.runs = [];
  mocks.createCalls = [];
  mocks.createError = null;
  mocks.finishCalls = [];
  mocks.steps = [];
  mocks.insertStepError = null;
  mocks.countError = null;
  mocks.todaySpend.mockReset().mockResolvedValue(0);
  mocks.getMyBook.mockReset().mockResolvedValue(bookRow());
  mocks.getPhotoNotesAdmin.mockReset().mockResolvedValue([
    { id: P1, takenAt: "2026-07-04T10:00:00+04:00", place: null, ai: { v: CURATOR_PROMPT_VERSION, description: SECRET_NOTE, scene: "group", mood: "joyful", quality: 0.8, coverWorthy: false } },
  ]);
  mocks.getUserMemoryAdmin.mockReset().mockResolvedValue({ prefs: { knownNames: [SECRET_MEMORY] }, updatedAt: "x" });
  vi.stubEnv("AI_MODE", "replay");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  logs = [];
  for (const k of ["error", "warn", "log", "info"] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Nothing private in logged steps, run rows (error codes) or console output (D-027). */
function expectNoPrivateData() {
  const dump = JSON.stringify({ steps: mocks.steps, runs: mocks.runs, finish: mocks.finishCalls, logs });
  for (const s of [SECRET_CAPTION, "Zebra", SECRET_NOTE, "SECRETNOTE", SECRET_MEMORY]) expect(dump).not.toContain(s);
}

describe("POST /api/ai/rewrite", () => {
  it("exports route fields only", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(60);
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "maxDuration", "runtime"]);
  });

  it("403 cross-origin or without Origin, before auth", async () => {
    mocks.user = null;
    expect(await read(await call(BODY, { origin: "https://evil.example" }))).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await read(await call(BODY, { origin: "" }))).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("401 signed out", async () => {
    mocks.user = null;
    expect(await read(await call())).toEqual({ status: 401, body: { error: "unauthenticated" } });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it.each([
    ["not json"],
    [{ ...BODY, instruction: "poem" }],
    [{ ...BODY, instruction: "tone:angry" }],
    [{ ...BODY, instruction: "Rewrite" }],
    [{ ...BODY, bookId: "abc" }],
    [{ ...BODY, pageId: "" }],
    [{ ...BODY, text: "" }],
    [{ ...BODY, text: "   " }],
    [{ ...BODY, text: "a".repeat(201) }],
    [{ ...BODY, text: "\ud83d broken" }],
    [{ ...BODY, targetLang: "ar" }],
    ["x".repeat(5000)],
  ])("400 invalid body %#", async (body) => {
    expect(await read(await call(body))).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(mocks.createCalls).toHaveLength(0);
  });

  it("accepts tone:<Tone> and exactly 200 code points (emoji = 1 code point)", async () => {
    const r1 = await read(await call({ ...BODY, instruction: "tone:fun" }));
    expect(r1.status).toBe(200);
    const text = "😀".repeat(199) + "a";
    const r2 = await read(await call({ ...BODY, text }));
    expect(r2.status).toBe(200);
  });

  it("404 for a book that isn't the caller's — no run, no notes", async () => {
    mocks.getMyBook.mockResolvedValue(null);
    expect(await read(await call())).toEqual({ status: 404, body: { error: "not_found" } });
    expect(mocks.createCalls).toHaveLength(0);
    expect(mocks.getPhotoNotesAdmin).not.toHaveBeenCalled();
  });

  it("503 ai_off when AI is off — no run created", async () => {
    vi.stubEnv("AI_MODE", "off");
    expect(await read(await call())).toEqual({ status: 503, body: { error: "ai_off" } });
    expect(mocks.createCalls).toHaveLength(0);
  });

  it("replay: 200 with text, lang and remaining; run finished ok; free cap 20, enforced", async () => {
    const r = await read(await call());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: expect.any(String), lang: "en", remaining: 19 });
    expect(r.body.text).not.toBe(SECRET_CAPTION);
    expect(mocks.createCalls).toEqual([[BOOK, "u1", "replay", 20, true, 60]]);
    expect(mocks.runs).toMatchObject([{ state: "done", aiStatus: "ok", errorCode: null }]);
    expect(mocks.steps).toHaveLength(1);
    expect(mocks.steps[0]).toMatchObject({ agent: "rewriter", status: "ok" });

    const r2 = await read(await call({ ...BODY, instruction: "shorter" }));
    expect(r2.body.remaining).toBe(18);
    expectNoPrivateData();
  });

  it("loads photo notes server-side from the SAVED page (slot order, unique) and sends them as text only", async () => {
    await call();
    expect(mocks.getPhotoNotesAdmin).toHaveBeenCalledWith(BOOK, [P1, P2]);
    const msg = mocks.requests[0].messages[0].content;
    expect(typeof msg).toBe("string");
    expect(msg).toContain("grandmother holding a blue kite");
    expect(JSON.stringify(mocks.requests[0].messages)).not.toContain('"image"');
    expectNoPrivateData();
  });

  it("unknown (unsaved) page → no photo notes, still 200; page without photos → no lookup", async () => {
    expect((await read(await call({ ...BODY, pageId: "new-page" }))).status).toBe(200);
    expect((await read(await call({ ...BODY, pageId: "pg2" }))).status).toBe(200);
    expect(mocks.getPhotoNotesAdmin).not.toHaveBeenCalled();
    expect(mocks.requests[0].messages[0].content).toContain("- none");
  });

  it("an unparsable saved doc or a failed notes/memory read degrades to no notes", async () => {
    mocks.getMyBook.mockResolvedValue(bookRow({ doc: {} }));
    expect((await read(await call())).status).toBe(200);
    mocks.getMyBook.mockResolvedValue(bookRow());
    mocks.getPhotoNotesAdmin.mockRejectedValue(Object.assign(new Error("boom"), { code: "XX000" }));
    mocks.getUserMemoryAdmin.mockRejectedValue(new Error("boom"));
    expect((await read(await call())).status).toBe(200);
    expect(logs.join("\n")).toContain("notes failed (XX000)");
  });

  it("21st rewrite on a free book → 429 limit, remaining 0", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await read(await call({ ...BODY, text: `${SECRET_CAPTION} take ${"x".repeat(i + 1)}` }));
      expect(r.status).toBe(200);
      expect(r.body.remaining).toBe(19 - i);
    }
    expect(await read(await call())).toEqual({ status: 429, body: { error: "limit", remaining: 0 } });
    expect(mocks.runs).toHaveLength(20);
  });

  it("paid book: cap 200, allows more than 20", async () => {
    mocks.getMyBook.mockResolvedValue(bookRow({ is_paid: true }));
    let last: { status: number; body: { remaining: number } } | null = null;
    for (let i = 0; i < 21; i++) last = await read(await call({ ...BODY, text: `${SECRET_CAPTION} ${"y".repeat(i + 1)}` }));
    expect(last).toEqual({ status: 200, body: expect.objectContaining({ remaining: 179 }) });
    expect(mocks.createCalls[0][3]).toBe(200);
    expect(mocks.createCalls[0][5]).toBe(400);
  });

  it("failure → 502 {error, retryable}, not counted, run finished failed with the code", async () => {
    mocks.transport = { kind: "live", parse: async () => { throw new TransportError("auth", "denied"); } };
    expect(await read(await call())).toEqual({ status: 502, body: { error: "auth", retryable: false } });
    expect(mocks.runs).toMatchObject([{ state: "failed", aiStatus: "failed", errorCode: "auth" }]);

    mocks.transport = null;
    const ok = await read(await call());
    expect(ok.body.remaining).toBe(19); // the failure didn't count
    expectNoPrivateData();
  });

  it("retryable transport failure → 502 retryable true (one transport retry)", async () => {
    let calls = 0;
    mocks.transport = { kind: "live", parse: async () => { calls++; throw new TransportError("rate_limited", "429"); } };
    expect(await read(await call())).toEqual({ status: 502, body: { error: "rate_limited", retryable: true } });
    expect(calls).toBe(2);
    expect(mocks.runs[0]).toMatchObject({ state: "failed", errorCode: "rate_limited" });
  });

  it("unusable output twice → 502 rewrite_unusable", async () => {
    mocks.transport = {
      kind: "live",
      // The model echoes the caption unchanged → pre-check "unchanged" on both attempts.
      parse: async () => ({
        parsed: { text: SECRET_CAPTION } as never,
        stopReason: "end_turn",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        model: "claude-opus-5-5",
        latencyMs: 1,
      }),
    };
    const r = await read(await call());
    expect(r).toEqual({ status: 502, body: { error: "rewrite_unusable", retryable: false } });
    expect(mocks.runs[0]).toMatchObject({ state: "failed", errorCode: "rewrite_unusable" });
    expect(mocks.steps).toHaveLength(2);
    expectNoPrivateData();
  });

  describe("D-059 daily AI budget (live mode)", () => {
    const liveOk: AgentTransport = {
      kind: "live",
      parse: async () => ({
        parsed: { text: "A brand new caption about the day" } as never,
        stopReason: "end_turn",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        model: "claude-opus-5-5",
        latencyMs: 1,
      }),
    };
    beforeEach(() => {
      vi.stubEnv("AI_MODE", "live");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      mocks.transport = liveOk;
    });

    it("over budget → 429 budget_exhausted, no run row, no model call, nothing counted", async () => {
      vi.stubEnv("AI_DAILY_BUDGET_USD", "10");
      mocks.todaySpend.mockResolvedValue(10.5);
      expect(await read(await call())).toEqual({ status: 429, body: { error: "budget_exhausted" } });
      expect(mocks.createCalls).toHaveLength(0);
      expect(mocks.runs).toHaveLength(0);
      expect(mocks.requests).toHaveLength(0);
      expect(mocks.steps).toHaveLength(0);
      expect(mocks.getPhotoNotesAdmin).not.toHaveBeenCalled();
    });

    it("under budget → unchanged", async () => {
      vi.stubEnv("AI_DAILY_BUDGET_USD", "10");
      mocks.todaySpend.mockResolvedValue(2);
      const r = await read(await call());
      expect(r.status).toBe(200);
      expect(mocks.createCalls).toHaveLength(1);
      expect(mocks.requests).toHaveLength(1);
    });

    it("unset budget → unchanged, spend never queried", async () => {
      vi.stubEnv("AI_DAILY_BUDGET_USD", "");
      mocks.todaySpend.mockResolvedValue(1_000);
      expect((await read(await call())).status).toBe(200);
      expect(mocks.todaySpend).not.toHaveBeenCalled();
    });

    it("spend query failure → fails open, logs the code only", async () => {
      vi.stubEnv("AI_DAILY_BUDGET_USD", "10");
      mocks.todaySpend.mockRejectedValue(Object.assign(new Error("db down"), { code: "57P01" }));
      expect((await read(await call())).status).toBe(200);
      expect(logs).toContain("[ai-budget] spend_query_failed (57P01)");
      expectNoPrivateData();
    });

    it("replay mode is never refused", async () => {
      vi.stubEnv("AI_MODE", "replay");
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      mocks.transport = null;
      vi.stubEnv("AI_DAILY_BUDGET_USD", "0");
      expect((await read(await call())).status).toBe(200);
      expect(mocks.todaySpend).not.toHaveBeenCalled();
    });
  });

  it("oversized body is rejected by the streamed reader (Content-Length or counted bytes) → 400", async () => {
    const big = JSON.stringify({ ...BODY, text: "a".repeat(5000) });
    expect(await read(await call(big))).toEqual({ status: 400, body: { error: "invalid_body" } });
    // A body without Content-Length is counted while streaming.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const req = new NextRequest("http://localhost:3000/api/ai/rewrite", {
      method: "POST",
      headers: { host: "localhost:3000", "content-type": "application/json", ...ORIGIN },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    expect(req.headers.get("content-length")).toBeNull();
    expect(await read(await route.POST(req))).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(mocks.createCalls).toHaveLength(0);
  });

  it.each([["Beach day"], ["يوم على الشاطئ"], ["One"], ["  Sun   and   sea  "]])(
    "shorter on a caption of ≤ 3 words → 400 too_short, before any run or lookup (%s)",
    async (text) => {
      expect(await read(await call({ ...BODY, instruction: "shorter", text }))).toEqual({ status: 400, body: { error: "too_short" } });
      expect(mocks.createCalls).toHaveLength(0);
      expect(mocks.getMyBook).not.toHaveBeenCalled();
      expect(mocks.requests).toHaveLength(0);
    },
  );

  it("shorter on 4 words is allowed; other instructions on short captions are allowed", async () => {
    expect((await read(await call({ ...BODY, instruction: "shorter", text: "Sun and sea today" }))).status).not.toBe(400);
    expect((await read(await call({ ...BODY, instruction: "rewrite", text: "Beach day" }))).status).toBe(200);
  });

  it("daily ceiling (all rewrite runs of the user, any outcome) → 429 daily_limit, no model call", async () => {
    for (let i = 0; i < 60; i++) {
      mocks.runs.push({ id: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`, bookId: "other", mode: "replay", state: "failed", aiStatus: "failed", errorCode: "refused" });
    }
    expect(await read(await call())).toEqual({ status: 429, body: { error: "daily_limit" } });
    expect(mocks.requests).toHaveLength(0);
    expect(mocks.finishCalls).toHaveLength(0);
  });

  it.each(["PGRST202", "42883"])("rewrite RPC missing before migration 0900 (%s) → 503 ai_unavailable, not 500", async (code) => {
    const { AgentRunsQueryError } = await import("@/lib/db/agent-runs");
    mocks.createError = new AgentRunsQueryError("create rewrite run", code);
    expect(await read(await call())).toEqual({ status: 503, body: { error: "ai_unavailable" } });
    expect(mocks.requests).toHaveLength(0);
  });

  it("any other RPC error stays 500 server_error", async () => {
    const { AgentRunsQueryError } = await import("@/lib/db/agent-runs");
    mocks.createError = new AgentRunsQueryError("create rewrite run", "42501");
    expect(await read(await call())).toEqual({ status: 500, body: { error: "server_error" } });
  });

  it("already_running → 409", async () => {
    mocks.runs.push({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", bookId: BOOK, mode: "replay", state: "queued", aiStatus: null, errorCode: null });
    expect(await read(await call())).toEqual({ status: 409, body: { error: "already_running" } });
    expect(mocks.requests).toHaveLength(0);
  });

  it("translate: target computed server-side (EN → ar, AR → en)", async () => {
    const r = await read(await call({ ...BODY, instruction: "translate" }));
    expect(r.status).toBe(200);
    expect(r.body.lang).toBe("ar");
    expect(r.body.text).toMatch(/[؀-ۿ]/);
    expect((mocks.requests[0].scenarioMeta as { targetLang: string }).targetLang).toBe("ar");

    const r2 = await read(await call({ ...BODY, instruction: "translate", text: "يوم جميل على الشاطئ" }));
    expect(r2.body.lang).toBe("en");
  });

  it("non-translate target = caption's script; letterless caption → book caption_lang", async () => {
    mocks.getMyBook.mockResolvedValue(bookRow({ caption_lang: "ar" }));
    expect((await read(await call({ ...BODY, text: "A very good day" }))).body.lang).toBe("en");
    expect((await read(await call({ ...BODY, text: "🎉🎉 2026" }))).body.lang).toBe("ar");
  });

  it("run is always finished when the rewrite throws (logger failure) → 500", async () => {
    mocks.insertStepError = Object.assign(new Error(`insert failed ${SECRET_CAPTION}`), { code: "PGRST" });
    expect(await read(await call())).toEqual({ status: 500, body: { error: "server_error" } });
    expect(mocks.runs).toMatchObject([{ state: "failed", aiStatus: "failed", errorCode: "server_error" }]);
    expect(mocks.finishCalls).toHaveLength(1);
    expectNoPrivateData();
  });

  it("a failed usage count still returns the text with remaining null", async () => {
    mocks.countError = new Error("x");
    const r = await read(await call());
    expect(r.status).toBe(200);
    expect(r.body.remaining).toBeNull();
    expect(mocks.runs[0].aiStatus).toBe("ok");
  });

  it("never writes the doc", async () => {
    await call();
    // Only the mocked getMyBook touches books; no save helper exists in the route's imports.
    expect(mocks.getMyBook).toHaveBeenCalledTimes(1);
  });
});
