// M12 T2 (D-069): every API route maps a Supabase timeout to 503 { error: "unavailable" } +
// Retry-After (finalize: 10 s) — whether Auth timed out (getCurrentUser → SupabaseUnavailableError)
// or a database / storage call did (error.code SUPABASE_TIMEOUT carried by the db helpers' errors).
// A real auth answer (null user) is still 401, and other errors stay 500.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: { id: "33333333-3333-4333-8333-333333333333" } as { id: string } | null,
  authError: null as unknown,
  getMyBook: vi.fn(),
  saveDocIfRev: vi.fn(),
  getActiveRunForBook: vi.fn(),
  getLatestRunForBook: vi.fn(),
  hasFinishedLiveAiRun: vi.fn(),
  getRunForOwner: vi.fn(),
  startRun: vi.fn(),
  advance: vi.fn(),
  getProgress: vi.fn(),
  finalizeBook: vi.fn(),
  requestExport: vi.fn(),
  getExportStateJob: vi.fn(),
  getExportStateStatus: vi.fn(),
  getPhotoUrls: vi.fn(),
  listPlaceablePhotos: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: async () => {
    if (mocks.authError) throw mocks.authError;
    return mocks.user;
  },
}));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook, saveDocIfRev: mocks.saveDocIfRev }));
vi.mock("@/lib/db/agent-runs", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/agent-runs")>()),
  getActiveRunForBook: mocks.getActiveRunForBook,
  getLatestRunForBook: mocks.getLatestRunForBook,
  hasFinishedLiveAiRun: mocks.hasFinishedLiveAiRun,
  getRunForOwner: mocks.getRunForOwner,
}));
vi.mock("@/lib/ai/orchestrator", () => ({
  startRun: mocks.startRun,
  advance: mocks.advance,
  getProgress: mocks.getProgress,
  analysisOf: () => null,
}));
vi.mock("@/lib/photos/finalize", () => ({ finalizeBook: mocks.finalizeBook }));
vi.mock("@/lib/pdf/job", () => ({
  requestExport: mocks.requestExport,
  getExportState: mocks.getExportStateJob,
  runExport: vi.fn(),
}));
vi.mock("@/lib/pdf/status", () => ({ getExportState: mocks.getExportStateStatus }));
vi.mock("@/lib/db/editor", () => ({
  getPhotoUrls: mocks.getPhotoUrls,
  EDITOR_URL_TTL_SECONDS: 3600,
  MAX_PHOTO_URL_IDS: 500,
}));
vi.mock("@/lib/db/photos", () => ({ listPlaceablePhotos: mocks.listPlaceablePhotos, markPlacedPhotosKept: vi.fn() }));

const { SupabaseUnavailableError } = await import("@/lib/supabase/deadline");
/** Same shape as every src/lib/db/* query error (the db module itself is mocked here). */
class BooksQueryError extends Error {
  readonly code: string;
  constructor(op: string, code: string) {
    super(`Failed to ${op} (${code})`);
    this.code = code;
  }
}
const runsRoute = await import("@/app/api/ai/runs/route");
const runRoute = await import("@/app/api/ai/runs/[id]/route");
const advanceRoute = await import("@/app/api/ai/runs/[id]/advance/route");
const rewriteRoute = await import("@/app/api/ai/rewrite/route");
const docRoute = await import("@/app/api/books/[id]/doc/route");
const finalizeRoute = await import("@/app/api/books/[id]/finalize/route");
const pdfRoute = await import("@/app/api/books/[id]/pdf/route");
const pdfStatusRoute = await import("@/app/api/books/[id]/pdf/status/route");
const photoUrlsRoute = await import("@/app/api/books/[id]/photo-urls/route");

