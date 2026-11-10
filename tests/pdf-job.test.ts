import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M8 T7: runExport — claim → photos → render → merge → upload → finish → older cleanup, and every
// failure path ends in fail_export with a code. DB, storage, Chromium and pdf-lib merge are mocked.

const BOOK = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const EXP = "44444444-4444-4444-8444-444444444444";
const OLD = "66666666-6666-4666-8666-666666666666";
const TOKEN = "77777777-7777-4777-8777-777777777777";
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECRET_CAPTION = "Teta's secret garden caption";
const SECRET_TITLE = "Private family title";

const mocks = vi.hoisted(() => ({
  claimExport: vi.fn(),
  getExportForRender: vi.fn(),
  uploadExportPdf: vi.fn(),
  finishExport: vi.fn(),
  failExport: vi.fn(),
  listOlderReadyExports: vi.fn(),
  removeExportObjects: vi.fn(),
  deleteExportRows: vi.fn(),
  listPrintPhotoSources: vi.fn(),
  renderBook: vi.fn(),
  mergePdfs: vi.fn(),
  createPrintImageLoader: vi.fn(),
}));

vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn() }));
vi.mock("@/lib/db/print", () => ({ listPrintPhotoSources: mocks.listPrintPhotoSources }));
vi.mock("@/lib/db/exports", async (orig) => {
  const real = await orig<typeof import("@/lib/db/exports")>();
  return {
    exportObjectPath: real.exportObjectPath,
    EXPORT_MAX_BYTES: real.EXPORT_MAX_BYTES,
    createExportJob: vi.fn(),
    getExportForOwner: vi.fn(),
    signExportUrl: vi.fn(),
    claimExport: mocks.claimExport,
    getExportForRender: mocks.getExportForRender,
    uploadExportPdf: mocks.uploadExportPdf,
    finishExport: mocks.finishExport,
    failExport: mocks.failExport,
    listOlderReadyExports: mocks.listOlderReadyExports,
    removeExportObjects: mocks.removeExportObjects,
    deleteExportRows: mocks.deleteExportRows,
  };
});
vi.mock("@/lib/pdf/render-pdf", () => ({ renderBook: mocks.renderBook }));
vi.mock("@/lib/pdf/finalize", () => ({ mergePdfs: mocks.mergePdfs }));
vi.mock("@/lib/pdf/images", async (orig) => ({
  ...(await orig<typeof import("@/lib/pdf/images")>()),
  createPrintImageLoader: mocks.createPrintImageLoader,
}));

const { runExport, failureCode, EXPORT_LEASE_SECONDS } = await import("@/lib/pdf/job");
const { PdfRenderError } = await import("@/lib/pdf/errors");
const { PrintImageError } = await import("@/lib/pdf/images");

const crop = { x: 0.5, y: 0.5, zoom: 1 };
function doc(n = 2) {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "family",
    cover: { layout: "cover", photoId: P(9), title: SECRET_TITLE, subtitle: "" },
    chapters: [{ id: "m1", title: "Beach", dateLabel: "Jul 2026", place: null }],
    pages: Array.from({ length: n }, (_, i) => ({
      id: `pg${i}`,
      chapterId: "m1",
      layout: "one-portrait",
      slots: [{ photoId: P(i + 1), crop }],
      caption: { text: SECRET_CAPTION, font: "Cairo", align: "center", source: "user" },
    })),
    style: { background: "#FFFFFF", font: "Playfair" },
  };
}

const PATH = `${USER}/${BOOK}/${EXP}.pdf`;
const LOADER = {
  get: vi.fn(() => Promise.resolve(Buffer.from("jpg"))),
  prefetch: vi.fn(),
  release: vi.fn(),
  stats: vi.fn(() => ({ produced: 0, failed: 0, heldBytes: 0, peakHeldBytes: 0, downloadMs: 0, encodeMs: 0 })),
};
const PDF = new Uint8Array([37, 80, 68, 70]);
let logs: string[];
const savedUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.ae";
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.claimExport.mockResolvedValue(TOKEN);
  mocks.getExportForRender.mockResolvedValue({
    id: EXP,
    bookId: BOOK,
    userId: USER,
    docRev: 7,
    doc: doc(2),
    captionLang: "en",
    status: "rendering",
  });
  mocks.listPrintPhotoSources.mockResolvedValue([
    { id: P(1), width: 4000, height: 3000, original_path: `${USER}/${BOOK}/${P(1)}-original.jpg` },
    { id: P(2), width: 3000, height: 4000, original_path: `${USER}/${BOOK}/${P(2)}-original.jpg` },
    { id: P(9), width: 3000, height: 4000, original_path: `${USER}/${BOOK}/${P(9)}-original.jpg` },
  ]);
  mocks.createPrintImageLoader.mockReturnValue(LOADER);
  mocks.renderBook.mockResolvedValue([Buffer.from("a"), Buffer.from("b")]);
  mocks.mergePdfs.mockResolvedValue({ bytes: PDF, pageCount: 3 });
  mocks.uploadExportPdf.mockResolvedValue(undefined);
  mocks.finishExport.mockResolvedValue(true);
  mocks.failExport.mockResolvedValue(true);
  mocks.listOlderReadyExports.mockResolvedValue([{ id: OLD, path: `${USER}/${BOOK}/${OLD}.pdf` }]);
  mocks.removeExportObjects.mockResolvedValue(undefined);
  mocks.deleteExportRows.mockResolvedValue(1);

  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedUrl;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function expectNoPii() {
  const all = logs.join("\n");
  for (const secret of [USER, BOOK, PATH, SECRET_CAPTION, SECRET_TITLE, "original.jpg", TOKEN]) {
    expect(all).not.toContain(secret);
  }
}

