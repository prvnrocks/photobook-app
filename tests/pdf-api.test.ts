import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

// M8 T7: /api/books/[id]/pdf — POST start/reuse, GET poll. DB, storage and after() are mocked;
// requestExport / getExportState (src/lib/pdf/job.ts) run for real.

const BOOK = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
const EXP = "44444444-4444-4444-8444-444444444444";
const EXP2 = "66666666-6666-4666-8666-666666666666";
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SIGNED = "https://sb.example/storage/v1/object/sign/exports/x.pdf?token=t&download=summer-2026.pdf";

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  book: null as Record<string, unknown> | null,
  getMyBook: vi.fn(),
  createExportJob: vi.fn(),
  getExportForOwner: vi.fn(),
  signExportUrl: vi.fn(),
  supersedeExports: vi.fn(),
  after: vi.fn(),
  runExport: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook }));
vi.mock("@/lib/db/print", () => ({ listPrintPhotoSources: vi.fn() }));
vi.mock("@/lib/db/exports", async (orig) => {
  const real = await orig<typeof import("@/lib/db/exports")>();
  return {
    exportObjectPath: real.exportObjectPath,
    EXPORT_MAX_BYTES: real.EXPORT_MAX_BYTES,
    createExportJob: mocks.createExportJob,
    getExportForOwner: mocks.getExportForOwner,
    signExportUrl: mocks.signExportUrl,
    supersedeExports: mocks.supersedeExports,
    claimExport: vi.fn(),
    failExport: vi.fn(),
    finishExport: vi.fn(),
    getExportForRender: vi.fn(),
    listOlderReadyExports: vi.fn(),
    removeExportObjects: vi.fn(),
    uploadExportPdf: vi.fn(),
  };
});
vi.mock("@/lib/pdf/render-pdf", () => ({ renderBook: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: mocks.after }));

const route = await import("@/app/api/books/[id]/pdf/route");
const statusRoute = await import("@/app/api/books/[id]/pdf/status/route");
const job = await import("@/lib/pdf/job");

const crop = { x: 0.5, y: 0.5, zoom: 1 };
function page(i: number) {
  return {
    id: `pg${i}`,
    chapterId: "m1",
    layout: "one-portrait",
    slots: [{ photoId: P(i + 1), crop }],
    caption: { text: "A day by the sea", font: "Cairo", align: "center", source: "user" },
  };
}
function doc(n = 2) {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "family",
    cover: { layout: "cover", photoId: P(1), title: "Summer 2026", subtitle: "" },
    chapters: [{ id: "m1", title: "Beach", dateLabel: "Jul 2026", place: null }],
    pages: Array.from({ length: n }, (_, i) => page(i)),
    style: { background: "#FFFFFF", font: "Playfair" },
  };
}

function ownerExport(over: Record<string, unknown> = {}) {
  return {
    id: EXP,
    bookId: BOOK,
    docRev: 3,
    status: "queued",
    bytes: null,
    pageCount: null,
    errorCode: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...over,
  };
}

const ORIGIN = { origin: "http://localhost:3000" };
const ctx = (id = BOOK) => ({ params: Promise.resolve({ id }) });
function post(headers: Record<string, string> = ORIGIN, id = BOOK) {
  return route.POST(
    new NextRequest(`http://localhost:3000/api/books/${id}/pdf`, {
      method: "POST",
      headers: { host: "localhost:3000", ...headers },
    }),
    ctx(id),
  );
}
function get(exportId: string = EXP, id = BOOK) {
  return route.GET(
    new NextRequest(`http://localhost:3000/api/books/${id}/pdf?exportId=${exportId}`, {
      headers: { host: "localhost:3000" },
    }),
    ctx(id),
  );
}

let logs: string[];
const ENV_KEYS = ["BOOK_ACCESS_SECRET", "PDF_CHROME_PATH", "NEXT_PUBLIC_APP_URL", "VERCEL_ENV", "VERCEL_URL", "VERCEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.BOOK_ACCESS_SECRET = "s".repeat(40);
  process.env.PDF_CHROME_PATH = "/opt/chrome";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL;

  mocks.user = { id: USER };
  mocks.book = { id: BOOK, title: "Summer 2026", is_paid: true, max_pages: 100, doc_rev: 3, caption_lang: "en", doc: doc() };
  for (const m of [mocks.getMyBook, mocks.createExportJob, mocks.getExportForOwner, mocks.signExportUrl, mocks.supersedeExports, mocks.after]) {
    m.mockReset();
  }
  mocks.getMyBook.mockImplementation(async () => mocks.book);
  mocks.createExportJob.mockResolvedValue({ status: "created", exportId: EXP });
  mocks.getExportForOwner.mockResolvedValue(ownerExport());
  mocks.signExportUrl.mockResolvedValue(SIGNED);
  mocks.supersedeExports.mockResolvedValue(1);

  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("route config", () => {
  it("is a nodejs, dynamic route with a 300 s budget", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(300);
  });
});

