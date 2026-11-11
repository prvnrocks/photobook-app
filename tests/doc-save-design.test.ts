// M10b A6 (D-063, review S2): PUT /api/books/[id]/doc takes format + design style from
// books.format / books.design_style, never from the client or the saved doc; spread `side` is
// allowed when aligned. TEST-ONLY spread layouts are mocked into the catalogue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/layouts", async (orig) => {
  const { withTestSpreads } = await import("./fixtures/test-spread-layouts");
  return withTestSpreads(await orig<typeof import("@/lib/layouts")>());
});

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  book: null as Record<string, unknown> | null,
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
const { forcedMeta } = await import("@/lib/book/validate-editor-doc");
const { bookDesignOf, withBookDesign, designOfDoc } = await import("@/lib/book/book-design");
const { parseBookDoc } = await import("@/lib/book/schema");

const BOOK = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SAVED_AT = "2026-11-11T10:00:00.000000+00:00";
const crop = { x: 0.5, y: 0.5, zoom: 1 };
const META = { generator: "ai", generatorVersion: 2, runId: RUN, userEdited: false };

function single(i: number, photo = P(i + 1)) {
  return {
    id: `pg${i}`,
    chapterId: "m1",
    layout: "one-portrait",
    slots: [{ photoId: photo, crop }],
    caption: { text: "A day by the sea", font: "Cairo", align: "center", source: "user" },
  };
}
/** test-spread-a (classic portrait, 3 photos + caption) as a left/right page pair. */
function spread(i: number, first: number) {
  return [
    {
      id: `pg${i}`,
      chapterId: "m1",
      layout: "test-spread-a",
      side: "left",
      slots: [0, 1, 2].map((k) => ({ photoId: P(first + k), crop })),
      caption: { text: "Spread caption", font: "Cairo", align: "center", source: "user" },
    },
    { id: `pg${i + 1}`, chapterId: "m1", layout: "test-spread-a", side: "right", slots: [], caption: null },
  ];
}
function v1Doc(pages: unknown[] = [single(0)], meta: unknown = META) {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "family",
    cover: { layout: "cover", photoId: P(1), title: "Summer 2026", subtitle: "" },
    chapters: [{ id: "m1", title: "Beach", dateLabel: "Jul 2026", place: null }],
    pages,
    style: { background: "#FFFFFF", font: "Playfair" },
    meta,
  };
}
function v2Doc(pages: unknown[], over: { format?: string; designStyle?: string } = {}) {
  return {
    version: 2,
    format: over.format ?? "A5_PORTRAIT",
    occasion: "family",
    cover: { layout: "cover", photoId: P(1), title: "Summer 2026", subtitle: "" },
    chapters: [{ id: "m1", title: "Beach", dateLabel: "Jul 2026", place: null }],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: over.designStyle ?? "classic", font: "Playfair" },
    meta: META,
  };
}

