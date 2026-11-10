// M9 T3 + T4: runCleanup sweeps, deleteBookCompletely and the src/lib/db/cleanup.ts wrappers over a
// fake admin client (RPCs, table chains and Storage list/remove).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

type Err = { code?: string; statusCode?: string; message?: string } | null;
type Result = { data?: unknown; error: Err; count?: number | null };
type Entry = { name: string; id: string | null };

const fake = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    rpcArgs: [] as { fn: string; args: Record<string, unknown> }[],
    /** Per-RPC queue of results; missing → empty result ([] for table RPCs, 0 for scalar ones). */
    rpc: {} as Record<string, Result[]>,
    tables: [] as { table: string; op: string; calls: unknown[][] }[],
    tableResults: [] as Result[],
    /** bucket → dir → entries (folders have id null). */
    objects: {} as Record<string, Record<string, Entry[]>>,
    listError: {} as Record<string, Err>,
    removeError: {} as Record<string, Err>,
    removed: {} as Record<string, string[][]>,
    clock: 0,
    /** ms added to the clock per RPC call (simulates slow batches). */
    rpcCost: 0,
  };
  const SCALAR = new Set(["cleanup_old_exports", "cleanup_unlock_attempts", "reap_stale_agent_runs", "release_warning"]);

  function builder(table: string, op: string) {
    const entry = { table, op, calls: [] as unknown[][] };
    state.tables.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
      state.calls.push(`${op}:${table}`);
      return Promise.resolve(state.tableResults.shift() ?? { data: null, error: null }).then(resolve, reject);
    };
    return b;
  }

  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.calls.push(`rpc:${fn}${fn === "cleanup_orphan_objects" ? `:${String(args.p_bucket)}` : ""}`);
      state.rpcArgs.push({ fn, args });
      state.clock += state.rpcCost;
      const q = state.rpc[fn];
      const r = q && q.length > 0 ? q.shift()! : { data: SCALAR.has(fn) ? 0 : [], error: null };
      return Promise.resolve(r);
    },
    from: (table: string) => ({
      select: (...a: unknown[]) => {
        const b = builder(table, "select");
        (b.select as (...x: unknown[]) => unknown)(...a);
        return b;
      },
      delete: () => builder(table, "delete"),
    }),
    storage: {
      from: (bucket: string) => ({
        list: async (dir: string, opts: { limit: number; offset: number }) => {
          state.calls.push(`list:${bucket}`);
          const err = state.listError[bucket];
          if (err) return { data: null, error: err };
          const all = state.objects[bucket]?.[dir] ?? [];
          return { data: all.slice(opts.offset, opts.offset + opts.limit), error: null };
        },
        remove: async (paths: string[]) => {
          state.calls.push(`remove:${bucket}`);
          const err = state.removeError[bucket];
          if (err) return { data: null, error: err };
          (state.removed[bucket] ??= []).push(paths);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.client }));

const { runCleanup, SWEEPS } = await import("@/lib/cleanup/run");
const { deleteBookCompletely } = await import("@/lib/cleanup/delete-book");
const db = await import("@/lib/db/cleanup");
const rules = await import("@/lib/cleanup/rules");

const U = "11111111-1111-4111-8111-111111111111";
const B1 = "22222222-2222-4222-8222-222222222222";
const B2 = "33333333-3333-4333-8333-333333333333";
const P1 = "44444444-4444-4444-8444-444444444444";

const books = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    user_id: U,
    book_id: `${String(i).padStart(8, "0")}-2222-4222-8222-222222222222`,
  }));

let info: MockInstance<typeof console.info>;
let error: MockInstance<typeof console.error>;