describe("POST /api/books/[id]/pdf", () => {
  it("401 when signed out", async () => {
    mocks.user = null;
    const res = await post();
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "unauthenticated" });
    expect(mocks.createExportJob).not.toHaveBeenCalled();
  });

  it("403 for a cross-site or Origin-less request (before any auth or DB work)", async () => {
    for (const headers of [{ origin: "https://evil.example" }, {}] as Record<string, string>[]) {
      const res = await post(headers);
      expect(res.status).toBe(403);
      expect(await body(res)).toEqual({ error: "forbidden" });
    }
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("404 for a malformed id or a book the caller does not own (RLS read returns null)", async () => {
    expect((await post(ORIGIN, "nope")).status).toBe(404);
    mocks.book = null;
    const res = await post();
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: "not_found" });
    expect(mocks.createExportJob).not.toHaveBeenCalled();
  });

  it("402 not_paid for a free book (never trusts anything but books.is_paid)", async () => {
    mocks.book = { ...mocks.book, is_paid: false };
    const res = await post();
    expect(res.status).toBe(402);
    expect(await body(res)).toEqual({ error: "not_paid" });
    expect(mocks.createExportJob).not.toHaveBeenCalled();
  });

  it("402 when the RPC sees the book unpaid (live check inside the lock)", async () => {
    mocks.createExportJob.mockResolvedValue({ status: "not_paid" });
    expect((await post()).status).toBe(402);
  });

  it("409 invalid_doc / empty / page_limit", async () => {
    mocks.book = { ...mocks.book, doc: { nope: true } };
    let res = await post();
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: "invalid_doc" });

    mocks.book = { ...mocks.book, doc: doc(0) };
    res = await post();
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: "empty" });

    mocks.book = { ...mocks.book, doc: doc(3), max_pages: 2 };
    res = await post();
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: "page_limit" });
    expect(mocks.createExportJob).not.toHaveBeenCalled();
  });

  it("429 daily_cap", async () => {
    mocks.createExportJob.mockResolvedValue({ status: "daily_cap" });
    const res = await post();
    expect(res.status).toBe(429);
    expect(await body(res)).toEqual({ error: "daily_cap" });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("503 unavailable when BOOK_ACCESS_SECRET or Chromium is missing (no job created)", async () => {
    delete process.env.BOOK_ACCESS_SECRET;
    let res = await post();
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ error: "unavailable" });

    process.env.BOOK_ACCESS_SECRET = "s".repeat(40);
    delete process.env.PDF_CHROME_PATH;
    res = await post();
    expect(res.status).toBe(503);
    expect(mocks.createExportJob).not.toHaveBeenCalled();
  });

  it("passes the saved doc, doc_rev, caption_lang and the D-051 limits to create_export_job", async () => {
    mocks.book = { ...mocks.book, caption_lang: "ar" };
    await post();
    expect(mocks.createExportJob).toHaveBeenCalledWith({
      bookId: BOOK,
      userId: USER,
      docRev: 3,
      doc: mocks.book!.doc,
      captionLang: "ar",
      rendererVersion: 3, // PDF_RENDERER_VERSION (M10b A19 N3)
      dailyCap: 20,
      staleSeconds: 360,
    });
  });

  it("created → 202 queued and runExport scheduled with after()", async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toEqual({ status: "queued", exportId: EXP });
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("ready → 200 with a fresh signed download URL, no new job and nothing scheduled", async () => {
    mocks.createExportJob.mockResolvedValue({ status: "ready", exportId: EXP });
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "ready", bytes: 1234, pageCount: 3 }));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      status: "ready",
      exportId: EXP,
      url: SIGNED,
      filename: "summer-2026.pdf",
      bytes: 1234,
      pageCount: 3,
    });
    expect(mocks.signExportUrl).toHaveBeenCalledWith(`${USER}/${BOOK}/${EXP}.pdf`, 600, "summer-2026.pdf");
    expect(mocks.createExportJob).toHaveBeenCalledTimes(1);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("ready but the PDF is missing from Storage → row marked missing_file (never deleted), a new job is created", async () => {
    mocks.createExportJob
      .mockResolvedValueOnce({ status: "ready", exportId: EXP })
      .mockResolvedValueOnce({ status: "created", exportId: EXP2 });
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "ready", bytes: 1, pageCount: 3 }));
    mocks.signExportUrl.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(202);
    expect(await body(res)).toEqual({ status: "queued", exportId: EXP2 });
    expect(mocks.supersedeExports).toHaveBeenCalledWith(BOOK, USER, [EXP], "missing_file");
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("running (rendering, live lease) → 202 rendering, nothing scheduled", async () => {
    mocks.createExportJob.mockResolvedValue({ status: "running", exportId: EXP, docRev: 3, state: "rendering", claimable: false });
    const res = await post();
    expect(res.status).toBe(202);
    expect(await body(res)).toEqual({ status: "rendering", exportId: EXP });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("running but still queued → 202 queued and re-kicked (claim is atomic)", async () => {
    mocks.createExportJob.mockResolvedValue({ status: "running", exportId: EXP, docRev: 2, state: "queued", claimable: true });
    const res = await post();
    expect(res.status).toBe(202);
    expect(await body(res)).toEqual({ status: "queued", exportId: EXP });
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("N3: rendering with an expired lease (claimable) → 202 rendering and re-kicked", async () => {
    mocks.createExportJob.mockResolvedValue({ status: "running", exportId: EXP, docRev: 3, state: "rendering", claimable: true });
    const res = await post();
    expect(await body(res)).toEqual({ status: "rendering", exportId: EXP });
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("stale_rev → re-reads the book once and retries with the new revision", async () => {
    let rev = 3;
    mocks.getMyBook.mockImplementation(async () => ({ ...mocks.book, doc_rev: rev++ }));
    mocks.createExportJob
      .mockResolvedValueOnce({ status: "stale_rev", docRev: 4 })
      .mockResolvedValueOnce({ status: "created", exportId: EXP });
    const res = await post();
    expect(res.status).toBe(202);
    expect(mocks.getMyBook).toHaveBeenCalledTimes(2);
    expect(mocks.createExportJob.mock.calls.map((c) => c[0].docRev)).toEqual([3, 4]);
  });

  it("stale_rev twice → 409 conflict", async () => {
    mocks.createExportJob.mockResolvedValue({ status: "stale_rev", docRev: 9 });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: "conflict" });
    expect(mocks.createExportJob).toHaveBeenCalledTimes(2);
  });

  it("500 server_error with a code-only log when the DB throws", async () => {
    mocks.createExportJob.mockRejectedValue(Object.assign(new Error(`secret ${USER} path`), { code: "PGRST301" }));
    const res = await post();
    expect(res.status).toBe(500);
    expect(await body(res)).toEqual({ error: "server_error" });
    expect(logs.join("\n")).toContain("PGRST301");
    expect(logs.join("\n")).not.toContain(USER);
  });
});

describe("GET /api/books/[id]/pdf?exportId=", () => {
  it("401 when signed out", async () => {
    mocks.user = null;
    expect((await get()).status).toBe(401);
  });

  it("404 for a missing/malformed exportId", async () => {
    expect((await get("nope")).status).toBe(404);
    const res = await route.GET(
      new NextRequest(`http://localhost:3000/api/books/${BOOK}/pdf`, { headers: { host: "localhost:3000" } }),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it("404 for another user's export (owner filter returns nothing)", async () => {
    mocks.user = { id: OTHER_USER };
    mocks.getExportForOwner.mockImplementation(async (_id: string, userId: string) => (userId === USER ? ownerExport() : null));
    const res = await get();
    expect(res.status).toBe(404);
    expect(mocks.getExportForOwner).toHaveBeenCalledWith(EXP, OTHER_USER);
  });

  it("404 for the caller's export of a different book", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ bookId: P(77) }));
    expect((await get()).status).toBe(404);
  });

  it("queued → { status: 'queued' }, no-store; a fresh queued job is not re-kicked", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toEqual({ status: "queued" });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("queued for > 10 s → re-kicked via after()", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ createdAt: new Date(Date.now() - 60_000).toISOString() }));
    await get();
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("rendering → { status: 'rendering' }", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "rendering" }));
    expect(await body(await get())).toEqual({ status: "rendering" });
  });

  it("ready → signed URL + filename + size", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "ready", bytes: 999, pageCount: 3 }));
    const res = await get();
    expect(await body(res)).toEqual({
      status: "ready",
      exportId: EXP,
      url: SIGNED,
      filename: "summer-2026.pdf",
      bytes: 999,
      pageCount: 3,
    });
    expect(mocks.signExportUrl).toHaveBeenCalledWith(`${USER}/${BOOK}/${EXP}.pdf`, 600, "summer-2026.pdf");
  });

  it("ready with an Arabic-only title → fallback filename", async () => {
    mocks.book = { ...mocks.book, title: "صيف ٢٠٢٦" };
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "ready", bytes: 1, pageCount: 3 }));
    expect((await body(await get())).filename).toBe("photobook.pdf");
  });

  it("ready but the object is gone → failed missing_file, row marked (not deleted)", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "ready", bytes: 1, pageCount: 3 }));
    mocks.signExportUrl.mockResolvedValue(null);
    expect(await body(await get())).toEqual({ status: "failed", error: "missing_file" });
    expect(mocks.supersedeExports).toHaveBeenCalledWith(BOOK, USER, [EXP], "missing_file");
  });

  it("superseded → failed superseded / missing_file (client re-POSTs)", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "superseded", errorCode: "superseded" }));
    expect(await body(await get())).toEqual({ status: "failed", error: "superseded" });
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "superseded", errorCode: "missing_file" }));
    expect(await body(await get())).toEqual({ status: "failed", error: "missing_file" });
  });

  it("failed → { status: 'failed', error: code }", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "failed", errorCode: "render_timeout" }));
    expect(await body(await get())).toEqual({ status: "failed", error: "render_timeout" });
  });
});

