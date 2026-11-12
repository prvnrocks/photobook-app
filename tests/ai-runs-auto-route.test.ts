// M13 T4 — POST /api/ai/runs { bookId, auto: true }: response contract for the frontend (T6/T7).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  startRun: vi.fn(),
  startAutoBuild: vi.fn(),
  getMyBook: vi.fn(),
  getActiveRunForBook: vi.fn(),
  getLatestRunForBook: vi.fn(),
  hasFinishedLiveAiRun: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/ai/orchestrator", () => ({ startRun: mocks.startRun }));
vi.mock("@/lib/ai/auto-build", () => ({
  startAutoBuild: mocks.startAutoBuild,
  isAutoBuildRefusal: (r: { ok: boolean; error?: string }) =>
    !r.ok && (r.error === "not_first" || r.error === "not_ready"),
}));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook }));
vi.mock("@/lib/db/agent-runs", () => ({
  getActiveRunForBook: mocks.getActiveRunForBook,
  getLatestRunForBook: mocks.getLatestRunForBook,
  hasFinishedLiveAiRun: mocks.hasFinishedLiveAiRun,
}));

const runsRoute = await import("@/app/api/ai/runs/route");

const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const DOC = { pages: [] };

function call(body: unknown) {
  return runsRoute.POST(
    new NextRequest("http://localhost:3000/api/ai/runs", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function expectShape(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual(body);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === "function") m.mockReset();
  mocks.user = { id: "u1" };
  mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: DOC });
  mocks.getLatestRunForBook.mockResolvedValue(null);
  mocks.hasFinishedLiveAiRun.mockResolvedValue(false);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/ai/runs { auto: true }", () => {
  it("201 adds auto: true; goes through startAutoBuild only (never startRun directly)", async () => {
    mocks.startAutoBuild.mockResolvedValue({ ok: true, runId: RUN, mode: "replay", state: "queued" });
    await expectShape(await call({ bookId: BOOK, auto: true }), 201, {
      runId: RUN,
      mode: "replay",
      state: "queued",
      auto: true,
    });
    expect(mocks.startAutoBuild).toHaveBeenCalledWith({ book: { id: BOOK, doc: DOC }, userId: "u1" });
    expect(mocks.startRun).not.toHaveBeenCalled();
    // The rule-run rate guard and rebuild derivation belong to manual starts.
    expect(mocks.getLatestRunForBook).not.toHaveBeenCalled();
  });

  it("ignores a 'rebuild' trigger hint", async () => {
    mocks.startAutoBuild.mockResolvedValue({ ok: false, error: "not_first" });
    await expectShape(await call({ bookId: BOOK, auto: true, trigger: "rebuild" }), 409, { error: "not_first" });
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it.each(["not_first", "not_ready"])("409 %s", async (error) => {
    mocks.startAutoBuild.mockResolvedValue({ ok: false, error });
    await expectShape(await call({ bookId: BOOK, auto: true }), 409, { error });
  });

  it("409 already_running with the active run id", async () => {
    mocks.startAutoBuild.mockResolvedValue({ ok: false, error: "already_running" });
    mocks.getActiveRunForBook.mockResolvedValue({ id: RUN });
    await expectShape(await call({ bookId: BOOK, auto: true }), 409, { error: "already_running", runId: RUN });
  });

  it.each(["daily_builds", "rebuilds", "budget_exhausted"])("429 limit %s (existing copy keys)", async (limit) => {
    mocks.startAutoBuild.mockResolvedValue({ ok: false, error: "limit", limit });
    await expectShape(await call({ bookId: BOOK, auto: true }), 429, { error: "limit", limit });
  });

  it("409 user_edited, 422 unsupported_design pass through", async () => {
    mocks.startAutoBuild.mockResolvedValue({ ok: false, error: "user_edited" });
    await expectShape(await call({ bookId: BOOK, auto: true }), 409, { error: "user_edited" });
    mocks.startAutoBuild.mockResolvedValue({ ok: false, error: "unsupported_design" });
    await expectShape(await call({ bookId: BOOK, auto: true }), 422, { error: "unsupported_design" });
  });

  it("auto rule run: 201 with state done", async () => {
    mocks.startAutoBuild.mockResolvedValue({ ok: true, runId: RUN, mode: "rule", state: "done" });
    await expectShape(await call({ bookId: BOOK, auto: true }), 201, { runId: RUN, mode: "rule", state: "done", auto: true });
  });

  it("400 for a non-boolean auto; 404 for someone else's book (no start)", async () => {
    await expectShape(await call({ bookId: BOOK, auto: "yes" }), 400, { error: "invalid_body" });
    mocks.getMyBook.mockResolvedValue(null);
    await expectShape(await call({ bookId: BOOK, auto: true }), 404, { error: "not_found" });
    expect(mocks.startAutoBuild).not.toHaveBeenCalled();
  });

  it("auto: false / absent → the manual path, no auto flag", async () => {
    mocks.startRun.mockResolvedValue({ ok: true, runId: RUN, mode: "replay", state: "queued" });
    await expectShape(await call({ bookId: BOOK, auto: false }), 201, { runId: RUN, mode: "replay", state: "queued" });
    expect(mocks.startAutoBuild).not.toHaveBeenCalled();
  });

  it("a db timeout in the auto start or the active-run lookup → 503 unavailable (retry)", async () => {
    const timeout = () => Object.assign(new Error("t"), { code: "SUPABASE_TIMEOUT" });
    mocks.startAutoBuild.mockRejectedValue(timeout());
    let res = await call({ bookId: BOOK, auto: true });
    expect(res.status).toBe(503);
    mocks.startAutoBuild.mockResolvedValue({ ok: false, error: "already_running" });
    mocks.getActiveRunForBook.mockRejectedValue(timeout());
    res = await call({ bookId: BOOK, auto: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("500 generic when the auto start throws", async () => {
    mocks.startAutoBuild.mockRejectedValue(new Error("boom"));
    await expectShape(await call({ bookId: BOOK, auto: true }), 500, { error: "server_error" });
  });
});
