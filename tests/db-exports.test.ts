// M8 T1: src/lib/db/exports.ts — RPC wrappers + reads over a mocked admin client.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error: { code?: string; message?: string } | null };

const fake = vi.hoisted(() => {
  const state = {
    rpcs: [] as { fn: string; args: Record<string, unknown> }[],
    chains: [] as { table: string; op: string; calls: unknown[][] }[],
    results: [] as Result[],
  };
  function builder(table: string, op: string) {
    const entry = { table, op, calls: [] as unknown[][] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "order", "limit", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(state.results.shift() ?? { data: null, error: null }).then(resolve, reject);
    return b;
  }
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args });
      return Promise.resolve(state.results.shift() ?? { data: null, error: null });
    },
    from: (table: string) => ({
      select: (...a: unknown[]) => {
        const b = builder(table, "select");
        (b.select as (...x: unknown[]) => unknown)(...a);
        return b;
      },
      delete: () => builder(table, "delete"),
    }),
  };
  return { state, client };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.client }));

import {
  OWNER_EXPORT_COLUMNS,
  ExportsQueryError,
  claimExport,
  createExportJob,
  deleteExportRows,
  exportObjectPath,
  failExport,
  finishExport,
  getExportForOwner,
  getExportForRender,
  latestReadyExport,
  listOlderReadyExports,
} from "@/lib/db/exports";

const U = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const E = "33333333-3333-4333-8333-333333333333";
const T = "44444444-4444-4444-8444-444444444444";

const createArgs = {
  bookId: B,
  userId: U,
  docRev: 7,
  doc: { pages: [] },
  captionLang: "en" as const,
  dailyCap: 20,
  staleSeconds: 600,
};

beforeEach(() => {
  fake.state.rpcs.length = 0;
  fake.state.chains.length = 0;
  fake.state.results.length = 0;
});

describe("createExportJob", () => {
  it("passes every argument to create_export_job", async () => {
    fake.state.results.push({ data: { status: "created", export_id: E }, error: null });
    await expect(createExportJob({ ...createArgs, dailyCap: 20.7 })).resolves.toEqual({ status: "created", exportId: E });
    expect(fake.state.rpcs).toEqual([
      {
        fn: "create_export_job",
        args: {
          p_book: B,
          p_user: U,
          p_doc_rev: 7,
          p_doc: { pages: [] },
          p_caption_lang: "en",
          p_daily_cap: 20,
          p_stale_seconds: 600,
        },
      },
    ]);
  });

  it.each([
    [{ status: "ready", export_id: E }, { status: "ready", exportId: E }],
    [{ status: "running", export_id: E, doc_rev: 6 }, { status: "running", exportId: E, docRev: 6 }],
    [{ status: "stale_rev", doc_rev: 8 }, { status: "stale_rev", docRev: 8 }],
    [{ status: "daily_cap" }, { status: "daily_cap" }],
    [{ status: "not_paid" }, { status: "not_paid" }],
    [{ status: "not_found" }, { status: "not_found" }],
  ])("maps %j", async (raw, expected) => {
    fake.state.results.push({ data: raw, error: null });
    await expect(createExportJob(createArgs)).resolves.toEqual(expected);
  });

  it.each([
    [{ status: "created" }],
    [{ status: "created", export_id: "nope" }],
    [{ status: "running", export_id: E }],
    [{ status: "weird" }],
    ["created"],
    [null],
  ])("rejects a malformed result %j", async (raw) => {
    fake.state.results.push({ data: raw, error: null });
    await expect(createExportJob(createArgs)).rejects.toMatchObject({ name: "ExportsQueryError", code: "bad_result" });
  });

  it("returns not_found for malformed ids without calling the RPC", async () => {
    await expect(createExportJob({ ...createArgs, bookId: "x" })).resolves.toEqual({ status: "not_found" });
    await expect(createExportJob({ ...createArgs, userId: "x" })).resolves.toEqual({ status: "not_found" });
    expect(fake.state.rpcs).toHaveLength(0);
  });

  it("throws a typed error carrying only a sanitised code", async () => {
    fake.state.results.push({ data: null, error: { code: "22023", message: `secret ${B}` } });
    const err = await createExportJob(createArgs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportsQueryError);
    expect((err as Error).message).toBe("exports: create failed (22023)");
    expect((err as Error).message).not.toContain(B);
  });
});

