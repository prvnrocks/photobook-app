import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M10c review S1 (D-062: only an explicit user pick may make a dropped photo public). An AI
// faded-photo background whose photo the user drops in review:
//   (a) togglePhotoAction(keep=false) prunes it from the draft right away (pruneUnkeptAiBackgrounds);
//   (b) the PDF export snapshot (what /print renders) strips it again — defence in depth.
// Publish is covered in publish-actions.test.ts; the DB write in db-books-prune-ai-backgrounds.test.ts.

const mocks = vi.hoisted(() => ({
  user: { id: "33333333-3333-4333-8333-333333333333" } as { id: string } | null,
  getMyBook: vi.fn(),
  pruneUnkeptAiBackgrounds: vi.fn(),
  setUserOverride: vi.fn(),
  listKeptPhotoIds: vi.fn(),
  createExportJob: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({
  getMyBook: mocks.getMyBook,
  getBookForRun: vi.fn(),
  writeDocIfReplaceable: vi.fn(),
  pruneUnkeptAiBackgrounds: mocks.pruneUnkeptAiBackgrounds,
}));
vi.mock("@/lib/db/photos", () => ({ setUserOverride: mocks.setUserOverride, listPhotosForCuration: vi.fn() }));
vi.mock("@/lib/db/agent-runs", () => ({ getActiveRunForBook: vi.fn() }));
vi.mock("@/lib/ai/learn-from-book", () => ({ learnFromBook: vi.fn() }));
vi.mock("@/lib/db/print", () => ({ listKeptPhotoIds: mocks.listKeptPhotoIds, listPrintPhotoSources: vi.fn() }));
vi.mock("@/lib/db/exports", async (orig) => {
  const real = await orig<typeof import("@/lib/db/exports")>();
  return {
    exportObjectPath: real.exportObjectPath,
    EXPORT_MAX_BYTES: real.EXPORT_MAX_BYTES,
    createExportJob: mocks.createExportJob,
    getExportForOwner: vi.fn(),
    signExportUrl: vi.fn(),
    supersedeExports: vi.fn(),
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
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const { togglePhotoAction } = await import("@/app/books/[id]/review/actions");
const { requestExport } = await import("@/lib/pdf/job");
const { parseBookDoc } = await import("@/lib/book/schema");
const { printPhotoIds } = await import("@/lib/pdf/print-doc");
const { hasAiPhotoBackground, stripUnusableAiPhotoBackgrounds } = await import("@/lib/design/background-suggest");
const { fadedBackgroundDoc, DROPPED, KEPT_A, KEPT_B, USER_PICK } = await import("./fixtures/ai-faded-background-doc");

const BOOK = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const EXP = "44444444-4444-4444-8444-444444444444";
const KEPT = new Set([KEPT_A, KEPT_B]);

function parsed(input: unknown) {
  const r = parseBookDoc(input);
  if (!r.ok) throw new Error("fixture doc must parse");
  return r.doc;
}

let logs: string[] = [];
beforeEach(() => {
  mocks.user = { id: USER };
  for (const m of [mocks.getMyBook, mocks.pruneUnkeptAiBackgrounds, mocks.setUserOverride, mocks.listKeptPhotoIds, mocks.createExportJob, mocks.revalidatePath]) {
    m.mockReset();
  }
  mocks.setUserOverride.mockResolvedValue(true);
  mocks.pruneUnkeptAiBackgrounds.mockResolvedValue("updated");
  mocks.listKeptPhotoIds.mockResolvedValue(KEPT);
  mocks.createExportJob.mockResolvedValue({ status: "created", exportId: EXP });
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});

describe("stripUnusableAiPhotoBackgrounds / hasAiPhotoBackground", () => {
  it("strips only AI photo backgrounds of unkept photos (page → none, book → style default); user picks stay", () => {
    const doc = parsed(fadedBackgroundDoc({ aiBookBackground: true }));
    expect(hasAiPhotoBackground(doc)).toBe(true);
    const r = stripUnusableAiPhotoBackgrounds(doc, (id) => KEPT.has(id));
    expect(r.changed).toBe(true);
    expect(r.doc.pages[0].background).toBeUndefined();
    expect(r.doc.pages[1].background).toMatchObject({ kind: "photo", photoId: USER_PICK, source: "user" });
    expect(r.doc.style.background).toEqual({ kind: "color", hex: "#FFFFFF" });
    expect(JSON.stringify(r.doc)).not.toContain(DROPPED);
    expect(hasAiPhotoBackground(r.doc)).toBe(false);
  });

  it("kept photo → same object, unchanged", () => {
    const doc = parsed(fadedBackgroundDoc());
    const r = stripUnusableAiPhotoBackgrounds(doc, () => true);
    expect(r).toEqual({ doc, changed: false });
    expect(r.doc).toBe(doc);
  });
});

describe("togglePhotoAction prunes AI backgrounds on drop (a)", () => {
  it.each([false, true])("drop + AI photo background → pruneUnkeptAiBackgrounds after the status write (userEdited %s)", async (userEdited) => {
    mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: fadedBackgroundDoc({ userEdited }) });
    expect(await togglePhotoAction(BOOK, DROPPED, false)).toEqual({ ok: true });
    expect(mocks.setUserOverride).toHaveBeenCalledWith(BOOK, DROPPED, false);
    expect(mocks.pruneUnkeptAiBackgrounds).toHaveBeenCalledWith(BOOK);
    expect(mocks.setUserOverride.mock.invocationCallOrder[0]).toBeLessThan(mocks.pruneUnkeptAiBackgrounds.mock.invocationCallOrder[0]);
  });

  it("keep, or a doc without AI photo backgrounds → no prune", async () => {
    mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: fadedBackgroundDoc() });
    expect(await togglePhotoAction(BOOK, DROPPED, true)).toEqual({ ok: true });
    mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: {} });
    expect(await togglePhotoAction(BOOK, DROPPED, false)).toEqual({ ok: true });
    expect(mocks.pruneUnkeptAiBackgrounds).not.toHaveBeenCalled();
  });

  it("prune failure is best effort: the choice is saved, ok, code-only log", async () => {
    mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: fadedBackgroundDoc() });
    mocks.pruneUnkeptAiBackgrounds.mockRejectedValueOnce(Object.assign(new Error(`boom ${DROPPED}`), { code: "XX000" }));
    expect(await togglePhotoAction(BOOK, DROPPED, false)).toEqual({ ok: true });
    mocks.pruneUnkeptAiBackgrounds.mockResolvedValueOnce("conflict");
    expect(await togglePhotoAction(BOOK, DROPPED, false)).toEqual({ ok: true });
    expect(logs).toHaveLength(2);
    for (const l of logs) expect(l).not.toContain(DROPPED);
  });
});

