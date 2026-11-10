// Review S3: opening a warned draft (editor / review page) bumps updated_at and clears the warning,
// owner-scoped, admin client, never throws, code-only logs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Call = { payload: unknown; filters: unknown[][] };

const fake = vi.hoisted(() => {
  const state = {
    updates: [] as Call[],
    results: [] as { data: unknown; error: { code?: string } | null }[],
  };
  const admin = {
    from: (table: string) => ({
      update: (payload: unknown) => {
        const call: Call = { payload, filters: [["table", table]] };
        state.updates.push(call);
        const b: Record<string, unknown> = {};
        for (const m of ["eq", "is", "not", "select"]) {
          b[m] = (...args: unknown[]) => {
            call.filters.push([m, ...args]);
            return b;
          };
        }
        b.then = (resolve: (r: unknown) => unknown) =>
          Promise.resolve(state.results.shift() ?? { data: null, error: null }).then(resolve);
        return b;
      },
    }),
  };
  return { state, admin };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));

const { touchWarnedDraft } = await import("@/lib/db/draft-activity");

const U = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fake.state.updates = [];
  fake.state.results = [];
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("touchWarnedDraft", () => {
  it("warned draft: bumps updated_at (owner + unpaid + unpublished + warned filters), then clears the warning", async () => {
    fake.state.results = [{ data: [{ id: B }], error: null }, { data: null, error: null }];
    expect(await touchWarnedDraft(B, U)).toBe("touched");
    const [bump, clear] = fake.state.updates;
    expect(Object.keys(bump.payload as object)).toEqual(["updated_at"]);
    expect(bump.filters).toEqual([
      ["table", "books"],
      ["eq", "id", B],
      ["eq", "user_id", U],
      ["eq", "is_paid", false],
      ["is", "published_at", null],
      ["not", "draft_warning_sent_at", "is", null],
      ["select", "id"],
    ]);
    expect(clear.payload).toEqual({ draft_warning_sent_at: null });
    expect(clear.filters).toEqual([
      ["table", "books"],
      ["eq", "id", B],
      ["eq", "user_id", U],
    ]);
  });

  it("nothing matched (not warned / not the owner's / published / paid) → noop, no second write", async () => {
    fake.state.results = [{ data: [], error: null }];
    expect(await touchWarnedDraft(B, U)).toBe("noop");
    expect(fake.state.updates).toHaveLength(1);
  });

  it("invalid ids → noop without any query", async () => {
    expect(await touchWarnedDraft("nope", U)).toBe("noop");
    expect(await touchWarnedDraft(B, "nope")).toBe("noop");
    expect(fake.state.updates).toHaveLength(0);
  });

  it("DB error → failed, logged as code only, never throws", async () => {
    fake.state.results = [{ data: null, error: { code: "57014" } }];
    expect(await touchWarnedDraft(B, U)).toBe("failed");
    expect(err).toHaveBeenCalledWith("[books] touch draft failed code=57014");
    fake.state.results = [{ data: [{ id: B }], error: null }, { data: null, error: { code: "42501" } }];
    expect(await touchWarnedDraft(B, U)).toBe("failed");
    const text = err.mock.calls.flat().join("\n");
    expect(text).not.toContain(B);
    expect(text).not.toContain(U);
  });
});

describe("pages call it after the ownership check", () => {
  for (const [file, check] of [
    ["src/app/books/[id]/edit/page.tsx", "if (!data) notFound();"],
    ["src/app/books/[id]/review/page.tsx", "if (!book) notFound();"],
  ] as const) {
    it(file, () => {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const at = src.indexOf("await touchWarnedDraft(");
      expect(at).toBeGreaterThan(src.indexOf(check));
      expect(src).toMatch(/await touchWarnedDraft\((data\.book|book)\.id, user\.id\)/);
    });
  }
});
