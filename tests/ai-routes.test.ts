import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  startRun: vi.fn(),
  advance: vi.fn(),
  getProgress: vi.fn(),
  getMyBook: vi.fn(),
  getActiveRunForBook: vi.fn(),
  getLatestRunForBook: vi.fn(),
  hasFinishedLiveAiRun: vi.fn(),
  getRunForOwner: vi.fn(),
  setUserOverride: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/ai/orchestrator", () => ({
  startRun: mocks.startRun,
  advance: mocks.advance,
  getProgress: mocks.getProgress,
}));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook }));
vi.mock("@/lib/db/agent-runs", () => ({
  getActiveRunForBook: mocks.getActiveRunForBook,
  getLatestRunForBook: mocks.getLatestRunForBook,
  hasFinishedLiveAiRun: mocks.hasFinishedLiveAiRun,
  getRunForOwner: mocks.getRunForOwner,
  isBuildRunTrigger: (t: unknown) => t === "build" || t === "rebuild",
}));
vi.mock("@/lib/db/photos", () => ({ setUserOverride: mocks.setUserOverride }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const runsRoute = await import("@/app/api/ai/runs/route");
const runRoute = await import("@/app/api/ai/runs/[id]/route");
const advanceRoute = await import("@/app/api/ai/runs/[id]/advance/route");
const { togglePhotoAction } = await import("@/app/books/[id]/review/actions");

const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const RUN2 = "33333333-3333-4333-8333-333333333333";
const PHOTO = "44444444-4444-4444-8444-444444444444";
const ORIGIN = { origin: "http://localhost:3000" };
const PROGRESS = { phase: "curating", photosTotal: 10, photosDone: 5, batchesTotal: 2, batchesDone: 1, photosCapped: 0 };
const SECRET = "SECRET_DESCRIPTION_beach_sunset";

function post(url: string, body?: unknown, headers: Record<string, string> = ORIGIN) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const get = (url: string) => new NextRequest(`http://localhost:3000${url}`, { headers: { host: "localhost:3000" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function expectShape(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("cursor");
  expect(JSON.parse(text)).toEqual(body);
}

let errors: string[];
beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === "function") m.mockReset();
  mocks.user = { id: "u1" };
  mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: {} });
  mocks.getLatestRunForBook.mockResolvedValue(null);
  mocks.hasFinishedLiveAiRun.mockResolvedValue(false);
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/ai/runs", () => {
  const call = (body: unknown = { bookId: BOOK }, headers?: Record<string, string>) =>
    runsRoute.POST(post("/api/ai/runs", body, headers));

  it("exports route fields only", () => {
    expect(runsRoute.runtime).toBe("nodejs");
    expect(runsRoute.dynamic).toBe("force-dynamic");
    expect(runsRoute.maxDuration).toBe(60);
    expect(Object.keys(runsRoute).sort()).toEqual(["POST", "dynamic", "maxDuration", "runtime"]);
  });

  it("403 without Origin, before auth", async () => {
    mocks.user = null;
    await expectShape(await call({ bookId: BOOK }, { origin: "" }), 403, { error: "forbidden" });
    await expectShape(await call({ bookId: BOOK }, { origin: "https://evil.example" }), 403, { error: "forbidden" });
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("401 without a user", async () => {
    mocks.user = null;
    await expectShape(await call(), 401, { error: "unauthenticated" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it.each([["not json"], [{}], [{ bookId: 5 }], [{ bookId: BOOK, trigger: "rewrite" }], ["x".repeat(2000)]])(
    "400 for invalid body %#",
    async (body) => {
      await expectShape(await call(body), 400, { error: "invalid_body" });
      expect(mocks.startRun).not.toHaveBeenCalled();
    },
  );

  it("404 for a non-uuid bookId and for a book that isn't the caller's", async () => {
    await expectShape(await call({ bookId: "abc" }), 404, { error: "not_found" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
    mocks.getMyBook.mockResolvedValue(null);
    await expectShape(await call(), 404, { error: "not_found" });
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("201 with default trigger 'build'", async () => {
    mocks.startRun.mockResolvedValue({ ok: true, runId: RUN, mode: "replay", state: "queued", extra: SECRET });
    await expectShape(await call(), 201, { runId: RUN, mode: "replay", state: "queued" });
    expect(mocks.startRun).toHaveBeenCalledWith({ bookId: BOOK, userId: "u1", trigger: "build" });
  });

  it("passes trigger 'rebuild'", async () => {
    mocks.startRun.mockResolvedValue({ ok: true, runId: RUN, mode: "rule", state: "done" });
    await expectShape(await call({ bookId: BOOK, trigger: "rebuild" }), 201, { runId: RUN, mode: "rule", state: "done" });
    expect(mocks.startRun).toHaveBeenCalledWith({ bookId: BOOK, userId: "u1", trigger: "rebuild" });
  });

  it("derives 'rebuild' server-side after a finished live AI run, whatever the body says (T16 #3)", async () => {
    mocks.startRun.mockResolvedValue({ ok: true, runId: RUN, mode: "live", state: "queued" });
    mocks.hasFinishedLiveAiRun.mockResolvedValue(true);
    await expectShape(await call({ bookId: BOOK, trigger: "build" }), 201, { runId: RUN, mode: "live", state: "queued" });
    expect(mocks.hasFinishedLiveAiRun).toHaveBeenCalledWith(BOOK);
    expect(mocks.startRun).toHaveBeenCalledWith({ bookId: BOOK, userId: "u1", trigger: "rebuild" });
    await call({ bookId: BOOK });
    expect(mocks.startRun).toHaveBeenLastCalledWith({ bookId: BOOK, userId: "u1", trigger: "rebuild" });
  });

  it("derives 'rebuild' when the doc was generated by AI (meta.generator 'ai')", async () => {
    mocks.startRun.mockResolvedValue({ ok: true, runId: RUN, mode: "replay", state: "queued" });
    mocks.getMyBook.mockResolvedValue({
      id: BOOK,
      doc: { version: 1, pages: [], meta: { generator: "ai", userEdited: false } },
    });
    await call({ bookId: BOOK, trigger: "build" });
    expect(mocks.startRun).toHaveBeenCalledWith({ bookId: BOOK, userId: "u1", trigger: "rebuild" });
  });

  it("keeps the hinted trigger for empty / rule docs without a finished live AI run", async () => {
    mocks.startRun.mockResolvedValue({ ok: true, runId: RUN, mode: "live", state: "queued" });
    mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: { version: 1, pages: [], meta: { generator: "rule", userEdited: false } } });
    await call({ bookId: BOOK });
    expect(mocks.startRun).toHaveBeenLastCalledWith({ bookId: BOOK, userId: "u1", trigger: "build" });
    await call({ bookId: BOOK, trigger: "rebuild" });
    expect(mocks.startRun).toHaveBeenLastCalledWith({ bookId: BOOK, userId: "u1", trigger: "rebuild" });
  });

  it("429 limit 'rate' within 10 s of a rule-mode run of the book (T16 #19)", async () => {
    mocks.getLatestRunForBook.mockResolvedValue({
      id: RUN2,
      mode: "rule",
      state: "done",
      started_at: new Date(Date.now() - 3_000).toISOString(),
    });
    const res = await call();
    expect(res.headers.get("retry-after")).toBe("7");
    await expectShape(res, 429, { error: "limit", limit: "rate" });
    expect(mocks.getLatestRunForBook).toHaveBeenCalledWith(BOOK);
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("no rate limit after 10 s, or when the latest run isn't a rule run", async () => {
    mocks.startRun.mockResolvedValue({ ok: true, runId: RUN, mode: "rule", state: "done" });
    mocks.getLatestRunForBook.mockResolvedValue({
      id: RUN2,
      mode: "rule",
      state: "done",
      started_at: new Date(Date.now() - 11_000).toISOString(),
    });
    expect((await call()).status).toBe(201);
    mocks.getLatestRunForBook.mockResolvedValue({
      id: RUN2,
      mode: "replay",
      state: "done",
      started_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect((await call()).status).toBe(201);
    expect(mocks.startRun).toHaveBeenCalledTimes(2);
  });

  it("409 already_running with the active run id (or null)", async () => {
    mocks.startRun.mockResolvedValue({ ok: false, error: "already_running" });
    mocks.getActiveRunForBook.mockResolvedValue({ id: RUN2, progress: { x: SECRET } });
    await expectShape(await call(), 409, { error: "already_running", runId: RUN2 });
    expect(mocks.getActiveRunForBook).toHaveBeenCalledWith(BOOK);
    mocks.getActiveRunForBook.mockResolvedValue(null);
    await expectShape(await call(), 409, { error: "already_running", runId: null });
  });

  it("409 user_edited", async () => {
    mocks.startRun.mockResolvedValue({ ok: false, error: "user_edited" });
    await expectShape(await call(), 409, { error: "user_edited" });
  });

  it.each(["daily_builds", "rebuilds", "analysed_photos"])("429 limit %s", async (limit) => {
    mocks.startRun.mockResolvedValue({ ok: false, error: "limit", limit });
    await expectShape(await call(), 429, { error: "limit", limit });
  });

  it("404 when startRun says not_found", async () => {
    mocks.startRun.mockResolvedValue({ ok: false, error: "not_found" });
    await expectShape(await call(), 404, { error: "not_found" });
  });

  it("500 generic, logs a code only", async () => {
    mocks.startRun.mockRejectedValue(Object.assign(new Error(SECRET), { code: "PGRST116" }));
    await expectShape(await call(), 500, { error: "server_error" });
    expect(errors.join("\n")).toContain("PGRST116");
    expect(errors.join("\n")).not.toContain(SECRET);
    expect(errors.join("\n")).not.toContain(BOOK);
  });
});

describe("GET /api/ai/runs/[id]", () => {
  const view = { state: "curating", progress: PROGRESS, aiStatus: null, errorCode: null, mode: "replay", done: false };

  it("exports route fields only, GET only", () => {
    expect(Object.keys(runRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
  });

  it("401 without a user", async () => {
    mocks.user = null;
    await expectShape(await runRoute.GET(get(`/api/ai/runs/${RUN}`), ctx(RUN)), 401, { error: "unauthenticated" });
    expect(mocks.getProgress).not.toHaveBeenCalled();
  });

  it("404 for a bad uuid / missing run", async () => {
    await expectShape(await runRoute.GET(get("/api/ai/runs/x"), ctx("x")), 404, { error: "not_found" });
    expect(mocks.getProgress).not.toHaveBeenCalled();
    mocks.getProgress.mockResolvedValue(null);
    await expectShape(await runRoute.GET(get(`/api/ai/runs/${RUN}`), ctx(RUN)), 404, { error: "not_found" });
  });

  it("200 ProgressView with only whitelisted fields", async () => {
    mocks.getProgress.mockResolvedValue({ ...view, cursor: { secret: SECRET } });
    await expectShape(await runRoute.GET(get(`/api/ai/runs/${RUN}`), ctx(RUN)), 200, view);
    expect(mocks.getProgress).toHaveBeenCalledWith(RUN);
  });

  it("500 generic", async () => {
    mocks.getProgress.mockRejectedValue(new Error(SECRET));
    await expectShape(await runRoute.GET(get(`/api/ai/runs/${RUN}`), ctx(RUN)), 500, { error: "server_error" });
    expect(errors.join("\n")).not.toContain(SECRET);
  });
});

describe("POST /api/ai/runs/[id]/advance", () => {
  const call = (id = RUN, headers?: Record<string, string>) =>
    advanceRoute.POST(post(`/api/ai/runs/${id}/advance`, undefined, headers), ctx(id));

  beforeEach(() => {
    mocks.getRunForOwner.mockResolvedValue({ id: RUN, trigger: "build" });
  });

  it("404 for a rewrite run (M5 review B1) — never advanced", async () => {
    mocks.getRunForOwner.mockResolvedValue({ id: RUN, trigger: "rewrite" });
    await expectShape(await call(), 404, { error: "not_found" });
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it("exports route fields only", () => {
    expect(advanceRoute.maxDuration).toBe(300);
    expect(advanceRoute.runtime).toBe("nodejs");
    expect(Object.keys(advanceRoute).sort()).toEqual(["POST", "dynamic", "maxDuration", "runtime"]);
  });

  it("403 cross-site, 401 signed out", async () => {
    await expectShape(await call(RUN, { origin: "https://evil.example" }), 403, { error: "forbidden" });
    mocks.user = null;
    await expectShape(await call(), 401, { error: "unauthenticated" });
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it("404 bad uuid / not the owner's (no advance)", async () => {
    await expectShape(await call("nope"), 404, { error: "not_found" });
    mocks.getRunForOwner.mockResolvedValue(null);
    await expectShape(await call(), 404, { error: "not_found" });
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it("200 AdvanceResult with a 40 s budget", async () => {
    mocks.advance.mockResolvedValue({ state: "curating", progress: PROGRESS, done: false, cursor: SECRET });
    await expectShape(await call(), 200, {
      state: "curating",
      progress: PROGRESS,
      done: false,
      aiStatus: null,
      errorCode: null,
    });
    expect(mocks.advance).toHaveBeenCalledWith(RUN, { budgetMs: 40_000 });
  });

  it("202 leased with Retry-After 2", async () => {
    mocks.advance.mockResolvedValue({ leased: true });
    const res = await call();
    expect(res.headers.get("retry-after")).toBe("2");
    await expectShape(res, 202, { leased: true });
  });

  it("404 when advance reports notFound", async () => {
    mocks.advance.mockResolvedValue({ notFound: true });
    await expectShape(await call(), 404, { error: "not_found" });
  });

  it("500 generic, code-only log", async () => {
    mocks.advance.mockRejectedValue(Object.assign(new Error(SECRET), { code: "storyteller_timeout" }));
    await expectShape(await call(), 500, { error: "server_error" });
    expect(errors.join("\n")).toContain("storyteller_timeout");
    expect(errors.join("\n")).not.toContain(SECRET);
  });
});

describe("togglePhotoAction", () => {
  it("rejects bad ids without touching the db", async () => {
    expect(await togglePhotoAction("x", PHOTO, true)).toMatchObject({ ok: false });
    expect(await togglePhotoAction(BOOK, "y", true)).toMatchObject({ ok: false });
    expect(await togglePhotoAction(BOOK, PHOTO, "yes" as unknown as boolean)).toMatchObject({ ok: false });
    expect(mocks.setUserOverride).not.toHaveBeenCalled();
  });

  it("requires a user", async () => {
    mocks.user = null;
    expect(await togglePhotoAction(BOOK, PHOTO, true)).toEqual({ ok: false, error: "Please sign in again." });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("requires ownership of the book", async () => {
    mocks.getMyBook.mockResolvedValue(null);
    expect(await togglePhotoAction(BOOK, PHOTO, false)).toMatchObject({ ok: false });
    expect(mocks.setUserOverride).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("not found when the photo isn't in the book", async () => {
    mocks.setUserOverride.mockResolvedValue(false);
    expect(await togglePhotoAction(BOOK, PHOTO, false)).toMatchObject({ ok: false });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([true, false])("saves keep=%s and revalidates the review page", async (keep) => {
    mocks.setUserOverride.mockResolvedValue(true);
    expect(await togglePhotoAction(BOOK, PHOTO, keep)).toEqual({ ok: true });
    expect(mocks.setUserOverride).toHaveBeenCalledWith(BOOK, PHOTO, keep);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${BOOK}/review`);
  });

  it("db error → friendly message, code-only log", async () => {
    mocks.setUserOverride.mockRejectedValue(Object.assign(new Error(SECRET), { code: "42501" }));
    expect(await togglePhotoAction(BOOK, PHOTO, true)).toEqual({ ok: false, error: "We couldn't save that. Please try again." });
    expect(errors.join("\n")).toContain("42501");
    expect(errors.join("\n")).not.toContain(SECRET);
  });
});
