import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  getMyBook: vi.fn(),
  getBookForRun: vi.fn(),
  writeDocIfReplaceable: vi.fn(),
  writeFallbackDocIfEmpty: vi.fn(),
  getUserMemoryAdmin: vi.fn(),
  upsertUserMemory: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({
  getMyBook: mocks.getMyBook,
  getBookForRun: mocks.getBookForRun,
  writeDocIfReplaceable: mocks.writeDocIfReplaceable,
  writeFallbackDocIfEmpty: mocks.writeFallbackDocIfEmpty,
}));
vi.mock("@/lib/db/memory", () => ({
  getUserMemoryAdmin: mocks.getUserMemoryAdmin,
  upsertUserMemory: mocks.upsertUserMemory,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const { finishEditingAction } = await import("@/app/books/[id]/edit/actions");
const { UserMemorySchema } = await import("@/lib/ai/schemas");

const USER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const BOOK = "11111111-1111-4111-8111-111111111111";
const SECRET = "SECRET_Ahmed_Private_Villa";
const UPDATED = "2026-11-09T07:00:00.000Z";

const words = (n: number) => `${SECRET} ${Array.from({ length: n - 1 }, () => "sea").join(" ")}`;

function caption(text: string, source: "user" | "ai") {
  return { text, font: "Playfair", align: "center", source };
}

/** An editor-saved doc (meta.userEdited true): 3 user captions (one an accepted ✨ rewrite →
 *  source "user", D-037 #1) of ~13 words, plus 2 long AI captions that must not count. */
function editorDoc() {
  const caps = [
    caption(words(12), "user"),
    caption(words(13), "user"),
    caption(words(14), "user"), // accepted rewrite
    caption(words(18), "ai"),
    caption(words(18), "ai"),
  ];
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: "a1", title: SECRET, subtitle: "" },
    chapters: [{ id: "c1", title: SECRET, dateLabel: "12 Oct 2026", place: SECRET }],
    pages: caps.map((c, i) => ({
      id: `p${i + 1}`,
      chapterId: "c1",
      layout: "one-portrait",
      slots: [{ photoId: "a1", crop: { x: 0.5, y: 0.5, zoom: 1 } }],
      caption: c,
    })),
    style: { background: "#FFFFFF", font: "Playfair" },
    meta: { generator: "ai", runId: null, userEdited: true },
  };
}

function runBook(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK,
    user_id: USER,
    title: SECRET,
    occasion: "travel",
    tone: "fun", // travel default → tone not learned
    caption_lang: "en",
    is_paid: false,
    max_pages: 20,
    doc: editorDoc(),
    updated_at: UPDATED,
    ai_status: "done",
    ...overrides,
  };
}

let logs: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: USER };
  mocks.getMyBook.mockResolvedValue({ id: BOOK });
  mocks.getBookForRun.mockResolvedValue(runBook());
  mocks.getUserMemoryAdmin.mockResolvedValue(null);
  mocks.upsertUserMemory.mockResolvedValue(undefined);
  logs = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  logs.forEach((s) => s.mockRestore());
});

const loggedText = () => JSON.stringify(logs.flatMap((s) => s.mock.calls));

function expectNoDocWrite() {
  expect(mocks.writeDocIfReplaceable).not.toHaveBeenCalled();
  expect(mocks.writeFallbackDocIfEmpty).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
}

