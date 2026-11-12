import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

// M5 Task 3 (D-036 / D-037): PUT /api/books/[id]/doc never trusts the client.

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  book: null as Record<string, unknown> | null,
  photos: [] as { id: string; status: string }[],
  getMyBook: vi.fn(),
  saveDocIfRev: vi.fn(),
  listPlaceablePhotos: vi.fn(),
  markPlacedPhotosKept: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook, saveDocIfRev: mocks.saveDocIfRev }));
vi.mock("@/lib/db/photos", () => ({
  listPlaceablePhotos: mocks.listPlaceablePhotos,
  markPlacedPhotosKept: mocks.markPlacedPhotosKept,
}));

const route = await import("@/app/api/books/[id]/doc/route");
const { validateEditorDoc, forcedMeta } = await import("@/lib/book/validate-editor-doc");

const BOOK = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FOREIGN = "99999999-9999-4999-8999-999999999999";
const SAVED_AT = "2026-11-10T10:00:00.000000+00:00";

const crop = { x: 0.5, y: 0.5, zoom: 1 };
function page(i: number, photoIds: (string | null)[] = [P(i + 1)], font = "Cairo") {
  return {
    id: `pg${i}`,
    chapterId: "m1",
    layout: "one-portrait",
    slots: photoIds.map((photoId) => ({ photoId, crop })),
    caption: { text: "A day by the sea", font, align: "center", source: "user" },
  };
}
function doc(pages = [page(0)], extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "family",
    cover: { layout: "cover", photoId: P(1), title: "Summer 2026", subtitle: "" },
    chapters: [{ id: "m1", title: "Beach", dateLabel: "Jul 2026", place: null }],
    pages,
    style: { background: "#FFFFFF", font: "Playfair" },
    ...extra,
  };
}