const BOOK = "22222222-2222-4222-8222-222222222222";
const RUN = "44444444-4444-4444-8444-444444444444";
const EXPORT = "55555555-5555-4555-8555-555555555555";
const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (path: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A db helper error carrying the deadline fetch's code (as all src/lib/db/* errors do). */
const dbTimeout = () => new BooksQueryError("load book", "SUPABASE_TIMEOUT");

type Case = { name: string; call: () => Promise<Response>; retryAfter: string; dbFail: () => void };

const cases: Case[] = [
  {
    name: "POST /api/ai/runs",
    call: () => runsRoute.POST(req("/api/ai/runs", "POST", { bookId: BOOK })),
    retryAfter: "3",
    dbFail: () => mocks.getMyBook.mockRejectedValue(dbTimeout()),
  },
  {
    name: "GET /api/ai/runs/[id]",
    call: () => runRoute.GET(req(`/api/ai/runs/${RUN}`, "GET"), ctx(RUN)),
    retryAfter: "3",
    dbFail: () => mocks.getProgress.mockRejectedValue(dbTimeout()),
  },
  {
    name: "POST /api/ai/runs/[id]/advance",
    call: () => advanceRoute.POST(req(`/api/ai/runs/${RUN}/advance`, "POST"), ctx(RUN)),
    retryAfter: "3",
    dbFail: () => {
      mocks.getRunForOwner.mockResolvedValue({ id: RUN, trigger: "build" });
      // e.g. a timed-out checkpoint inside the tick (T4: advance throws after releasing the lease)
      mocks.advance.mockRejectedValue(dbTimeout());
    },
  },
  {
    name: "POST /api/ai/rewrite",
    call: () =>
      rewriteRoute.POST(
        req("/api/ai/rewrite", "POST", { bookId: BOOK, pageId: "pg1", instruction: "rewrite", text: "A day by the sea" }),
      ),
    retryAfter: "3",
    dbFail: () => mocks.getMyBook.mockRejectedValue(dbTimeout()),
  },
  {
    name: "PUT /api/books/[id]/doc",
    call: () => docRoute.PUT(req(`/api/books/${BOOK}/doc`, "PUT", { doc: {}, baseRev: 1 }), ctx(BOOK)),
    retryAfter: "3",
    dbFail: () => mocks.getMyBook.mockRejectedValue(dbTimeout()),
  },
  {
    name: "POST /api/books/[id]/finalize",
    call: () => finalizeRoute.POST(req(`/api/books/${BOOK}/finalize`, "POST"), ctx(BOOK)),
    retryAfter: "10",
    dbFail: () => mocks.finalizeBook.mockRejectedValue(dbTimeout()),
  },
  {
    name: "POST /api/books/[id]/pdf",
    call: () => pdfRoute.POST(req(`/api/books/${BOOK}/pdf`, "POST"), ctx(BOOK)),
    retryAfter: "3",
    dbFail: () => mocks.requestExport.mockRejectedValue(dbTimeout()),
  },
  {
    name: "GET /api/books/[id]/pdf",
    call: () => pdfRoute.GET(req(`/api/books/${BOOK}/pdf?exportId=${EXPORT}`, "GET"), ctx(BOOK)),
    retryAfter: "3",
    dbFail: () => mocks.getExportStateJob.mockRejectedValue(dbTimeout()),
  },
  {
    name: "GET /api/books/[id]/pdf/status",
    call: () => pdfStatusRoute.GET(req(`/api/books/${BOOK}/pdf/status?exportId=${EXPORT}`, "GET"), ctx(BOOK)),
    retryAfter: "3",
    dbFail: () => mocks.getExportStateStatus.mockRejectedValue(dbTimeout()),
  },
  {
    name: "POST /api/books/[id]/photo-urls",
    call: () => photoUrlsRoute.POST(req(`/api/books/${BOOK}/photo-urls`, "POST", {}), ctx(BOOK)),
    retryAfter: "3",
    // storage-js shape: statusCode SUPABASE_TIMEOUT (createSignedUrls)
    dbFail: () => mocks.getPhotoUrls.mockRejectedValue(Object.assign(new Error("sign"), { statusCode: "SUPABASE_TIMEOUT" })),
  },
];

let logs: string[];
beforeEach(() => {
  mocks.user = { id: "33333333-3333-4333-8333-333333333333" };
  mocks.authError = null;
  for (const m of Object.values(mocks)) if (typeof m === "function" && "mockReset" in m) (m as ReturnType<typeof vi.fn>).mockReset();
  mocks.getLatestRunForBook.mockResolvedValue(null);
  mocks.hasFinishedLiveAiRun.mockResolvedValue(false);
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});

async function expectUnavailable(res: Response, retryAfter: string) {
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe(retryAfter);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: "unavailable" });
}

describe.each(cases)("$name", ({ call, retryAfter, dbFail }) => {
  it(`Auth timeout (SupabaseUnavailableError) → 503 unavailable + Retry-After ${retryAfter}, not 401`, async () => {
    mocks.authError = new SupabaseUnavailableError();
    await expectUnavailable(await call(), retryAfter);
  });

  it(`database / storage timeout → 503 unavailable + Retry-After ${retryAfter}`, async () => {
    dbFail();
    await expectUnavailable(await call(), retryAfter);
  });

  it("a real auth answer (no user) is still 401", async () => {
    mocks.user = null;
    expect((await call()).status).toBe(401);
  });
});

describe("other errors keep their 500", () => {
  it("non-timeout db error → 500 server_error (no 503)", async () => {
    mocks.getMyBook.mockRejectedValue(new BooksQueryError("load book", "40001"));
    const res = await docRoute.PUT(req(`/api/books/${BOOK}/doc`, "PUT", { doc: {}, baseRev: 1 }), ctx(BOOK));
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(logs.some((l) => l.includes("40001"))).toBe(true);
  });

  it("finalize non-timeout error → 500", async () => {
    mocks.finalizeBook.mockRejectedValue(Object.assign(new Error("x"), { code: "XX000" }));
    expect((await finalizeRoute.POST(req(`/api/books/${BOOK}/finalize`, "POST"), ctx(BOOK))).status).toBe(500);
  });
});

describe("POST /api/ai/runs — a start retry after a timeout resumes the active run (T3)", () => {
  it("already_running → 409 with the active run id, so the client drives that run", async () => {
    mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: {} });
    mocks.startRun.mockResolvedValue({ ok: false, error: "already_running" });
    mocks.getActiveRunForBook.mockResolvedValue({ id: RUN });
    const res = await runsRoute.POST(req("/api/ai/runs", "POST", { bookId: BOOK }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_running", runId: RUN });
  });

  it("the active-run lookup timing out → 503 (retry), not a 409 with runId null", async () => {
    mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: {} });
    mocks.startRun.mockResolvedValue({ ok: false, error: "already_running" });
    mocks.getActiveRunForBook.mockRejectedValue(dbTimeout());
    await expectUnavailable(await runsRoute.POST(req("/api/ai/runs", "POST", { bookId: BOOK })), "3");
  });
});
