import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M5 Task 3: listPlaceablePhotos (RLS) + markPlacedPhotosKept (admin, D-037 (4)).

const fake = vi.hoisted(() => {
  const state = {
    chains: [] as { client: string; op: string; payload?: unknown; calls: unknown[][] }[],
    results: [] as { data: unknown; error: { code?: string } | null }[],
  };
  function builder(client: string, op: string, payload?: unknown) {
    const entry = { client, op, payload, calls: [] as unknown[][] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "in", "select"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (res: (r: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.results.shift() ?? { data: [], error: null }).then(res, rej);
    return b;
  }
  const make = (kind: string) => ({
    from: () => ({
      select: (cols: string) => {
        const b = builder(kind, "select");
        (b.select as (c: string) => unknown)(cols);
        return b;
      },
      update: (payload: unknown) => builder(kind, "update", payload),
    }),
  });
  return { state, user: make("user"), admin: make("admin") };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.user }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));

const { listPlaceablePhotos, markPlacedPhotosKept, setUserOverride } = await import("@/lib/db/photos");

const B = "22222222-2222-4222-8222-222222222222";
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  fake.state.chains = [];
  fake.state.results = [];
});

describe("listPlaceablePhotos", () => {
  it("selects ready photos of the book (kept and dropped) with the RLS client", async () => {
    fake.state.results.push({ data: [{ id: P1, status: "dropped" }], error: null });
    expect(await listPlaceablePhotos(B)).toEqual([{ id: P1, status: "dropped" }]);
    const c = fake.state.chains[0];
    expect(c.client).toBe("user");
    expect(c.calls).toContainEqual(["eq", "book_id", B]);
    expect(c.calls).toContainEqual(["eq", "upload_state", "ready"]);
    expect(c.calls.some((x) => x[0] === "eq" && x[1] === "status")).toBe(false);
  });

  it("[] for a malformed id", async () => {
    expect(await listPlaceablePhotos("x")).toEqual([]);
    expect(fake.state.chains).toHaveLength(0);
  });
});

describe("markPlacedPhotosKept", () => {
  it("admin update scoped to book + dropped + ready, same patch as the review toggle", async () => {
    fake.state.results.push({ data: [{ id: P1 }], error: null });
    expect(await markPlacedPhotosKept(B, [P1, P1, "bad", P2])).toBe(1);
    const c = fake.state.chains[0];
    expect(c.client).toBe("admin");
    expect(c.payload).toEqual({ status: "kept", drop_reason: null, user_override: true });
    expect(c.calls).toContainEqual(["eq", "book_id", B]);
    expect(c.calls).toContainEqual(["eq", "status", "dropped"]);
    expect(c.calls).toContainEqual(["eq", "upload_state", "ready"]);
    expect(c.calls).toContainEqual(["in", "id", [P1, P2]]);

    fake.state.results.push({ data: [{ id: P1 }], error: null });
    await setUserOverride(B, P1, true);
    expect(fake.state.chains[1].payload).toEqual(c.payload);
  });

  it("no query for empty / invalid input; throws code-only errors", async () => {
    expect(await markPlacedPhotosKept(B, [])).toBe(0);
    expect(await markPlacedPhotosKept("x", [P1])).toBe(0);
    expect(fake.state.chains).toHaveLength(0);
    fake.state.results.push({ data: null, error: { code: "42501" } });
    await expect(markPlacedPhotosKept(B, [P1])).rejects.toThrow("(42501)");
  });
});
