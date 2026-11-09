import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  getMyBook: vi.fn(),
  getBookForRun: vi.fn(),
  writeDocIfReplaceable: vi.fn(),
  getActiveRunForBook: vi.fn(),
  listPhotosForCuration: vi.fn(),
  setUserOverride: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({
  getMyBook: mocks.getMyBook,
  getBookForRun: mocks.getBookForRun,
  writeDocIfReplaceable: mocks.writeDocIfReplaceable,
}));
vi.mock("@/lib/db/agent-runs", () => ({ getActiveRunForBook: mocks.getActiveRunForBook }));
vi.mock("@/lib/db/photos", () => ({
  listPhotosForCuration: mocks.listPhotosForCuration,
  setUserOverride: mocks.setUserOverride,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const { updateAlbumAction } = await import("@/app/books/[id]/review/actions");

const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const SECRET_PLACE = "SECRET_PLACE_Private_Villa";
const T0 = "2026-11-09T07:00:00.000Z";
const T1 = "2026-11-09T07:00:05.000Z";

function row(id: string, takenAt: string | null, status: "kept" | "dropped" = "kept") {
  return {
    id,
    thumb_path: `u/${id}.jpg`,
    width: 3000,
    height: 4000,
    taken_at: takenAt,
    date_source: "exif",
    place: SECRET_PLACE,
    dup_group: null,
    blur_score: 50,
    ai: { v: 1, description: "SECRET_DESCRIPTION" },
    status,
    drop_reason: null,
    user_override: false,
    original_mime: "image/jpeg",
    camera: "iPhone",
  };
}

const ROWS = [row("a1", "2026-10-12T10:00:00"), row("a2", "2026-10-12T11:00:00"), row("a3", "2026-10-12T12:00:00")];

function aiDoc(userEdited = false): BookDoc {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: "a1", title: "Weekend", subtitle: "" },
    chapters: [{ id: "c1", title: "Beach", dateLabel: "12 Oct 2026", place: null }],
    pages: [
      { id: "p1", chapterId: "c1", layout: "one-portrait", slots: [{ photoId: "a1", crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption: null },
      {
        id: "p2",
        chapterId: "c1",
        layout: "two-vertical",
        slots: [
          { photoId: "a2", crop: { x: 0.5, y: 0.5, zoom: 1 } },
          { photoId: "a3", crop: { x: 0.5, y: 0.5, zoom: 1 } },
        ],
        caption: null,
      },
    ],
    style: { background: "#FFFFFF", font: "Playfair" },
    meta: { generator: "ai", generatorVersion: 2, runId: RUN, userEdited },
  };
}

function book(doc: unknown, updatedAt = T0) {
  return {
    id: BOOK,
    user_id: "u1",
    title: null,
    occasion: "travel",
    tone: "warm",
    caption_lang: "en",
    is_paid: false,
    max_pages: 20,
    doc,
    updated_at: updatedAt,
    ai_status: "done",
  };
}

let logs: string[];
beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === "function") m.mockReset();
  mocks.user = { id: "u1" };
  mocks.getMyBook.mockResolvedValue({ id: BOOK, doc: aiDoc() });
  mocks.getActiveRunForBook.mockResolvedValue(null);
  mocks.getBookForRun.mockResolvedValue(book(aiDoc()));
  mocks.listPhotosForCuration.mockResolvedValue(ROWS);
  mocks.writeDocIfReplaceable.mockResolvedValue({ ok: true });
  logs = [];
  const capture = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const writtenDoc = (call = 0) => mocks.writeDocIfReplaceable.mock.calls[call][1] as BookDoc;

describe("updateAlbumAction — guards", () => {
  it("signed out → signed_out, no db access", async () => {
    mocks.user = null;
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "signed_out" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "", "1111"])("malformed id %j → not_found", async (id) => {
    expect(await updateAlbumAction(id)).toEqual({ ok: false, error: "not_found" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("non-string id → not_found", async () => {
    expect(await updateAlbumAction(42 as unknown as string)).toEqual({ ok: false, error: "not_found" });
  });

  it("someone else's / missing book (RLS) → not_found, no admin read", async () => {
    mocks.getMyBook.mockResolvedValue(null);
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "not_found" });
    expect(mocks.getBookForRun).not.toHaveBeenCalled();
    expect(mocks.writeDocIfReplaceable).not.toHaveBeenCalled();
  });

  it("an active run → busy, nothing written", async () => {
    mocks.getActiveRunForBook.mockResolvedValue({ id: RUN, state: "curating" });
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "busy" });
    expect(mocks.getBookForRun).not.toHaveBeenCalled();
    expect(mocks.writeDocIfReplaceable).not.toHaveBeenCalled();
  });

  it("user-edited album → user_edited, nothing written", async () => {
    mocks.getBookForRun.mockResolvedValue(book(aiDoc(true)));
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "user_edited" });
    expect(mocks.writeDocIfReplaceable).not.toHaveBeenCalled();
  });

  it("unparsable doc → user_edited (never overwritten)", async () => {
    mocks.getBookForRun.mockResolvedValue(book({ version: 9 }));
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "user_edited" });
    expect(mocks.writeDocIfReplaceable).not.toHaveBeenCalled();
  });

  it("db error → failed with a generic code log (no photo data)", async () => {
    mocks.listPhotosForCuration.mockRejectedValue(Object.assign(new Error(SECRET_PLACE), { code: "PGRST301" }));
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "failed" });
    expect(logs.join("\n")).not.toContain(SECRET_PLACE);
    expect(logs.join("\n")).not.toContain("SECRET_DESCRIPTION");
  });
});

