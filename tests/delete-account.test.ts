// M9 T6: delete account (D-060) + email reminders toggle (D-057). Real src/lib/account +
// src/lib/db/{account,profiles} over a fake admin client (orders / books / profiles / Storage /
// auth.admin) and a fake user-scoped server client (profiles read, signOut).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

type Err = { code?: string; statusCode?: string; status?: number; message?: string } | null;
type Result = { data?: unknown; error: Err; count?: number | null };
type Chain = { client: "admin" | "user"; table: string; op: string; payload?: unknown; calls: unknown[][] };

const fake = vi.hoisted(() => {
  const state = {
    user: null as { id: string } | null,
    calls: [] as string[],
    chains: [] as Chain[],
    /** Per "client:op:table" queue of results. */
    results: {} as Record<string, Result[]>,
    objects: {} as Record<string, Record<string, { name: string; id: string | null }[]>>,
    removed: {} as Record<string, string[][]>,
    listError: {} as Record<string, Err>,
    deleteUserError: null as Err,
    deletedUsers: [] as string[],
    signOut: [] as unknown[],
    signOutThrows: false,
  };

  function builder(client: "admin" | "user", table: string, op: string, payload?: unknown) {
    const entry: Chain = { client, table, op, payload, calls: [] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "or", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
      const key = `${client}:${op}:${table}`;
      state.calls.push(key);
      const q = state.results[key];
      return Promise.resolve(q && q.length > 0 ? q.shift()! : { data: [], error: null, count: 0 }).then(resolve, reject);
    };
    return b;
  }
  const from = (client: "admin" | "user") => (table: string) => ({
    select: (...a: unknown[]) => {
      const b = builder(client, table, "select");
      (b.select as (...x: unknown[]) => unknown)(...a);
      return b;
    },
    delete: () => builder(client, table, "delete"),
    update: (payload: unknown) => builder(client, table, "update", payload),
    upsert: (payload: unknown, opts: unknown) => {
      const b = builder(client, table, "upsert", payload);
      state.chains[state.chains.length - 1].calls.push(["upsert", opts]);
      return b;
    },
  });

  const admin = {
    from: from("admin"),
    rpc: async () => ({ data: null, error: { code: "unexpected" } }),
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
          (state.removed[bucket] ??= []).push(paths);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          state.calls.push("auth:deleteUser");
          if (state.deleteUserError) return { data: null, error: state.deleteUserError };
          state.deletedUsers.push(id);
          return { data: {}, error: null };
        },
      },
    },
  };
  const userClient = {
    from: from("user"),
    auth: {
      signOut: async (opts: unknown) => {
        state.calls.push("auth:signOut");
        state.signOut.push(opts);
        if (state.signOutThrows) throw new Error("network");
        return { error: null };
      },
    },
  };
  return { state, admin, userClient, revalidatePath: vi.fn(), redirect: vi.fn() };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.userClient }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => fake.state.user }));
