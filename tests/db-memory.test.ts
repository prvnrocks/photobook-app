import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error: { code?: string; message?: string } | null; count?: number | null };

// Two fake Supabase clients (admin = secret key, rls = user session). Every
// chain records which client / operation / filters were used and resolves to
// the next queued result.
const fake = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    results: [] as Result[],
    upserts: [] as { row: unknown; opts: unknown }[],
    filters: [] as [string, unknown][][],
    deleteOpts: [] as unknown[],
    user: null as { id: string } | null,
  };
  function client(name: "admin" | "rls") {
    return {
      from: (table: string) => {
        if (table !== "user_memory") throw new Error("unexpected table");
        const filters: [string, unknown][] = [];
        const b: Record<string, unknown> = {};
        const run = (op: string) => {
          state.log.push(`${name}:${op}`);
          state.filters.push(filters);
          return Promise.resolve(state.results.shift() ?? { data: null, error: null, count: null });
        };
        let op = "";
        b.select = (cols: string) => {
          op = `select(${cols})`;
          return b;
        };
        b.delete = (opts: unknown) => {
          op = "delete";
          state.deleteOpts.push(opts);
          return b;
        };
        b.upsert = (row: unknown, opts: unknown) => {
          state.upserts.push({ row, opts });
          return run("upsert");
        };
        b.eq = (col: string, val: unknown) => {
          filters.push([`eq:${col}`, val]);
          return b;
        };
        b.maybeSingle = () => b;
        b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => run(op).then(resolve, reject);
        return b;
      },
    };
  }
  return { state, admin: client("admin"), rls: client("rls") };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.rls }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => fake.state.user }));

const { getUserMemoryAdmin, getOwnMemory, upsertUserMemory, deleteOwnMemory, assertMemoryWritable, MemoryQueryError, USER_MEMORY_MAX_BYTES } =
  await import("@/lib/db/memory");

const U = "11111111-1111-4111-8111-111111111111";
const SECRET = "Ahmed-secret-pref-ZZZ";
const PREFS = { tonePreference: "fun", language: "en", knownNames: [SECRET] };

let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  Object.assign(fake.state, { log: [], results: [], upserts: [], filters: [], deleteOpts: [], user: null });
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  for (const s of spies) {
    for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
    s.mockRestore();
  }
});

async function caught(p: Promise<unknown>): Promise<InstanceType<typeof MemoryQueryError>> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MemoryQueryError);
    return e as InstanceType<typeof MemoryQueryError>;
  }
  throw new Error("expected a MemoryQueryError");
}

describe("getUserMemoryAdmin", () => {
  it("reads with the admin client, filtered by user id", async () => {
    fake.state.results.push({ data: { prefs: PREFS, updated_at: "2026-11-09T00:00:00Z" }, error: null });
    await expect(getUserMemoryAdmin(U)).resolves.toEqual({ prefs: PREFS, updatedAt: "2026-11-09T00:00:00Z" });
    expect(fake.state.log).toEqual(["admin:select(prefs, updated_at)"]);
    expect(fake.state.filters[0]).toEqual([["eq:user_id", U]]);
  });

  it("null when no row; invalid id never reaches the DB", async () => {
    await expect(getUserMemoryAdmin(U)).resolves.toBeNull();
    expect((await caught(getUserMemoryAdmin("nope"))).code).toBe("invalid_id");
    expect(fake.state.log).toEqual(["admin:select(prefs, updated_at)"]);
  });

  it("DB error → typed error with the code only", async () => {
    fake.state.results.push({ data: null, error: { code: "42501", message: `boom ${SECRET}` } });
    const e = await caught(getUserMemoryAdmin(U));
    expect(e.code).toBe("42501");
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toContain(U);
  });
});

describe("getOwnMemory (RLS)", () => {
  it("signed out → null without a query", async () => {
    await expect(getOwnMemory()).resolves.toBeNull();
    expect(fake.state.log).toEqual([]);
  });

  it("uses the RLS client for the current user", async () => {
    fake.state.user = { id: U };
    fake.state.results.push({ data: { prefs: PREFS, updated_at: "t" }, error: null });
    await expect(getOwnMemory()).resolves.toEqual({ prefs: PREFS, updatedAt: "t" });
    expect(fake.state.log).toEqual(["rls:select(prefs, updated_at)"]);
    expect(fake.state.filters[0]).toEqual([["eq:user_id", U]]);
  });

  it("DB error → typed error", async () => {
    fake.state.user = { id: U };
    fake.state.results.push({ data: null, error: { code: "PGRST301" } });
    expect((await caught(getOwnMemory())).code).toBe("PGRST301");
  });
});