describe("finishEditingAction", () => {
  it("learns caption length from the saved user captions only, leaves the doc untouched", async () => {
    const book = runBook();
    const before = structuredClone(book.doc);
    mocks.getBookForRun.mockResolvedValue(book);

    await expect(finishEditingAction(BOOK)).resolves.toEqual({ ok: true, redirectTo: `/books/${BOOK}/publish` });

    expect(mocks.getBookForRun).toHaveBeenCalledWith(BOOK);
    expect(mocks.getUserMemoryAdmin).toHaveBeenCalledWith(USER);
    expect(mocks.upsertUserMemory).toHaveBeenCalledTimes(1);
    const [uid, prefs] = mocks.upsertUserMemory.mock.calls[0];
    expect(uid).toBe(USER);
    expect(UserMemorySchema.safeParse(prefs).success).toBe(true);
    // median of user captions 12/13/14 = 13 → medium; the 18-word AI captions would make it long.
    expect(prefs).toMatchObject({
      language: "en",
      captionLength: "medium",
      sources: { captionLength: "user_captions" },
    });
    expect(prefs).not.toHaveProperty("tonePreference");
    expect(JSON.stringify(prefs)).not.toContain(SECRET);

    expect(book.doc).toEqual(before);
    expectNoDocWrite();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(logs.every((s) => s.mock.calls.length === 0)).toBe(true);
  });

  it("fewer than 3 user captions → caption length not learned", async () => {
    const d = editorDoc();
    d.pages[2].caption = caption(words(14), "ai");
    mocks.getBookForRun.mockResolvedValue(runBook({ doc: d }));
    await expect(finishEditingAction(BOOK)).resolves.toMatchObject({ ok: true });
    const prefs = mocks.upsertUserMemory.mock.calls[0][1];
    expect(prefs).not.toHaveProperty("captionLength");
  });

  it("signed out → signed_out, no reads or writes", async () => {
    mocks.user = null;
    await expect(finishEditingAction(BOOK)).resolves.toEqual({ ok: false, error: "signed_out" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
    expect(mocks.getBookForRun).not.toHaveBeenCalled();
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
    expectNoDocWrite();
  });

  it("invalid id → not_found without any query", async () => {
    await expect(finishEditingAction("nope")).resolves.toEqual({ ok: false, error: "not_found" });
    await expect(finishEditingAction(7 as unknown as string)).resolves.toEqual({ ok: false, error: "not_found" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("non-owner (RLS → null) → not_found, no memory read or write", async () => {
    mocks.getMyBook.mockResolvedValue(null);
    await expect(finishEditingAction(BOOK)).resolves.toEqual({ ok: false, error: "not_found" });
    expect(mocks.getBookForRun).not.toHaveBeenCalled();
    expect(mocks.getUserMemoryAdmin).not.toHaveBeenCalled();
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
    expectNoDocWrite();
  });

  it("admin read owned by someone else (belt and braces) → no memory write", async () => {
    mocks.getBookForRun.mockResolvedValue(runBook({ user_id: OTHER }));
    await expect(finishEditingAction(BOOK)).resolves.toMatchObject({ ok: true });
    expect(mocks.getUserMemoryAdmin).not.toHaveBeenCalled();
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
    expectNoDocWrite();
  });

  it("getMyBook error → failed, code only logged", async () => {
    mocks.getMyBook.mockRejectedValue(Object.assign(new Error(SECRET), { code: "08006" }));
    await expect(finishEditingAction(BOOK)).resolves.toEqual({ ok: false, error: "failed" });
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
    expect(loggedText()).toMatch(/\[editor\] finish: load failed \(08006\)/);
    expect(loggedText()).not.toContain(SECRET);
  });

  it("memory write error → still ok, logs a code only (no captions, prefs or ids)", async () => {
    mocks.upsertUserMemory.mockRejectedValue(Object.assign(new Error(SECRET), { code: "too_large" }));
    await expect(finishEditingAction(BOOK)).resolves.toEqual({ ok: true, redirectTo: `/books/${BOOK}/publish` });
    const text = loggedText();
    expect(text).toMatch(/\[editor\] memory update failed \(too_large\)/);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("sea sea");
    expect(text).not.toContain(USER);
    expect(text).not.toContain(BOOK);
  });

  it("unchanged memory → no upsert", async () => {
    mocks.getUserMemoryAdmin.mockResolvedValue({
      prefs: { v: 1, captionLength: "medium", language: "en", sources: { captionLength: "user_captions" } },
      updatedAt: UPDATED,
    });
    await expect(finishEditingAction(BOOK)).resolves.toMatchObject({ ok: true });
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
  });

  it("tone back at the occasion default keeps a previously learned tone (D-032 semantics unchanged)", async () => {
    mocks.getUserMemoryAdmin.mockResolvedValue({
      prefs: { v: 1, tonePreference: "romantic", language: "en", sources: { tone: "explicit" } },
      updatedAt: UPDATED,
    });
    await expect(finishEditingAction(BOOK)).resolves.toMatchObject({ ok: true });
    const prefs = mocks.upsertUserMemory.mock.calls[0][1];
    expect(prefs).toMatchObject({ tonePreference: "romantic", sources: { tone: "explicit" } });
  });
});
