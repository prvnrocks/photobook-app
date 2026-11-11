import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M10a review S3: stripPhotoFromBookDoc — read (RLS) → strip → saveDocIfRev (admin, doc_rev
// guard), retried once on conflict.

type Result = { data: unknown; error: { code?: string; message?: string } | null };

const fake = vi.hoisted(() => {
  const state = {
    chains: [] as { client: "user" | "admin"; table: string; op: string; payload?: unknown; calls: unknown[][] }[],
    results: [] as Result[],
    user: { id: "33333333-3333-4333-8333-333333333333" } as { id: string } | null,
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

const { stripPhotoFromBookDoc } = await import("@/lib/db/books");

const BOOK = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const P = "44444444-4444-4444-8444-444444444444";
const Q = "55555555-5555-4555-8555-555555555555";
const TS = "2026-11-10T10:00:00.123456+00:00";

const v2Doc = (bgPhoto: string) => ({
  version: 2,
  format: "A5_PORTRAIT",
  occasion: "travel",
  cover: { layout: "cover", photoId: Q, title: "T", subtitle: "" },
  chapters: [],
  pages: [
    {
      id: "p1",
      chapterId: null,
      layout: "two-vertical",
      slots: [
        { photoId: P, crop: { x: 0.5, y: 0.5, zoom: 1 } },
        { photoId: Q, crop: { x: 0.5, y: 0.5, zoom: 1 } },
      ],
      caption: null,
    },
  ],
  style: { background: { kind: "photo", photoId: bgPhoto, veil: 0.75, veilColor: "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
  meta: { generator: "rule", generatorVersion: 1, runId: null, userEdited: true },
});
/** listPhotoDims result (RLS photos select) — read only when a page held the photo (M10b A19 reflow). */
const dimsRows = { data: [{ id: Q, width: 1000, height: 1500, taken_at: null }], error: null };
const bookRow = (doc: unknown, rev: number | null = 4) => ({ data: { id: BOOK, doc, doc_rev: rev, max_pages: 20 }, error: null });

beforeEach(() => {
  fake.state.chains = [];
  fake.state.results = [];
  fake.state.user = { id: U };
});

describe("stripPhotoFromBookDoc", () => {
  it("reads under RLS, writes the stripped doc (v1 when no v2 feature remains) guarded by doc_rev + owner", async () => {
    fake.state.results.push(bookRow(v2Doc(P)), dimsRows, { data: [{ doc_rev: 5, updated_at: TS }], error: null });
    expect(await stripPhotoFromBookDoc(BOOK, P)).toBe("updated");
    const [read, dims, write] = fake.state.chains;
    expect(read).toMatchObject({ client: "user", table: "books", op: "select" });
    expect(dims).toMatchObject({ client: "user", table: "photos", op: "select" });
    expect(dims.calls).toContainEqual(["eq", "book_id", BOOK]);
    expect(write).toMatchObject({ client: "admin", table: "books", op: "update" });
    expect(write.calls).toEqual([
      ["eq", "id", BOOK],
      ["eq", "user_id", U],
      ["eq", "doc_rev", 4],
      ["select", "doc_rev, updated_at"],
    ]);
    const payload = write.payload as { doc: Record<string, unknown>; page_count: number; title?: unknown };
    expect(payload.page_count).toBe(1);
    expect(payload).not.toHaveProperty("title");
    // Background photo gone → white colour → nothing v2 left → stored as v1.
    expect(payload.doc.version).toBe(1);
    expect((payload.doc.style as { background: string }).background).toBe("#FFFFFF");
    // M10b A19: the page refits to a one-photo layout with the photo left (portrait Q), id kept.
    const pg = (payload.doc.pages as { id: string; layout: string; slots: { photoId: string | null }[] }[])[0];
    expect(pg.id).toBe("p1");
    expect(pg.slots.map((s) => s.photoId)).toEqual([Q]);
    expect(["full-page", "one-portrait"]).toContain(pg.layout);
    // meta kept as is (a cleanup is not a user edit)
    expect(payload.doc.meta).toEqual(v2Doc(P).meta);
  });

  it("retries once on a conflict with a fresh read", async () => {
    fake.state.results.push(
      bookRow(v2Doc(P), 4),
      dimsRows,
      { data: [], error: null },
      { data: { id: BOOK }, error: null }, // still exists → conflict
      bookRow(v2Doc(P), 6),
      dimsRows,
      { data: [{ doc_rev: 7, updated_at: TS }], error: null },
    );
    expect(await stripPhotoFromBookDoc(BOOK, P)).toBe("updated");
    const writes = fake.state.chains.filter((c) => c.op === "update");
    expect(writes).toHaveLength(2);
    expect(writes[1].calls).toContainEqual(["eq", "doc_rev", 6]);
  });

  it("two conflicts → 'conflict' (no third write)", async () => {
    for (let i = 0; i < 2; i++) {
      fake.state.results.push(bookRow(v2Doc(P), 4 + i), dimsRows, { data: [], error: null }, { data: { id: BOOK }, error: null });
    }
    expect(await stripPhotoFromBookDoc(BOOK, P)).toBe("conflict");
    expect(fake.state.chains.filter((c) => c.op === "update")).toHaveLength(2);
  });

  it("doc without the photo, {} doc, unparsable doc, pre-0900 → unchanged without a write", async () => {
    const other = "66666666-6666-4666-8666-666666666666";
    const cases: [Result, string][] = [
      [bookRow(v2Doc(P)), other],
      [bookRow({}), P],
      [bookRow({ version: 9 }), P],
      [bookRow(v2Doc(P), null), P],
    ];
    for (const [row, photoId] of cases) {
      fake.state.chains = [];
      fake.state.results.push(row);
      expect(await stripPhotoFromBookDoc(BOOK, photoId)).toBe("unchanged");
      expect(fake.state.chains.filter((c) => c.op === "update")).toHaveLength(0);
    }
  });

  it("photo dims query failing → still reflows (photos count as square)", async () => {
    fake.state.results.push(bookRow(v2Doc(P)), { data: null, error: { code: "57014" } }, { data: [{ doc_rev: 5, updated_at: TS }], error: null });
    expect(await stripPhotoFromBookDoc(BOOK, P)).toBe("updated");
    const write = fake.state.chains.find((c) => c.op === "update");
    const pages = (write?.payload as { doc: { pages: { slots: { photoId: string | null }[] }[] } }).doc.pages;
    expect(pages[0].slots.map((s) => s.photoId)).toEqual([Q]);
  });

  it("missing book, signed out, malformed ids → not_found", async () => {
    fake.state.results.push({ data: null, error: null });
    expect(await stripPhotoFromBookDoc(BOOK, P)).toBe("not_found");
    fake.state.user = null;
    expect(await stripPhotoFromBookDoc(BOOK, P)).toBe("not_found");
    fake.state.user = { id: U };
    fake.state.chains = [];
    expect(await stripPhotoFromBookDoc("nope", P)).toBe("not_found");
    expect(await stripPhotoFromBookDoc(BOOK, "nope")).toBe("not_found");
    expect(fake.state.chains).toHaveLength(0);
  });
});
