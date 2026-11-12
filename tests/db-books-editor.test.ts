import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M5 Task 1 (D-036): saveDocIfRev (admin, doc_rev optimistic lock) and the
// deploy-order tolerant getMyBook (doc_rev may not exist before 0900).

type Result = { data: unknown; error: { code?: string; message?: string } | null };

const fake = vi.hoisted(() => {
  const state = {
    chains: [] as { client: "user" | "admin"; table: string; op: string; payload?: unknown; calls: unknown[][] }[],
    results: [] as Result[],
    user: { id: "u" } as { id: string } | null,
  };
  function builder(client: "user" | "admin", table: string, op: string, payload?: unknown) {
    const entry = { client, table, op, payload, calls: [] as unknown[][] };
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
        const b = builder(kind, table, "select");
        (b.select as (c: string) => unknown)(cols);
        return b;
      },
      update: (payload: unknown) => builder(kind, table, "update", payload),
    }),
  });
  return { state, client: make("user"), admin: make("admin") };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => fake.state.user }));

const { saveDocIfRev, getMyBook, writeDocIfEmpty, BooksQueryError, listMyBooks, getMyBookTitle } = await import("@/lib/db/books");

const B = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const TS = "2026-11-10T10:00:00.123456+00:00";
const DOC = { version: 1, pages: [] };

beforeEach(() => {
  fake.state.chains = [];
  fake.state.results = [];
  fake.state.user = { id: "u" };
});

