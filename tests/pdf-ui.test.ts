// M8 T8: the "Download PDF" controller (src/lib/pdf/ui.ts) with a fake transport + fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNED_URL_TTL_SECONDS } from "@/lib/pdf/rules";
import {
  createPdfDownloadController,
  errorCodeFor,
  formatPdfSize,
  isSafeDownloadUrl,
  parseReady,
  supabaseStorageOrigin,
  PDF_FREE_COPY,
  PDF_LINK_VALID_MS,
  PDF_POLL_CAP_MS,
  PDF_POLL_MS,
  PDF_PREPARING_COPY,
  PDF_SIGNED_URL_TTL_SECONDS,
  PDF_TIMEOUT_COPY,
  pdfApiPath,
  pdfStatusPath,
  PDF_REKICK_MAX,
  PDF_REKICK_QUEUED_MS,
  pdfButtonLabel,
  pdfErrorCopy,
  pdfReadyDetail,
  pdfStatusCopy,
  type PdfHttpResult,
  type PdfUiState,
} from "@/lib/pdf/ui";

// Signed download URLs must be on the configured Supabase origin (N8).
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");

const BOOK = "11111111-1111-4111-8111-111111111111";
const URL_ = "https://x.supabase.co/storage/v1/object/sign/exports/u/b/e1.pdf?token=t&download=book.pdf";
const READY = { status: "ready", exportId: "e1", url: URL_, filename: "book.pdf", bytes: 2_516_582, pageCount: 41 };

type Call = { method: string; url: string };