function req(body: unknown) {
  return new NextRequest(`http://localhost:3000/api/books/${BOOK}/doc`, {
    method: "PUT",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const put = (doc: unknown) => route.PUT(req({ doc, baseRev: 3 }), { params: Promise.resolve({ id: BOOK }) });
const stored = () => mocks.saveDocIfRev.mock.calls[0][2] as Record<string, unknown>;

beforeEach(() => {
  mocks.user = { id: USER };
  mocks.book = {
    id: BOOK,
    title: "Old title",
    is_paid: false,
    max_pages: 20,
    doc_rev: 3,
    format: "A5_PORTRAIT",
    design_style: "classic",
    doc: v1Doc(),
  };
  mocks.getMyBook.mockReset().mockImplementation(async () => mocks.book);
  mocks.listPlaceablePhotos
    .mockReset()
    .mockImplementation(async () => Array.from({ length: 30 }, (_, i) => ({ id: P(i + 1), status: "kept" })));
  mocks.saveDocIfRev.mockReset().mockResolvedValue({ ok: true, rev: 4, savedAt: SAVED_AT });
  mocks.markPlacedPhotosKept.mockReset().mockResolvedValue(0);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT doc — books.format / books.design_style are the authority (D-063)", () => {
  it("client sends landscape for a portrait book → stored portrait (v1 when nothing else is v2)", async () => {
    const res = await put({ ...v1Doc(), version: 2, format: "A5_LANDSCAPE", style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" } });
    expect(res.status).toBe(200);
    expect(stored().format).toBe("A5_PORTRAIT");
    expect(stored().version).toBe(1);
  });

  it("client sends designStyle modern for a classic book → stored classic", async () => {
    const res = await put(v2Doc([single(0)], { designStyle: "modern" }));
    expect(res.status).toBe(200);
    expect(stored().version).toBe(1); // classic portrait + no v2 feature → v1
    expect(parseBookDoc(stored()).ok && designOfDoc(stored())).toEqual({ format: "A5_PORTRAIT", designStyle: "classic" });
  });

  it("classic portrait save → v1, byte-identical to what was sent", async () => {
    const sent = v1Doc([single(0), single(1)], forcedMeta(mocks.book!.doc));
    const res = await put(sent);
    expect(res.status).toBe(200);
    expect(JSON.stringify(stored())).toBe(JSON.stringify(sent));
  });

  it("the columns win over the saved doc (saved doc says modern, column says classic)", async () => {
    mocks.book!.doc = v2Doc([single(0)], { designStyle: "modern" });
    const res = await put(v1Doc());
    expect(res.status).toBe(200);
    expect(stored().version).toBe(1);
  });

  it("style mismatch → 422 invalid_doc: classic layouts in a modern book; a modern layout in a classic book", async () => {
    mocks.book!.design_style = "modern";
    expect(await (await put(v1Doc())).json()).toEqual({ error: "invalid_doc" });
    mocks.book!.design_style = "classic";
    const modernPage = { ...single(0), layout: "test-modern-one" };
    const res = await put(v2Doc([modernPage]));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_doc" });
    expect(mocks.saveDocIfRev).not.toHaveBeenCalled();
  });

  it("format mismatch → 422 invalid_doc: portrait layouts in a landscape book", async () => {
    mocks.book!.format = "A5_LANDSCAPE";
    const res = await put(v1Doc());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_doc" });
  });

  it("valid spread pair (left at an even index + right half) → saved as v2 with sides", async () => {
    const res = await put(v2Doc([...spread(0, 1), single(2, P(10))]));
    expect(res.status).toBe(200);
    const pages = stored().pages as { side?: string; layout: string }[];
    expect(stored().version).toBe(2);
    expect(pages.map((p) => p.side)).toEqual(["left", "right", undefined]);
  });

  it("misaligned spread (left half on a right-hand page) → 422 invalid_doc", async () => {
    const res = await put(v2Doc([single(0, P(10)), ...spread(1, 1)]));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_doc" });
  });

  it("half a spread / side on a single page → 422 invalid_doc", async () => {
    const [left] = spread(0, 1);
    expect((await put(v2Doc([left, single(1, P(10))]))).status).toBe(422);
    expect((await put(v2Doc([{ ...single(0), side: "left" }]))).status).toBe(422);
    expect(mocks.saveDocIfRev).not.toHaveBeenCalled();
  });
});

describe("bookDesignOf / withBookDesign", () => {
  it("columns win; missing/invalid columns fall back to the doc's design, then the default", () => {
    expect(bookDesignOf({ format: "A5_LANDSCAPE", design_style: "modern", doc: v1Doc() })).toEqual({ format: "A5_LANDSCAPE", designStyle: "modern" });
    expect(bookDesignOf({ format: null, design_style: null, doc: v2Doc([], { designStyle: "modern" }) })).toEqual({ format: "A5_PORTRAIT", designStyle: "modern" });
    expect(bookDesignOf({ format: "nope", doc: {} })).toEqual({ format: "A5_PORTRAIT", designStyle: "classic" });
    expect(bookDesignOf({})).toEqual({ format: "A5_PORTRAIT", designStyle: "classic" });
  });

  it("withBookDesign returns the same object when nothing changes, a fresh one otherwise", () => {
    const parsed = parseBookDoc(v1Doc());
    if (!parsed.ok) throw new Error("fixture");
    const doc = parsed.doc;
    expect(withBookDesign(doc, { format: "A5_PORTRAIT", designStyle: "classic" })).toBe(doc);
    const modern = withBookDesign(doc, { format: "A5_PORTRAIT", designStyle: "modern" });
    expect(modern).not.toBe(doc);
    expect(modern.style.designStyle).toBe("modern");
    expect(doc.style.designStyle).toBe("classic"); // not mutated
  });
});
