import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
  createBook: vi.fn(),
  deletePhoto: vi.fn(),
  deleteUnfinished: vi.fn(),
  stripPhotoFromBookDoc: vi.fn(),
  revalidatePath: vi.fn(),
  getOwnMemoryView: vi.fn(),
  acceptLanguage: null as string | null,
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
vi.mock("next/headers", () => ({
  headers: async () => new Headers(mocks.acceptLanguage === null ? {} : { "accept-language": mocks.acceptLanguage }),
}));
vi.mock("@/lib/db/memory", () => ({ getOwnMemoryView: mocks.getOwnMemoryView }));
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
const { DEFAULT_TONE } = await import("@/lib/book/options");

const BOOK_ID = "22222222-2222-4222-8222-222222222222";
const PHOTO_ID = "33333333-3333-4333-8333-333333333333";

function form(fields: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, v);
  return fd;
}

/** M20 T9: createBookAction `next` = wizard step 5 inside /books/new (no upload page hop). */
const STEP5 = `/books/new?book=${BOOK_ID}&step=5`;

const valid = { title: "Our trip", occasion: "travel", tone: "fun", captionLang: "en" };

/**
 * `redirect` = where the user ends up: a thrown server redirect (signed out) or, since M19 BUG-2, the
 * success result's `next` (the wizard navigates there itself after fixing its history entry).
 */