describe("upsertUserMemory (admin)", () => {
  it("upserts on user_id with the admin client", async () => {
    await upsertUserMemory(U, PREFS);
    expect(fake.state.log).toEqual(["admin:upsert"]);
    expect(fake.state.upserts).toEqual([{ row: { user_id: U, prefs: PREFS }, opts: { onConflict: "user_id" } }]);
  });

  it("rejects > 8 KB before writing (too_large)", async () => {
    const big = { knownNames: ["x".repeat(USER_MEMORY_MAX_BYTES)], note: SECRET };
    const e = await caught(upsertUserMemory(U, big));
    expect(e.code).toBe("too_large");
    expect(e.message).not.toContain(SECRET);
    expect(fake.state.log).toEqual([]);
  });

  it("measures UTF-8 bytes, not UTF-16 units (Arabic)", () => {
    const ar = "م".repeat(3000); // 3000 code units, 6000 bytes
    expect(() => assertMemoryWritable({ a: ar })).not.toThrow();
    expect(() => assertMemoryWritable({ a: ar + "م".repeat(1100) })).toThrow(/too_large/);
  });

  it("accepts emoji (paired surrogates) and literal backslash-u text", () => {
    expect(() => assertMemoryWritable({ a: "trip \u{1F334}", b: "\\ud800 typed by user" })).not.toThrow();
  });

  it("exactly at the limit is accepted", () => {
    const pad = USER_MEMORY_MAX_BYTES - JSON.stringify({ a: "" }).length;
    expect(() => assertMemoryWritable({ a: "x".repeat(pad) })).not.toThrow();
    expect(() => assertMemoryWritable({ a: "x".repeat(pad + 1) })).toThrow(/too_large/);
  });

  it.each([
    ["array", ["a"]],
    ["null", null],
    ["string", "x"],
    ["lone high surrogate", { a: "ok\uD800" }],
    ["lone low surrogate", { a: "\uDC00x" }],
    ["lone surrogate in a key", { ["k\uD83D"]: 1 }],
  ])("rejects %s as invalid_prefs without writing", async (_, prefs) => {
    expect((await caught(upsertUserMemory(U, prefs as never))).code).toBe("invalid_prefs");
    expect(fake.state.log).toEqual([]);
  });

  it("invalid user id never writes", async () => {
    expect((await caught(upsertUserMemory("x", PREFS))).code).toBe("invalid_id");
    expect(fake.state.log).toEqual([]);
  });

  it("DB size check (23514) maps to too_large; other errors keep their code", async () => {
    fake.state.results.push({ data: null, error: { code: "23514" } });
    expect((await caught(upsertUserMemory(U, PREFS))).code).toBe("too_large");
    fake.state.results.push({ data: null, error: { code: "08006", message: SECRET } });
    const e = await caught(upsertUserMemory(U, PREFS));
    expect(e.code).toBe("08006");
    expect(e.message).not.toContain(SECRET);
  });
});

describe("deleteOwnMemory (RLS)", () => {
  it("signed out → false without a query", async () => {
    await expect(deleteOwnMemory()).resolves.toBe(false);
    expect(fake.state.log).toEqual([]);
  });

  it("deletes own row with the RLS client; true only when a row went", async () => {
    fake.state.user = { id: U };
    fake.state.results.push({ data: null, error: null, count: 1 }, { data: null, error: null, count: 0 });
    await expect(deleteOwnMemory()).resolves.toBe(true);
    await expect(deleteOwnMemory()).resolves.toBe(false);
    expect(fake.state.log).toEqual(["rls:delete", "rls:delete"]);
    expect(fake.state.filters[0]).toEqual([["eq:user_id", U]]);
    expect(fake.state.deleteOpts[0]).toEqual({ count: "exact" });
  });

  it("DB error → typed error", async () => {
    fake.state.user = { id: U };
    fake.state.results.push({ data: null, error: { code: "42501" } });
    expect((await caught(deleteOwnMemory())).code).toBe("42501");
  });
});

describe("source guards", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "db", "memory.ts"), "utf8");

  it("is server-only and never logs", () => {
    expect(src).toMatch(/^import "server-only";/);
    expect(src).not.toMatch(/console\.|logger|analytics/);
  });

  it("owner reads/deletes use the RLS client; only admin helpers use the admin client", () => {
    const fn = (name: string) => src.slice(src.indexOf(`export async function ${name}`)).split(/\nexport /)[0];
    for (const n of ["getOwnMemory", "deleteOwnMemory"]) {
      expect(fn(n)).toContain("await createClient()");
      expect(fn(n)).not.toContain("createAdminClient");
    }
    for (const n of ["getUserMemoryAdmin", "upsertUserMemory"]) expect(fn(n)).toContain("createAdminClient()");
  });
});