describe("PDF export snapshot (b)", () => {
  const book = (doc: unknown) => ({ id: BOOK, title: "Family", is_paid: true, max_pages: 100, doc_rev: 3, caption_lang: "en", doc });
  const env = { PDF_CHROME_PATH: "/opt/chrome", NEXT_PUBLIC_APP_URL: "http://localhost:3000", BOOK_ACCESS_SECRET: "s".repeat(40) } as unknown as NodeJS.ProcessEnv;
  const snapshot = () => mocks.createExportJob.mock.calls[0][0].doc as unknown;

  it("AI faded background of a dropped photo is not in the export doc (nor in the print photo ids); the user pick is", async () => {
    mocks.getMyBook.mockResolvedValue(book(fadedBackgroundDoc()));
    const r = await requestExport(BOOK, USER, { schedule: vi.fn(), env });
    expect(r.ok).toBe(true);
    expect(mocks.listKeptPhotoIds).toHaveBeenCalledWith(BOOK, USER);
    const doc = parsed(snapshot());
    expect(doc.pages[0].background).toBeUndefined();
    expect(doc.pages[1].background).toMatchObject({ kind: "photo", photoId: USER_PICK, source: "user" });
    expect(JSON.stringify(snapshot())).not.toContain(DROPPED);
    const ids = printPhotoIds(doc, ["cover", 0, 1]);
    expect(ids).not.toContain(DROPPED);
    expect(ids).toContain(USER_PICK);
  });

  it("no AI photo background → the stored doc verbatim, no photo query", async () => {
    const stored = { ...fadedBackgroundDoc(), pages: fadedBackgroundDoc().pages.slice(1) };
    mocks.getMyBook.mockResolvedValue(book(stored));
    expect((await requestExport(BOOK, USER, { schedule: vi.fn(), env })).ok).toBe(true);
    expect(snapshot()).toBe(stored);
    expect(mocks.listKeptPhotoIds).not.toHaveBeenCalled();
  });

  it("AI photo background of a kept photo → the stored doc verbatim", async () => {
    const stored = fadedBackgroundDoc();
    mocks.getMyBook.mockResolvedValue(book(stored));
    mocks.listKeptPhotoIds.mockResolvedValue(new Set([KEPT_A, KEPT_B, DROPPED]));
    expect((await requestExport(BOOK, USER, { schedule: vi.fn(), env })).ok).toBe(true);
    expect(snapshot()).toBe(stored);
  });
});