vi.mock("next/cache", () => ({ revalidatePath: fake.revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    fake.redirect(url);
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));

const { deleteAccountAction, setEmailRemindersAction } = await import("@/app/settings/actions");
const { deleteAccountCompletely } = await import("@/lib/account/delete-account");
const { getOwnEmailReminders } = await import("@/lib/db/account");
const accountUi = await import("@/lib/settings/account");

const U = "11111111-1111-4111-8111-111111111111";
const B1 = "22222222-2222-4222-8222-222222222222";
const B2 = "33333333-3333-4333-8333-333333333333";

let info: MockInstance<typeof console.info>;
let error: MockInstance<typeof console.error>;

beforeEach(() => {
  const s = fake.state;
  s.user = { id: U };
  s.calls = [];
  s.chains = [];
  s.results = {};
  s.objects = {};
  s.removed = {};
  s.listError = {};
  s.deleteUserError = null;
  s.deletedUsers = [];
  s.signOut = [];
  s.signOutThrows = false;
  fake.revalidatePath.mockReset();
  fake.redirect.mockReset();
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logLines = () => [...info.mock.calls, ...error.mock.calls].map((c) => String(c[0]));

/** Two books (one paid — the list doesn't care), no pending order, both deleted. */
function happyPath() {
  fake.state.results["admin:select:books"] = [{ data: [{ id: B1 }, { id: B2 }], error: null }];
  fake.state.results["admin:select:orders"] = [{ data: null, error: null, count: 0 }];
  fake.state.results["admin:delete:books"] = [{ data: [{ id: B1 }, { id: B2 }], error: null }];
  fake.state.objects.photos = {
    [`${U}/${B1}`]: [{ name: "p1-web.jpg", id: "1" }],
    [`${U}/${B2}`]: [{ name: "p2-original.jpg", id: "2" }],
  };
  fake.state.objects.exports = { [`${U}/${B2}`]: [{ name: "book.pdf", id: "3" }] };
}

describe("deleteAccountCompletely", () => {
  it("a pending order blocks it — nothing deleted", async () => {
    fake.state.results["admin:select:books"] = [{ data: [{ id: B1 }], error: null }];
    fake.state.results["admin:select:orders"] = [{ data: null, error: null, count: 1 }];
    expect(await deleteAccountCompletely(U)).toEqual({ ok: false, error: "payment_in_progress" });
    expect(fake.state.calls).toEqual(["admin:select:books", "admin:select:orders"]);
    expect(fake.state.deletedUsers).toEqual([]);
    const orders = fake.state.chains.find((c) => c.table === "orders")!;
    expect(orders.calls).toContainEqual(["eq", "status", "pending"]);
    expect(orders.calls).toContainEqual(["or", `user_id.eq.${U},book_id.in.(${B1})`]);
  });

  it("no books → pending check by user only", async () => {
    fake.state.results["admin:select:books"] = [{ data: [], error: null }];
    fake.state.results["admin:select:orders"] = [{ data: null, error: null, count: 0 }];
    fake.state.results["admin:delete:books"] = [{ data: [], error: null }];
    expect(await deleteAccountCompletely(U)).toEqual({ ok: true, booksDeleted: 0, storageFailures: 0 });
    const orders = fake.state.chains.find((c) => c.table === "orders")!;
    expect(orders.calls).toContainEqual(["or", `user_id.eq.${U}`]);
    expect(fake.state.deletedUsers).toEqual([U]);
  });

  it("deletes ALL book rows by user_id (paid included: no is_paid filter), then Storage, then the auth user", async () => {
    happyPath();
    expect(await deleteAccountCompletely(U)).toEqual({ ok: true, booksDeleted: 2, storageFailures: 0 });
    const del = fake.state.chains.find((c) => c.op === "delete")!;
    expect(del.table).toBe("books");
    expect(del.calls).toEqual([
      ["eq", "user_id", U],
      ["select", "id"],
    ]);
    const c = fake.state.calls;
    expect(c.indexOf("admin:delete:books")).toBeLessThan(c.indexOf("list:photos"));
    expect(c.lastIndexOf("remove:exports")).toBeLessThan(c.indexOf("auth:deleteUser"));
    expect(fake.state.removed).toEqual({
      photos: [[`${U}/${B1}/p1-web.jpg`], [`${U}/${B2}/p2-original.jpg`]],
      exports: [[`${U}/${B2}/book.pdf`]],
    });
    expect(fake.state.deletedUsers).toEqual([U]);
    expect(logLines()).toEqual(["[account] deleted books=2 storage_failures=0"]);
  });

  it("storage failures are counted and logged as codes; the user is still deleted", async () => {
    happyPath();
    fake.state.listError.exports = { statusCode: "403" };
    expect(await deleteAccountCompletely(U)).toEqual({ ok: true, booksDeleted: 2, storageFailures: 2 });
    expect(fake.state.deletedUsers).toEqual([U]);
    for (const l of logLines()) {
      expect(l).not.toContain(U);
      expect(l).not.toContain(B1);
    }
    expect(logLines()).toContain("[cleanup] delete_account storage_fail bucket=exports code=403");
  });

  it("auth delete failure → failed (books already gone; retry is safe)", async () => {
    happyPath();
    fake.state.deleteUserError = { status: 500, message: "boom for someone@example.com" };
    expect(await deleteAccountCompletely(U)).toEqual({ ok: false, error: "failed" });
    expect(logLines()).toEqual(["[account] delete failed step=user code=500"]);
  });

  it("DB error on the book delete → failed, no Storage / auth calls", async () => {
    fake.state.results["admin:select:books"] = [{ data: [{ id: B1 }], error: null }];
    fake.state.results["admin:select:orders"] = [{ data: null, error: null, count: 0 }];
    fake.state.results["admin:delete:books"] = [{ data: null, error: { code: "57014" } }];
    expect(await deleteAccountCompletely(U)).toEqual({ ok: false, error: "failed" });
    expect(fake.state.calls.some((c) => c.startsWith("list:") || c === "auth:deleteUser")).toBe(false);
    expect(logLines()).toEqual(["[account] delete failed step=books code=57014"]);
  });

  it("invalid user id → invalid", async () => {
    expect(await deleteAccountCompletely("nope")).toEqual({ ok: false, error: "invalid" });
    expect(fake.state.calls).toEqual([]);
  });
});

describe("deleteAccountAction", () => {
  it("requires the exact word DELETE", async () => {
    for (const bad of ["", "delete", "DELET", "DELETE ME", undefined as unknown as string]) {
      expect(await deleteAccountAction(bad)).toEqual({ ok: false, error: "confirm" });
    }
    expect(fake.state.calls).toEqual([]);
    expect(accountUi.isDeleteConfirmed("  DELETE ")).toBe(true);
  });

  it("signed out → unauthenticated", async () => {
    fake.state.user = null;
    expect(await deleteAccountAction("DELETE")).toEqual({ ok: false, error: "unauthenticated" });
    expect(fake.state.calls).toEqual([]);
  });

  it("pending order → payment_in_progress, no sign-out", async () => {
    fake.state.results["admin:select:books"] = [{ data: [], error: null }];
    fake.state.results["admin:select:orders"] = [{ data: null, error: null, count: 1 }];
    expect(await deleteAccountAction("DELETE")).toEqual({ ok: false, error: "payment_in_progress" });
    expect(fake.state.signOut).toEqual([]);
    expect(fake.redirect).not.toHaveBeenCalled();
  });

  it("success → deletes books + storage + auth user, signs out locally, redirects with the flash", async () => {
    happyPath();
    await expect(deleteAccountAction("DELETE")).rejects.toMatchObject({ message: "NEXT_REDIRECT" });
    expect(fake.state.deletedUsers).toEqual([U]);
    expect(fake.state.signOut).toEqual([{ scope: "local" }]);
    expect(fake.state.calls.indexOf("auth:deleteUser")).toBeLessThan(fake.state.calls.indexOf("auth:signOut"));
    expect(fake.redirect).toHaveBeenCalledWith("/?account=deleted");
    expect(accountUi.ACCOUNT_DELETED_HREF).toBe("/?account=deleted");
  });

  it("sign-out throwing after the delete still redirects", async () => {
    happyPath();
    fake.state.signOutThrows = true;
    await expect(deleteAccountAction("DELETE")).rejects.toMatchObject({ message: "NEXT_REDIRECT" });
    expect(fake.redirect).toHaveBeenCalledWith("/?account=deleted");
  });

  it("failure → failed, still signed in", async () => {
    happyPath();
    fake.state.deleteUserError = { status: 500 };
    expect(await deleteAccountAction("DELETE")).toEqual({ ok: false, error: "failed" });
    expect(fake.state.signOut).toEqual([]);
  });

  it("error copy", () => {
    expect(accountUi.deleteAccountErrorCopy("payment_in_progress")).toMatch(/payment is still being processed/);
    expect(accountUi.deleteAccountErrorCopy("confirm")).toBe("Please type DELETE to confirm.");
    expect(accountUi.deleteAccountErrorCopy("failed")).toMatch(/try again/);
  });
});

describe("setEmailRemindersAction", () => {
  it("writes ONLY the session user's profile row (shared setEmailReminders, upsert on id)", async () => {
    fake.state.results["admin:upsert:profiles"] = [{ data: [{ id: U }], error: null }];
    expect(await setEmailRemindersAction(false)).toEqual({ ok: true, on: false });
    const chain = fake.state.chains.find((c) => c.op === "upsert")!;
    expect(chain).toMatchObject({ table: "profiles", payload: { id: U, email_reminders: false } });
    expect(chain.calls).toContainEqual(["upsert", { onConflict: "id" }]);
    expect(fake.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("turns back on", async () => {
    fake.state.results["admin:upsert:profiles"] = [{ data: [{ id: U }], error: null }];
    expect(await setEmailRemindersAction(true)).toEqual({ ok: true, on: true });
  });

  it("non-boolean → invalid; signed out → unauthenticated", async () => {
    expect(await setEmailRemindersAction("false" as unknown as boolean)).toEqual({ ok: false, error: "invalid" });
    fake.state.user = null;
    expect(await setEmailRemindersAction(true)).toEqual({ ok: false, error: "unauthenticated" });
    expect(fake.state.chains).toEqual([]);
  });

  it("no row updated / DB error → failed (code-only log)", async () => {
    fake.state.results["admin:upsert:profiles"] = [
      { data: [], error: null },
      { data: null, error: { code: "42501", message: "permission denied for someone@example.com" } },
    ];
    expect(await setEmailRemindersAction(false)).toEqual({ ok: false, error: "failed" });
    expect(await setEmailRemindersAction(false)).toEqual({ ok: false, error: "failed" });
    expect(logLines()).toEqual([
      "[settings] set email reminders failed (no_row)",
      "[settings] set email reminders failed (42501)",
    ]);
  });

  it("getOwnEmailReminders: missing row → true (column default), false when off", async () => {
    fake.state.results["user:select:profiles"] = [
      { data: null, error: null },
      { data: { email_reminders: false }, error: null },
    ];
    expect(await getOwnEmailReminders(U)).toBe(true);
    expect(await getOwnEmailReminders(U)).toBe(false);
  });
});