describe("updateAlbumAction — success paths", () => {
  it("no review changes → changed:false, nothing written", async () => {
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: true, changed: false, pages: 2 });
    expect(mocks.writeDocIfReplaceable).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("dropped photo → re-laid-out doc written with the lock, paths revalidated", async () => {
    mocks.listPhotosForCuration.mockResolvedValue([ROWS[0], row("a2", "2026-10-12T11:00:00", "dropped"), ROWS[2]]);
    const r = await updateAlbumAction(BOOK);
    expect(r).toEqual({ ok: true, changed: true, pages: 2 });
    expect(mocks.writeDocIfReplaceable).toHaveBeenCalledTimes(1);
    const [id, , pageCount, lock] = mocks.writeDocIfReplaceable.mock.calls[0];
    expect(id).toBe(BOOK);
    expect(pageCount).toBe(2);
    expect(lock).toEqual({ updatedAt: T0 });
    const doc = writtenDoc();
    expect(parseBookDoc(doc).ok).toBe(true);
    expect(doc.meta).toEqual({ generator: "ai", generatorVersion: 2, runId: RUN, userEdited: false });
    expect(doc.pages.flatMap((p) => p.slots.map((s) => s.photoId))).toEqual(["a1", "a3"]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/books/${BOOK}/review`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("newly kept photo → added", async () => {
    mocks.listPhotosForCuration.mockResolvedValue([...ROWS, row("a4", "2026-10-12T13:00:00")]);
    const r = await updateAlbumAction(BOOK);
    expect(r).toEqual({ ok: true, changed: true, pages: 3 });
    expect(writtenDoc().pages[2].slots[0].photoId).toBe("a4");
  });

  it("empty {} doc → fresh rule album (meta generator rule)", async () => {
    mocks.getBookForRun.mockResolvedValue(book({}));
    const r = await updateAlbumAction(BOOK);
    expect(r.ok && r.changed).toBe(true);
    const doc = writtenDoc();
    expect(doc.meta).toMatchObject({ generator: "rule", runId: null, userEdited: false });
    expect(doc.pages.length).toBeGreaterThan(0);
  });

  it("empty {} doc and no kept photos → changed:false, nothing written", async () => {
    mocks.getBookForRun.mockResolvedValue(book({}));
    mocks.listPhotosForCuration.mockResolvedValue(ROWS.map((r) => ({ ...r, status: "dropped" })));
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: true, changed: false, pages: 0 });
    expect(mocks.writeDocIfReplaceable).not.toHaveBeenCalled();
  });

  it("write says user_edited (edit landed meanwhile) → user_edited", async () => {
    mocks.listPhotosForCuration.mockResolvedValue([ROWS[0], ROWS[1]]);
    mocks.writeDocIfReplaceable.mockResolvedValue({ ok: false, reason: "user_edited" });
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "user_edited" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("conflict → reloads the book and retries once with the new lock", async () => {
    mocks.listPhotosForCuration.mockResolvedValue([ROWS[0], ROWS[1]]);
    mocks.getBookForRun.mockResolvedValueOnce(book(aiDoc(), T0)).mockResolvedValueOnce(book(aiDoc(), T1));
    mocks.writeDocIfReplaceable.mockResolvedValueOnce({ ok: false, reason: "conflict" }).mockResolvedValueOnce({ ok: true });
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: true, changed: true, pages: 2 });
    expect(mocks.writeDocIfReplaceable).toHaveBeenCalledTimes(2);
    expect(mocks.writeDocIfReplaceable.mock.calls[1][3]).toEqual({ updatedAt: T1 });
  });

  it("conflict twice → busy", async () => {
    mocks.listPhotosForCuration.mockResolvedValue([ROWS[0], ROWS[1]]);
    mocks.writeDocIfReplaceable.mockResolvedValue({ ok: false, reason: "conflict" });
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "busy" });
    expect(mocks.writeDocIfReplaceable).toHaveBeenCalledTimes(2);
  });

  it("write not_found → not_found", async () => {
    mocks.listPhotosForCuration.mockResolvedValue([ROWS[0], ROWS[1]]);
    mocks.writeDocIfReplaceable.mockResolvedValue({ ok: false, reason: "not_found" });
    expect(await updateAlbumAction(BOOK)).toEqual({ ok: false, error: "not_found" });
  });

  it("never logs photo data on success", async () => {
    mocks.listPhotosForCuration.mockResolvedValue([ROWS[0], ROWS[1]]);
    await updateAlbumAction(BOOK);
    expect(logs).toEqual([]);
  });
});
