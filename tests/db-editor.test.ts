import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M5 Task 4: getEditorData / getPhotoUrls (src/lib/db/editor.ts).

type Result = { data: unknown; error: { code?: string } | null; count?: number | null };

const fake = vi.hoisted(() => {
  const state = {
    chains: [] as { table: string; calls: unknown[][] }[],
    /** Results per table, consumed in order. */
    results: {} as Record<string, Result[]>,
    signCalls: [] as { bucket: string; paths: string[]; ttl: number }[],
    signError: null as { statusCode: string } | null,
    book: null as Record<string, unknown> | null,
  };
  function builder(table: string) {
    const entry = { table, calls: [] as unknown[][] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "order", "limit", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(state.results[table]?.shift() ?? { data: [], error: null }).then(resolve, reject);
    return b;
  }
  const client = {
    from: (table: string) => builder(table),
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[], ttl: number) => {
          state.signCalls.push({ bucket, paths, ttl });
          if (state.signError) return { data: null, error: state.signError };
          return {
            data: paths.map((p) => ({ path: p, signedUrl: `https://cdn.test/sign/${p}?token=t`, error: null })),
            error: null,
          };
        },
      }),
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/db/books", () => ({ getMyBook: async () => fake.state.book }));

const { getEditorData, getPhotoUrls, EDITOR_URL_TTL_SECONDS, EditorQueryError } = await import("@/lib/db/editor");

const B = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const pid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

// PLAN "Book document format" example (same as tests/book-schema.test.ts).
const VALID_DOC = {
  version: 1,
  format: "A5_PORTRAIT",
  occasion: "wedding",
  cover: { layout: "cover", photoId: "p1", title: "Sara & Omar", subtitle: "Abu Dhabi · 2026" },
  chapters: [{ id: "m1", title: "The Mehndi Night", dateLabel: "12 Oct 2026", place: "Abu Dhabi" }],
  pages: [
    {
      id: "pg1",
      chapterId: "m1",
      layout: "two-vertical",
      slots: [
        { photoId: "p2", crop: { x: 0.5, y: 0.4, zoom: 1.0 } },
        { photoId: "p3", crop: { x: 0.5, y: 0.5, zoom: 1.2 } },
      ],
      caption: { text: "Best night", font: "Cairo", align: "center", source: "ai" },
    },
  ],
  style: { background: "#FFFFFF", font: "Playfair" },
};

function bookRow(over: Record<string, unknown> = {}) {
  return {
    id: B,
    title: "Summer",
    occasion: "travel",
    tone: "warm",
    caption_lang: "en",
    is_paid: false,
    max_pages: 20,
    page_count: 0,
    doc: VALID_DOC,
    updated_at: "2026-11-10T10:00:00Z",
    doc_rev: 4,
    ...over,
  };
}

/** A photos row as the DB would return it if someone over-selected — the loader must not leak extras. */
function photoRow(i: number, over: Record<string, unknown> = {}) {
  return {
    id: pid(i),
    status: i % 3 === 0 ? "dropped" : "kept",
    user_override: i % 5 === 0,
    width: 4032,
    height: 3024,
    web_path: `${U}/${B}/${pid(i)}-web.jpg`,
    thumb_path: `${U}/${B}/${pid(i)}-thumb.jpg`,
    ...over,
  };
}

function queue(table: string, ...results: Result[]) {
  (fake.state.results[table] ??= []).push(...results);
}

beforeEach(() => {
  fake.state.chains = [];
  fake.state.results = {};
  fake.state.signCalls = [];
  fake.state.signError = null;
  fake.state.book = bookRow();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("AI_MODE", "");
  vi.stubEnv("VERCEL_ENV", "");
});
afterEach(() => vi.unstubAllEnvs());

function photosChain() {
  return fake.state.chains.find((c) => c.table === "photos");
}

describe("getEditorData", () => {
  it("returns null for a malformed id, a missing / foreign book (RLS) — without other queries", async () => {
    expect(await getEditorData("nope")).toBeNull();
    fake.state.book = null;
    expect(await getEditorData(B)).toBeNull();
    expect(fake.state.chains).toEqual([]);
    expect(fake.state.signCalls).toEqual([]);
  });

  it("maps the book, signs web + thumb, and never leaks paths / AI / GPS / EXIF", async () => {
    queue("photos", {
      data: [
        { ...photoRow(1), ai: { description: "SECRET-DESC" }, lat: 24.45, lng: 54.37, camera: "iPhone", taken_at: "x" },
        photoRow(3),
      ],
      error: null,
    });
    queue("agent_runs", { data: null, error: null, count: 2 }, { data: { id: pid(99) }, error: null });

    const d = await getEditorData(B);
    expect(d).not.toBeNull();
    expect(d!.book).toEqual({
      id: B,
      title: "Summer",
      occasion: "travel",
      tone: "warm",
      captionLang: "en",
      isPaid: false,
      maxPages: 20,
    });
    expect(d!.photos).toEqual([
      {
        id: pid(1),
        status: "kept",
        userOverride: false,
        width: 4032,
        height: 3024,
        webUrl: `https://cdn.test/sign/${U}/${B}/${pid(1)}-web.jpg?token=t`,
        thumbUrl: `https://cdn.test/sign/${U}/${B}/${pid(1)}-thumb.jpg?token=t`,
      },
      expect.objectContaining({ id: pid(3), status: "dropped" }),
    ]);
    for (const p of d!.photos) {
      expect(Object.keys(p).sort()).toEqual(["height", "id", "status", "thumbUrl", "userOverride", "webUrl", "width"]);
    }
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/SECRET-DESC|description|_path|"lat"|"lng"|camera|taken_at|exif/i);
    expect(d!.activeBuildRunId).toBe(pid(99));

    // Only upload-finished photos of this book; never selects ai / gps / exif columns.
    const sel = photosChain()!.calls.find((c) => c[0] === "select")![1] as string;
    expect(sel).not.toMatch(/\bai\b|lat|lng|camera|exif|taken_at,|description/);
    expect(photosChain()!.calls).toContainEqual(["eq", "book_id", B]);
    expect(photosChain()!.calls).toContainEqual(["eq", "upload_state", "ready"]);
  });

  it("signs 500 photos (1000 paths) in exactly one call to the photos bucket with TTL 3600", async () => {
    queue("photos", { data: Array.from({ length: 500 }, (_, i) => photoRow(i + 1)), error: null });
    const d = await getEditorData(B);
    expect(fake.state.signCalls).toHaveLength(1);
    expect(fake.state.signCalls[0].bucket).toBe("photos");
    expect(fake.state.signCalls[0].paths).toHaveLength(1000);
    expect(fake.state.signCalls[0].ttl).toBe(3600);
    expect(EDITOR_URL_TTL_SECONDS).toBe(3600);
    expect(d!.photos).toHaveLength(500);
    expect(d!.photos.every((p) => p.webUrl && p.thumbUrl)).toBe(true);
  });

  it("no photos → no signing call", async () => {
    await getEditorData(B);
    expect(fake.state.signCalls).toEqual([]);
  });

  it("rewritesLeft = 20 − ok rewrites for a free book; counts only ok rewrite runs", async () => {
    queue("agent_runs", { data: null, error: null, count: 7 });
    const d = await getEditorData(B);
    expect(d!.rewritesUsed).toBe(7);
    expect(d!.rewritesLeft).toBe(13);
    const countChain = fake.state.chains.filter((c) => c.table === "agent_runs")[0];
    expect(countChain.calls).toContainEqual(["select", "id", { count: "exact", head: true }]);
    expect(countChain.calls).toContainEqual(["eq", "book_id", B]);
    expect(countChain.calls).toContainEqual(["eq", "trigger", "rewrite"]);
    expect(countChain.calls).toContainEqual(["eq", "ai_status", "ok"]);
  });

  it("paid book: 200 rewrites; never negative", async () => {
    fake.state.book = bookRow({ is_paid: true, max_pages: 100 });
    queue("agent_runs", { data: null, error: null, count: 150 });
    let d = await getEditorData(B);
    expect(d!.rewritesLeft).toBe(50);
    expect(d!.book.maxPages).toBe(100);

    fake.state.book = bookRow({ is_paid: false });
    queue("agent_runs", { data: null, error: null, count: 25 });
    d = await getEditorData(B);
    expect(d!.rewritesLeft).toBe(0);
  });

  it("activeBuildRunId only considers active build / rebuild runs", async () => {
    await getEditorData(B);
    const runChain = fake.state.chains.filter((c) => c.table === "agent_runs")[1];
    expect(runChain.calls).toContainEqual(["in", "trigger", ["build", "rebuild"]]);
    expect(runChain.calls).toContainEqual(["not", "state", "in", "(done,failed)"]);
  });

  it("doc_rev null (0900 not applied) → canSave false; number → canSave true", async () => {
    fake.state.book = bookRow({ doc_rev: null });
    let d = await getEditorData(B);
    expect(d!.docRev).toBeNull();
    expect(d!.canSave).toBe(false);

    fake.state.book = bookRow({ doc_rev: 0 });
    d = await getEditorData(B);
    expect(d!.docRev).toBe(0);
    expect(d!.canSave).toBe(true);
  });

  it("doc: parsable → parsed doc, docError null", async () => {
    const d = await getEditorData(B);
    expect(d!.docError).toBeNull();
    expect(d!.doc).toMatchObject({ version: 1, pages: [{ id: "pg1" }] });
  });

  it("doc: empty → null/empty, unparsable → null/invalid", async () => {
    fake.state.book = bookRow({ doc: {} });
    let d = await getEditorData(B);
    expect(d!.doc).toBeNull();
    expect(d!.docError).toBe("empty");

    fake.state.book = bookRow({ doc: { version: 99, junk: true } });
    d = await getEditorData(B);
    expect(d!.doc).toBeNull();
    expect(d!.docError).toBe("invalid");
  });

  it("aiMode: off in production without a key, replay locally, live with a key", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await getEditorData(B))!.aiMode).toBe("off");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await getEditorData(B))!.aiMode).toBe("replay");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect((await getEditorData(B))!.aiMode).toBe("live");
  });

  it("query / storage errors throw EditorQueryError with a code only", async () => {
    queue("photos", { data: null, error: { code: "42501" } });
    await expect(getEditorData(B)).rejects.toThrow(EditorQueryError);

    queue("photos", { data: [photoRow(1)], error: null });
    fake.state.signError = { statusCode: "403" };
    const err = await getEditorData(B).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditorQueryError);
    expect((err as InstanceType<typeof EditorQueryError>).code).toBe("403");
    expect(String(err)).not.toContain(U);
  });
});

