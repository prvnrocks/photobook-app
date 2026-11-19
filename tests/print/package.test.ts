// Task 10: print package = cover PDF + interior PDF cut from the ready export (one render).
import { PDFDocument, PDFName, PDFArray, PDFNumber } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const BOOK = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const EXP = "44444444-4444-4444-8444-444444444444";

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  getMyBook: vi.fn(),
  latestReadyExport: vi.fn(),
  signExportUrl: vi.fn(),
  downloadExportPdf: vi.fn(),
  uploadExportPdf: vi.fn(),
  hit: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook }));
vi.mock("@/lib/db/exports", async (orig) => {
  const real = await orig<typeof import("@/lib/db/exports")>();
  return { ...real, latestReadyExport: mocks.latestReadyExport, signExportUrl: mocks.signExportUrl, downloadExportPdf: mocks.downloadExportPdf, uploadExportPdf: mocks.uploadExportPdf };
});
vi.mock("@/lib/http/rate-limit", async (orig) => {
  const real = await orig<typeof import("@/lib/http/rate-limit")>();
  return { ...real, rateLimitResponse: (route: Parameters<typeof real.rateLimitResponse>[0], subject: string) => real.rateLimitResponse(route, subject, { hit: mocks.hit }) };
});

const { splitPrintPackage, requestPrintPackage } = await import("@/lib/pdf/package");
const { mergePdfs } = await import("@/lib/pdf/finalize");
const { exportPackagePath } = await import("@/lib/db/exports");
const route = await import("@/app/api/books/[id]/pdf/package/route");

async function bookPdf(sheets: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < sheets; i++) doc.addPage([437.04, 612]).drawText(`sheet ${i}`, { x: 30, y: 30, size: 14 });
  return (await mergePdfs([await doc.save()], { title: "Summer by the sea" })).bytes;
}

const boxMm = (doc: PDFDocument, i: number, name: string) => {
  const arr = doc.getPage(i).node.lookup(PDFName.of(name), PDFArray);
  const [x1, y1, x2, y2] = arr.asArray().map((n) => (n as PDFNumber).asNumber());
  return [Math.round(((x2 - x1) * 25.4) / 72), Math.round(((y2 - y1) * 25.4) / 72)];
};

describe("splitPrintPackage", () => {
  it("cover = sheet 1, interior = the rest, print boxes kept, text kept, no extra metadata", async () => {
    const split = await splitPrintPackage(await bookPdf(5), { title: "Summer by the sea", now: new Date("2026-11-19T00:00:00Z") });
    expect(split.interiorPages).toBe(4);
    const cover = await PDFDocument.load(split.cover);
    const interior = await PDFDocument.load(split.interior);
    expect(cover.getPageCount()).toBe(1);
    expect(interior.getPageCount()).toBe(4);
    for (const [d, i] of [[cover, 0], [interior, 0], [interior, 3]] as const) {
      expect(boxMm(d, i, "MediaBox")).toEqual([154, 216]);
      expect(boxMm(d, i, "BleedBox")).toEqual([154, 216]);
      expect(boxMm(d, i, "TrimBox")).toEqual([148, 210]);
    }
    expect(cover.getTitle()).toBe("Summer by the sea — cover");
    expect(interior.getTitle()).toBe("Summer by the sea — interior");
    expect(cover.getAuthor()).toBeUndefined();
  });

  it("rejects a PDF without interior pages or an invalid file", async () => {
    await expect(splitPrintPackage(await bookPdf(1))).rejects.toMatchObject({ code: "too_few_pages" });
    await expect(splitPrintPackage(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "invalid_pdf" });
  });
});

