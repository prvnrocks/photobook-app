import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
  createBook: vi.fn(),
  deletePhoto: vi.fn(),
  deleteUnfinished: vi.fn(),
  stripPhotoFromBookDoc: vi.fn(),
  revalidatePath: vi.fn(),
}));

class RedirectError extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({ createBook: mocks.createBook, stripPhotoFromBookDoc: mocks.stripPhotoFromBookDoc }));
vi.mock("@/lib/db/photos", () => ({
  deletePhoto: mocks.deletePhoto,
  deleteUnfinished: mocks.deleteUnfinished,
}));

const { createBookAction, deletePhotoAction, deleteUnfinishedAction } = await import(
  "@/app/books/actions"
);
const { initialNewBookFormState } = await import("@/app/books/form-state");

const BOOK_ID = "22222222-2222-4222-8222-222222222222";
const PHOTO_ID = "33333333-3333-4333-8333-333333333333";

function form(fields: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, v);
  return fd;
}

const valid = { title: "Our trip", occasion: "travel", tone: "fun", captionLang: "en" };

async function run(fields: Record<string, string | undefined>) {
  try {
    return { state: await createBookAction(initialNewBookFormState, form(fields)), redirect: null };
  } catch (e) {
    if (e instanceof RedirectError) return { state: null, redirect: e.url };
    throw e;
  }
}

beforeEach(() => {
  mocks.user = { id: "11111111-1111-4111-8111-111111111111" };
  mocks.createBook.mockReset().mockResolvedValue({ id: BOOK_ID });
  mocks.deletePhoto.mockReset().mockResolvedValue(null);
  mocks.stripPhotoFromBookDoc.mockReset().mockResolvedValue("updated");
  mocks.deleteUnfinished.mockReset().mockResolvedValue(0);
  mocks.revalidatePath.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createBookAction", () => {
  it("creates the book and redirects to its upload page", async () => {
    const r = await run({ ...valid, format: "A5_LANDSCAPE", designStyle: "classic" });
    expect(r.redirect).toBe(`/books/${BOOK_ID}/upload`);
    expect(mocks.createBook).toHaveBeenCalledWith({
      title: "Our trip",
      occasion: "travel",
      tone: "fun",
      captionLang: "en",
      format: "A5_LANDSCAPE",
      designStyle: "classic",
    });
  });

  it("absent shape / style (pre-M10b form) → portrait + the occasion's default style (modern)", async () => {
    const r = await run(valid);
    expect(r.redirect).toBe(`/books/${BOOK_ID}/upload`);
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ format: "A5_PORTRAIT", designStyle: "modern" });
  });

  it("passes portrait + modern through", async () => {
    await run({ ...valid, format: "A5_PORTRAIT", designStyle: "modern" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ format: "A5_PORTRAIT", designStyle: "modern" });
  });

  it.each(["geometric", "scrapbook"])("refuses %s for now with a friendly error (D-065)", async (designStyle) => {
    const r = await run({ ...valid, format: "A5_PORTRAIT", designStyle });
    expect(r.redirect).toBeNull();
    expect(r.state?.fieldErrors?.designStyle).toMatch(/coming soon/i);
    expect(mocks.createBook).not.toHaveBeenCalled();
  });

  it("redirects signed-out users to login without creating", async () => {
    mocks.user = null;
    const r = await run(valid);
    expect(r.redirect).toBe("/login?next=/books/new");
    expect(mocks.createBook).not.toHaveBeenCalled();
  });

  it.each([
    ["occasion", { occasion: "birthday" }],
    ["occasion", { occasion: undefined }],
    ["tone", { tone: "sad" }],
    ["captionLang", { captionLang: "fr" }],
    ["captionLang", { captionLang: undefined }],
    ["format", { format: "A4_PORTRAIT" }],
    ["format", { format: "" }],
    ["format", { format: "a5_landscape" }],
    ["designStyle", { designStyle: "brutalist" }],
    ["designStyle", { designStyle: "" }],
    ["designStyle", { designStyle: "Modern" }],
  ] as const)("rejects a bad %s", async (field, patch) => {
    const r = await run({ ...valid, ...patch });
    expect(r.redirect).toBeNull();
    expect(r.state?.ok).toBe(false);
    expect(r.state?.fieldErrors?.[field]).toBeTruthy();
    expect(mocks.createBook).not.toHaveBeenCalled();
  });

  it("rejects a title over 120 characters, accepts exactly 120", async () => {
    const tooLong = await run({ ...valid, title: "a".repeat(121) });
    expect(tooLong.state?.fieldErrors?.title).toBeTruthy();
    expect(mocks.createBook).not.toHaveBeenCalled();

    const ok = await run({ ...valid, title: "a".repeat(120) });
    expect(ok.redirect).toBe(`/books/${BOOK_ID}/upload`);
  });

  it("counts code points, not UTF-16 units (emoji / Arabic)", async () => {
    const r = await run({ ...valid, title: "😀".repeat(120) });
    expect(r.redirect).toBe(`/books/${BOOK_ID}/upload`);
    const ar = await run({ ...valid, title: "رحلتنا ".repeat(10).trim() });
    expect(ar.redirect).toBe(`/books/${BOOK_ID}/upload`);
  });

  it("turns an empty / whitespace / missing title into null", async () => {
    for (const title of ["", "   ", "\n\t", undefined]) {
      mocks.createBook.mockClear();
      const r = await run({ ...valid, title });
      expect(r.redirect).toBe(`/books/${BOOK_ID}/upload`);
      expect(mocks.createBook.mock.calls[0][0].title).toBeNull();
    }
  });

  it("strips control characters and trims", async () => {
    await run({ ...valid, title: "  Our\u0000 trip\u0007\nto\tDubai\u001b  " });
    expect(mocks.createBook.mock.calls[0][0].title).toBe("Our trip to Dubai");
  });

  it("returns a generic error when the insert fails", async () => {
    mocks.createBook.mockRejectedValue(new Error("Failed to create book (23514)"));
    const r = await run(valid);
    expect(r.redirect).toBeNull();
    expect(r.state).toEqual({ ok: false, error: expect.any(String) });
    expect(r.state?.error).not.toContain("23514");
  });
});