describe("GET /api/books/[id]/pdf/status?exportId= (lightweight poll)", () => {
  function sget(exportId: string = EXP, id = BOOK) {
    return statusRoute.GET(
      new NextRequest(`http://localhost:3000/api/books/${id}/pdf/status?exportId=${exportId}`, {
        headers: { host: "localhost:3000" },
      }),
      ctx(id),
    );
  }

  it("is a nodejs dynamic route without the render budget", () => {
    expect(statusRoute.runtime).toBe("nodejs");
    expect(statusRoute.dynamic).toBe("force-dynamic");
    expect("maxDuration" in statusRoute).toBe(false);
    expect(Object.keys(statusRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
  });

  it("401 / 404 like the heavy route", async () => {
    mocks.user = null;
    expect((await sget()).status).toBe(401);
    mocks.user = { id: USER };
    expect((await sget("nope")).status).toBe(404);
    mocks.getExportForOwner.mockResolvedValue(null);
    expect((await sget()).status).toBe(404);
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ bookId: P(77) }));
    expect((await sget()).status).toBe(404);
  });

  it("queued (even old) → queued, never re-kicks", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ createdAt: new Date(Date.now() - 600_000).toISOString() }));
    const res = await sget();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toEqual({ status: "queued" });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("ready → signed URL; failed → code", async () => {
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "ready", bytes: 999, pageCount: 3 }));
    expect(await body(await sget())).toMatchObject({ status: "ready", url: SIGNED, filename: "summer-2026.pdf" });
    mocks.getExportForOwner.mockResolvedValue(ownerExport({ status: "failed", errorCode: "too_large" }));
    expect(await body(await sget())).toEqual({ status: "failed", error: "too_large" });
  });

  it("500 with a code-only log when the DB throws", async () => {
    mocks.getExportForOwner.mockRejectedValue(Object.assign(new Error(`secret ${USER}`), { code: "PGRST301" }));
    const res = await sget();
    expect(res.status).toBe(500);
    expect(logs.join("\n")).not.toContain(USER);
  });
});