describe("saveDocIfRev", () => {
  it("one admin UPDATE guarded by id, owner and doc_rev; returns the new rev + updated_at", async () => {
    fake.state.results.push({ data: [{ doc_rev: 8, updated_at: TS }], error: null });
    expect(await saveDocIfRev(B, U, DOC, 3, 7)).toEqual({ ok: true, rev: 8, savedAt: TS });
    expect(fake.state.chains).toHaveLength(1);
    const [c] = fake.state.chains;
    expect(c).toMatchObject({ client: "admin", table: "books", op: "update", payload: { doc: DOC, page_count: 3 } });
    expect(c.payload).not.toHaveProperty("title");
    expect(c.payload).not.toHaveProperty("doc_rev"); // trigger-managed
    expect(c.calls).toEqual([
      ["eq", "id", B],
      ["eq", "user_id", U],
      ["eq", "doc_rev", 7],
      ["select", "doc_rev, updated_at"],
    ]);
  });

  it("writes the title only when given (cover title edit, D-037 (7))", async () => {
    fake.state.results.push({ data: [{ doc_rev: 1, updated_at: TS }], error: null });
    await saveDocIfRev(B, U, DOC, 1, 0, { title: "Summer in Abu Dhabi" });
    expect(fake.state.chains[0].payload).toEqual({ doc: DOC, page_count: 1, title: "Summer in Abu Dhabi" });
  });

  it("0 rows + the book still exists for the owner → conflict", async () => {
    fake.state.results.push({ data: [], error: null }, { data: { doc_rev: 2, doc: { other: true }, title: "T", updated_at: TS }, error: null });
    expect(await saveDocIfRev(B, U, DOC, 1, 2)).toEqual({ ok: false, reason: "conflict" });
    const [, check] = fake.state.chains;
    expect(check).toMatchObject({ client: "admin", table: "books", op: "select" });
    expect(check.calls).toEqual([
      ["select", "doc_rev, doc, title, updated_at"],
      ["eq", "id", B],
      ["eq", "user_id", U],
      ["maybeSingle"],
    ]);
  });

  describe("replay after a timed-out save (M12 T3)", () => {
    const SENT = { version: 1, cover: { title: "Eid", photoId: null }, pages: [{ id: "p1", slots: [] }] };
    // jsonb hands keys back in its own order — same value, different key order.
    const STORED = { pages: [{ slots: [], id: "p1" }], cover: { photoId: null, title: "Eid" }, version: 1 };

    it("doc_rev = baseRev + 1 and the stored doc canonically equals the sent doc → ok with that rev", async () => {
      fake.state.results.push(
        { data: [], error: null },
        { data: { doc_rev: 8, doc: STORED, title: "Eid", updated_at: TS }, error: null },
      );
      expect(await saveDocIfRev(B, U, SENT, 1, 7)).toEqual({ ok: true, rev: 8, savedAt: TS });
      // one UPDATE (0 rows) + one read; nothing written a second time
      expect(fake.state.chains.map((c) => c.op)).toEqual(["update", "select"]);
    });

    it("the same replay with the title it saved → ok", async () => {
      fake.state.results.push(
        { data: [], error: null },
        { data: { doc_rev: 8, doc: STORED, title: "Eid", updated_at: TS }, error: null },
      );
      expect(await saveDocIfRev(B, U, SENT, 1, 7, { title: "Eid" })).toEqual({ ok: true, rev: 8, savedAt: TS });
    });

    it("a different doc at baseRev + 1 → conflict", async () => {
      const changed = { ...STORED, cover: { photoId: null, title: "Eid 2026" } };
      fake.state.results.push(
        { data: [], error: null },
        { data: { doc_rev: 8, doc: changed, title: "Eid", updated_at: TS }, error: null },
      );
      expect(await saveDocIfRev(B, U, SENT, 1, 7)).toEqual({ ok: false, reason: "conflict" });
    });

    it("the same doc but more than one rev ahead (another save in between) → conflict", async () => {
      fake.state.results.push(
        { data: [], error: null },
        { data: { doc_rev: 9, doc: STORED, title: "Eid", updated_at: TS }, error: null },
      );
      expect(await saveDocIfRev(B, U, SENT, 1, 7)).toEqual({ ok: false, reason: "conflict" });
    });

    it("the same doc but a different stored title → conflict", async () => {
      fake.state.results.push(
        { data: [], error: null },
        { data: { doc_rev: 8, doc: STORED, title: "Renamed elsewhere", updated_at: TS }, error: null },
      );
      expect(await saveDocIfRev(B, U, SENT, 1, 7, { title: "Eid" })).toEqual({ ok: false, reason: "conflict" });
    });
  });

  it("0 rows + no such book for the owner → not_found", async () => {
    fake.state.results.push({ data: [], error: null }, { data: null, error: null });
    expect(await saveDocIfRev(B, U, DOC, 1, 2)).toEqual({ ok: false, reason: "not_found" });
  });

  it("malformed ids → not_found, bad baseRev → conflict, both without a query", async () => {
    expect(await saveDocIfRev("nope", U, DOC, 1, 0)).toEqual({ ok: false, reason: "not_found" });
    expect(await saveDocIfRev(B, "nope", DOC, 1, 0)).toEqual({ ok: false, reason: "not_found" });
    expect(await saveDocIfRev(B, U, DOC, 1, -1)).toEqual({ ok: false, reason: "conflict" });
    expect(await saveDocIfRev(B, U, DOC, 1, 1.5)).toEqual({ ok: false, reason: "conflict" });
    expect(fake.state.chains).toHaveLength(0);
  });

  it("db errors → BooksQueryError with the code only (update and existence check)", async () => {
    fake.state.results.push({ data: null, error: { code: "42703", message: "column books.doc_rev does not exist" } });
    const e1 = await saveDocIfRev(B, U, DOC, 1, 0).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(BooksQueryError);
    expect((e1 as InstanceType<typeof BooksQueryError>).code).toBe("42703");
    expect((e1 as Error).message).not.toContain("doc_rev does not exist");

    fake.state.results.push({ data: [], error: null }, { data: null, error: { code: "08006" } });
    const e2 = await saveDocIfRev(B, U, DOC, 1, 0).catch((e: unknown) => e);
    expect((e2 as InstanceType<typeof BooksQueryError>).code).toBe("08006");
  });
});

