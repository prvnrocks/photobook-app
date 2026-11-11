import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M10c review S1 (D-062): pruneUnkeptAiBackgrounds — after a review drop, AI photo backgrounds
// whose photo is no longer kept are removed: read (RLS) → kept photos (RLS) → pruneAiBackgrounds →
// saveDocIfRev (admin, doc_rev guard), retried once on conflict. Works on user-edited albums;
// user-picked backgrounds are never touched.

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

const { pruneUnkeptAiBackgrounds } = await import("@/lib/db/books");
const { fadedBackgroundDoc, PHOTO_STATUSES, DROPPED, USER_PICK } = await import("./fixtures/ai-faded-background-doc");

const BOOK = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const TS = "2026-11-11T10:00:00.123456+00:00";
const bookRow = (doc: unknown, rev: number | null = 4) => ({ data: { id: BOOK, doc, doc_rev: rev, max_pages: 20 }, error: null });
const photoRows = { data: PHOTO_STATUSES, error: null };
const saved = (rev = 5) => ({ data: [{ doc_rev: rev, updated_at: TS }], error: null });

type Written = {
  pages: { id: string; background?: { kind: string; photoId?: string; source?: string } }[];
  style: { background: unknown; backgroundSource?: string };
  meta: unknown;
};
const written = () => (fake.state.chains.find((c) => c.op === "update")?.payload as { doc: Written }).doc;

beforeEach(() => {
  fake.state.chains = [];
  fake.state.results = [];
  fake.state.user = { id: U };
});

describe("pruneUnkeptAiBackgrounds (M10c review S1)", () => {
  it.each([false, true])("removes the AI faded background of a dropped photo, keeps the user pick (userEdited %s)", async (userEdited) => {
    fake.state.results.push(bookRow(fadedBackgroundDoc({ userEdited })), photoRows, saved());
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("updated");
    const [read, photos, write] = fake.state.chains;
    expect(read).toMatchObject({ client: "user", table: "books", op: "select" });
    expect(photos).toMatchObject({ client: "user", table: "photos", op: "select" });
    expect(write).toMatchObject({ client: "admin", table: "books", op: "update" });
    expect(write.calls).toEqual([
      ["eq", "id", BOOK],
      ["eq", "user_id", U],
      ["eq", "doc_rev", 4],
      ["select", "doc_rev, updated_at"],
    ]);
    const doc = written();
    expect(doc.pages[0].background).toBeUndefined();
    expect(doc.pages[1].background).toMatchObject({ kind: "photo", photoId: USER_PICK, source: "user" });
    expect(JSON.stringify(doc)).not.toContain(DROPPED);
    // meta as is (a cleanup is not a user edit)
    expect(doc.meta).toEqual(fadedBackgroundDoc({ userEdited }).meta);
  });

  it("an AI photo book background of a dropped photo → the style default", async () => {
    fake.state.results.push(bookRow(fadedBackgroundDoc({ aiBookBackground: true })), photoRows, saved());
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("updated");
    expect(written().style.background).toEqual({ kind: "color", hex: "#FFFFFF" });
    expect(JSON.stringify(written())).not.toContain(DROPPED);
  });

  it("photo still kept → unchanged, no write", async () => {
    const kept = PHOTO_STATUSES.map((p) => ({ ...p, status: "kept" }));
    fake.state.results.push(bookRow(fadedBackgroundDoc()), { data: kept, error: null });
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("unchanged");
    expect(fake.state.chains.some((c) => c.op === "update")).toBe(false);
  });

  it("no AI photo background → unchanged without a photo query; {} / pre-0900 → unchanged", async () => {
    const d = fadedBackgroundDoc();
    const noAi = { ...d, pages: d.pages.map((p, i) => (i === 0 ? { ...p, background: undefined } : p)) };
    fake.state.results.push(bookRow(JSON.parse(JSON.stringify(noAi))));
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("unchanged");
    expect(fake.state.chains.map((c) => c.table)).toEqual(["books"]);
    fake.state.chains = [];
    fake.state.results.push(bookRow({}));
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("unchanged");
    fake.state.results.push(bookRow(fadedBackgroundDoc(), null));
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("unchanged");
    expect(fake.state.chains.some((c) => c.op === "update")).toBe(false);
  });

  it("retries once on a conflict, then reports conflict", async () => {
    const conflict = { data: [], error: null };
    const exists = { data: { id: BOOK }, error: null };
    fake.state.results.push(bookRow(fadedBackgroundDoc()), photoRows, conflict, exists, bookRow(fadedBackgroundDoc(), 6), photoRows, saved(7));
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("updated");
    expect(fake.state.chains.filter((c) => c.op === "update").at(-1)?.calls).toContainEqual(["eq", "doc_rev", 6]);

    fake.state.chains = [];
    fake.state.results.push(bookRow(fadedBackgroundDoc()), photoRows, conflict, exists, bookRow(fadedBackgroundDoc()), photoRows, conflict, exists);
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("conflict");
  });

  it("signed out / bad id / missing book → not_found", async () => {
    expect(await pruneUnkeptAiBackgrounds("nope")).toBe("not_found");
    fake.state.user = null;
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("not_found");
    fake.state.user = { id: U };
    fake.state.results.push({ data: null, error: null });
    expect(await pruneUnkeptAiBackgrounds(BOOK)).toBe("not_found");
  });
});
