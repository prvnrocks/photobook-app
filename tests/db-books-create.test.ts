import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M10b A1 (D-063, migration 1900): createBook sends books.format / design_style only when chosen.

const fake = vi.hoisted(() => {
  const state = {
    inserts: [] as { client: "user" | "admin"; table: string; payload: unknown }[],
    result: { data: { id: "new-book" }, error: null } as { data: unknown; error: { code?: string } | null },
    user: { id: "u" } as { id: string } | null,
  };
  const make = (kind: "user" | "admin") => ({
    from: (table: string) => ({
      insert: (payload: unknown) => {
        state.inserts.push({ client: kind, table, payload });
        const b = { select: () => b, single: async () => state.result };
        return b;
      },
    }),
  });
  return { state, client: make("user"), admin: make("admin") };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => fake.state.user }));

const { createBook, BooksQueryError } = await import("@/lib/db/books");

const BASE = { title: "Trip", occasion: "travel", tone: "warm", captionLang: "en" } as unknown as Parameters<
  typeof createBook
>[0];

beforeEach(() => {
  fake.state.inserts = [];
  fake.state.result = { data: { id: "new-book" }, error: null };
  fake.state.user = { id: "u" };
});

describe("createBook format / designStyle", () => {
  it("omits both columns when not chosen (DB defaults portrait / classic)", async () => {
    await expect(createBook(BASE)).resolves.toEqual({ id: "new-book" });
    expect(fake.state.inserts).toHaveLength(1);
    const { client, table, payload } = fake.state.inserts[0]!;
    expect(client).toBe("user");
    expect(table).toBe("books");
    expect(payload).not.toHaveProperty("format");
    expect(payload).not.toHaveProperty("design_style");
  });

  it("sends the chosen format and design style with the user client", async () => {
    await createBook({ ...BASE, format: "A5_LANDSCAPE", designStyle: "modern" });
    expect(fake.state.inserts[0]).toMatchObject({
      client: "user",
      payload: { user_id: "u", format: "A5_LANDSCAPE", design_style: "modern" },
    });
  });

  it("rejects values outside the enums before inserting", async () => {
    const badFormat = { ...BASE, format: "A4_PORTRAIT" } as unknown as Parameters<typeof createBook>[0];
    const badStyle = { ...BASE, designStyle: "baroque" } as unknown as Parameters<typeof createBook>[0];
    await expect(createBook(badFormat)).rejects.toMatchObject({ code: "invalid_format" });
    await expect(createBook(badStyle)).rejects.toBeInstanceOf(BooksQueryError);
    await expect(createBook(badStyle)).rejects.toMatchObject({ code: "invalid_design_style" });
    expect(fake.state.inserts).toHaveLength(0);
  });
});
