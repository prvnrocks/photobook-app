import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data: unknown; error: { code?: string } | null };

// Records every query chain (table, operation, payload, filters) and resolves
// to the next queued result.
const fake = vi.hoisted(() => {
  const state = {
    chains: [] as { table: string; op: string; payload?: unknown; calls: unknown[][] }[],
    results: [] as Result[],
  };
  function builder(table: string, op: string, payload?: unknown) {
    const entry = { table, op, payload, calls: [] as unknown[][] };
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
  const client = {
    from: (table: string) => ({
      select: (cols: string) => {
        const b = builder(table, "select");
        (b.select as (c: string) => unknown)(cols);
        return b;
      },
      update: (payload: unknown) => builder(table, "update", payload),
    }),
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => ({ id: "u" }) }));

const { writeDocIfEmpty, BooksQueryError } = await import("@/lib/db/books");
const { listReadyPhotosForFinalize, setPhotosDupGroup, setPhotosPlace } = await import(
  "@/lib/db/photos"
);

const B = "22222222-2222-4222-8222-222222222222";
const TS = "2026-11-08T10:00:00.123456+00:00";
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

beforeEach(() => {
  fake.state.chains = [];
  fake.state.results = [];
});

describe("writeDocIfEmpty (conditional doc update)", () => {
  it("updates doc + page_count guarded by id, doc = {} and updated_at", async () => {
    fake.state.results.push({ data: [{ id: B }], error: null });
    const doc = { version: 1 };
    expect(await writeDocIfEmpty(B, doc, 7, TS)).toBe(true);
    const [c] = fake.state.chains;
    expect(c).toMatchObject({ table: "books", op: "update", payload: { doc, page_count: 7 } });
    expect(c.calls).toEqual([
      ["eq", "id", B],
      ["filter", "doc", "eq", "{}"],
      ["eq", "updated_at", TS],
      ["select", "id"],
    ]);
  });

  it("returns false when no row matched (doc no longer empty / changed / not visible)", async () => {
    fake.state.results.push({ data: [], error: null });
    expect(await writeDocIfEmpty(B, {}, 1, TS)).toBe(false);
  });

  it("malformed id → false without a query; db error → BooksQueryError with code only", async () => {
    expect(await writeDocIfEmpty("nope", {}, 1, TS)).toBe(false);
    expect(fake.state.chains).toHaveLength(0);
    fake.state.results.push({ data: null, error: { code: "42501" } });
    const err = await writeDocIfEmpty(B, {}, 1, TS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BooksQueryError);
    expect((err as InstanceType<typeof BooksQueryError>).code).toBe("42501");
  });
});

describe("finalize photo queries", () => {
  it("listReadyPhotosForFinalize selects ready photos of the book", async () => {
    fake.state.results.push({ data: [], error: null });
    await listReadyPhotosForFinalize(B);
    const [c] = fake.state.chains;
    expect(c.table).toBe("photos");
    expect(c.calls).toContainEqual(["eq", "book_id", B]);
    expect(c.calls).toContainEqual(["eq", "upload_state", "ready"]);
    expect(String(c.calls[0][1])).toContain("dup_group");
  });

  it("setPhotosDupGroup batches ids (≤100 per request)", async () => {
    await setPhotosDupGroup(B, ids(150), 3);
    expect(fake.state.chains).toHaveLength(2);
    for (const c of fake.state.chains) {
      expect(c.payload).toEqual({ dup_group: 3 });
      expect(c.calls).toContainEqual(["eq", "book_id", B]);
    }
    const sizes = fake.state.chains.map((c) => (c.calls.find((x) => x[0] === "in")?.[2] as string[]).length);
    expect(sizes).toEqual([100, 50]);
  });

  it("setPhotosPlace only fills NULL places", async () => {
    await setPhotosPlace(B, ids(2), "X");
    const [c] = fake.state.chains;
    expect(c.payload).toEqual({ place: "X" });
    expect(c.calls).toContainEqual(["is", "place", null]);
  });

  it("no ids → no request", async () => {
    await setPhotosDupGroup(B, [], null);
    await setPhotosPlace(B, [], "X");
    expect(fake.state.chains).toHaveLength(0);
  });
});