describe("getMyBook (deploy-order tolerant)", () => {
  it("selects doc_rev under RLS (user client)", async () => {
    const row = { id: B, doc: {}, doc_rev: 4 };
    fake.state.results.push({ data: row, error: null });
    expect(await getMyBook(B)).toEqual(row);
    const [c] = fake.state.chains;
    expect(c.client).toBe("user");
    expect(String(c.calls[0][1])).toMatch(/\bdoc_rev\b/);
    expect(String(c.calls[0][1])).toMatch(/\bupdated_at\b/);
  });

  it("before migration 0900 (doc_rev missing) retries without it and returns doc_rev: null", async () => {
    fake.state.results.push(
      { data: null, error: { code: "42703", message: "column books.doc_rev does not exist" } },
      { data: { id: B, doc: {} }, error: null },
    );
    expect(await getMyBook(B)).toEqual({ id: B, doc: {}, doc_rev: null, format: null, design_style: null });
    expect(fake.state.chains).toHaveLength(2);
    expect(String(fake.state.chains[1].calls[0][1])).not.toMatch(/doc_rev/);
  });

  it("M10b A6: selects format + design_style; before migration 1900 retries with the base columns (doc_rev null → saving unavailable)", async () => {
    fake.state.results.push({ data: { id: B }, error: null });
    await getMyBook(B);
    expect(String(fake.state.chains[0].calls[0][1])).toMatch(/\bformat\b.*\bdesign_style\b/);

    fake.state.chains = [];
    fake.state.results.push(
      { data: null, error: { code: "42703", message: "column books.design_style does not exist" } },
      { data: { id: B, doc: {} }, error: null },
    );
    expect(await getMyBook(B)).toEqual({ id: B, doc: {}, doc_rev: null, format: null, design_style: null });
    expect(String(fake.state.chains[1].calls[0][1])).not.toMatch(/doc_rev|format|design_style/);
  });

  it("legacy fallback keeps null for a missing book; other errors are not swallowed", async () => {
    fake.state.results.push({ data: null, error: { code: "42703", message: "column books.doc_rev does not exist" } });
    fake.state.results.push({ data: null, error: null });
    expect(await getMyBook(B)).toBeNull();

    fake.state.results.push({ data: null, error: { code: "42703", message: "column books.other does not exist" } });
    await expect(getMyBook(B)).rejects.toBeInstanceOf(BooksQueryError);
    fake.state.results.push({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(getMyBook(B)).rejects.toBeInstanceOf(BooksQueryError);
    // A missing-column code without a message naming doc_rev is not the deploy window either.
    fake.state.results.push({ data: null, error: { code: "PGRST204" } });
    await expect(getMyBook(B)).rejects.toBeInstanceOf(BooksQueryError);
  });

  it("signed out / malformed id → null without a query", async () => {
    expect(await getMyBook("nope")).toBeNull();
    fake.state.user = null;
    expect(await getMyBook(B)).toBeNull();
    expect(fake.state.chains).toHaveLength(0);
  });
});

describe("writeDocIfEmpty", () => {
  it("signed out → false without a query (the admin write is always owner-scoped)", async () => {
    fake.state.user = null;
    expect(await writeDocIfEmpty(B, DOC, 1, TS)).toBe(false);
    expect(fake.state.chains).toHaveLength(0);
  });
});

describe("listMyBooks publish fields (M6 T8)", () => {
  const row = {
    id: B,
    title: "Trip",
    updated_at: TS,
    page_count: 3,
    published_at: TS,
    is_paid: false,
    ai_status: "done",
    slug: "trip-abc",
    expires_at: "2026-12-12T08:00:00Z",
    user_edited: true,
    photos: [{ count: 4 }],
  };

  it("`published` = live snapshot exists (published_doc->version), not published_at/slug (M6 S1)", async () => {
    fake.state.results.push({
      // Unpublished books keep published_at + slug (D-039) — only `live` decides.
      data: [{ ...row, live: 1 }, { ...row, id: "x", live: null }, { ...row, id: "y" }],
      error: null,
    });
    const books = await listMyBooks();
    expect(books.map((b) => b.published)).toEqual([true, false, false]);
    expect(books[0]).toMatchObject({ slug: "trip-abc", expires_at: "2026-12-12T08:00:00Z", photo_count: 4, user_edited: true });
    expect(books[1]).not.toHaveProperty("live");
    const cols = String(fake.state.chains[0].calls.find((c) => c[0] === "select")?.[1]);
    expect(cols).toContain("live:published_doc->version");
    // Never loads the snapshot itself.
    expect(cols).not.toMatch(/published_doc(?!->)/);
  });

  it("no pre-1000 retry: a missing column throws after a single query", async () => {
    fake.state.results.push({ data: null, error: { code: "42703", message: "column books.published_doc does not exist" } });
    await expect(listMyBooks()).rejects.toBeInstanceOf(BooksQueryError);
    expect(fake.state.chains).toHaveLength(1);
  });

  it("other errors throw", async () => {
    fake.state.results.push({ data: null, error: { code: "42501" } });
    await expect(listMyBooks()).rejects.toBeInstanceOf(BooksQueryError);
  });

  it("getMyBookTitle: title, else cover title, else null", async () => {
    fake.state.results.push({ data: { title: " Trip ", cover_title: "Cover" }, error: null });
    await expect(getMyBookTitle(B)).resolves.toBe("Trip");
    fake.state.results.push({ data: { title: null, cover_title: "عطلتنا" }, error: null });
    await expect(getMyBookTitle(B)).resolves.toBe("عطلتنا");
    fake.state.results.push({ data: null, error: null });
    await expect(getMyBookTitle(B)).resolves.toBeNull();
    await expect(getMyBookTitle("nope")).resolves.toBeNull();
  });
});
