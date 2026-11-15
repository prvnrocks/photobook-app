import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRuleDraft, type DraftPhotoRow } from "@/lib/book/rule-draft";

vi.mock("server-only", () => ({}));

// M13 T2 (D-070): updateBookSetupAction.

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOOK_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-11-12T10:00:00.000Z";

const mocks = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
  acceptLanguage: null as string | null,
  memory: null as { tone?: string; language?: string } | null,
  memoryError: false,
  createBook: vi.fn(),
  getMyBook: vi.fn(),
  hasAnyRunForBook: vi.fn(),
  writeBookSetup: vi.fn(),
  listReadyPhotosForFinalize: vi.fn(),
  revalidatePath: vi.fn(),
  draftFails: false,
}));

vi.mock("@/lib/book/rule-draft", async (orig) => {
  const actual = await orig<typeof import("@/lib/book/rule-draft")>();
  return {
    ...actual,
    buildRuleDraft: (...args: Parameters<typeof actual.buildRuleDraft>) =>
      mocks.draftFails ? { ok: false, reason: "invalid" } : actual.buildRuleDraft(...args),
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => (k === "accept-language" ? mocks.acceptLanguage : null) }),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({
  createBook: mocks.createBook,
  getMyBook: mocks.getMyBook,
  writeBookSetup: mocks.writeBookSetup,
  stripPhotoFromBookDoc: vi.fn(),
}));
vi.mock("@/lib/db/agent-runs", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/agent-runs")>()),
  hasAnyRunForBook: mocks.hasAnyRunForBook,
}));
vi.mock("@/lib/db/memory", () => ({
  getOwnMemoryView: async () => {
    if (mocks.memoryError) throw new Error("db down");
    return mocks.memory;
  },
}));
vi.mock("@/lib/db/photos", () => ({
  deletePhoto: vi.fn(),
  deleteUnfinished: vi.fn(),
  listReadyPhotosForFinalize: mocks.listReadyPhotosForFinalize,
}));

const { updateBookSetupAction } = await import("@/app/books/actions");

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PHOTOS: DraftPhotoRow[] = Array.from({ length: 8 }, (_, i) => ({
  id: pid(i + 1),
  width: 1200,
  height: 1600,
  taken_at: `2026-10-12T${String(8 + i).padStart(2, "0")}:00:00+04:00`,
  date_source: "exif",
  place: null,
  blur_score: 100,
  status: "kept",
  dup_group: null,
  color: "#a0b0c0",
}));

function ruleDraft(format: "A5_PORTRAIT" | "A5_LANDSCAPE" = "A5_PORTRAIT", designStyle: "modern" | "classic" = "modern") {
  const r = buildRuleDraft(PHOTOS, { occasion: "other", title: null, captionLang: "en", isPaid: false, design: { format, designStyle } });
  if (!r.ok) throw new Error("fixture draft failed");
  return JSON.parse(JSON.stringify(r.doc)) as Record<string, unknown> & { meta: Record<string, unknown> };
}

