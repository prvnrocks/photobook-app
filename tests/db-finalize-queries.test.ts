import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data: unknown; error: { code?: string } | null };

// Records every query chain (table, operation, payload, filters) and resolves
// to the next queued result.
const fake = vi.hoisted(() => {
  const state = {
    chains: [] as {
      client: "user" | "admin";
      table: string;
      op: string;
      payload?: unknown;
      calls: unknown[][];
    }[],
    rpcs: [] as { fn: string; args: unknown }[],
    results: [] as Result[],
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
    rpc: async (fn: string, args: unknown) => {
      state.rpcs.push({ fn, args });
      return state.results.shift() ?? { data: null, error: null };
    },
  });
  return { state, client: make("user"), admin: make("admin") };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => ({ id: "u" }) }));

const { writeDocIfEmpty, BooksQueryError } = await import("@/lib/db/books");
const { listReadyPhotosForFinalize, setPhotosDupGroup, setPhotosPlace, setPhotosPlaceChecked, PLACE_MAX } =
  await import("@/lib/db/photos");
const { claimFinalizeRun, reserveGeocodeCalls, FinalizeRunsQueryError } = await import(
  "@/lib/db/finalize-runs"
);

const B = "22222222-2222-4222-8222-222222222222";
const TS = "2026-11-08T10:00:00.123456+00:00";
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

beforeEach(() => {
  fake.state.chains = [];
  fake.state.rpcs = [];
  fake.state.results = [];
});

describe("writeDocIfEmpty (conditional doc update)", () => {
  it("updates doc + page_count with the admin client, guarded by id, owner, doc = {} and updated_at", async () => {
    fake.state.results.push({ data: [{ id: B }], error: null });
    const doc = { version: 1 };
    expect(await writeDocIfEmpty(B, doc, 7, TS)).toBe(true);
    const [c] = fake.state.chains;
    // doc / page_count are server-only from migration 0900 (D-036): a user-scoped
    // update would silently keep the old doc.
    expect(c).toMatchObject({ client: "admin", table: "books", op: "update", payload: { doc, page_count: 7 } });
    expect(c.calls).toEqual([
      ["eq", "id", B],
      ["eq", "user_id", "u"],
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
    expect(String(c.calls[0][1])).toContain("place_checked_at");
    expect(c.client).toBe("user"); // reads stay under RLS
  });

  it("setPhotosDupGroup batches ids (≤100 per request)", async () => {
    await setPhotosDupGroup(B, ids(150), 3);
    expect(fake.state.chains).toHaveLength(2);
    for (const c of fake.state.chains) {
      expect(c.client).toBe("admin"); // server-only column (0500 guard)
      expect(c.payload).toEqual({ dup_group: 3 });
      expect(c.calls).toContainEqual(["eq", "book_id", B]);
    }
    const sizes = fake.state.chains.map((c) => (c.calls.find((x) => x[0] === "in")?.[2] as string[]).length);
    expect(sizes).toEqual([100, 50]);
  });

  it("setPhotosPlace only fills NULL places", async () => {
    await setPhotosPlace(B, ids(2), "X");
    const [c] = fake.state.chains;
    expect(c.client).toBe("admin");
    expect(c.payload).toEqual({ place: "X" });
    expect(c.calls).toContainEqual(["is", "place", null]);
    expect(c.calls).toContainEqual(["eq", "book_id", B]);
  });

  it("setPhotosPlace clips long labels without splitting an emoji", async () => {
    const long = "a".repeat(PLACE_MAX - 2) + "😀😀😀";
    await setPhotosPlace(B, ids(1), long);
    const label = (fake.state.chains[0].payload as { place: string }).place;
    expect(label.length).toBeLessThanOrEqual(PLACE_MAX);
    expect(label.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label)).toBe(false);
  });

  it("setPhotosPlaceChecked writes place_checked_at with the admin client, filtered by book", async () => {
    await setPhotosPlaceChecked(B, ids(120), "2026-11-08T10:00:00.000Z");
    expect(fake.state.chains).toHaveLength(2);
    for (const c of fake.state.chains) {
      expect(c.client).toBe("admin");
      expect(c.payload).toEqual({ place_checked_at: "2026-11-08T10:00:00.000Z" });
      expect(c.calls).toContainEqual(["eq", "book_id", B]);
    }
  });

  it("no ids → no request", async () => {
    await setPhotosDupGroup(B, [], null);
    await setPhotosPlace(B, [], "X");
    await setPhotosPlaceChecked(B, [], "x");
    await setPhotosPlace("nope", ids(1), "X");
    expect(fake.state.chains).toHaveLength(0);
  });
});

describe("finalize run RPCs (admin client)", () => {
  it("claimFinalizeRun: 0 → ok; >0 → retryAfterSeconds", async () => {
    fake.state.results.push({ data: 0, error: null }, { data: 7, error: null });
    expect(await claimFinalizeRun(B, 10)).toEqual({ ok: true });
    expect(await claimFinalizeRun(B, 10)).toEqual({ ok: false, retryAfterSeconds: 7 });
    expect(fake.state.rpcs[0]).toEqual({
      fn: "claim_finalize_run",
      args: { p_book_id: B, p_min_interval_seconds: 10 },
    });
  });

  it("claimFinalizeRun: db error → FinalizeRunsQueryError with code only; bad id throws", async () => {
    fake.state.results.push({ data: null, error: { code: "42501" } });
    const err = await claimFinalizeRun(B, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinalizeRunsQueryError);
    expect((err as InstanceType<typeof FinalizeRunsQueryError>).code).toBe("42501");
    await expect(claimFinalizeRun("nope", 10)).rejects.toBeInstanceOf(FinalizeRunsQueryError);
  });

  it("reserveGeocodeCalls passes want/cap and clamps the result to 0..want", async () => {
    fake.state.results.push({ data: 30, error: null }, { data: 999, error: null });
    expect(await reserveGeocodeCalls(B, 50, 200)).toBe(30);
    expect(await reserveGeocodeCalls(B, 50, 200)).toBe(50);
    expect(fake.state.rpcs[0]).toEqual({
      fn: "reserve_geocode_calls",
      args: { p_book_id: B, p_want: 50, p_daily_cap: 200 },
    });
    expect(await reserveGeocodeCalls(B, 0, 200)).toBe(0);
    expect(fake.state.rpcs).toHaveLength(2);
  });
});
