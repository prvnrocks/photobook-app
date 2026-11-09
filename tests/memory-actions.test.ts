import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  getMyBook: vi.fn(),
  getBookForRun: vi.fn(),
  writeDocIfReplaceable: vi.fn(),
  getUserMemoryAdmin: vi.fn(),
  upsertUserMemory: vi.fn(),
  deleteOwnMemory: vi.fn(),
  clearMemoryFromActiveRuns: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({
  getMyBook: mocks.getMyBook,
  getBookForRun: mocks.getBookForRun,
  writeDocIfReplaceable: mocks.writeDocIfReplaceable,
}));
vi.mock("@/lib/db/memory", () => ({
  getUserMemoryAdmin: mocks.getUserMemoryAdmin,
  upsertUserMemory: mocks.upsertUserMemory,
  deleteOwnMemory: mocks.deleteOwnMemory,
}));
vi.mock("@/lib/db/agent-runs", () => ({
  getActiveRunForBook: vi.fn(),
  clearMemoryFromActiveRuns: mocks.clearMemoryFromActiveRuns,
}));
vi.mock("@/lib/db/photos", () => ({ listPhotosForCuration: vi.fn(), setUserOverride: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

const { confirmAlbumAction } = await import("@/app/books/[id]/review/actions");
const { clearMemoryAction } = await import("@/app/settings/actions");
const { UserMemorySchema } = await import("@/lib/ai/schemas");

const USER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const BOOK = "11111111-1111-4111-8111-111111111111";
const SECRET = "SECRET_Ahmed_Private_Villa";
const UPDATED = "2026-11-09T07:00:00.000Z";

function caption(text: string, source: "user" | "ai" = "user") {
  return { text, font: "Playfair", align: "center", source };
}

function doc() {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: "a1", title: SECRET, subtitle: "" },
    chapters: [{ id: "c1", title: SECRET, dateLabel: "12 Oct 2026", place: SECRET }],
    pages: ["p1", "p2", "p3"].map((id) => ({
      id,
      chapterId: "c1",
      layout: "one-portrait",
      slots: [{ photoId: "a1", crop: { x: 0.5, y: 0.5, zoom: 1 } }],
      caption: caption(`${SECRET} by the sea`),
    })),
    style: { background: "#FFFFFF", font: "Playfair" },
    meta: { generator: "ai", runId: null, userEdited: false },
  };
}

function runBook(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK,
    user_id: USER,
    title: SECRET,
    occasion: "travel",
    tone: "romantic", // travel default is not romantic → explicit
    caption_lang: "ar",
    is_paid: false,
    max_pages: 20,
    doc: doc(),
    updated_at: UPDATED,
    ai_status: "done",
    ...overrides,
  };
}

async function expectRedirect(p: Promise<unknown>, url: string) {
  await expect(p).rejects.toMatchObject({ url });
}

let logs: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: USER };
  mocks.getMyBook.mockResolvedValue({ id: BOOK });
  mocks.getBookForRun.mockResolvedValue(runBook());
  mocks.getUserMemoryAdmin.mockResolvedValue(null);
  mocks.upsertUserMemory.mockResolvedValue(undefined);
  mocks.clearMemoryFromActiveRuns.mockResolvedValue(0);
  logs = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  logs.forEach((s) => s.mockRestore());
});

function loggedText(): string {
  return JSON.stringify(logs.flatMap((s) => s.mock.calls));
}