describe("lease wrappers", () => {
  it("claimExport returns the token, null when not claimable or malformed", async () => {
    fake.state.results.push({ data: T, error: null }, { data: null, error: null }, { data: "junk", error: null });
    await expect(claimExport(E, 120.9)).resolves.toBe(T);
    await expect(claimExport(E, 120)).resolves.toBeNull();
    await expect(claimExport(E, 120)).resolves.toBeNull();
    expect(fake.state.rpcs[0]).toEqual({ fn: "claim_export", args: { p_export: E, p_lease_seconds: 120 } });
    await expect(claimExport("bad", 120)).resolves.toBeNull();
    expect(fake.state.rpcs).toHaveLength(3);
  });

  it("finishExport passes path / size / pages and returns the RPC boolean", async () => {
    const path = exportObjectPath(U, B, E);
    expect(path).toBe(`${U}/${B}/${E}.pdf`);
    fake.state.results.push({ data: true, error: null }, { data: false, error: null });
    await expect(finishExport({ exportId: E, token: T, path, bytes: 1234, pageCount: 41 })).resolves.toBe(true);
    await expect(finishExport({ exportId: E, token: T, path, bytes: 1234, pageCount: 41 })).resolves.toBe(false);
    expect(fake.state.rpcs[0]).toEqual({
      fn: "finish_export",
      args: { p_export: E, p_token: T, p_path: path, p_bytes: 1234, p_pages: 41 },
    });
    await expect(finishExport({ exportId: E, token: "bad", path, bytes: 1, pageCount: 1 })).resolves.toBe(false);
    expect(fake.state.rpcs).toHaveLength(2);
  });

  it("finishExport surfaces a check violation as a typed error", async () => {
    fake.state.results.push({ data: null, error: { code: "23514" } });
    await expect(
      finishExport({ exportId: E, token: T, path: "x.pdf", bytes: 1, pageCount: 1 }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("failExport sends a safe code (free text becomes 'error')", async () => {
    fake.state.results.push({ data: true, error: null }, { data: true, error: null });
    await expect(failExport(E, T, "render_timeout")).resolves.toBe(true);
    await expect(failExport(E, T, "Chrome crashed at /tmp/x")).resolves.toBe(true);
    expect(fake.state.rpcs.map((r) => r.args.p_code)).toEqual(["render_timeout", "error"]);
    expect(fake.state.rpcs[0]).toEqual({ fn: "fail_export", args: { p_export: E, p_token: T, p_code: "render_timeout" } });
  });
});

describe("reads", () => {
  const ownerRow = {
    id: E,
    book_id: B,
    doc_rev: 7,
    status: "ready",
    bytes: 1000,
    page_count: 41,
    error_code: null,
    created_at: "2026-11-10T00:00:00Z",
    finished_at: "2026-11-10T00:01:00Z",
  };

  it("OWNER_EXPORT_COLUMNS never includes doc, path, user_id or the lease", () => {
    const cols = OWNER_EXPORT_COLUMNS.split(",").map((c) => c.trim());
    for (const c of ["doc", "path", "user_id", "lease_token", "lease_until", "caption_lang", "attempt"]) {
      expect(cols).not.toContain(c);
    }
  });

  it("getExportForOwner filters by id AND user_id and selects only owner columns", async () => {
    fake.state.results.push({ data: ownerRow, error: null });
    await expect(getExportForOwner(E, U)).resolves.toEqual({
      id: E,
      bookId: B,
      docRev: 7,
      status: "ready",
      bytes: 1000,
      pageCount: 41,
      errorCode: null,
      createdAt: "2026-11-10T00:00:00Z",
      finishedAt: "2026-11-10T00:01:00Z",
    });
    expect(fake.state.chains[0]).toEqual({
      table: "exports",
      op: "select",
      calls: [["select", OWNER_EXPORT_COLUMNS], ["eq", "id", E], ["eq", "user_id", U], ["maybeSingle"]],
    });
  });

  it("getExportForOwner: null when missing or ids malformed; typed error on db error", async () => {
    fake.state.results.push({ data: null, error: null });
    await expect(getExportForOwner(E, U)).resolves.toBeNull();
    await expect(getExportForOwner("x", U)).resolves.toBeNull();
    expect(fake.state.chains).toHaveLength(1);
    fake.state.results.push({ data: null, error: { code: "42501" } });
    await expect(getExportForOwner(E, U)).rejects.toMatchObject({ code: "42501" });
    fake.state.results.push({ data: { ...ownerRow, status: "bogus" }, error: null });
    await expect(getExportForOwner(E, U)).rejects.toMatchObject({ code: "bad_status" });
  });

  it("getExportForRender returns the snapshot", async () => {
    fake.state.results.push({
      data: { id: E, book_id: B, user_id: U, doc_rev: 7, doc: { pages: [1] }, caption_lang: "ar", status: "rendering" },
      error: null,
    });
    await expect(getExportForRender(E)).resolves.toEqual({
      id: E,
      bookId: B,
      userId: U,
      docRev: 7,
      doc: { pages: [1] },
      captionLang: "ar",
      status: "rendering",
    });
    const calls = fake.state.chains[0].calls;
    expect(calls[0][0]).toBe("select");
    expect(String(calls[0][1])).toContain("doc");
    expect(calls[1]).toEqual(["eq", "id", E]);
    await expect(getExportForRender("x")).resolves.toBeNull();
  });

  it("latestReadyExport filters book / ready / doc_rev (+ lang), newest first", async () => {
    fake.state.results.push({ data: ownerRow, error: null }, { data: null, error: null });
    await expect(latestReadyExport(B, 7, "ar")).resolves.toMatchObject({ id: E, status: "ready" });
    expect(fake.state.chains[0].calls).toEqual([
      ["select", OWNER_EXPORT_COLUMNS],
      ["eq", "book_id", B],
      ["eq", "status", "ready"],
      ["eq", "doc_rev", 7],
      ["eq", "caption_lang", "ar"],
      ["order", "finished_at", { ascending: false }],
      ["limit", 1],
      ["maybeSingle"],
    ]);
    await expect(latestReadyExport(B, 7)).resolves.toBeNull();
    expect(fake.state.chains[1].calls.some((c) => c[1] === "caption_lang")).toBe(false);
  });

  it("listOlderReadyExports excludes the kept id and rows without a path", async () => {
    const other = "55555555-5555-4555-8555-555555555555";
    fake.state.results.push({
      data: [
        { id: other, path: `${U}/${B}/${other}.pdf` },
        { id: "66666666-6666-4666-8666-666666666666", path: null },
      ],
      error: null,
    });
    await expect(listOlderReadyExports(B, E)).resolves.toEqual([{ id: other, path: `${U}/${B}/${other}.pdf` }]);
    expect(fake.state.chains[0].calls).toEqual([
      ["select", "id, path"],
      ["eq", "book_id", B],
      ["eq", "status", "ready"],
      ["neq", "id", E],
    ]);
    await expect(listOlderReadyExports("x", E)).resolves.toEqual([]);
  });

  it("deleteExportRows only deletes finished rows of the book", async () => {
    fake.state.results.push({ data: [{ id: E }], error: null });
    await expect(deleteExportRows(B, [E, "junk"])).resolves.toBe(1);
    expect(fake.state.chains[0]).toEqual({
      table: "exports",
      op: "delete",
      calls: [
        ["eq", "book_id", B],
        ["in", "id", [E]],
        ["in", "status", ["ready", "failed"]],
        ["select", "id"],
      ],
    });
    await expect(deleteExportRows(B, ["junk"])).resolves.toBe(0);
    expect(fake.state.chains).toHaveLength(1);
  });
});