describe("runExport", () => {
  it("success: claim → photos (book + owner) → render → merge → upload exact path → finish → older cleanup", async () => {
    expect(await runExport(EXP)).toBe("ready");

    expect(mocks.claimExport).toHaveBeenCalledWith(EXP, EXPORT_LEASE_SECONDS);
    // cover photo included, deduplicated, filtered by the export row's book AND user
    expect(mocks.listPrintPhotoSources).toHaveBeenCalledWith(BOOK, USER, [P(9), P(1), P(2)]);
    const [plan, photos] = mocks.createPrintImageLoader.mock.calls[0];
    expect([...plan.keys()].sort()).toEqual([P(1), P(2), P(9)].sort());
    expect(photos).toHaveLength(3);

    expect(mocks.renderBook).toHaveBeenCalledTimes(1);
    const renderOpts = mocks.renderBook.mock.calls[0][0];
    expect(renderOpts).toMatchObject({
      origin: "https://app.example.ae",
      bookId: BOOK,
      exportId: EXP,
      docRev: 7,
      sheetCount: 3,
      loader: LOADER,
    });
    expect(Object.keys(renderOpts).sort()).toEqual(
      ["bookId", "docRev", "exportId", "loader", "onChunkDone", "origin", "sheetCount", "timings"].sort(),
    );
    // prefetch on by default: all three photos queued (one chunk), released after it renders
    expect(renderOpts.onChunkDone).toBeTypeOf("function");
    expect(LOADER.prefetch).toHaveBeenCalledWith([P(9), P(1), P(2)]);
    expect(mocks.mergePdfs).toHaveBeenCalledWith([Buffer.from("a"), Buffer.from("b")], { title: SECRET_TITLE });
    expect(mocks.uploadExportPdf).toHaveBeenCalledWith(PATH, PDF);
    expect(mocks.finishExport).toHaveBeenCalledWith({ exportId: EXP, token: TOKEN, path: PATH, bytes: 4, pageCount: 3 });
    expect(mocks.listOlderReadyExports).toHaveBeenCalledWith(BOOK, EXP);
    expect(mocks.removeExportObjects).toHaveBeenCalledWith([`${USER}/${BOOK}/${OLD}.pdf`]);
    expect(mocks.deleteExportRows).toHaveBeenCalledWith(BOOK, [OLD]);
    expect(mocks.failExport).not.toHaveBeenCalled();
    // the upload happened before finish
    expect(mocks.uploadExportPdf.mock.invocationCallOrder[0]).toBeLessThan(mocks.finishExport.mock.invocationCallOrder[0]);
    expect(logs.join("\n")).toContain(`ready ${EXP}`);
    expectNoPii();
  });

  it("not claimable (already leased / done) → does nothing", async () => {
    mocks.claimExport.mockResolvedValue(null);
    expect(await runExport(EXP)).toBe("not_claimed");
    expect(mocks.getExportForRender).not.toHaveBeenCalled();
    expect(mocks.renderBook).not.toHaveBeenCalled();
    expect(mocks.failExport).not.toHaveBeenCalled();
  });

  it("malformed id → not claimed", async () => {
    expect(await runExport("nope")).toBe("not_claimed");
    expect(mocks.claimExport).not.toHaveBeenCalled();
  });

  it("finish false (lease lost) → removes the uploaded object, no cleanup, no fail", async () => {
    mocks.finishExport.mockResolvedValue(false);
    expect(await runExport(EXP)).toBe("lease_lost");
    expect(mocks.removeExportObjects).toHaveBeenCalledWith([PATH]);
    expect(mocks.listOlderReadyExports).not.toHaveBeenCalled();
    expect(mocks.deleteExportRows).not.toHaveBeenCalled();
    expect(mocks.failExport).not.toHaveBeenCalled();
  });

  it("finish throws → removes the uploaded object and fails the job", async () => {
    mocks.finishExport.mockRejectedValue(Object.assign(new Error("x"), { code: "08006" }));
    expect(await runExport(EXP)).toBe("failed");
    expect(mocks.removeExportObjects).toHaveBeenCalledWith([PATH]);
    expect(mocks.failExport).toHaveBeenCalledWith(EXP, TOKEN, "server_error");
  });

  it.each([
    ["chrome_unavailable"],
    ["navigation_failed"],
    ["image_failed"],
    ["render_timeout"],
    ["token_unavailable"],
  ] as const)("render error %s → failExport with that code, nothing uploaded", async (code) => {
    mocks.renderBook.mockRejectedValue(new PdfRenderError(code));
    expect(await runExport(EXP)).toBe("failed");
    expect(mocks.failExport).toHaveBeenCalledWith(EXP, TOKEN, code);
    expect(mocks.uploadExportPdf).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(`failed ${EXP} (${code})`);
    expectNoPii();
  });

  it("merge error → merge_failed", async () => {
    mocks.mergePdfs.mockRejectedValue(new PdfRenderError("merge_failed"));
    await runExport(EXP);
    expect(mocks.failExport).toHaveBeenCalledWith(EXP, TOKEN, "merge_failed");
  });

  it("> 50 MB → too_large, nothing uploaded", async () => {
    mocks.mergePdfs.mockResolvedValue({ bytes: new Uint8Array(50 * 1024 * 1024 + 1), pageCount: 3 });
    expect(await runExport(EXP)).toBe("failed");
    expect(mocks.failExport).toHaveBeenCalledWith(EXP, TOKEN, "too_large");
    expect(mocks.uploadExportPdf).not.toHaveBeenCalled();
  });

  it("upload error → upload_failed", async () => {
    mocks.uploadExportPdf.mockRejectedValue(new Error(`storage ${PATH}`));
    await runExport(EXP);
    expect(mocks.failExport).toHaveBeenCalledWith(EXP, TOKEN, "upload_failed");
    expect(mocks.finishExport).not.toHaveBeenCalled();
    expectNoPii();
  });

  it("export row gone or not rendering → not_found; invalid snapshot → invalid_doc", async () => {
    mocks.getExportForRender.mockResolvedValueOnce(null);
    await runExport(EXP);
    expect(mocks.failExport).toHaveBeenLastCalledWith(EXP, TOKEN, "not_found");

    mocks.getExportForRender.mockResolvedValueOnce({
      id: EXP,
      bookId: BOOK,
      userId: USER,
      docRev: 7,
      doc: { broken: true },
      captionLang: "en",
      status: "rendering",
    });
    await runExport(EXP);
    expect(mocks.failExport).toHaveBeenLastCalledWith(EXP, TOKEN, "invalid_doc");
    expect(mocks.renderBook).not.toHaveBeenCalled();
  });

  it("overall deadline → render_timeout, and the late render never uploads", async () => {
    let finishRender: (v: Buffer[]) => void = () => undefined;
    mocks.renderBook.mockReturnValue(new Promise<Buffer[]>((r) => (finishRender = r)));
    expect(await runExport(EXP, { deadlineMs: 20 })).toBe("failed");
    expect(mocks.failExport).toHaveBeenCalledWith(EXP, TOKEN, "render_timeout");
    finishRender([Buffer.from("late")]);
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.uploadExportPdf).not.toHaveBeenCalled();
  });

  it("older-PDF cleanup failure is logged but the export stays ready", async () => {
    mocks.removeExportObjects.mockRejectedValue(Object.assign(new Error("x"), { code: "500" }));
    expect(await runExport(EXP)).toBe("ready");
    expect(mocks.deleteExportRows).not.toHaveBeenCalled();
    expect(mocks.failExport).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(`cleanup_failed ${EXP} (500)`);
  });

  it("claim / fail_export DB errors never throw", async () => {
    mocks.claimExport.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "57014" }));
    expect(await runExport(EXP)).toBe("not_claimed");
    mocks.renderBook.mockRejectedValue(new PdfRenderError("print_failed"));
    mocks.failExport.mockRejectedValue(Object.assign(new Error("x"), { code: "57014" }));
    await expect(runExport(EXP)).resolves.toBe("failed");
  });
});