describe("deletePhotoAction / deleteUnfinishedAction", () => {
  it("deletes and revalidates the upload page", async () => {
    expect(await deletePhotoAction(PHOTO_ID, BOOK_ID)).toEqual({ ok: true });
    expect(mocks.deletePhoto).toHaveBeenCalledWith(PHOTO_ID);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${BOOK_ID}/upload`);

    expect(await deleteUnfinishedAction(BOOK_ID)).toEqual({ ok: true });
    expect(mocks.deleteUnfinished).toHaveBeenCalledWith(BOOK_ID);
  });

  it("strips the deleted photo from the doc of the row's own book (not the client's id)", async () => {
    const OWN = "44444444-4444-4444-8444-444444444444";
    mocks.deletePhoto.mockResolvedValue(OWN);
    expect(await deletePhotoAction(PHOTO_ID, BOOK_ID)).toEqual({ ok: true });
    expect(mocks.stripPhotoFromBookDoc).toHaveBeenCalledWith(OWN, PHOTO_ID);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${OWN}/edit`);
  });

  it("no row deleted → no doc write", async () => {
    mocks.deletePhoto.mockResolvedValue(null);
    expect(await deletePhotoAction(PHOTO_ID, BOOK_ID)).toEqual({ ok: true });
    expect(mocks.stripPhotoFromBookDoc).not.toHaveBeenCalled();
  });

  it("a failing doc cleanup still reports the delete as done", async () => {
    mocks.deletePhoto.mockResolvedValue(BOOK_ID);
    mocks.stripPhotoFromBookDoc.mockRejectedValue(new Error("Failed to save book doc (500)"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await deletePhotoAction(PHOTO_ID, BOOK_ID)).toEqual({ ok: true });
      expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${BOOK_ID}/upload`);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects malformed ids without touching the db", async () => {
    expect((await deletePhotoAction("nope", BOOK_ID)).ok).toBe(false);
    expect((await deletePhotoAction(PHOTO_ID, "../x")).ok).toBe(false);
    expect((await deleteUnfinishedAction("x")).ok).toBe(false);
    expect(mocks.deletePhoto).not.toHaveBeenCalled();
    expect(mocks.deleteUnfinished).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses when signed out", async () => {
    mocks.user = null;
    expect((await deletePhotoAction(PHOTO_ID, BOOK_ID)).ok).toBe(false);
    expect((await deleteUnfinishedAction(BOOK_ID)).ok).toBe(false);
    expect(mocks.deletePhoto).not.toHaveBeenCalled();
  });

  it("returns a generic error when deletion fails", async () => {
    mocks.deletePhoto.mockRejectedValue(new Error("Failed to remove photo files (500)"));
    const r = await deletePhotoAction(PHOTO_ID, BOOK_ID);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("500");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