const ORIGIN = { origin: "http://localhost:3000" };
function req(body: unknown, headers: Record<string, string> = ORIGIN) {
  return new NextRequest(`http://localhost:3000/api/books/${BOOK}/doc`, {
    method: "PUT",
    headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = (id = BOOK) => ({ params: Promise.resolve({ id }) });
const put = (body: unknown, headers?: Record<string, string>, id?: string) =>
  route.PUT(req(body, headers), ctx(id));
const savedDoc = () => mocks.saveDocIfRev.mock.calls[0][2];

let logs: string[];
beforeEach(() => {
  mocks.user = { id: USER };
  mocks.book = {
    id: BOOK,
    title: "Old title",
    is_paid: false,
    max_pages: 20,
    doc_rev: 3,
    doc: doc([page(0)], { meta: { generator: "ai", generatorVersion: 2, runId: RUN, userEdited: false } }),
  };
  mocks.photos = Array.from({ length: 30 }, (_, i) => ({ id: P(i + 1), status: "kept" }));
  mocks.getMyBook.mockReset().mockImplementation(async () => mocks.book);
  mocks.listPlaceablePhotos.mockReset().mockImplementation(async () => mocks.photos);
  mocks.saveDocIfRev.mockReset().mockResolvedValue({ ok: true, rev: 4, savedAt: SAVED_AT });
  mocks.markPlacedPhotosKept.mockReset().mockResolvedValue(1);
  logs = [];
  for (const level of ["error", "log", "warn", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/books/[id]/doc", () => {
  it("exports PUT only, nodejs runtime", () => {
    expect(route.runtime).toBe("nodejs");
    expect(Object.keys(route)).not.toContain("POST");
    expect(Object.keys(route)).not.toContain("GET");
  });

  it("200 { rev, savedAt } and saves with the DB's ownership + baseRev", async () => {
    const res = await put({ doc: doc(), baseRev: 3 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ rev: 4, savedAt: SAVED_AT });
    const [bookId, ownerId, , pageCount, baseRev] = mocks.saveDocIfRev.mock.calls[0];
    expect([bookId, ownerId, pageCount, baseRev]).toEqual([BOOK, USER, 1, 3]);
  });

  it("403 cross-origin (no DB calls)", async () => {
    const res = await put({ doc: doc(), baseRev: 3 }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const noOrigin = await put({ doc: doc(), baseRev: 3 }, {});
    expect(noOrigin.status).toBe(403);
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("401 signed out", async () => {
    mocks.user = null;
    const res = await put({ doc: doc(), baseRev: 3 });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(mocks.saveDocIfRev).not.toHaveBeenCalled();
  });

  it("404 malformed id and non-owner / missing book", async () => {
    expect((await put({ doc: doc(), baseRev: 3 }, ORIGIN, "nope")).status).toBe(404);
    mocks.book = null;
    const res = await put({ doc: doc(), baseRev: 3 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mocks.saveDocIfRev).not.toHaveBeenCalled();
  });

  it("404 when the save finds no row", async () => {
    mocks.saveDocIfRev.mockResolvedValue({ ok: false, reason: "not_found" });
    expect((await put({ doc: doc(), baseRev: 3 })).status).toBe(404);
  });

  it("413 too large (declared and streamed)", async () => {
    const big = { doc: doc(), baseRev: 3, pad: "x".repeat(300 * 1024) };
    const res = await put(big);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });

    const streamed = new NextRequest(`http://localhost:3000/api/books/${BOOK}/doc`, {
      method: "PUT",
      headers: { host: "localhost:3000", ...ORIGIN },
      body: new ReadableStream({
        start(c) {
          for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode("y".repeat(64 * 1024)));
          c.close();
        },
      }),
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    expect((await route.PUT(streamed, ctx())).status).toBe(413);
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", "{nope"],
    ["missing doc", { baseRev: 3 }],
    ["negative baseRev", { doc: doc(), baseRev: -1 }],
    ["fractional baseRev", { doc: doc(), baseRev: 1.5 }],
    ["string baseRev", { doc: doc(), baseRev: "3" }],
    ["missing baseRev", { doc: doc() }],
  ])("400 invalid_body: %s", async (_name, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(mocks.saveDocIfRev).not.toHaveBeenCalled();
  });

  it("503 saving_unavailable when doc_rev is null (migration 0900 missing)", async () => {
    mocks.book = { ...mocks.book, doc_rev: null };
    const res = await put({ doc: doc(), baseRev: 0 });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "saving_unavailable" });
    expect(mocks.saveDocIfRev).not.toHaveBeenCalled();
  });

  it("409 stale rev (early) and when the conditional update loses the race", async () => {
    // Two or more revs behind → early 409. (One behind may be a replay of this save — below.)
    const stale = await put({ doc: doc(), baseRev: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict" });
    const ahead = await put({ doc: doc(), baseRev: 4 });
    expect(ahead.status).toBe(409);
    expect(mocks.saveDocIfRev).not.toHaveBeenCalled();

    mocks.saveDocIfRev.mockResolvedValue({ ok: false, reason: "conflict" });
    const raced = await put({ doc: doc(), baseRev: 3 });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "conflict" });
  });

  it("M12 T3: baseRev one behind (a save that committed while its response timed out) goes to saveDocIfRev", async () => {
    // doc_rev is 3: the client's retry still sends baseRev 2. saveDocIfRev decides replay vs conflict.
    mocks.saveDocIfRev.mockResolvedValue({ ok: true, rev: 3, savedAt: SAVED_AT });
    const replay = await put({ doc: doc(), baseRev: 2 });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ rev: 3, savedAt: SAVED_AT });
    expect(mocks.saveDocIfRev.mock.calls[0][4]).toBe(2);

    mocks.saveDocIfRev.mockResolvedValue({ ok: false, reason: "conflict" });
    const different = await put({ doc: doc(), baseRev: 2 });
    expect(different.status).toBe(409);
    expect(await different.json()).toEqual({ error: "conflict" });
  });

  it("M12 T3: a replay re-validates against the saved doc and sends the same stored doc (same forced meta)", async () => {
    // First save at rev 3 …
    await put({ doc: doc(), baseRev: 3 });
    const first = savedDoc();
    // … committed (rev 4, stored = what we sent) but the response was lost; the retry sends baseRev 3.
    mocks.book = { ...mocks.book, doc_rev: 4, doc: first };
    mocks.saveDocIfRev.mockClear();
    await put({ doc: doc(), baseRev: 3 });
    expect(JSON.stringify(savedDoc())).toBe(JSON.stringify(first));
  });

  it("422 foreign_photo for a photo id not in the book (page or cover)", async () => {
    const res = await put({ doc: doc([page(0, [FOREIGN])]), baseRev: 3 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "foreign_photo" });
    const cover = doc();
    cover.cover.photoId = FOREIGN;
    expect(await (await put({ doc: cover, baseRev: 3 })).json()).toEqual({ error: "foreign_photo" });
    expect(mocks.saveDocIfRev).not.toHaveBeenCalled();
  });

  it("422 page_limit: 21 pages on a free book; max_pages comes from the DB only", async () => {
    const pages = Array.from({ length: 21 }, (_, i) => page(i));
    const res = await put({ doc: doc(pages), baseRev: 3, maxPages: 100, is_paid: true });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "page_limit" });

    mocks.book = { ...mocks.book, is_paid: true, max_pages: 100 };
    expect((await put({ doc: doc(pages), baseRev: 3 })).status).toBe(200);
  });

  it("422 page_limit even above the schema maximum", async () => {
    const pages = Array.from({ length: 101 }, (_, i) => page(i, [null]));
    expect(await (await put({ doc: doc(pages), baseRev: 3 })).json()).toEqual({ error: "page_limit" });
  });

  it("422 invalid_doc / duplicate_photo / invalid_font carry codes only", async () => {
    const bad = { ...doc(), version: 2 };
    expect(await (await put({ doc: bad, baseRev: 3 })).json()).toEqual({ error: "invalid_doc" });

    const unknownLayout = doc([{ ...page(0), layout: "SECRET-caption-text" }]);
    const r1 = await put({ doc: unknownLayout, baseRev: 3 });
    expect(r1.status).toBe(422);
    expect(await r1.text()).not.toContain("SECRET");

    const dup = doc([page(0), page(1, [P(1)])]);
    expect(await (await put({ doc: dup, baseRev: 3 })).json()).toEqual({ error: "duplicate_photo" });

    const font = doc([page(0, [P(1)], "Comic Sans")]);
    expect(await (await put({ doc: font, baseRev: 3 })).json()).toEqual({ error: "invalid_font" });
  });

  it("an unchanged legacy caption font on the same page may stay; moving it elsewhere may not", async () => {
    mocks.book = { ...mocks.book, doc: doc([page(0, [P(1)], "Georgia")]) };
    expect((await put({ doc: doc([page(0, [P(1)], "Georgia")]), baseRev: 3 })).status).toBe(200);
    const other = doc([page(0, [P(1)], "Georgia"), page(1, [P(2)], "Georgia")]);
    expect(await (await put({ doc: other, baseRev: 3 })).json()).toEqual({ error: "invalid_font" });
  });

  it("client meta.userEdited:false is overridden to true", async () => {
    const meta = { generator: "ai", generatorVersion: 2, runId: RUN, userEdited: false };
    expect((await put({ doc: doc([page(0)], { meta }), baseRev: 3 })).status).toBe(200);
    expect(savedDoc().meta).toEqual({ ...meta, userEdited: true });
  });

  it("client meta.generator spoofing is ignored — origin fields come from the saved doc", async () => {
    mocks.book = {
      ...mocks.book,
      doc: doc([page(0)], { meta: { generator: "rule", generatorVersion: 1, runId: null, userEdited: false } }),
    };
    const spoof = { generator: "ai", generatorVersion: 9, runId: RUN, userEdited: false };
    await put({ doc: doc([page(0)], { meta: spoof }), baseRev: 3 });
    expect(savedDoc().meta).toEqual({ generator: "rule", generatorVersion: 1, runId: null, userEdited: true });
  });

  it("saved doc without meta (or {}) → rule defaults; client doc without meta gets one", async () => {
    mocks.book = { ...mocks.book, doc: {} };
    await put({ doc: doc(), baseRev: 3 });
    expect(savedDoc().meta).toEqual({ generator: "rule", generatorVersion: 1, runId: null, userEdited: true });
  });

  it("dropped photo placed in the doc → marked kept after a successful save", async () => {
    mocks.photos[1] = { id: P(2), status: "dropped" };
    mocks.photos[5] = { id: P(6), status: "dropped" }; // dropped but not placed
    const res = await put({ doc: doc([page(0), page(1)]), baseRev: 3 });
    expect(res.status).toBe(200);
    expect(mocks.markPlacedPhotosKept).toHaveBeenCalledWith(BOOK, [P(2)]);
    expect(mocks.saveDocIfRev.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markPlacedPhotosKept.mock.invocationCallOrder[0],
    );
  });

  it("no photo update when the save fails, and none when nothing dropped is placed", async () => {
    mocks.photos[1] = { id: P(2), status: "dropped" };
    mocks.saveDocIfRev.mockResolvedValue({ ok: false, reason: "conflict" });
    await put({ doc: doc([page(0), page(1)]), baseRev: 3 });
    expect(mocks.markPlacedPhotosKept).not.toHaveBeenCalled();

    mocks.saveDocIfRev.mockResolvedValue({ ok: true, rev: 4, savedAt: SAVED_AT });
    await put({ doc: doc([page(0)]), baseRev: 3 });
    expect(mocks.markPlacedPhotosKept).not.toHaveBeenCalled();
  });

  it("a failing photo update still returns 200 (logs code only)", async () => {
    mocks.photos[1] = { id: P(2), status: "dropped" };
    mocks.markPlacedPhotosKept.mockRejectedValue(Object.assign(new Error("boom"), { code: "42501" }));
    const res = await put({ doc: doc([page(0), page(1)]), baseRev: 3 });
    expect(res.status).toBe(200);
    expect(logs.join("\n")).toContain("42501");
  });

  it("cover title syncs to books.title (trimmed); empty keeps the existing title", async () => {
    const d = doc();
    d.cover.title = "  Our Eid 🌙  ";
    await put({ doc: d, baseRev: 3 });
    expect(mocks.saveDocIfRev.mock.calls[0][5]).toEqual({ title: "Our Eid 🌙" });

    mocks.saveDocIfRev.mockClear();
    d.cover.title = "   ";
    await put({ doc: d, baseRev: 3 });
    expect(mocks.saveDocIfRev.mock.calls[0][5]).toEqual({});
  });

  it("500 server_error on a DB failure, without doc contents in logs or response", async () => {
    mocks.saveDocIfRev.mockRejectedValue(Object.assign(new Error("x"), { code: "XX000" }));
    const d = doc();
    d.cover.title = "PRIVATE-TITLE";
    const res = await put({ doc: d, baseRev: 3 });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_error" });
    expect(logs.join("\n")).not.toContain("PRIVATE");
    expect(logs.join("\n")).not.toContain(BOOK);
  });

  it("strips unknown keys from the stored doc", async () => {
    await put({ doc: { ...doc(), evil: "<script>" }, baseRev: 3 });
    expect(savedDoc()).not.toHaveProperty("evil");
  });
});

describe("validateEditorDoc / forcedMeta (pure)", () => {
  const ctxFor = (savedDoc: unknown = {}) => ({ photoIds: new Set([P(1)]), maxPages: 20, savedDoc });

  it("returns placed photo ids including the cover", () => {
    const r = validateEditorDoc(doc(), ctxFor());
    expect(r.ok && r.placedPhotoIds).toEqual([P(1)]);
  });

  it("clips the title to 120 code points", () => {
    const d = doc();
    d.cover.title = "😀".repeat(120);
    const r = validateEditorDoc(d, ctxFor());
    expect(r.ok && Array.from(r.title ?? "").length).toBe(120);
  });

  it("forcedMeta ignores a malformed saved meta", () => {
    expect(forcedMeta({ meta: { generator: "ai", extra: 1 } })).toEqual({
      generator: "rule",
      generatorVersion: 1,
      runId: null,
      userEdited: true,
    });
    expect(forcedMeta(null).userEdited).toBe(true);
  });
});