describe("confirmAlbumAction", () => {
  it("signed out → /login with next back to review, no reads", async () => {
    mocks.user = null;
    await expectRedirect(
      confirmAlbumAction(BOOK),
      `/login?next=${encodeURIComponent(`/books/${BOOK}/review`)}`,
    );
    expect(mocks.getMyBook).not.toHaveBeenCalled();
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
  });

  it("invalid id → /dashboard without any query", async () => {
    await expectRedirect(confirmAlbumAction("not-a-uuid"), "/dashboard");
    await expectRedirect(confirmAlbumAction(42 as unknown as string), "/dashboard");
    expect(mocks.getMyBook).not.toHaveBeenCalled();
    expect(mocks.getBookForRun).not.toHaveBeenCalled();
  });

  it("another user's book (RLS → null) → /dashboard, no memory read or write", async () => {
    mocks.getMyBook.mockResolvedValue(null);
    await expectRedirect(confirmAlbumAction(BOOK), "/dashboard");
    expect(mocks.getBookForRun).not.toHaveBeenCalled();
    expect(mocks.getUserMemoryAdmin).not.toHaveBeenCalled();
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
  });

  it("admin read owned by someone else (belt and braces) → no memory write", async () => {
    mocks.getBookForRun.mockResolvedValue(runBook({ user_id: OTHER }));
    await expectRedirect(confirmAlbumAction(BOOK), "/dashboard");
    expect(mocks.getUserMemoryAdmin).not.toHaveBeenCalled();
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
  });

  it("owner + changed → upserts once with sanitized prefs for the session user", async () => {
    mocks.getUserMemoryAdmin.mockResolvedValue({
      prefs: { v: 1, junk: "x", knownNames: ["Sara", "sara"] },
      updatedAt: UPDATED,
    });
    await expectRedirect(confirmAlbumAction(BOOK), "/dashboard");
    expect(mocks.getUserMemoryAdmin).toHaveBeenCalledWith(USER);
    expect(mocks.upsertUserMemory).toHaveBeenCalledTimes(1);
    const [uid, prefs] = mocks.upsertUserMemory.mock.calls[0];
    expect(uid).toBe(USER);
    expect(UserMemorySchema.safeParse(prefs).success).toBe(true);
    expect(prefs).toMatchObject({
      v: 1,
      tonePreference: "romantic",
      language: "ar",
      captionLength: "short",
      knownNames: ["Sara"],
    });
    expect(prefs).not.toHaveProperty("junk");
    expect(JSON.stringify(prefs)).not.toContain(SECRET);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("unchanged memory → no upsert, still redirects", async () => {
    mocks.getUserMemoryAdmin.mockResolvedValue({
      prefs: {
        v: 1,
        tonePreference: "romantic",
        captionLength: "short",
        language: "ar",
        sources: { tone: "explicit", captionLength: "user_captions" },
      },
      updatedAt: UPDATED,
    });
    await expectRedirect(confirmAlbumAction(BOOK), "/dashboard");
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
  });

  it("only AI captions → caption length not learned", async () => {
    const d = doc();
    d.pages.forEach((p) => (p.caption = caption("A calm day by the sea", "ai")));
    mocks.getBookForRun.mockResolvedValue(runBook({ doc: d }));
    await expectRedirect(confirmAlbumAction(BOOK), "/dashboard");
    const prefs = mocks.upsertUserMemory.mock.calls[0][1];
    expect(prefs).not.toHaveProperty("captionLength");
  });

  it.each([
    ["getBookForRun", () => mocks.getBookForRun.mockRejectedValue(Object.assign(new Error(SECRET), { code: "PGRST301" }))],
    ["getUserMemoryAdmin", () => mocks.getUserMemoryAdmin.mockRejectedValue(Object.assign(new Error(SECRET), { code: "42501" }))],
    ["upsertUserMemory", () => mocks.upsertUserMemory.mockRejectedValue(Object.assign(new Error(SECRET), { code: "too_large" }))],
  ])("%s error → swallowed, still redirects, logs a code only", async (_name, arrange) => {
    arrange();
    await expectRedirect(confirmAlbumAction(BOOK), "/dashboard");
    const text = loggedText();
    expect(text).toMatch(/memory update failed \((PGRST301|42501|too_large)\)/);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(USER);
    expect(text).not.toContain(BOOK);
  });

  it("getMyBook error → /dashboard, code only logged, no memory", async () => {
    mocks.getMyBook.mockRejectedValue(Object.assign(new Error(SECRET), { code: "08006" }));
    await expectRedirect(confirmAlbumAction(BOOK), "/dashboard");
    expect(mocks.upsertUserMemory).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(SECRET);
  });

  it("success logs nothing", async () => {
    await expectRedirect(confirmAlbumAction(BOOK), "/dashboard");
    expect(mocks.upsertUserMemory).toHaveBeenCalledTimes(1);
    expect(logs.every((s) => s.mock.calls.length === 0)).toBe(true);
  });
});

describe("clearMemoryAction", () => {
  it("signed out → signed_out, no delete", async () => {
    mocks.user = null;
    await expect(clearMemoryAction()).resolves.toEqual({ ok: false, error: "signed_out" });
    expect(mocks.deleteOwnMemory).not.toHaveBeenCalled();
    expect(mocks.clearMemoryFromActiveRuns).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("also strips memory from the session user's active runs", async () => {
    mocks.deleteOwnMemory.mockResolvedValue(true);
    mocks.clearMemoryFromActiveRuns.mockResolvedValue(2);
    await expect(clearMemoryAction()).resolves.toEqual({ ok: true, cleared: true });
    expect(mocks.clearMemoryFromActiveRuns).toHaveBeenCalledTimes(1);
    expect(mocks.clearMemoryFromActiveRuns).toHaveBeenCalledWith(USER);
    expect(mocks.deleteOwnMemory.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearMemoryFromActiveRuns.mock.invocationCallOrder[0],
    );
    expect(logs.every((s) => s.mock.calls.length === 0)).toBe(true);
  });

  it("nothing to forget → still strips active runs", async () => {
    mocks.deleteOwnMemory.mockResolvedValue(false);
    await expect(clearMemoryAction()).resolves.toEqual({ ok: true, cleared: false });
    expect(mocks.clearMemoryFromActiveRuns).toHaveBeenCalledWith(USER);
  });

  it.each([true, false])("run strip failure is tolerated (cleared=%s), code only logged", async (cleared) => {
    mocks.deleteOwnMemory.mockResolvedValue(cleared);
    mocks.clearMemoryFromActiveRuns.mockRejectedValue(
      Object.assign(new Error(`${SECRET} ${USER}`), { code: "08006" }),
    );
    await expect(clearMemoryAction()).resolves.toEqual({ ok: true, cleared });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
    const text = loggedText();
    expect(text).toMatch(/clear run memory failed \(08006\)/);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(USER);
  });

  it("success → cleared true + revalidates /settings", async () => {
    mocks.deleteOwnMemory.mockResolvedValue(true);
    await expect(clearMemoryAction()).resolves.toEqual({ ok: true, cleared: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("nothing to forget → cleared false", async () => {
    mocks.deleteOwnMemory.mockResolvedValue(false);
    await expect(clearMemoryAction()).resolves.toEqual({ ok: true, cleared: false });
  });

  it("db error → failed, code only logged", async () => {
    mocks.deleteOwnMemory.mockRejectedValue(Object.assign(new Error(SECRET), { code: "42501" }));
    await expect(clearMemoryAction()).resolves.toEqual({ ok: false, error: "failed" });
    expect(mocks.clearMemoryFromActiveRuns).not.toHaveBeenCalled();
    const text = loggedText();
    expect(text).toContain("42501");
    expect(text).not.toContain(SECRET);
  });
});