beforeEach(() => {
  const s = fake.state;
  s.calls = [];
  s.rpcArgs = [];
  s.rpc = {};
  s.tables = [];
  s.tableResults = [];
  s.objects = {};
  s.listError = {};
  s.removeError = {};
  s.removed = {};
  s.clock = 0;
  s.rpcCost = 0;
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const clock = () => fake.state.clock;
const rpcCalls = () => fake.state.calls.filter((c) => c.startsWith("rpc:"));
const logLines = () => [...info.mock.calls, ...error.mock.calls].map((c) => String(c[0]));

describe("runCleanup — order and arguments", () => {
  it("runs every sweep once, in order, with the rules constants", async () => {
    const order: string[] = [];
    const counts = await runCleanup({
      now: clock,
      sendWarnings: async () => {
        order.push("warnings");
        return { sent: 2, failed: 1 };
      },
    });
    expect(order).toEqual(["warnings"]);
    expect(rpcCalls()).toEqual([
      "rpc:cleanup_delete_expired_books",
      "rpc:cleanup_delete_abandoned_drafts",
      "rpc:cleanup_pending_uploads",
      "rpc:cleanup_orphan_objects:photos",
      "rpc:cleanup_orphan_objects:exports",
      "rpc:cleanup_old_exports",
      "rpc:cleanup_unlock_attempts",
      "rpc:reap_stale_agent_runs",
    ]);
    const args = Object.fromEntries(fake.state.rpcArgs.map((r) => [r.fn + (r.args.p_bucket ? `:${r.args.p_bucket}` : ""), r.args]));
    expect(args.cleanup_delete_expired_books).toEqual({ p_limit: rules.CLEANUP_BATCH.expiredBooks, p_grace_days: 14 });
    expect(args.cleanup_delete_abandoned_drafts).toEqual({ p_limit: 25, p_days: 45, p_notice_days: 7 });
    expect(args.cleanup_pending_uploads).toEqual({ p_limit: 200, p_days: 7 });
    expect(args["cleanup_orphan_objects:photos"]).toEqual({ p_bucket: "photos", p_days: 7, p_limit: 500 });
    expect(args.cleanup_old_exports).toEqual({ p_days: 30 });
    expect(args.cleanup_unlock_attempts).toEqual({ p_hours: 24 });
    expect(args.reap_stale_agent_runs).toEqual({ p_hours: 1 });

    expect(Object.keys(counts.sweeps)).toEqual([...SWEEPS]);
    expect(counts.sweeps.warnings).toMatchObject({ n: 2, storageFailures: 1 });
    expect(counts.ok).toBe(true);
    expect(counts.complete).toBe(true);
    expect(logLines().map((l) => l.split(" ")[1])).toEqual([...SWEEPS]);
  });

  it("the default warnings hook is a no-op", async () => {
    const counts = await runCleanup({ now: clock });
    expect(counts.sweeps.warnings).toMatchObject({ n: 0, failed: false, complete: true });
  });

  it("deleted books: row first, then prefixes in photos and exports", async () => {
    fake.state.rpc.cleanup_delete_expired_books = [{ data: [{ user_id: U, book_id: B1 }], error: null }];
    fake.state.objects.photos = { [`${U}/${B1}`]: [{ name: `${P1}-web.jpg`, id: "x" }, { name: `${P1}-thumb.jpg`, id: "y" }] };
    fake.state.objects.exports = { [`${U}/${B1}`]: [{ name: `${P1}.pdf`, id: "z" }] };
    const counts = await runCleanup({ now: clock });
    const i = fake.state.calls;
    expect(i.indexOf("rpc:cleanup_delete_expired_books")).toBeLessThan(i.indexOf("remove:photos"));
    expect(fake.state.removed.photos).toEqual([[`${U}/${B1}/${P1}-web.jpg`, `${U}/${B1}/${P1}-thumb.jpg`]]);
    expect(fake.state.removed.exports).toEqual([[`${U}/${B1}/${P1}.pdf`]]);
    expect(counts.sweeps.expired_books).toMatchObject({ n: 1, storageRemoved: 3, storageFailures: 0 });
  });

  it("pending uploads: removes the returned paths in photos", async () => {
    fake.state.rpc.cleanup_pending_uploads = [
      { data: [{ user_id: U, book_id: B1, photo_id: P1, paths: [`${U}/${B1}/${P1}-original.jpg`, null] }], error: null },
    ];
    const counts = await runCleanup({ now: clock });
    expect(fake.state.removed.photos).toEqual([[`${U}/${B1}/${P1}-original.jpg`]]);
    expect(counts.sweeps.pending_uploads).toMatchObject({ n: 1, storageRemoved: 1 });
  });
});

describe("runCleanup — batching and budget", () => {
  it("loops while batches are full and stops on the first short batch", async () => {
    fake.state.rpc.cleanup_delete_expired_books = [
      { data: books(25), error: null },
      { data: books(25), error: null },
      { data: books(3), error: null },
    ];
    const counts = await runCleanup({ now: clock });
    expect(rpcCalls().filter((c) => c === "rpc:cleanup_delete_expired_books")).toHaveLength(3);
    expect(counts.sweeps.expired_books).toMatchObject({ n: 53, complete: true });
  });

  it("orphans: loops on full batches, stops on a short one", async () => {
    const names = (n: number, k: number) => Array.from({ length: n }, (_, i) => ({ name: `${U}/${B1}/o${k}-${i}.jpg` }));
    fake.state.rpc.cleanup_orphan_objects = [
      { data: names(500, 1), error: null },
      { data: names(10, 2), error: null },
      { data: [], error: null }, // exports
    ];
    const counts = await runCleanup({ now: clock });
    expect(counts.sweeps.orphans_photos).toMatchObject({ n: 510, storageRemoved: 510, complete: true });
    expect(fake.state.removed.photos.map((p) => p.length)).toEqual([500, 10]);
  });

  it("stops starting batches when the budget is spent and skips the remaining sweeps", async () => {
    fake.state.rpcCost = 600;
    fake.state.rpc.cleanup_delete_expired_books = Array.from({ length: 10 }, () => ({ data: books(25), error: null }));
    const counts = await runCleanup({ now: clock, budgetMs: 1000 });
    // 1st call at t=0 → 600 (budget left), 2nd → 1200 (spent) → stop.
    expect(rpcCalls()).toEqual(["rpc:cleanup_delete_expired_books", "rpc:cleanup_delete_expired_books"]);
    expect(counts.sweeps.expired_books).toMatchObject({ n: 50, complete: false, failed: false });
    expect(counts.sweeps.stale_runs).toMatchObject({ n: 0, complete: false });
    expect(counts).toMatchObject({ ok: true, complete: false, budgetSpent: true });
    expect(logLines().filter((l) => l.includes("skipped=1"))).toHaveLength(SWEEPS.length - 2);
    expect(logLines().find((l) => l.includes("expired_books"))).toMatch(/ partial=1$/);
  });

  it("a second run with nothing left does nothing", async () => {
    fake.state.rpc.cleanup_delete_expired_books = [{ data: books(2), error: null }];
    fake.state.rpc.cleanup_old_exports = [{ data: 4, error: null }];
    const first = await runCleanup({ now: clock });
    expect(first.sweeps.expired_books.n).toBe(2);
    expect(first.sweeps.old_exports.n).toBe(4);
    const second = await runCleanup({ now: clock });
    for (const s of SWEEPS) expect(second.sweeps[s]).toMatchObject({ n: 0, storageRemoved: 0, storageFailures: 0 });
    expect(second.complete).toBe(true);
  });
});

describe("runCleanup — failures", () => {
  it("a storage failure doesn't throw, is counted, and the run continues", async () => {
    fake.state.rpc.cleanup_delete_expired_books = [{ data: [{ user_id: U, book_id: B1 }, { user_id: U, book_id: B2 }], error: null }];
    fake.state.removeError.photos = { statusCode: "403", message: "nope" };
    fake.state.objects.photos = {
      [`${U}/${B1}`]: [{ name: "a.jpg", id: "1" }],
      [`${U}/${B2}`]: [{ name: "b.jpg", id: "2" }],
    };
    fake.state.objects.exports = { [`${U}/${B1}`]: [{ name: "c.pdf", id: "3" }] };
    fake.state.rpc.cleanup_unlock_attempts = [{ data: 9, error: null }];
    const counts = await runCleanup({ now: clock });
    expect(counts.sweeps.expired_books).toMatchObject({ n: 2, storageFailures: 2, storageRemoved: 1, failed: false });
    expect(counts.sweeps.unlock_attempts.n).toBe(9);
    expect(counts.ok).toBe(true);
    expect(logLines().find((l) => l.includes("expired_books"))).toBe("[cleanup] expired_books n=2 ms=0 storage_removed=1 storage_fail=2");
  });

  it("orphan sweep stops (no spin) when removal fails", async () => {
    fake.state.rpc.cleanup_orphan_objects = [{ data: Array.from({ length: 500 }, (_, i) => ({ name: `x/${i}` })), error: null }];
    fake.state.removeError.photos = { statusCode: "500" };
    const counts = await runCleanup({ now: clock });
    expect(rpcCalls().filter((c) => c === "rpc:cleanup_orphan_objects:photos")).toHaveLength(1);
    expect(counts.sweeps.orphans_photos).toMatchObject({ n: 0, storageFailures: 1, complete: false });
  });

  it("an RPC error marks that sweep failed (code only) and the next sweeps still run", async () => {
    fake.state.rpc.cleanup_delete_abandoned_drafts = [{ data: null, error: { code: "42501", message: "permission denied for books" } }];
    const counts = await runCleanup({ now: clock });
    expect(counts.sweeps.abandoned_drafts).toMatchObject({ failed: true, complete: false });
    expect(rpcCalls()).toContain("rpc:reap_stale_agent_runs");
    expect(counts.ok).toBe(false);
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual(["[cleanup] abandoned_drafts n=0 ms=0 error=42501"]);
  });

  it("a throwing warnings hook doesn't stop the run", async () => {
    const counts = await runCleanup({
      now: clock,
      sendWarnings: async () => {
        throw Object.assign(new Error("resend down for someone@example.com"), { code: "resend_5xx" });
      },
    });
    expect(counts.sweeps.warnings.failed).toBe(true);
    expect(counts.sweeps.stale_runs.failed).toBe(false);
    expect(logLines().join("\n")).not.toContain("example.com");
  });
});

describe("runCleanup — logs contain counts only", () => {
  it("never logs ids, paths, titles or emails", async () => {
    fake.state.rpc.cleanup_delete_expired_books = [{ data: [{ user_id: U, book_id: B1 }], error: null }];
    fake.state.rpc.cleanup_pending_uploads = [{ data: [{ user_id: U, book_id: B1, photo_id: P1, paths: [`${U}/${B1}/${P1}-web.jpg`] }], error: null }];
    fake.state.rpc.cleanup_orphan_objects = [{ data: [{ name: `${U}/${B2}/${P1}-thumb.jpg` }], error: null }];
    fake.state.objects.photos = { [`${U}/${B1}`]: [{ name: "a.jpg", id: "1" }] };
    fake.state.removeError.exports = { statusCode: "403" };
    fake.state.listError.exports = { statusCode: "403" };
    await runCleanup({ now: clock, sendWarnings: async () => ({ sent: 1, failed: 0 }) });
    const lines = logLines();
    expect(lines).toHaveLength(SWEEPS.length);
    for (const l of lines) {
      expect(l).toMatch(/^\[cleanup\] [a-z_]+ n=\d+ ms=\d+( [a-z_]+=[A-Za-z0-9_-]+)*$/);
      for (const secret of [U, B1, B2, P1, ".jpg", "@"]) expect(l).not.toContain(secret);
    }
  });
});

describe("deleteBookCompletely", () => {
  const bookRow = (isPaid: boolean) => ({ data: { id: B1, is_paid: isPaid }, error: null });

  it("refuses a paid book without deleting", async () => {
    fake.state.tableResults = [bookRow(true)];
    expect(await deleteBookCompletely({ bookId: B1, userId: U })).toEqual({ ok: false, error: "protected" });
    expect(fake.state.tables.map((t) => t.op)).toEqual(["select"]);
    expect(fake.state.calls.some((c) => c.startsWith("remove:"))).toBe(false);
  });

  it("refuses a book with a protected order (pending / paid / needs_review / disputed)", async () => {
    fake.state.tableResults = [bookRow(false), { data: null, error: null, count: 1 }];
    expect(await deleteBookCompletely({ bookId: B1, userId: U })).toEqual({ ok: false, error: "protected" });
    const orders = fake.state.tables.find((t) => t.table === "orders")!;
    expect(orders.calls).toContainEqual(["in", "status", ["pending", "paid", "needs_review", "disputed"]]);
    expect(fake.state.tables.some((t) => t.op === "delete")).toBe(false);
  });

  it("guarded delete: owner + unpaid filters; became paid meanwhile → protected", async () => {
    fake.state.tableResults = [
      bookRow(false),
      { data: null, error: null, count: 0 },
      { data: [], error: null }, // delete matched nothing
      { data: { id: B1 }, error: null }, // still there
    ];
    expect(await deleteBookCompletely({ bookId: B1, userId: U })).toEqual({ ok: false, error: "protected" });
    const del = fake.state.tables.find((t) => t.op === "delete")!;
    expect(del.calls).toEqual(
      expect.arrayContaining([
        ["eq", "id", B1],
        ["eq", "user_id", U],
        ["eq", "is_paid", false],
      ]),
    );
  });

  it("deletes the row, then removes both prefixes", async () => {
    fake.state.tableResults = [bookRow(false), { data: null, error: null, count: 0 }, { data: [{ id: B1 }], error: null }];
    fake.state.objects.photos = { [`${U}/${B1}`]: [{ name: "a-web.jpg", id: "1" }] };
    fake.state.objects.exports = { [`${U}/${B1}`]: [{ name: "e.pdf", id: "2" }] };
    expect(await deleteBookCompletely({ bookId: B1, userId: U })).toEqual({ ok: true, storageRemoved: 2, storageFailures: 0 });
    expect(fake.state.calls.indexOf("delete:books")).toBeLessThan(fake.state.calls.indexOf("list:photos"));
    expect(fake.state.removed).toEqual({ photos: [[`${U}/${B1}/a-web.jpg`]], exports: [[`${U}/${B1}/e.pdf`]] });
  });

  it("storage failure after the row delete → ok with the failure counted and a code-only log", async () => {
    fake.state.tableResults = [bookRow(false), { data: null, error: null, count: 0 }, { data: [{ id: B1 }], error: null }];
    fake.state.listError.exports = { statusCode: "403" };
    expect(await deleteBookCompletely({ bookId: B1, userId: U })).toEqual({ ok: true, storageRemoved: 0, storageFailures: 1 });
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual(["[cleanup] delete_book storage_fail bucket=exports code=403"]);
  });

  it("not found / foreign / invalid ids", async () => {
    fake.state.tableResults = [{ data: null, error: null }];
    expect(await deleteBookCompletely({ bookId: B1, userId: U })).toEqual({ ok: false, error: "not_found" });
    expect(await deleteBookCompletely({ bookId: "nope", userId: U })).toEqual({ ok: false, error: "invalid" });
    const read = fake.state.tables[0];
    expect(read.calls).toContainEqual(["eq", "user_id", U]);
  });

  it("DB error → failed (code only)", async () => {
    fake.state.tableResults = [{ data: null, error: { code: "57014", message: "statement timeout on book 'Our trip'" } }];
    expect(await deleteBookCompletely({ bookId: B1, userId: U })).toEqual({ ok: false, error: "failed" });
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual(["[cleanup] delete_book failed code=57014"]);
  });
});

describe("db/cleanup storage helpers", () => {
  it("removeStoragePrefix refuses anything but {uuid}/{uuid}/", async () => {
    for (const p of ["", "/", U, `${U}/`, `${U}/${B1}/x`, "../x/y", `${U}/*`]) {
      await expect(db.removeStoragePrefix("photos", p)).rejects.toMatchObject({ code: "invalid_prefix" });
    }
    expect(fake.state.calls).toEqual([]);
  });

  it("removeStoragePrefix paginates, recurses into folders and removes in ≤ STORAGE_REMOVE_MAX batches", async () => {
    const files = Array.from({ length: 1500 }, (_, i) => ({ name: `f${String(i).padStart(4, "0")}.jpg`, id: String(i) }));
    fake.state.objects.photos = {
      [`${U}/${B1}`]: [...files, { name: "sub", id: null }],
      [`${U}/${B1}/sub`]: [{ name: "deep.jpg", id: "d" }],
    };
    const n = await db.removeStoragePrefix("photos", `${U}/${B1}/`);
    expect(n).toBe(1501);
    expect(fake.state.calls.filter((c) => c === "list:photos")).toHaveLength(3);
    const batches = fake.state.removed.photos;
    expect(batches.map((b) => b.length)).toEqual([rules.STORAGE_REMOVE_MAX, 501]);
    expect(batches.flat()).toContain(`${U}/${B1}/sub/deep.jpg`);
  });

  it("removeStoragePaths dedupes, skips empties and throws a typed error with the string statusCode", async () => {
    expect(await db.removeStoragePaths("exports", [])).toBe(0);
    expect(await db.removeStoragePaths("exports", ["a", "a", ""])).toBe(1);
    fake.state.removeError.exports = { statusCode: "403", message: `denied ${U}` };
    const e = await db.removeStoragePaths("exports", ["a"]).catch((x) => x);
    expect(e).toBeInstanceOf(db.CleanupStorageError);
    expect(e.code).toBe("403");
    expect(e.message).not.toContain(U);
  });

  it("warning claims: nullable title / email are kept as null", async () => {
    fake.state.rpc.claim_expiry_warnings = [
      { data: [{ book_id: B1, user_id: U, email: null, title: null, expires_at: "2026-11-12T00:00:00Z", is_live: true }], error: null },
    ];
    fake.state.rpc.claim_draft_warnings = [
      { data: [{ book_id: B1, user_id: U, email: "a@b.c", title: null, last_activity_at: "x", delete_after: "y" }], error: null },
    ];
    expect(await db.claimExpiryWarnings(50, 3)).toEqual([
      { bookId: B1, userId: U, email: null, title: null, expiresAt: "2026-11-12T00:00:00Z", isLive: true },
    ]);
    expect(await db.claimDraftWarnings(50, 38, 45)).toEqual([
      { bookId: B1, userId: U, email: "a@b.c", title: null, lastActivityAt: "x", deleteAfter: "y" },
    ]);
    expect(fake.state.rpcArgs.map((r) => r.args)).toEqual([
      { p_limit: 50, p_days_before: 3 },
      { p_limit: 50, p_warn_days: 38, p_delete_days: 45 },
    ]);
  });

  it("releaseWarning passes kind and refuses non-uuids; RPC errors become CleanupQueryError", async () => {
    fake.state.rpc.release_warning = [{ data: true, error: null }];
    expect(await db.releaseWarning(B1, "draft")).toBe(true);
    expect(fake.state.rpcArgs[0]).toEqual({ fn: "release_warning", args: { p_book: B1, p_kind: "draft" } });
    expect(await db.releaseWarning("x", "expiry")).toBe(false);
    fake.state.rpc.cleanup_old_exports = [{ data: null, error: { code: "22023" } }];
    await expect(db.deleteOldExportRows(0)).rejects.toMatchObject({ name: "CleanupQueryError", code: "22023" });
  });
});

describe("module boundaries", () => {
  it.each(["src/lib/db/cleanup.ts", "src/lib/cleanup/run.ts", "src/lib/cleanup/delete-book.ts", "src/lib/cleanup/cron-auth.ts"])(
    '%s starts with import "server-only"',
    (file) => {
      const first = readFileSync(join(process.cwd(), file), "utf8").split(/\r?\n/).find((l) => l.trim() !== "");
      expect(first?.trim()).toMatch(/^import ["']server-only["'];?$/);
    },
  );
});