describe("getPhotoUrls", () => {
  it("null when the book is not visible (non-owner / missing / malformed)", async () => {
    expect(await getPhotoUrls("bad")).toBeNull();
    queue("books", { data: null, error: null });
    expect(await getPhotoUrls(B, [pid(1)])).toBeNull();
    expect(fake.state.signCalls).toEqual([]);
  });

  it("no ids → all ready photos; returns only id + urls", async () => {
    queue("books", { data: { id: B }, error: null });
    queue("photos", { data: [photoRow(1), photoRow(2)], error: null });
    const r = await getPhotoUrls(B);
    expect(r).toHaveLength(2);
    expect(Object.keys(r![0]).sort()).toEqual(["id", "thumbUrl", "webUrl"]);
    expect(JSON.stringify(r)).not.toMatch(/_path/);
  });

  it("500 ids → chunked id lookups, one signing call", async () => {
    queue("books", { data: { id: B }, error: null });
    const all = Array.from({ length: 500 }, (_, i) => photoRow(i + 1));
    for (let i = 0; i < 5; i++) queue("photos", { data: all.slice(i * 100, i * 100 + 100), error: null });
    const r = await getPhotoUrls(B, all.map((p) => p.id));
    expect(r).toHaveLength(500);
    const photoChains = fake.state.chains.filter((c) => c.table === "photos");
    expect(photoChains).toHaveLength(5);
    for (const c of photoChains) {
      expect(c.calls).toContainEqual(["eq", "book_id", B]);
      expect(c.calls).toContainEqual(["eq", "upload_state", "ready"]);
    }
    expect(fake.state.signCalls).toHaveLength(1);
    expect(fake.state.signCalls[0].paths).toHaveLength(1000);
  });

  it("empty ids → no photo query, no signing", async () => {
    queue("books", { data: { id: B }, error: null });
    expect(await getPhotoUrls(B, [])).toEqual([]);
    expect(fake.state.chains.filter((c) => c.table === "photos")).toHaveLength(0);
    expect(fake.state.signCalls).toEqual([]);
  });
});
