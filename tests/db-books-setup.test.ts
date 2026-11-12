import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M13 T2 (D-070): bookHasAnyRun + writeBookSetup (admin client, owner filter, updated_at lock).

type Call = { table: string; op: string; payload?: unknown; filters: [string, string, unknown][]; head?: boolean };

const fake = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    countResult: { count: 0 as number | null, error: null as { code?: string } | null },
    updateResult: { data: [{ id: "b" }] as unknown[], error: null as { code?: string } | null },
    readResult: { data: { id: "b" } as unknown, error: null as { code?: string } | null },
    userClientUsed: false,
  };
  const admin = {
    from: (table: string) => {
      const call: Call = { table, op: "", filters: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = (_cols: string, opts?: { head?: boolean }) => {
        if (!call.op) call.op = "select";
        if (opts?.head) call.head = true;
        return b;
      };
      b.update = (payload: unknown) => {
        call.op = "update";
        call.payload = payload;
        return b;
      };
      b.eq = (col: string, v: unknown) => {
        call.filters.push(["eq", col, v]);
        return chain();
      };
      b.maybeSingle = async () => state.readResult;
      b.then = (resolve: (v: unknown) => void) =>
        resolve(call.op === "update" ? state.updateResult : state.countResult);
      return b;
    },
  };
  return { state, admin };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    fake.state.userClientUsed = true;
    return fake.admin;
  },
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => ({ id: "u" }) }));

const { bookHasAnyRun, writeBookSetup } = await import("@/lib/db/books");

const BOOK = "22222222-2222-4222-8222-222222222222";
const OWNER = "11111111-1111-4111-8111-111111111111";
const AT = "2026-11-12T10:00:00.000Z";

beforeEach(() => {
  fake.state.calls = [];
  fake.state.countResult = { count: 0, error: null };
  fake.state.updateResult = { data: [{ id: BOOK }], error: null };
  fake.state.readResult = { data: { id: BOOK }, error: null };
  fake.state.userClientUsed = false;
});

describe("bookHasAnyRun", () => {
  it("counts agent_runs of the book (any trigger/state) with a head count", async () => {
    fake.state.countResult = { count: 1, error: null };
    await expect(bookHasAnyRun(BOOK)).resolves.toBe(true);
    expect(fake.state.calls[0]).toMatchObject({ table: "agent_runs", head: true, filters: [["eq", "book_id", BOOK]] });
  });

  it("false for 0 / null count", async () => {
    await expect(bookHasAnyRun(BOOK)).resolves.toBe(false);
    fake.state.countResult = { count: null, error: null };
    await expect(bookHasAnyRun(BOOK)).resolves.toBe(false);
  });

  it("throws (fail closed) on a DB error or malformed id", async () => {
    fake.state.countResult = { count: null, error: { code: "57014" } };
    await expect(bookHasAnyRun(BOOK)).rejects.toMatchObject({ code: "57014" });
    await expect(bookHasAnyRun("nope")).rejects.toMatchObject({ code: "invalid_id" });
  });
});

describe("writeBookSetup", () => {
  it("one admin UPDATE filtered by id + owner + updated_at", async () => {
    const r = await writeBookSetup(BOOK, OWNER, { format: "A5_LANDSCAPE", design_style: "classic" }, AT, {
      doc: { version: 2 },
      pageCount: 7,
    });
    expect(r).toEqual({ ok: true });
    expect(fake.state.calls).toHaveLength(1);
    expect(fake.state.calls[0]).toEqual({
      table: "books",
      op: "update",
      payload: { format: "A5_LANDSCAPE", design_style: "classic", doc: { version: 2 }, page_count: 7 },
      filters: [
        ["eq", "id", BOOK],
        ["eq", "user_id", OWNER],
        ["eq", "updated_at", AT],
      ],
    });
    expect(fake.state.userClientUsed).toBe(false);
  });

  it("columns only when no draft is given", async () => {
    await writeBookSetup(BOOK, OWNER, { occasion: "travel", title: null }, AT);
    expect(fake.state.calls[0].payload).toEqual({ occasion: "travel", title: null });
  });

  it("0 rows → conflict when the owner's book still exists, else not_found", async () => {
    fake.state.updateResult = { data: [], error: null };
    await expect(writeBookSetup(BOOK, OWNER, { tone: "fun" }, AT)).resolves.toEqual({ ok: false, reason: "conflict" });
    expect(fake.state.calls[1].filters).toEqual([
      ["eq", "id", BOOK],
      ["eq", "user_id", OWNER],
    ]);
    fake.state.readResult = { data: null, error: null };
    await expect(writeBookSetup(BOOK, OWNER, { tone: "fun" }, AT)).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects bad enums / page counts before writing; bad ids → not_found", async () => {
    await expect(writeBookSetup(BOOK, OWNER, { format: "A4" as never }, AT)).rejects.toMatchObject({ code: "invalid_format" });
    await expect(writeBookSetup(BOOK, OWNER, { design_style: "baroque" as never }, AT)).rejects.toMatchObject({
      code: "invalid_design_style",
    });
    await expect(writeBookSetup(BOOK, OWNER, {}, AT, { doc: {}, pageCount: -1 })).rejects.toMatchObject({
      code: "invalid_page_count",
    });
    await expect(writeBookSetup("x", OWNER, { tone: "fun" }, AT)).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(writeBookSetup(BOOK, "x", { tone: "fun" }, AT)).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(fake.state.calls).toHaveLength(0);
  });

  it("an empty patch writes nothing", async () => {
    await expect(writeBookSetup(BOOK, OWNER, {}, AT)).resolves.toEqual({ ok: true });
    expect(fake.state.calls).toHaveLength(0);
  });

  it("DB errors carry the code only", async () => {
    fake.state.updateResult = { data: [], error: { code: "23514" } };
    await expect(writeBookSetup(BOOK, OWNER, { tone: "fun" }, AT)).rejects.toMatchObject({ code: "23514" });
  });
});