describe("renderOrigin / exportAvailable", () => {
  const secret = "s".repeat(40);
  it("uses NEXT_PUBLIC_APP_URL (trailing slash trimmed), the deployment URL on Vercel Preview", () => {
    expect(job.renderOrigin({ NEXT_PUBLIC_APP_URL: "https://app.example.ae/" })).toBe("https://app.example.ae");
    expect(
      job.renderOrigin({ NEXT_PUBLIC_APP_URL: "https://app.example.ae", VERCEL_ENV: "preview", VERCEL_URL: "pb-abc.vercel.app" }),
    ).toBe("https://pb-abc.vercel.app");
    expect(
      job.renderOrigin({ NEXT_PUBLIC_APP_URL: "https://app.example.ae", VERCEL_ENV: "production", VERCEL_URL: "pb-abc.vercel.app" }),
    ).toBe("https://app.example.ae");
    expect(job.renderOrigin({ NODE_ENV: "production" })).toBeNull();
    expect(job.renderOrigin({ NODE_ENV: "development" })).toBe("http://localhost:3000");
  });

  it("needs the secret, an origin and Chromium (PDF_CHROME_PATH or serverless Linux)", () => {
    const base = { BOOK_ACCESS_SECRET: secret, NEXT_PUBLIC_APP_URL: "https://a.example" };
    expect(job.exportAvailable({ ...base, PDF_CHROME_PATH: "/c" }, "darwin")).toBe(true);
    expect(job.exportAvailable(base, "darwin")).toBe(false);
    expect(job.exportAvailable({ ...base, VERCEL: "1" }, "linux")).toBe(true);
    expect(job.exportAvailable({ ...base, BOOK_ACCESS_SECRET: "short", PDF_CHROME_PATH: "/c" }, "darwin")).toBe(false);
    expect(job.exportAvailable({ BOOK_ACCESS_SECRET: secret, NODE_ENV: "production", PDF_CHROME_PATH: "/c" }, "darwin")).toBe(false);
  });
});