function setup(answers: Array<PdfHttpResult | Error | (() => PdfHttpResult | Promise<PdfHttpResult>)>, opts: { hidden?: () => boolean } = {}) {
  const calls: Call[] = [];
  const states: PdfUiState[] = [];
  const navigate = vi.fn();
  let visibleCb: (() => void) | null = null;
  const unsub = vi.fn(() => {
    visibleCb = null;
  });
  const queue = [...answers];
  const transport = vi.fn(async (method: "POST" | "GET", url: string) => {
    calls.push({ method, url });
    const next = queue.shift();
    if (next === undefined) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  const c = createPdfDownloadController({
    bookId: BOOK,
    onChange: (s) => states.push(s),
    transport,
    navigate,
    now: () => Date.now(),
    isHidden: opts.hidden ?? (() => false),
    onVisible: (cb) => {
      visibleCb = cb;
      return unsub;
    },
  });
  return { c, calls, states, navigate, transport, unsub, fireVisible: () => visibleCb?.(), hasVisibleCb: () => visibleCb !== null };
}

const ok = (body: unknown, status = 200): PdfHttpResult => ({ status, body });
const queued = (status: "queued" | "rendering" = "queued", code = 202) => ok({ status, exportId: "e1" }, code);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("copy", () => {
  it.each([
    ["not_paid", PDF_FREE_COPY],
    ["daily_cap", "You've made a lot of PDFs today — try again tomorrow"],
    ["invalid_doc", "Fix the book before exporting"],
    ["empty", "Fix the book before exporting"],
    ["page_limit", "This book has more pages than allowed"],
    ["unavailable", "PDF export isn't available right now"],
    ["failed", "We couldn't make your PDF — try again"],
    ["server_error", "We couldn't make your PDF — try again"],
    ["unauthenticated", "Please sign in again"],
  ] as const)("%s → %s", (code, text) => {
    expect(pdfErrorCopy(code)).toBe(text);
  });

  it("status copy per state", () => {
    expect(pdfStatusCopy({ kind: "idle" })).toBeNull();
    expect(pdfStatusCopy({ kind: "starting" })).toBe(PDF_PREPARING_COPY);
    expect(PDF_PREPARING_COPY).toBe("Preparing your PDF… this can take up to a minute");
    expect(pdfStatusCopy({ kind: "preparing", exportId: "e", status: "queued", paused: false })).toBe(PDF_PREPARING_COPY);
    expect(pdfStatusCopy({ kind: "ready", ...READY })).toBe("Your PDF is ready");
    expect(pdfStatusCopy({ kind: "timeout", exportId: "e" })).toBe("Still working — check back in a minute");
  });

  it("button labels", () => {
    expect(pdfButtonLabel({ kind: "idle" })).toBe("Download PDF");
    expect(pdfButtonLabel({ kind: "error", code: "failed" })).toBe("Try again");
    expect(pdfButtonLabel({ kind: "timeout", exportId: "e" })).toBe("Check again");
  });

  it("size + pages detail", () => {
    expect(formatPdfSize(2_516_582)).toBe("2.4 MB");
    expect(formatPdfSize(1_000)).toBe("0.1 MB");
    expect(formatPdfSize(Number.NaN)).toBe("0.1 MB");
    expect(pdfReadyDetail({ bytes: 2_516_582, pageCount: 41 })).toBe("2.4 MB · 41 pages");
    expect(pdfReadyDetail({ bytes: 2_516_582, pageCount: 1 })).toBe("2.4 MB · 1 page");
  });

  it("the link lifetime matches the server's signed URL TTL", () => {
    expect(PDF_SIGNED_URL_TTL_SECONDS).toBe(SIGNED_URL_TTL_SECONDS);
    expect(PDF_LINK_VALID_MS).toBeLessThan(SIGNED_URL_TTL_SECONDS * 1000);
  });
});

describe("parsing helpers", () => {
  it("API paths", () => {
    expect(pdfApiPath(BOOK)).toBe(`/api/books/${BOOK}/pdf`);
    expect(pdfApiPath(BOOK, "e 1")).toBe(`/api/books/${BOOK}/pdf?exportId=e%201`);
    expect(pdfStatusPath(BOOK, "e 1")).toBe(`/api/books/${BOOK}/pdf/status?exportId=e%201`);
  });

  it("only Supabase Storage URLs (https, configured origin) or same-origin download URLs", () => {
    expect(isSafeDownloadUrl(URL_)).toBe(true);
    expect(isSafeDownloadUrl("/files/x.pdf")).toBe(true);
    // Another origin, even https / another Supabase project / lookalike host.
    expect(isSafeDownloadUrl("https://evil.example/storage/v1/object/sign/x.pdf")).toBe(false);
    expect(isSafeDownloadUrl("https://y.supabase.co/storage/v1/object/sign/x.pdf")).toBe(false);
    expect(isSafeDownloadUrl("https://x.supabase.co.evil.example/storage/v1/object/sign/x.pdf")).toBe(false);
    expect(isSafeDownloadUrl("https://x.supabase.co:8443/storage/v1/object/sign/x.pdf")).toBe(false);
    // Right origin, wrong scheme / path / credentials.
    expect(isSafeDownloadUrl("http://x.supabase.co/storage/v1/object/sign/x.pdf")).toBe(false);
    expect(isSafeDownloadUrl("https://x.supabase.co/auth/v1/authorize?x=1")).toBe(false);
    expect(isSafeDownloadUrl("https://user:pw@x.supabase.co/storage/v1/object/sign/x.pdf")).toBe(false);
    expect(isSafeDownloadUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeDownloadUrl("data:application/pdf;base64,AAAA")).toBe(false);
    expect(isSafeDownloadUrl("//evil.example/x.pdf")).toBe(false);
    expect(isSafeDownloadUrl("/\\evil.example/x.pdf")).toBe(false);
    expect(isSafeDownloadUrl("/files/x.pdf\nfoo")).toBe(false);
    expect(isSafeDownloadUrl("")).toBe(false);
    expect(isSafeDownloadUrl(null)).toBe(false);
  });

  it("absolute same-origin URLs pass; no configured Supabase origin → storage URLs refused", () => {
    expect(isSafeDownloadUrl("https://app.example/files/x.pdf", { pageOrigin: "https://app.example" })).toBe(true);
    expect(isSafeDownloadUrl("https://other.example/files/x.pdf", { pageOrigin: "https://app.example" })).toBe(false);
    expect(isSafeDownloadUrl(URL_, { storageOrigin: null })).toBe(false);
    // Local Supabase (supabase start) is plain http on loopback.
    const local = "http://127.0.0.1:54321";
    expect(isSafeDownloadUrl(`${local}/storage/v1/object/sign/x.pdf`, { storageOrigin: local })).toBe(true);
    expect(isSafeDownloadUrl("http://127.0.0.1:9999/storage/v1/object/sign/x.pdf", { storageOrigin: local })).toBe(false);
  });

  it("supabaseStorageOrigin reads the public env origin", () => {
    expect(supabaseStorageOrigin()).toBe("https://x.supabase.co");
    expect(supabaseStorageOrigin("https://x.supabase.co/some/path ")).toBe("https://x.supabase.co");
    expect(supabaseStorageOrigin("")).toBeNull();
    expect(supabaseStorageOrigin("not a url")).toBeNull();
    expect(supabaseStorageOrigin("ftp://x.example")).toBeNull();
  });

  it("parseReady refuses a ready answer with a foreign URL", () => {
    expect(parseReady(READY)?.url).toBe(URL_);
    expect(parseReady({ ...READY, url: "https://evil.example/storage/v1/object/sign/x.pdf" })).toBeNull();
  });

  it("error code: body first, then HTTP status", () => {
    expect(errorCodeFor(409, { error: "page_limit" })).toBe("page_limit");
    expect(errorCodeFor(409, { error: "empty" })).toBe("empty");
    expect(errorCodeFor(409, null)).toBe("invalid_doc");
    expect(errorCodeFor(401, null)).toBe("unauthenticated");
    expect(errorCodeFor(402, {})).toBe("not_paid");
    expect(errorCodeFor(429, {})).toBe("daily_cap");
    expect(errorCodeFor(503, {})).toBe("unavailable");
    expect(errorCodeFor(500, { error: "weird" })).toBe("server_error");
  });
});

describe("controller", () => {
  it("POST 200 ready → navigates once, ready state with info", async () => {
    const t = setup([ok(READY)]);
    await t.c.start();
    expect(t.calls).toEqual([{ method: "POST", url: `/api/books/${BOOK}/pdf` }]);
    expect(t.navigate).toHaveBeenCalledTimes(1);
    expect(t.navigate).toHaveBeenCalledWith(URL_);
    expect(t.states.map((s) => s.kind)).toEqual(["starting", "ready"]);
    expect(t.c.getState()).toMatchObject({ kind: "ready", exportId: "e1", url: URL_, bytes: 2_516_582, pageCount: 41 });
  });

  it("awaits beforeStart (editor save) before the POST", async () => {
    const order: string[] = [];
    let release!: () => void;
    const transport = vi.fn(async () => {
      order.push("post");
      return ok(READY);
    });
    const c = createPdfDownloadController({
      bookId: BOOK,
      onChange: () => {},
      transport,
      navigate: () => {},
      beforeStart: () =>
        new Promise<void>((r) => {
          order.push("settle");
          release = r;
        }),
    });
    const p = c.start();
    await Promise.resolve();
    expect(transport).not.toHaveBeenCalled();
    release();
    await p;
    expect(order).toEqual(["settle", "post"]);
  });

  it("202 → polls GET every 2 s → ready navigates", async () => {
    const t = setup([queued(), ok({ status: "queued" }), ok({ status: "rendering" }), ok(READY)]);
    await t.c.start();
    expect(t.c.getState()).toEqual({ kind: "preparing", exportId: "e1", status: "queued", paused: false });
    expect(t.navigate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PDF_POLL_MS - 1);
    expect(t.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    // polls the lightweight status route (no renderer in that function)
    expect(t.calls[1]).toEqual({ method: "GET", url: `/api/books/${BOOK}/pdf/status?exportId=e1` });
    expect(t.c.getState()).toMatchObject({ kind: "preparing", status: "queued" });

    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(t.c.getState()).toMatchObject({ kind: "preparing", status: "rendering" });

    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(t.calls).toHaveLength(4);
    expect(t.navigate).toHaveBeenCalledWith(URL_);
    expect(t.c.getState().kind).toBe("ready");

    // No more polling after ready.
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 5);
    expect(t.calls).toHaveLength(4);
  });

  it("ready link expires: back to idle before the signed URL does", async () => {
    const t = setup([ok(READY)]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_LINK_VALID_MS - 1);
    expect(t.c.getState().kind).toBe("ready");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.c.getState()).toEqual({ kind: "idle" });
    expect(t.navigate).toHaveBeenCalledTimes(1);
  });

  it("failed job → failed copy with the server code; Try again starts over", async () => {
    const t = setup([queued(), ok({ status: "failed", error: "render_timeout" }), ok(READY)]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    const s = t.c.getState();
    expect(s).toEqual({ kind: "error", code: "failed", detail: "render_timeout" });
    expect(pdfStatusCopy(s)).toBe("We couldn't make your PDF — try again");
    expect(pdfButtonLabel(s)).toBe("Try again");
    await t.c.start();
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
    expect(t.c.getState().kind).toBe("ready");
  });

  it.each([
    "stale",
    "render_timeout",
    "too_large",
    "upload_failed",
    "not_found",
    "invalid_doc",
    "server_error",
    "image_failed",
    "chrome_unavailable",
    "navigation_failed",
    "merge_failed",
    undefined,
  ])("failed (%s) → same retry copy", async (code) => {
    const t = setup([queued(), ok(code ? { status: "failed", error: code } : { status: "failed" })]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(pdfStatusCopy(t.c.getState())).toBe("We couldn't make your PDF — try again");
  });

  it.each(["superseded", "missing_file"])("failed (%s) → re-POSTs once for the current PDF → ready", async (code) => {
    const t = setup([queued(), ok({ status: "failed", error: code }), ok(READY)]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
    expect(t.navigate).toHaveBeenCalledWith(URL_);
    expect(t.c.getState().kind).toBe("ready");
  });

  it("superseded twice → error (only one re-POST)", async () => {
    const t = setup([queued(), ok({ status: "failed", error: "superseded" }), queued(), ok({ status: "failed", error: "superseded" })]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 3);
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(t.c.getState()).toEqual({ kind: "error", code: "failed", detail: "superseded" });
  });

  it("stuck in queued for 20 s → re-POST (POST kicks the job); at most PDF_REKICK_MAX times", async () => {
    expect(PDF_REKICK_QUEUED_MS).toBe(20_000);
    const t = setup([queued(), ...Array.from({ length: 400 }, () => () => (t.calls.at(-1)!.method === "POST" ? queued() : ok({ status: "queued" })))]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_REKICK_QUEUED_MS - PDF_POLL_MS);
    expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    const posts = t.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1].url).toBe(`/api/books/${BOOK}/pdf`);
    expect(t.c.getState()).toMatchObject({ kind: "preparing", exportId: "e1", status: "queued" });
    await vi.advanceTimersByTimeAsync(PDF_REKICK_QUEUED_MS * 10);
    expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(1 + PDF_REKICK_MAX);
  });

  it("rendering never re-POSTs (the job is alive)", async () => {
    const t = setup([queued("rendering"), ...Array.from({ length: 40 }, () => ok({ status: "rendering" }))]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 30);
    expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a re-POST that finds the PDF ready navigates", async () => {
    const t = setup([queued(), ...Array.from({ length: 10 }, () => ok({ status: "queued" })), ok(READY)]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_REKICK_QUEUED_MS);
    expect(t.calls.at(-1)?.method).toBe("POST");
    expect(t.navigate).toHaveBeenCalledWith(URL_);
  });

  it("429 daily cap → copy, no navigation, no polling", async () => {
    const t = setup([ok({ error: "daily_cap" }, 429)]);
    await t.c.start();
    expect(t.c.getState()).toEqual({ kind: "error", code: "daily_cap" });
    expect(pdfStatusCopy(t.c.getState())).toBe("You've made a lot of PDFs today — try again tomorrow");
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 3);
    expect(t.calls).toHaveLength(1);
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it("402 not_paid → upgrade state", async () => {
    const t = setup([ok({ error: "not_paid" }, 402)]);
    await t.c.start();
    expect(t.c.getState()).toEqual({ kind: "error", code: "not_paid" });
    expect(pdfStatusCopy(t.c.getState())).toBe("PDF download comes with the upgrade");
  });

  it.each([
    [401, "unauthenticated", "Please sign in again"],
    [403, "forbidden", "We couldn't find this book"],
    [404, "not_found", "We couldn't find this book"],
    [409, "invalid_doc", "Fix the book before exporting"],
    [409, "empty", "Fix the book before exporting"],
    [409, "page_limit", "This book has more pages than allowed"],
    [503, "unavailable", "PDF export isn't available right now"],
    [500, "server_error", "We couldn't make your PDF — try again"],
  ] as const)("POST %i %s → %s", async (status, error, text) => {
    const t = setup([ok({ error }, status)]);
    await t.c.start();
    expect(t.c.getState()).toEqual({ kind: "error", code: error });
    expect(pdfStatusCopy(t.c.getState())).toBe(text);
  });

  it("409 conflict → POST retried once → continues", async () => {
    const t = setup([ok({ error: "conflict" }, 409), ok(READY)]);
    await t.c.start();
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(t.c.getState().kind).toBe("ready");
  });

  it("409 conflict twice → generic try-again copy (no third POST)", async () => {
    const t = setup([ok({ error: "conflict" }, 409), ok({ error: "conflict" }, 409)]);
    await t.c.start();
    expect(t.calls).toHaveLength(2);
    expect(t.c.getState()).toEqual({ kind: "error", code: "conflict" });
    expect(pdfStatusCopy(t.c.getState())).toBe("We couldn't make your PDF — try again");
    expect(pdfButtonLabel(t.c.getState())).toBe("Try again");
  });

  it("409 page_limit is not retried", async () => {
    const t = setup([ok({ error: "page_limit" }, 409)]);
    await t.c.start();
    expect(t.calls).toHaveLength(1);
  });

  it("network error on POST → network copy", async () => {
    const t = setup([new Error("offline")]);
    await t.c.start();
    expect(t.c.getState()).toEqual({ kind: "error", code: "network" });
  });

  it("2xx without a usable body → server_error; unsafe URL is never followed", async () => {
    const t = setup([ok({ ...READY, url: "javascript:alert(1)" })]);
    await t.c.start();
    expect(t.c.getState()).toEqual({ kind: "error", code: "server_error" });
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it("transient poll failures are retried; 3 in a row → error", async () => {
    const t = setup([queued(), new Error("net"), ok({}, 502), ok(READY)]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 3);
    expect(t.c.getState().kind).toBe("ready");

    const u = setup([queued(), new Error("net"), new Error("net"), new Error("net")]);
    await u.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 3);
    expect(u.c.getState()).toEqual({ kind: "error", code: "network" });
  });

  it("poll 401 → sign in again (final)", async () => {
    const t = setup([queued(), ok({ error: "unauthenticated" }, 401)]);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(t.c.getState()).toEqual({ kind: "error", code: "unauthenticated" });
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 3);
    expect(t.calls).toHaveLength(2);
  });

  it("hidden tab pauses polling; visible resumes with an immediate poll", async () => {
    let hidden = false;
    const t = setup([queued(), ok({ status: "rendering" }), ok(READY)], { hidden: () => hidden });
    await t.c.start();
    hidden = true;
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(t.calls).toHaveLength(1); // no GET while hidden
    expect(t.c.getState()).toMatchObject({ kind: "preparing", paused: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toHaveLength(1);

    hidden = false;
    t.fireVisible();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(2);
    expect(t.unsub).toHaveBeenCalled();
    expect(t.c.getState()).toMatchObject({ kind: "preparing", status: "rendering", paused: false });
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(t.c.getState().kind).toBe("ready");
  });

  it("still pending after ~5 min → timeout; Check again re-POSTs", async () => {
    const pending = () => ok({ status: "rendering" });
    const answers = [queued(), ...Array.from({ length: 200 }, () => pending)];
    const t = setup(answers);
    await t.c.start();
    await vi.advanceTimersByTimeAsync(PDF_POLL_CAP_MS - PDF_POLL_MS);
    expect(t.c.getState().kind).toBe("preparing");
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(t.c.getState()).toEqual({ kind: "timeout", exportId: "e1" });
    expect(pdfStatusCopy(t.c.getState())).toBe(PDF_TIMEOUT_COPY);
    const n = t.calls.length;
    expect(n).toBe(1 + PDF_POLL_CAP_MS / PDF_POLL_MS);
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 5);
    expect(t.calls).toHaveLength(n); // stopped
    await t.c.start();
    expect(t.calls[n]).toEqual({ method: "POST", url: `/api/books/${BOOK}/pdf` });
  });

  it("start() while busy is a no-op", async () => {
    const t = setup([queued(), ok(READY)]);
    await t.c.start();
    await t.c.start();
    expect(t.calls).toHaveLength(1);
  });

  it("dispose (unmount) stops polling, listeners, and ignores late answers", async () => {
    const t = setup([queued(), ok(READY)]);
    await t.c.start();
    t.c.dispose();
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS * 5);
    expect(t.calls).toHaveLength(1);
    expect(t.navigate).not.toHaveBeenCalled();

    // An in-flight POST answering after dispose does nothing.
    let resolve!: (r: PdfHttpResult) => void;
    const u = setup([() => new Promise<PdfHttpResult>((r) => (resolve = r))]);
    const p = u.c.start();
    await Promise.resolve();
    u.c.dispose();
    resolve(ok(READY));
    await p;
    expect(u.navigate).not.toHaveBeenCalled();
    expect(u.states.map((s) => s.kind)).toEqual(["starting"]);

    // Disposed while paused on a hidden tab → the visibility listener is removed.
    let hidden = false;
    const v = setup([queued()], { hidden: () => hidden });
    await v.c.start();
    hidden = true;
    await vi.advanceTimersByTimeAsync(PDF_POLL_MS);
    expect(v.hasVisibleCb()).toBe(true);
    v.c.dispose();
    expect(v.unsub).toHaveBeenCalled();
    expect(v.hasVisibleCb()).toBe(false);
  });
});
