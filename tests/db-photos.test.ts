import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error: { code?: string; statusCode?: string; message?: string } | null; count?: number };

// Minimal fake of the Supabase server client: every `from()` chain records its
// calls and resolves to the next queued result for that operation.
const fake = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    selectResults: [] as Result[],
    deleteResults: [] as Result[],
    removeResults: [] as Result[],
    removed: [] as string[][],
    deleteFilters: [] as [string, unknown][][],
  };
  function builder(kind: "select" | "delete") {
    const filters: [string, unknown][] = [];
    const b: Record<string, unknown> = {};
    const chain = (name: string) => (col: string, val: unknown) => {
      filters.push([`${name}:${col}`, val]);
      return b;
    };
    b.eq = chain("eq");
    b.in = chain("in");
    b.maybeSingle = () => b;
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
      state.log.push(kind);
      if (kind === "delete") state.deleteFilters.push(filters);
      const r = (kind === "select" ? state.selectResults : state.deleteResults).shift() ?? {
        data: null,
        error: null,
      };
      return Promise.resolve(r).then(resolve, reject);
    };
    return b;
  }
  const client = {
    from: (table: string) => {
      if (table !== "photos") throw new Error("unexpected table");
      return { select: () => builder("select"), delete: () => builder("delete") };
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          state.log.push(`remove:${bucket}`);
          state.removed.push(paths);
          return state.removeResults.shift() ?? { data: [], error: null };
        },
      }),
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));

const { deletePhoto, deleteUnfinished, countPhotos, listUploadState, PhotosQueryError } =
  await import("@/lib/db/photos");

const U = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const row = (id: string, o: Partial<Record<"original_path" | "web_path" | "thumb_path", string | null>> = {}) => ({
  id,
  original_path: `${U}/${B}/${id}/original.jpg`,
  web_path: `${U}/${B}/${id}/web.jpg`,
  thumb_path: `${U}/${B}/${id}/thumb.jpg`,
  ...o,
});

beforeEach(() => {
  Object.assign(fake.state, {
    log: [],
    selectResults: [],
    deleteResults: [],
    removeResults: [],
    removed: [],
    deleteFilters: [],
  });
});

describe("deletePhoto", () => {
  it("removes the 3 storage objects from bucket photos, then deletes the row", async () => {
    fake.state.selectResults.push({ data: row(P), error: null });
    await deletePhoto(P);
    expect(fake.state.log).toEqual(["select", "remove:photos", "delete"]);
    expect(fake.state.removed).toEqual([
      [`${U}/${B}/${P}/original.jpg`, `${U}/${B}/${P}/web.jpg`, `${U}/${B}/${P}/thumb.jpg`],
    ]);
    expect(fake.state.deleteFilters[0]).toEqual([["eq:id", P]]);
  });

  it("returns the deleted row's book id (null on a no-op) for the doc cleanup", async () => {
    fake.state.selectResults.push({ data: { ...row(P), book_id: B }, error: null });
    expect(await deletePhoto(P)).toBe(B);
    fake.state.selectResults.push({ data: null, error: null });
    expect(await deletePhoto(P)).toBeNull();
    expect(await deletePhoto("not-a-uuid")).toBeNull();
  });

  it("skips null paths", async () => {
    fake.state.selectResults.push({ data: row(P, { original_path: null, thumb_path: null }), error: null });
    await deletePhoto(P);
    expect(fake.state.removed).toEqual([[`${U}/${B}/${P}/web.jpg`]]);
    expect(fake.state.log.at(-1)).toBe("delete");
  });

  it("does not call storage when all paths are null, still deletes the row", async () => {
    fake.state.selectResults.push({
      data: row(P, { original_path: null, web_path: null, thumb_path: null }),
      error: null,
    });
    await deletePhoto(P);
    expect(fake.state.log).toEqual(["select", "delete"]);
  });

  it("keeps the row when storage removal fails", async () => {
    fake.state.selectResults.push({ data: row(P), error: null });
    fake.state.removeResults.push({ data: null, error: { statusCode: "500", message: "boom" } });
    await expect(deletePhoto(P)).rejects.toBeInstanceOf(PhotosQueryError);
    expect(fake.state.log).toEqual(["select", "remove:photos"]);
  });

  it("is a no-op for a missing/foreign row and for malformed ids", async () => {
    fake.state.selectResults.push({ data: null, error: null });
    await deletePhoto(P);
    expect(fake.state.log).toEqual(["select"]);

    fake.state.log = [];
    await deletePhoto("not-a-uuid");
    expect(fake.state.log).toEqual([]);
  });

  it("throws typed errors without user data", async () => {
    fake.state.selectResults.push({ data: null, error: { code: "42501", message: `row ${P}` } });
    const err = await deletePhoto(P).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotosQueryError);
    expect((err as InstanceType<typeof PhotosQueryError>).code).toBe("42501");
    expect((err as Error).message).not.toContain(P);
  });
});

describe("deleteUnfinished", () => {
  it("removes objects of all pending rows, then deletes only pending rows by id", async () => {
    fake.state.selectResults.push({
      data: [row("a"), row("b", { original_path: null, web_path: null, thumb_path: null })],
      error: null,
    });
    fake.state.deleteResults.push({ data: null, error: null, count: 2 });
    expect(await deleteUnfinished(B)).toBe(2);
    expect(fake.state.log).toEqual(["select", "remove:photos", "delete"]);
    expect(fake.state.removed[0]).toHaveLength(3);
    expect(fake.state.deleteFilters[0]).toEqual([
      ["eq:book_id", B],
      ["eq:upload_state", "pending"],
      ["in:id", ["a", "b"]],
    ]);
  });

  it("batches large sets", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => row(`r${i}`));
    fake.state.selectResults.push({ data: rows, error: null });
    fake.state.deleteResults.push({ error: null, count: 100 }, { error: null, count: 50 });
    expect(await deleteUnfinished(B)).toBe(150);
    expect(fake.state.removed.map((b) => b.length)).toEqual([100, 100, 100, 100, 50]);
    expect(fake.state.deleteFilters).toHaveLength(2);
  });

  it("keeps rows when storage removal fails", async () => {
    fake.state.selectResults.push({ data: [row("a")], error: null });
    fake.state.removeResults.push({ data: null, error: { statusCode: "403" } });
    await expect(deleteUnfinished(B)).rejects.toBeInstanceOf(PhotosQueryError);
    expect(fake.state.log).not.toContain("delete");
  });

  it("does nothing when there are no pending rows", async () => {
    fake.state.selectResults.push({ data: [], error: null });
    expect(await deleteUnfinished(B)).toBe(0);
    expect(fake.state.log).toEqual(["select"]);
  });
});

describe("listUploadState / countPhotos", () => {
  it("returns rows and counts; malformed ids short-circuit", async () => {
    const rows = [{ id: P, fingerprint: "s1:abcdef0123456789", upload_state: "ready" }];
    fake.state.selectResults.push({ data: rows, error: null }, { data: null, error: null, count: 7 });
    expect(await listUploadState(B)).toEqual(rows);
    expect(await countPhotos(B)).toBe(7);
    expect(await listUploadState("x")).toEqual([]);
    expect(await countPhotos("x")).toBe(0);
  });
});
