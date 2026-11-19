// Task 10 (known gap from Task 9): a granted (non-Stripe) full storybook gets the PAID page limit for
// composition, while the PDF / watermark / permanent link stay is_paid-only (D-093).
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { LIMITS } from "@/lib/ai/limits";
import { grantBookEntitlement, revokeBookEntitlement } from "@/lib/entitlements/grant";
import { resolveEntitlement } from "@/lib/entitlements/resolve";

const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function db(book: Record<string, unknown> = { id: BOOK, is_paid: false, page_count: 12, max_pages: 100 }) {
  const updates: { table: string; row: unknown; filters: string[] }[] = [];
  const c = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "books" ? book : null, error: null }) }) }),
      insert: async () => ({ error: null }),
      update: (row: unknown) => {
        const u = { table, row, filters: [] as string[] };
        updates.push(u);
        const chain: Record<string, unknown> = {
          eq: (k: string, v: unknown) => (u.filters.push(`${k}=${String(v)}`), chain),
          is: (k: string) => (u.filters.push(`${k} is null`), chain),
          lt: (k: string, v: unknown) => (u.filters.push(`${k}<${String(v)}`), chain),
          select: async () => ({ data: [{ id: "g1" }], error: null }),
          then: (r: (v: { error: null }) => void) => r({ error: null }),
        };
        return chain;
      },
    }),
  };
  return { c, updates };
}

describe("grant → paid page limit for composition", () => {
  it("resolveEntitlement: a grant composes up to the paid page limit but still cannot export a PDF", () => {
    const e = resolveEntitlement({ bookId: BOOK, isPaid: false, maxPages: 20, orderStatus: null, hasActiveGrant: true }, { pages: 5, maxRuns: 3 });
    expect(e).toMatchObject({ tier: "full", source: "grant", isPaid: false, canExportPdf: false });
    expect(e.limits.maxPages).toBe(LIMITS.paid.maxPages);
    // a free book without a grant keeps 20
    expect(resolveEntitlement({ bookId: BOOK, isPaid: false, maxPages: 20, orderStatus: null, hasActiveGrant: false }).limits.maxPages).toBe(20);
  });

  it("granting raises books.max_pages of an unpaid book (never is_paid)", async () => {
    const d = db();
    expect(await grantBookEntitlement({ bookId: BOOK, adminUserId: ADMIN, reason: "support" }, { isAdmin: () => true, client: () => d.c as never })).toEqual({ ok: true, status: "granted" });
    const books = d.updates.filter((u) => u.table === "books");
    expect(books).toEqual([{ table: "books", row: { max_pages: LIMITS.paid.maxPages }, filters: [`id=${BOOK}`, "is_paid=false", `max_pages<${LIMITS.paid.maxPages}`] }]);
    expect(JSON.stringify(d.updates)).not.toContain("is_paid\":true");
  });

  it("revoking returns to the free limit only when the book still fits in it", async () => {
    const fits = db({ id: BOOK, is_paid: false, page_count: 12, max_pages: 100 });
    expect(await revokeBookEntitlement({ bookId: BOOK, adminUserId: ADMIN }, { isAdmin: () => true, client: () => fits.c as never })).toEqual({ ok: true, revoked: 1 });
    expect(fits.updates.filter((u) => u.table === "books").map((u) => u.row)).toEqual([{ max_pages: LIMITS.free.maxPages }]);

    const big = db({ id: BOOK, is_paid: false, page_count: 48, max_pages: 100 });
    await revokeBookEntitlement({ bookId: BOOK, adminUserId: ADMIN }, { isAdmin: () => true, client: () => big.c as never });
    expect(big.updates.filter((u) => u.table === "books")).toEqual([]);

    const paid = db({ id: BOOK, is_paid: true, page_count: 12, max_pages: 100 });
    await revokeBookEntitlement({ bookId: BOOK, adminUserId: ADMIN }, { isAdmin: () => true, client: () => paid.c as never });
    expect(paid.updates.filter((u) => u.table === "books")).toEqual([]);
  });
});