function book(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    title: null,
    occasion: "other",
    tone: "minimal",
    caption_lang: "en",
    is_paid: false,
    max_pages: 20,
    page_count: 0,
    doc: {},
    updated_at: UPDATED_AT,
    doc_rev: 0,
    format: "A5_PORTRAIT",
    design_style: "modern",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.user = { id: OWNER };
  mocks.acceptLanguage = null;
  mocks.memory = null;
  mocks.memoryError = false;
  mocks.draftFails = false;
  mocks.createBook.mockReset().mockResolvedValue({ id: BOOK_ID });
  mocks.getMyBook.mockReset().mockResolvedValue(book());
  mocks.hasAnyRunForBook.mockReset().mockResolvedValue(false);
  mocks.writeBookSetup.mockReset().mockResolvedValue({ ok: true });
  mocks.listReadyPhotosForFinalize.mockReset().mockResolvedValue(PHOTOS);
  mocks.revalidatePath.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// startBookAction (photos-first start) was removed in M19 (D-071); createBookAction's defaults from
// memory / Accept-Language are covered in tests/books-actions.test.ts.

describe("updateBookSetupAction — details", () => {
  it("changes occasion / tone / language / title on an empty book (columns only)", async () => {
    const r = await updateBookSetupAction(BOOK_ID, {
      occasion: "wedding",
      tone: "romantic",
      captionLang: "ar",
      title: "  Our  wedding\n",
    });
    expect(r).toEqual({
      ok: true,
      relaidOut: false,
      setup: {
        occasion: "wedding",
        tone: "romantic",
        captionLang: "ar",
        title: "Our  wedding",
        format: "A5_PORTRAIT",
        designStyle: "modern",
      },
    });
    expect(mocks.writeBookSetup).toHaveBeenCalledWith(
      BOOK_ID,
      OWNER,
      { occasion: "wedding", tone: "romantic", caption_lang: "ar", title: "Our  wedding" },
      UPDATED_AT,
      undefined,
    );
    expect(mocks.listReadyPhotosForFinalize).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${BOOK_ID}/upload`);
  });

  it("an empty title clears it (AI suggests one)", async () => {
    mocks.getMyBook.mockResolvedValue(book({ title: "Old" }));
    const r = await updateBookSetupAction(BOOK_ID, { title: "   " });
    expect(r).toMatchObject({ ok: true, setup: { title: null } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ title: null });
  });

  it("unchanged values are a no-op (no write, no run check)", async () => {
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "other", format: "A5_PORTRAIT", designStyle: "modern" });
    expect(r).toMatchObject({ ok: true, relaidOut: false });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
    expect(mocks.hasAnyRunForBook).not.toHaveBeenCalled();
  });

  it("details are locked once an AI run exists", async () => {
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "travel" });
    expect(r).toEqual({ ok: false, error: "locked", reason: "ai_started" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it.each([
    ["title", { title: "New title" }],
    ["occasion", { occasion: "baby" }],
    ["tone", { tone: "fun" }],
    ["captionLang", { captionLang: "ar" }],
  ] as const)("%s is locked on a user-edited album (M13 review, D-037 #7: the user's cover title wins)", async (_f, patch) => {
    const doc = ruleDraft();
    doc.meta.userEdited = true;
    (doc.cover as { title?: string }).title = "My own cover";
    mocks.getMyBook.mockResolvedValue(book({ doc, title: "Old" }));
    const r = await updateBookSetupAction(BOOK_ID, patch);
    expect(r).toEqual({ ok: false, error: "locked", reason: "user_edited" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
    expect(mocks.listReadyPhotosForFinalize).not.toHaveBeenCalled();
  });

  it("details are locked on an AI album even if its run row is gone", async () => {
    const doc = ruleDraft();
    doc.meta.generator = "ai";
    mocks.getMyBook.mockResolvedValue(book({ doc }));
    const r = await updateBookSetupAction(BOOK_ID, { title: "Eid" });
    expect(r).toEqual({ ok: false, error: "locked", reason: "ai_started" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("sending the unchanged setup back to a user-edited album is still a no-op success", async () => {
    const doc = ruleDraft();
    doc.meta.userEdited = true;
    mocks.getMyBook.mockResolvedValue(book({ doc }));
    expect(await updateBookSetupAction(BOOK_ID, { occasion: "other" })).toMatchObject({ ok: true, relaidOut: false });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("re-lays out an untouched rule draft when the title changes", async () => {
    mocks.getMyBook.mockResolvedValue(book({ doc: ruleDraft() }));
    const r = await updateBookSetupAction(BOOK_ID, { title: "Eid 2026" });
    expect(r).toMatchObject({ ok: true, relaidOut: true });
    const draft = mocks.writeBookSetup.mock.calls[0][4] as { doc: { cover: { title: string } }; pageCount: number };
    expect(draft.doc.cover.title).toBe("Eid 2026");
  });

  it("tone alone never re-lays out", async () => {
    mocks.getMyBook.mockResolvedValue(book({ doc: ruleDraft() }));
    const r = await updateBookSetupAction(BOOK_ID, { tone: "fun" });
    expect(r).toMatchObject({ ok: true, relaidOut: false });
    expect(mocks.listReadyPhotosForFinalize).not.toHaveBeenCalled();
  });
});

describe("updateBookSetupAction — tone follows occasion (M19 review)", () => {
  it("an occasion change without a tone re-derives the tone from the new occasion", async () => {
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "wedding" });
    expect(r).toMatchObject({ ok: true, setup: { occasion: "wedding", tone: "romantic" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ occasion: "wedding", tone: "romantic" });
  });

  it("a remembered tone wins over the occasion default", async () => {
    mocks.memory = { tone: "fun" };
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "wedding" });
    expect(r).toMatchObject({ ok: true, setup: { tone: "fun" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ occasion: "wedding", tone: "fun" });
  });

  it("an explicit tone wins (no memory read needed)", async () => {
    mocks.memory = { tone: "fun" };
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "wedding", tone: "nostalgic" });
    expect(r).toMatchObject({ ok: true, setup: { occasion: "wedding", tone: "nostalgic" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ occasion: "wedding", tone: "nostalgic" });
  });

  it("an unchanged occasion keeps the book's tone", async () => {
    mocks.getMyBook.mockResolvedValue(book({ occasion: "wedding", tone: "fun" }));
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "wedding", title: "Us" });
    expect(r).toMatchObject({ ok: true, setup: { tone: "fun", title: "Us" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ title: "Us" });
  });

  it("a memory read failure falls back to the occasion default", async () => {
    mocks.memoryError = true;
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "baby" });
    expect(r).toMatchObject({ ok: true, setup: { occasion: "baby", tone: "nostalgic" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ occasion: "baby", tone: "nostalgic" });
  });

  it("revalidates the upload screen and the dashboard", async () => {
    await updateBookSetupAction(BOOK_ID, { title: "Eid" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${BOOK_ID}/upload`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });
});

describe("updateBookSetupAction — caption language follows the title (M20, D-072)", () => {
  it("an Arabic title without captionLang → ar (wins over memory and Accept-Language)", async () => {
    mocks.memory = { language: "en" };
    mocks.acceptLanguage = "en-US";
    const r = await updateBookSetupAction(BOOK_ID, { title: "عيد مبارك" });
    expect(r).toMatchObject({ ok: true, setup: { title: "عيد مبارك", captionLang: "ar" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ title: "عيد مبارك", caption_lang: "ar" });
  });

  it("an explicit captionLang wins over the title", async () => {
    const r = await updateBookSetupAction(BOOK_ID, { title: "عيد مبارك", captionLang: "en" });
    expect(r).toMatchObject({ ok: true, setup: { captionLang: "en" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ title: "عيد مبارك" });
  });

  it("a Latin title → en, whatever memory and Accept-Language say (D-072 refined)", async () => {
    mocks.getMyBook.mockResolvedValue(book({ title: "عيد", caption_lang: "ar" }));
    mocks.memory = { language: "ar" };
    mocks.acceptLanguage = "ar-AE,ar;q=0.9";
    const r = await updateBookSetupAction(BOOK_ID, { title: "Eid" });
    expect(r).toMatchObject({ ok: true, setup: { title: "Eid", captionLang: "en" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ title: "Eid", caption_lang: "en" });
  });

  it("a cleared title re-derives from memory, then Accept-Language", async () => {
    mocks.getMyBook.mockResolvedValue(book({ title: "Eid", caption_lang: "en" }));
    mocks.memory = { language: "ar" };
    expect(await updateBookSetupAction(BOOK_ID, { title: null })).toMatchObject({ ok: true, setup: { title: null, captionLang: "ar" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ title: null, caption_lang: "ar" });

    mocks.writeBookSetup.mockClear();
    mocks.memory = null;
    mocks.acceptLanguage = "ar-AE,ar;q=0.9";
    expect(await updateBookSetupAction(BOOK_ID, { title: null })).toMatchObject({ ok: true, setup: { captionLang: "ar" } });

    mocks.writeBookSetup.mockClear();
    mocks.acceptLanguage = "en-US";
    expect(await updateBookSetupAction(BOOK_ID, { title: null })).toMatchObject({ ok: true, setup: { captionLang: "en" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).toEqual({ title: null });
  });

  it("no title change → caption language untouched (no memory read needed)", async () => {
    mocks.getMyBook.mockResolvedValue(book({ title: "عيد", caption_lang: "en" }));
    const r = await updateBookSetupAction(BOOK_ID, { title: "عيد", occasion: "family" });
    expect(r).toMatchObject({ ok: true, setup: { captionLang: "en" } });
    expect(mocks.writeBookSetup.mock.calls[0][2]).not.toHaveProperty("caption_lang");
  });

  it("locked details never change the language", async () => {
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    expect(await updateBookSetupAction(BOOK_ID, { title: "عيد" })).toEqual({ ok: false, error: "locked", reason: "ai_started" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("a derived language change re-lays out the rule draft in that language", async () => {
    mocks.getMyBook.mockResolvedValue(book({ doc: ruleDraft() }));
    const r = await updateBookSetupAction(BOOK_ID, { title: "عيد" });
    expect(r).toMatchObject({ ok: true, relaidOut: true, setup: { captionLang: "ar" } });
    const draft = mocks.writeBookSetup.mock.calls[0][4] as { doc: { captionLang?: string; cover: { title: string } } };
    expect(draft.doc.cover.title).toBe("عيد");
  });
});

describe("updateBookSetupAction — shape / style (D-070)", () => {
  it("changes shape + style on an empty book (columns only; finalize lays out later)", async () => {
    const r = await updateBookSetupAction(BOOK_ID, { format: "A5_LANDSCAPE", designStyle: "scrapbook" });
    expect(r).toMatchObject({ ok: true, relaidOut: false, setup: { format: "A5_LANDSCAPE", designStyle: "scrapbook" } });
    expect(mocks.writeBookSetup).toHaveBeenCalledWith(
      BOOK_ID,
      OWNER,
      { format: "A5_LANDSCAPE", design_style: "scrapbook" },
      UPDATED_AT,
      undefined,
    );
  });

  it("re-lays out an existing rule draft in the new design (columns + doc in one write)", async () => {
    mocks.getMyBook.mockResolvedValue(book({ doc: ruleDraft(), page_count: 5 }));
    const r = await updateBookSetupAction(BOOK_ID, { format: "A5_LANDSCAPE", designStyle: "classic" });
    expect(r).toMatchObject({ ok: true, relaidOut: true });
    const [, , columns, , draft] = mocks.writeBookSetup.mock.calls[0] as [
      string,
      string,
      unknown,
      string,
      { doc: { format: string; style: { designStyle?: string } }; pageCount: number },
    ];
    expect(columns).toEqual({ format: "A5_LANDSCAPE", design_style: "classic" });
    expect(draft.doc.format).toBe("A5_LANDSCAPE");
    expect(draft.doc.style.designStyle ?? "classic").toBe("classic");
    expect(draft.pageCount).toBeGreaterThan(0);
  });

  it("rejected after an AI run started", async () => {
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    const r = await updateBookSetupAction(BOOK_ID, { format: "A5_LANDSCAPE" });
    expect(r).toEqual({ ok: false, error: "locked", reason: "ai_started" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("rejected when the album is user-edited", async () => {
    const doc = ruleDraft();
    doc.meta.userEdited = true;
    mocks.getMyBook.mockResolvedValue(book({ doc }));
    const r = await updateBookSetupAction(BOOK_ID, { designStyle: "geometric" });
    expect(r).toEqual({ ok: false, error: "locked", reason: "user_edited" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("rejected when a run appears between the check and the write", async () => {
    mocks.hasAnyRunForBook.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const r = await updateBookSetupAction(BOOK_ID, { format: "A5_LANDSCAPE" });
    expect(r).toEqual({ ok: false, error: "locked", reason: "ai_started" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("refused when the draft can't be rebuilt (doc must agree with the columns)", async () => {
    mocks.getMyBook.mockResolvedValue(book({ doc: ruleDraft() }));
    mocks.draftFails = true;
    const r = await updateBookSetupAction(BOOK_ID, { format: "A5_LANDSCAPE" });
    expect(r).toEqual({ ok: false, error: "failed" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("a details change whose draft can't be rebuilt still saves the columns (doc untouched)", async () => {
    mocks.getMyBook.mockResolvedValue(book({ doc: ruleDraft() }));
    mocks.draftFails = true;
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "family" });
    expect(r).toMatchObject({ ok: true, relaidOut: false });
    expect(mocks.writeBookSetup.mock.calls[0][4]).toBeUndefined();
  });

  it("pre-1900 rows (format column missing) can't change the design", async () => {
    mocks.getMyBook.mockResolvedValue(book({ format: null, design_style: null }));
    const r = await updateBookSetupAction(BOOK_ID, { format: "A5_LANDSCAPE" });
    expect(r).toEqual({ ok: false, error: "failed" });
  });
});

describe("updateBookSetupAction — ownership, validation, races", () => {
  it("a foreign or missing book → not_found (RLS read returns null)", async () => {
    mocks.getMyBook.mockResolvedValue(null);
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "travel" });
    expect(r).toEqual({ ok: false, error: "not_found" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("malformed book id → not_found without any read", async () => {
    expect(await updateBookSetupAction("nope", { occasion: "travel" })).toEqual({ ok: false, error: "not_found" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("signed out → unauthenticated", async () => {
    mocks.user = null;
    expect(await updateBookSetupAction(BOOK_ID, { occasion: "travel" })).toEqual({ ok: false, error: "unauthenticated" });
  });

  it.each([
    ["occasion", { occasion: "birthday" }],
    ["tone", { tone: "sad" }],
    ["captionLang", { captionLang: "fr" }],
    ["format", { format: "A4_PORTRAIT" }],
    ["format", { format: "a5_landscape" }],
    ["designStyle", { designStyle: "brutalist" }],
    ["designStyle", { designStyle: "Modern" }],
    ["title", { title: "a".repeat(121) }],
    ["title", { title: 42 }],
  ] as const)("rejects a bad %s", async (field, patch) => {
    const r = await updateBookSetupAction(BOOK_ID, patch as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid");
    expect(r.fieldErrors?.[field]).toBeTruthy();
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("accepts a 120-code-point title (emoji count as one)", async () => {
    const r = await updateBookSetupAction(BOOK_ID, { title: "😀".repeat(120) });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown keys and empty patches", async () => {
    expect(await updateBookSetupAction(BOOK_ID, { isPaid: true } as never)).toMatchObject({ ok: false, error: "invalid" });
    expect(await updateBookSetupAction(BOOK_ID, {})).toMatchObject({ ok: false, error: "invalid" });
    expect(mocks.writeBookSetup).not.toHaveBeenCalled();
  });

  it("retries once on a conflict, then reports conflict", async () => {
    mocks.writeBookSetup.mockResolvedValue({ ok: false, reason: "conflict" });
    const r = await updateBookSetupAction(BOOK_ID, { occasion: "travel" });
    expect(r).toEqual({ ok: false, error: "conflict" });
    expect(mocks.writeBookSetup).toHaveBeenCalledTimes(2);
    expect(mocks.getMyBook).toHaveBeenCalledTimes(2);
  });

  it("a conflict followed by success re-reads the book", async () => {
    mocks.writeBookSetup.mockResolvedValueOnce({ ok: false, reason: "conflict" }).mockResolvedValueOnce({ ok: true });
    expect(await updateBookSetupAction(BOOK_ID, { occasion: "travel" })).toMatchObject({ ok: true });
  });

  it("a DB error → failed (no stack trace)", async () => {
    mocks.hasAnyRunForBook.mockRejectedValue(new Error("Failed to check book runs (500)"));
    expect(await updateBookSetupAction(BOOK_ID, { occasion: "travel" })).toEqual({ ok: false, error: "failed" });
  });
});