describe("requestPrintPackage + route", () => {
  let logs: string[];
  beforeEach(() => {
    mocks.user = { id: USER };
    for (const m of Object.values(mocks)) if (typeof m === "function" && "mockReset" in m) (m as ReturnType<typeof vi.fn>).mockReset();
    mocks.getMyBook.mockResolvedValue({ id: BOOK, title: "Summer by the sea", is_paid: true, max_pages: 100, doc_rev: 4, caption_lang: "en", doc: {} });
    mocks.latestReadyExport.mockResolvedValue({ id: EXP, bookId: BOOK, docRev: 4, status: "ready", bytes: 10, pageCount: 5, errorCode: null, createdAt: "", finishedAt: "" });
    mocks.hit.mockResolvedValue(0);
    logs = [];
    vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  it("existing package → fresh 10-min signed URLs, nothing downloaded", async () => {
    mocks.signExportUrl.mockImplementation(async (path: string) => `https://sb.example/storage/v1/object/sign/exports/${path.endsWith("-cover.pdf") ? "c" : "i"}?token=t`);
    const r = await requestPrintPackage(BOOK, USER);
    expect(r).toEqual({
      ok: true,
      body: {
        cover: { url: expect.stringContaining("/c?"), filename: "summer-by-the-sea-cover.pdf", pages: 1 },
        interior: { url: expect.stringContaining("/i?"), filename: "summer-by-the-sea-interior.pdf", pages: 4 },
        spec: "generic-a5-digital",
        expiresInSeconds: 600,
      },
    });
    expect(mocks.signExportUrl).toHaveBeenCalledWith(exportPackagePath(USER, BOOK, EXP, "cover"), 600, "summer-by-the-sea-cover.pdf");
    expect(mocks.latestReadyExport).toHaveBeenCalledWith(BOOK, 4, "en");
    expect(mocks.downloadExportPdf).not.toHaveBeenCalled();
  });

  it("first request → downloads the ready PDF, splits, uploads both parts to the owner's folder", async () => {
    let made = false;
    mocks.signExportUrl.mockImplementation(async () => (made ? "https://sb.example/storage/v1/object/sign/x?token=t" : null));
    mocks.downloadExportPdf.mockResolvedValue(await bookPdf(3));
    mocks.uploadExportPdf.mockImplementation(async () => void (made = true));
    const r = await requestPrintPackage(BOOK, USER);
    expect(r.ok).toBe(true);
    expect(mocks.downloadExportPdf).toHaveBeenCalledWith(`${USER}/${BOOK}/${EXP}.pdf`);
    expect(mocks.uploadExportPdf.mock.calls.map((c) => c[0])).toEqual([`${USER}/${BOOK}/${EXP}-cover.pdf`, `${USER}/${BOOK}/${EXP}-interior.pdf`]);
    expect(logs.join("\n")).toBe("[pdf-package] made pages=2");
  });

  it("free / granted books never get print files; no ready PDF → pdf_first", async () => {
    mocks.getMyBook.mockResolvedValueOnce({ id: BOOK, title: "x", is_paid: false, max_pages: 100, doc_rev: 4, caption_lang: "en", doc: {} });
    expect(await requestPrintPackage(BOOK, USER)).toEqual({ ok: false, error: "not_paid" });
    mocks.latestReadyExport.mockResolvedValueOnce(null);
    expect(await requestPrintPackage(BOOK, USER)).toEqual({ ok: false, error: "pdf_first" });
    mocks.getMyBook.mockResolvedValueOnce(null);
    expect(await requestPrintPackage(BOOK, USER)).toEqual({ ok: false, error: "not_found" });
    expect(mocks.signExportUrl).not.toHaveBeenCalled();
  });

  const post = (headers: Record<string, string> = { origin: "http://localhost:3000" }) =>
    route.POST(new NextRequest(`http://localhost:3000/api/books/${BOOK}/pdf/package`, { method: "POST", headers: { host: "localhost:3000", ...headers } }), { params: Promise.resolve({ id: BOOK }) });

  it("route: 403 cross-site, 401 signed out, 402 free, 409 pdf_first, 429 rate limited", async () => {
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    mocks.user = null;
    expect((await post()).status).toBe(401);
    mocks.user = { id: USER };
    mocks.getMyBook.mockResolvedValueOnce({ id: BOOK, title: "x", is_paid: false, max_pages: 20, doc_rev: 4, caption_lang: "en", doc: {} });
    expect((await post()).status).toBe(402);
    mocks.latestReadyExport.mockResolvedValueOnce(null);
    const r409 = await post();
    expect(r409.status).toBe(409);
    expect(await r409.json()).toEqual({ error: "pdf_first" });
    mocks.hit.mockResolvedValueOnce(120);
    const r429 = await post();
    expect(r429.status).toBe(429);
    expect(r429.headers.get("retry-after")).toBe("120");
  });
});