async function run(fields: Record<string, string | undefined>) {
  try {
    const state = await createBookAction(initialNewBookFormState, form(fields));
    return { state, redirect: state.ok ? (state.next ?? null) : null };
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
  mocks.getOwnMemoryView.mockReset().mockResolvedValue({});
  mocks.acceptLanguage = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createBookAction", () => {
  it("creates the book and points next at wizard step 5 (M20 T9)", async () => {
    const r = await run({ ...valid, format: "A5_LANDSCAPE", designStyle: "classic" });
    expect(r.redirect).toBe(STEP5);
    expect(mocks.createBook).toHaveBeenCalledWith({
      title: "Our trip",
      occasion: "travel",
      tone: "fun",
      captionLang: "en",
      format: "A5_LANDSCAPE",
      designStyle: "classic",
    });
  });

  it("success returns the new id + next instead of redirecting (M19 BUG-2)", async () => {
    const state = await createBookAction(initialNewBookFormState, form(valid));
    expect(state).toMatchObject({ ok: true, bookId: BOOK_ID, next: STEP5 });
    // M20 T6: the wizard's step-5 data for the new book (shown in place, no extra request).
    expect(state.step5).toMatchObject({
      step: 5,
      bookId: BOOK_ID,
      title: "Our trip",
      rawTitle: "Our trip",
      occasion: "travel",
      captionLang: "en",
      isPaid: false,
      resolved: 5,
      userId: "11111111-1111-4111-8111-111111111111",
      existing: [],
      readyCount: 0,
      pendingCount: 0,
      hasDoc: false,
      firstRun: "none",
    });
    expect(state.step5?.maxUpload).toBeGreaterThan(0);
    expect(mocks.createBook).toHaveBeenCalledTimes(1);
  });

  it("analytics on → next carries the one-shot ?_ev=book_created exactly once", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    try {
      const state = await createBookAction(initialNewBookFormState, form(valid));
      expect(state.next).toBe(`${STEP5}&_ev=book_created`);
      expect(state.next?.match(/_ev=/g)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("revalidates the dashboard; redirect unchanged", async () => {
    const r = await run(valid);
    expect(r.redirect).toBe(STEP5);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("tone / captionLang present → used as sent; memory not read", async () => {
    mocks.getOwnMemoryView.mockResolvedValue({ tone: "nostalgic", language: "ar" });
    await run({ ...valid, tone: "minimal", captionLang: "en" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ tone: "minimal", captionLang: "en" });
    expect(mocks.getOwnMemoryView).not.toHaveBeenCalled();
  });

  it("tone / captionLang absent, no memory → DEFAULT_TONE[occasion] + en (D-071)", async () => {
    const r = await run({ title: "", occasion: "wedding" });
    expect(r.redirect).toBe(STEP5);
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({
      title: null,
      occasion: "wedding",
      tone: DEFAULT_TONE.wedding,
      captionLang: "en",
      format: "A5_PORTRAIT",
      designStyle: "modern",
    });
  });

  it("tone / captionLang absent → remembered tone + language (D-032)", async () => {
    mocks.getOwnMemoryView.mockResolvedValue({ tone: "nostalgic", language: "ar" });
    mocks.acceptLanguage = "en-US,en;q=0.9";
    await run({ occasion: "travel" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ tone: "nostalgic", captionLang: "ar" });
  });

  it("captionLang absent, no remembered language → Accept-Language (Arabic first → ar)", async () => {
    mocks.acceptLanguage = "ar-AE,ar;q=0.9,en;q=0.8";
    await run({ occasion: "travel", tone: "fun" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ tone: "fun", captionLang: "ar" });
  });

  it("D-072: an Arabic-script title → ar, winning over memory and Accept-Language", async () => {
    mocks.getOwnMemoryView.mockResolvedValue({ language: "en" });
    mocks.acceptLanguage = "en-US,en;q=0.9";
    await run({ title: "رحلتنا إلى العين", occasion: "travel" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ title: "رحلتنا إلى العين", captionLang: "ar" });
  });

  it("D-072 (refined): a mixed title with any Arabic letter → ar; a Latin title → en over memory / Accept-Language", async () => {
    await run({ title: "Eid 2026 عيد", occasion: "family" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ captionLang: "ar" });
    mocks.createBook.mockClear();
    // Memory Keeper remembered "ar" from an earlier book: an English title still gets English captions.
    mocks.getOwnMemoryView.mockResolvedValue({ language: "ar" });
    mocks.acceptLanguage = "ar-AE,ar;q=0.9";
    await run({ title: "Our trip", occasion: "travel" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ captionLang: "en" });
    mocks.createBook.mockClear();
    // No title → memory decides.
    await run({ title: "", occasion: "travel" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ captionLang: "ar" });
    mocks.createBook.mockClear();
    // No title, no memory → Accept-Language.
    mocks.getOwnMemoryView.mockResolvedValue({});
    mocks.acceptLanguage = "en-GB";
    await run({ title: "", occasion: "travel" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ captionLang: "en" });
  });

  it("D-072: an explicit captionLang still wins over an Arabic title", async () => {
    await run({ ...valid, title: "عيد", captionLang: "en" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ captionLang: "en" });
  });

  it("memory read failing is best effort → defaults, book still created", async () => {
    mocks.getOwnMemoryView.mockRejectedValue(new Error("db down"));
    const r = await run({ occasion: "baby" });
    expect(r.redirect).toBe(STEP5);
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ tone: DEFAULT_TONE.baby, captionLang: "en" });
  });

  it("absent shape / style (pre-M10b form) → portrait + the occasion's default style (travel → geometric, D-068)", async () => {
    const r = await run(valid);
    expect(r.redirect).toBe(STEP5);
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ format: "A5_PORTRAIT", designStyle: "geometric" });
  });

  it.each([
    ["wedding", "modern"],
    ["baby", "scrapbook"],
    ["other", "modern"],
  ] as const)("absent style for %s → %s (D-068)", async (occasion, designStyle) => {
    await run({ ...valid, occasion });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ designStyle });
  });

  it("passes portrait + modern through", async () => {
    await run({ ...valid, format: "A5_PORTRAIT", designStyle: "modern" });
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ format: "A5_PORTRAIT", designStyle: "modern" });
  });

  it.each([
    ["A5_PORTRAIT", "geometric"],
    ["A5_LANDSCAPE", "geometric"],
    ["A5_PORTRAIT", "scrapbook"],
    ["A5_LANDSCAPE", "scrapbook"],
  ] as const)("accepts %s + %s (M10c, D-068)", async (format, designStyle) => {
    const r = await run({ ...valid, occasion: "wedding", format, designStyle });
    expect(r.redirect).toBe(STEP5);
    expect(mocks.createBook.mock.calls[0][0]).toMatchObject({ format, designStyle });
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
    ["tone", { tone: "" }],
    ["captionLang", { captionLang: "fr" }],
    ["captionLang", { captionLang: "" }],
    ["format", { format: "A4_PORTRAIT" }],
    ["format", { format: "" }],
    ["format", { format: "a5_landscape" }],
    ["designStyle", { designStyle: "brutalist" }],
    ["designStyle", { designStyle: "" }],
    ["designStyle", { designStyle: "Modern" }],
    ["designStyle", { designStyle: "Scrapbook" }],
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
    expect(ok.redirect).toBe(STEP5);
  });

  it("counts code points, not UTF-16 units (emoji / Arabic)", async () => {
    const r = await run({ ...valid, title: "😀".repeat(120) });
    expect(r.redirect).toBe(STEP5);
    const ar = await run({ ...valid, title: "رحلتنا ".repeat(10).trim() });
    expect(ar.redirect).toBe(STEP5);
  });

  it("turns an empty / whitespace / missing title into null", async () => {
    for (const title of ["", "   ", "\n\t", undefined]) {
      mocks.createBook.mockClear();
      const r = await run({ ...valid, title });
      expect(r.redirect).toBe(STEP5);
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
