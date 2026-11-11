import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M11 task 4: listMyBooks carries format / designStyle / coverThumbUrl. Cover photo id comes from
// JSON paths (doc->cover->>photoId, else doc->pages->0->slots->0->>photoId), thumbs are signed in
// ONE createSignedUrls call with the RLS client; any lookup/signing problem → null, never a throw.

type Result = { data: unknown; error: { code?: string; message?: string } | null };

const fake = vi.hoisted(() => {
  const state = {
    chains: [] as { client: "user" | "admin"; table: string; calls: unknown[][] }[],
    results: [] as Result[],
    signCalls: [] as { client: "user" | "admin"; bucket: string; paths: string[]; ttl: number }[],
    signResult: null as null | { data: unknown; error: unknown },
    signThrows: false,
    user: { id: "u" } as { id: string } | null,
  };
  function builder(client: "user" | "admin", table: string) {
    const entry = { client, table, calls: [] as unknown[][] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "in", "is", "filter", "order", "select", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(state.results.shift() ?? { data: [], error: null }).then(resolve, reject);
    return b;
  }
  const make = (kind: "user" | "admin") => ({
    from: (table: string) => ({
      select: (cols: string) => {
        const b = builder(kind, table);
        (b.select as (c: string) => unknown)(cols);
        return b;
      },
    }),
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[], ttl: number) => {
          state.signCalls.push({ client: kind, bucket, paths, ttl });
          if (state.signThrows) throw new Error("network");
          if (state.signResult) return state.signResult;
          return { data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}`, error: null })), error: null };
        },
      }),
    },
  });
  return { state, client: make("user"), admin: make("admin") };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => fake.state.user }));

const { listMyBooks, BooksQueryError, COVER_THUMB_TTL_SECONDS } = await import("@/lib/db/books");
const { REVIEW_URL_TTL_SECONDS } = await import("@/lib/db/photos");

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const B3 = "33333333-3333-4333-8333-333333333333";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function bookRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: "Trip",
    updated_at: "2026-11-10T08:00:00Z",
    page_count: 3,
    published_at: null,
    is_paid: false,
    ai_status: "done",
    slug: null,
    expires_at: null,
    draft_warning_sent_at: null,
    format: "A5_LANDSCAPE",
    design_style: "modern",
    user_edited: null,
    live: null,
    cover_photo: null,
    first_photo: null,
    photos: [{ count: 2 }],
    ...extra,
  };
}

beforeEach(() => {
  fake.state.chains = [];
  fake.state.results = [];
  fake.state.signCalls = [];
  fake.state.signResult = null;
  fake.state.signThrows = false;
  fake.state.user = { id: "u" };
});

describe("listMyBooks cover thumbs (M11 task 4)", () => {
  it("selects cover/first photo ids as JSON paths plus format/design_style, never the whole doc", async () => {
    fake.state.results.push({ data: [], error: null });
    await listMyBooks();
    const cols = String(fake.state.chains[0]!.calls.find((c) => c[0] === "select")?.[1]);
    expect(cols).toContain("cover_photo:doc->cover->>photoId");
    expect(cols).toContain("first_photo:doc->pages->0->slots->0->>photoId");
    expect(cols).toMatch(/\bformat\b/);
    expect(cols).toMatch(/\bdesign_style\b/);
    expect(cols).not.toMatch(/(^|[ ,])doc(?!->)/);
  });

  it("signs every cover in ONE createSignedUrls call with the user client and the thumb TTL", async () => {
    fake.state.results.push({
      data: [
        bookRow(B1, { cover_photo: P1, first_photo: P3 }),
        bookRow(B2, { first_photo: P2 }), // no cover photo → first slot photo
        bookRow(B3), // nothing at all
      ],
      error: null,
    });
    fake.state.results.push({
      data: [
        { id: P1, book_id: B1, thumb_path: "u/b1/p1-thumb.jpg" },
        { id: P2, book_id: B2, thumb_path: "u/b2/p2-thumb.jpg" },
      ],
      error: null,
    });

    const books = await listMyBooks();

    expect(fake.state.signCalls).toHaveLength(1);
    expect(fake.state.signCalls[0]).toEqual({
      client: "user",
      bucket: "photos",
      paths: ["u/b1/p1-thumb.jpg", "u/b2/p2-thumb.jpg"],
      ttl: COVER_THUMB_TTL_SECONDS,
    });
    expect(COVER_THUMB_TTL_SECONDS).toBe(REVIEW_URL_TTL_SECONDS);
    expect(fake.state.chains.every((c) => c.client === "user")).toBe(true);
    const photoQuery = fake.state.chains[1]!;
    expect(photoQuery.table).toBe("photos");
    expect(photoQuery.calls).toContainEqual(["in", "id", [P1, P2]]);
    expect(photoQuery.calls).toContainEqual(["eq", "upload_state", "ready"]);

    expect(books.map((b) => b.coverThumbUrl)).toEqual([
      "https://signed/u/b1/p1-thumb.jpg",
      "https://signed/u/b2/p2-thumb.jpg",
      null,
    ]);
    expect(books[0]).toMatchObject({ format: "A5_LANDSCAPE", designStyle: "modern" });
    expect(books[0]).not.toHaveProperty("cover_photo");
    expect(books[0]).not.toHaveProperty("design_style");
  });

  it("no cover photos → no photos query and no storage call; all null", async () => {
    fake.state.results.push({ data: [bookRow(B1), bookRow(B2, { cover_photo: "not-a-uuid" })], error: null });
    const books = await listMyBooks();
    expect(fake.state.chains).toHaveLength(1);
    expect(fake.state.signCalls).toHaveLength(0);
    expect(books.map((b) => b.coverThumbUrl)).toEqual([null, null]);
  });

  it("deleted photo, another book's photo or a photo without thumb → null, no error", async () => {
    fake.state.results.push({
      data: [bookRow(B1, { cover_photo: P1 }), bookRow(B2, { cover_photo: P2 }), bookRow(B3, { cover_photo: P3 })],
      error: null,
    });
    fake.state.results.push({
      // P1 deleted (absent); P2 belongs to B1, not B2; P3 has no thumb yet.
      data: [
        { id: P2, book_id: B1, thumb_path: "u/b1/p2-thumb.jpg" },
        { id: P3, book_id: B3, thumb_path: null },
      ],
      error: null,
    });
    const books = await listMyBooks();
    expect(books.map((b) => b.coverThumbUrl)).toEqual([null, null, null]);
    expect(fake.state.signCalls).toHaveLength(0);
  });

  it("a storage object missing at signing time → null for that book only", async () => {
    fake.state.results.push({ data: [bookRow(B1, { cover_photo: P1 }), bookRow(B2, { cover_photo: P2 })], error: null });
    fake.state.results.push({
      data: [
        { id: P1, book_id: B1, thumb_path: "p1.jpg" },
        { id: P2, book_id: B2, thumb_path: "p2.jpg" },
      ],
      error: null,
    });
    fake.state.signResult = {
      data: [
        { path: "p1.jpg", signedUrl: null, error: "Object not found" },
        { path: "p2.jpg", signedUrl: "https://signed/p2", error: null },
      ],
      error: null,
    };
    const books = await listMyBooks();
    expect(books.map((b) => b.coverThumbUrl)).toEqual([null, "https://signed/p2"]);
  });

  it("photos lookup error, signing error or a throw → covers null, the list still loads", async () => {
    fake.state.results.push({ data: [bookRow(B1, { cover_photo: P1 })], error: null });
    fake.state.results.push({ data: null, error: { code: "42501" } });
    expect((await listMyBooks()).map((b) => b.coverThumbUrl)).toEqual([null]);

    fake.state.results.push({ data: [bookRow(B1, { cover_photo: P1 })], error: null });
    fake.state.results.push({ data: [{ id: P1, book_id: B1, thumb_path: "p1.jpg" }], error: null });
    fake.state.signResult = { data: null, error: { statusCode: "500" } };
    expect((await listMyBooks()).map((b) => b.coverThumbUrl)).toEqual([null]);

    fake.state.signResult = null;
    fake.state.signThrows = true;
    fake.state.results.push({ data: [bookRow(B1, { cover_photo: P1 })], error: null });
    fake.state.results.push({ data: [{ id: P1, book_id: B1, thumb_path: "p1.jpg" }], error: null });
    expect((await listMyBooks()).map((b) => b.coverThumbUrl)).toEqual([null]);
  });

  it("dedupes photo ids and paths shared by two books", async () => {
    fake.state.results.push({ data: [bookRow(B1, { cover_photo: P1 }), bookRow(B2, { cover_photo: P1 })], error: null });
    fake.state.results.push({ data: [{ id: P1, book_id: B1, thumb_path: "p1.jpg" }], error: null });
    const books = await listMyBooks();
    expect(fake.state.chains[1]!.calls).toContainEqual(["in", "id", [P1]]);
    expect(fake.state.signCalls[0]!.paths).toEqual(["p1.jpg"]);
    expect(books.map((b) => b.coverThumbUrl)).toEqual(["https://signed/p1.jpg", null]);
  });

  it("unknown format / design_style read as the column defaults", async () => {
    fake.state.results.push({ data: [bookRow(B1, { format: null, design_style: "baroque" })], error: null });
    const [book] = await listMyBooks();
    expect(book).toMatchObject({ format: "A5_PORTRAIT", designStyle: "classic", coverThumbUrl: null });
  });

  it("the books query error still throws (only cover problems are swallowed)", async () => {
    fake.state.results.push({ data: null, error: { code: "42501" } });
    await expect(listMyBooks()).rejects.toBeInstanceOf(BooksQueryError);
  });

  it("signed out → [] without any query", async () => {
    fake.state.user = null;
    expect(await listMyBooks()).toEqual([]);
    expect(fake.state.chains).toHaveLength(0);
    expect(fake.state.signCalls).toHaveLength(0);
  });
});