describe("runExport prefetch + timing logs", () => {
  function prefetchLoader() {
    return {
      get: vi.fn(() => Promise.resolve(Buffer.from("jpg"))),
      prefetch: vi.fn(),
      release: vi.fn(),
      stats: vi.fn(() => ({ produced: 3, failed: 0, heldBytes: 0, peakHeldBytes: 3 * 1024 * 200, downloadMs: 120, encodeMs: 45 })),
    };
  }
  const twoChunkDoc = () => {
    const d = doc(25); // cover + 25 pages = 26 sheets → chunks [0..19] [20..25]
    d.pages[24].slots[0].photoId = P(1); // P(1) also used by the second chunk
    return d;
  };

  it("prefetches the first window right after planning, releases per chunk, logs a timing line", async () => {
    const loader = prefetchLoader();
    mocks.createPrintImageLoader.mockReturnValue(loader);
    mocks.getExportForRender.mockResolvedValue({ id: EXP, bookId: BOOK, userId: USER, docRev: 7, doc: twoChunkDoc(), captionLang: "en", status: "rendering" });
    const sources = Array.from({ length: 24 }, (_, i) => i + 1).map((n) => ({ id: P(n), width: 3000, height: 4000, original_path: `x/${n}-original.jpg` }));
    mocks.listPrintPhotoSources.mockResolvedValue(sources);
    mocks.renderBook.mockImplementation(async (opts: { onChunkDone?: (k: number) => void; timings?: { launchMs: number; chunkMs: number[] } }) => {
      // prefetch was queued before the renderer (and its browser launch) started
      expect(loader.prefetch).toHaveBeenCalledTimes(2);
      expect(loader.release).not.toHaveBeenCalled();
      opts.timings!.launchMs = 400;
      opts.timings!.chunkMs = [900, 300];
      opts.onChunkDone!(0);
      opts.onChunkDone!(1);
      return [Buffer.from("a"), Buffer.from("b")];
    });

    expect(await runExport(EXP)).toBe("ready");
    const first = [...loader.prefetch.mock.calls[0][0]];
    const second = [...loader.prefetch.mock.calls[1][0]];
    expect(first[0]).toBe(P(9)); // cover first
    expect(first).toHaveLength(19); // cover P(9) + pages 1..19 (P(1)..P(19)), P(9) deduplicated
    expect(second).toEqual([P(20), P(21), P(22), P(23), P(24), P(1)]);
    const released = loader.release.mock.calls.flatMap((c) => [...c[0]]);
    expect(released).not.toContain(undefined);
    // P(1) is used again in chunk 1 → released only after chunk 1
    expect([...loader.release.mock.calls[0][0]]).not.toContain(P(1));
    expect([...loader.release.mock.calls[1][0]]).toContain(P(1));
    expect(new Set(released).size).toBe(sources.length);

    const timing = logs.find((l) => l.includes(`timing ${EXP}`));
    expect(timing).toBeDefined();
    expect(timing).toMatch(/load=\d+ plan=\d+ images_ready=-?\d+ launch=400 render=\d+ chunks=900\/300 merge=\d+ upload=\d+ finish=\d+/);
    expect(timing).toMatch(/imgs=24 produced=3 failed=0 peak_kb=600 dl_sum=120 enc_sum=45 conc=auto/);
    expectNoPii();
    for (const s of sources) expect(logs.join("\n")).not.toContain(s.id);
  });

  it("encodeConcurrency is passed to the loader", async () => {
    expect(await runExport(EXP, { encodeConcurrency: 1 })).toBe("ready");
    expect(mocks.createPrintImageLoader.mock.calls[0][2]).toEqual({ encodeConcurrency: 1 });
    expect(logs.join("\n")).toMatch(/conc=auto enc_conc=1/);
  });

  it("prefetch: false → lazy loading (no prefetch hook); imageConcurrency / parallelChunks are passed through", async () => {
    const loader = prefetchLoader();
    mocks.createPrintImageLoader.mockReturnValue(loader);
    expect(await runExport(EXP, { prefetch: false, imageConcurrency: 3, parallelChunks: 2 })).toBe("ready");
    expect(loader.prefetch).not.toHaveBeenCalled();
    expect(mocks.createPrintImageLoader.mock.calls[0][2]).toEqual({ concurrency: 3 });
    expect(logs.join("\n")).toMatch(/enc_conc=auto/);
    const opts = mocks.renderBook.mock.calls[0][0];
    expect(opts.onChunkDone).toBeUndefined();
    expect(opts.parallelChunks).toBe(2);
    expect(logs.join("\n")).toMatch(new RegExp(`timing ${EXP} .*conc=3`));
  });

  it("a failed job still logs its timing line (phases not reached = -1)", async () => {
    mocks.renderBook.mockRejectedValue(new PdfRenderError("render_timeout"));
    expect(await runExport(EXP)).toBe("failed");
    const timing = logs.find((l) => l.includes(`timing ${EXP}`));
    expect(timing).toMatch(/merge=-1 upload=-1 finish=-1/);
    expectNoPii();
  });
});

describe("failureCode", () => {
  it("maps typed errors to their codes and anything else to server_error", () => {
    expect(failureCode(new PdfRenderError("print_failed"))).toBe("print_failed");
    expect(failureCode(new PrintImageError("decode_failed"))).toBe("decode_failed");
    expect(failureCode(new Error("boom"))).toBe("server_error");
    expect(failureCode("x")).toBe("server_error");
  });
});
