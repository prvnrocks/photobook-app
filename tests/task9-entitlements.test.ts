// Task 9: the entitlement abstraction (preview vs full, sources, the PDF gate), authorized grants,
// the preview configuration and page selection, the editor's preview banner state.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { LIMITS } from "@/lib/ai/limits";
import { PREVIEW_MAX_PAGES, previewSelection } from "@/lib/ai/story/preview";
import { storyPreviewCopy, storyPreviewState } from "@/lib/editor/story-preview";
import { getBookEntitlement, getEntitlementTier } from "@/lib/entitlements";
import { grantBookEntitlement, revokeBookEntitlement, validGrantReason } from "@/lib/entitlements/grant";
import { PREVIEW_DEFAULTS, readPreviewConfig } from "@/lib/entitlements/preview";
import { resolveEntitlement, type EntitlementFacts } from "@/lib/entitlements/resolve";
import { canExport } from "@/lib/pdf/rules";
import { emptyStoryProgress, type StoryRunView } from "@/lib/storybook/run/progress";

const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const facts = (over: Partial<EntitlementFacts> = {}): EntitlementFacts => ({ bookId: BOOK, isPaid: false, maxPages: 20, orderStatus: null, hasActiveGrant: false, ...over });

describe("resolveEntitlement: preview vs full from server facts only", () => {
  it("a free book is a preview with no PDF; limits come from config and the book row", () => {
    expect(resolveEntitlement(facts(), { pages: 5, maxRuns: 3 })).toEqual({
      bookId: BOOK,
      tier: "preview",
      source: "none",
      isPaid: false,
      canExportPdf: false,
      limits: { maxPages: 20, previewPages: 5, maxPreviewRuns: 3, maxRunCostUsd: LIMITS.free.maxRunCostUsd },
    });
  });

  it("paid by Stripe → full + PDF; comped → full + PDF with source comp", () => {
    expect(resolveEntitlement(facts({ isPaid: true, maxPages: 100, orderStatus: "paid" }))).toMatchObject({ tier: "full", source: "stripe", canExportPdf: true, limits: { maxPages: 100 } });
    expect(resolveEntitlement(facts({ isPaid: true, maxPages: 100, orderStatus: "comped" }))).toMatchObject({ tier: "full", source: "comp", canExportPdf: true });
  });

  it("an authorized grant gives full storybook generation but NEVER the paid export", () => {
    const e = resolveEntitlement(facts({ hasActiveGrant: true }));
    expect(e).toMatchObject({ tier: "full", source: "grant", isPaid: false, canExportPdf: false });
    expect(canExport({ isPaid: e.canExportPdf, doc: {}, maxPages: e.limits.maxPages })).toEqual({ ok: false, reason: "not_paid" });
  });

  it("getBookEntitlement reads facts server-side; a missing book is null; tier lookups fail SAFE to preview", async () => {
    expect(await getBookEntitlement(BOOK, { readFacts: async () => facts({ isPaid: true, orderStatus: "paid" }) })).toMatchObject({ tier: "full" });
    expect(await getBookEntitlement(BOOK, { readFacts: async () => null })).toBeNull();
    expect(await getEntitlementTier(BOOK, { readFacts: async () => Promise.reject(new Error("db down")) })).toBe("preview");
    expect(await getEntitlementTier(BOOK, { readFacts: async () => null })).toBe("preview");
    expect(await getEntitlementTier(BOOK, { readFacts: async () => facts({ hasActiveGrant: true }) })).toBe("full");
  });
});

describe("preview configuration", () => {
  it("defaults 5 pages / 3 live previews; env clamps to 4–6 pages and 1–10 runs; garbage → default", () => {
    expect(readPreviewConfig({})).toEqual(PREVIEW_DEFAULTS);
    expect(readPreviewConfig({ AI_PREVIEW_PAGES: "6", AI_PREVIEW_MAX_RUNS: "1" })).toEqual({ pages: 6, maxRuns: 1 });
    expect(readPreviewConfig({ AI_PREVIEW_PAGES: "40", AI_PREVIEW_MAX_RUNS: "0" })).toEqual({ pages: 6, maxRuns: 1 });
    expect(readPreviewConfig({ AI_PREVIEW_PAGES: "2" }).pages).toBe(4);
    expect(readPreviewConfig({ AI_PREVIEW_PAGES: "five", AI_PREVIEW_MAX_RUNS: "-2" })).toEqual(PREVIEW_DEFAULTS);
  });
});

describe("previewSelection: the first chapter(s) of the full plan, 4–6 pages, never the closing page", () => {
  const page = (id: string, chapterId: string | null, kind = "photo") => ({ id, kind, chapterId, momentId: null, photoIds: [], blocks: [], narrativeShare: 0 }) as never;
  const plan = (sizes: number[], closing = true) => {
    let n = 0;
    const chapters = sizes.map((_, i) => ({ id: `c${i + 1}` }) as never);
    const pages = sizes.flatMap((k, i) => Array.from({ length: k }, (_, j) => page(`pg${++n}`, `c${i + 1}`, j === 0 ? "chapter_opener" : "photo")));
    if (closing) pages.push(page(`pg${++n}`, null, "closing"));
    return { chapters, skeleton: { pages, omittedPhotos: 0, balance: {} } } as never;
  };

  it("whole chapters while they fit", () => {
    expect(previewSelection(plan([3, 2, 4]), 5)).toEqual({ pageIds: ["pg1", "pg2", "pg3", "pg4", "pg5"], groups: ["c1", "c2"] });
    expect(previewSelection(plan([5, 5]), 5)).toEqual({ pageIds: ["pg1", "pg2", "pg3", "pg4", "pg5"], groups: ["c1"] });
  });

  it("a long first chapter is cut to the page count; a short start is topped up from the next chapter", () => {
    expect(previewSelection(plan([9, 3]), 5).pageIds).toHaveLength(5);
    expect(previewSelection(plan([9, 3]), 5).groups).toEqual(["c1"]);
    expect(previewSelection(plan([2, 8]), 5)).toEqual({ pageIds: ["pg1", "pg2", "pg3", "pg4", "pg5"], groups: ["c1", "c2"] });
    expect(previewSelection(plan([4, 8]), 5)).toEqual({ pageIds: ["pg1", "pg2", "pg3", "pg4"], groups: ["c1"] });
  });

  it("never more than 6 pages whatever is asked; a tiny book previews what it has, without the closing page", () => {
    expect(previewSelection(plan([10]), 50).pageIds.length).toBe(PREVIEW_MAX_PAGES);
    expect(previewSelection(plan([2]), 5)).toEqual({ pageIds: ["pg1", "pg2"], groups: ["c1"] });
  });
});

describe("authorized grants (server-only, admin allow-list)", () => {
  function client(insertError: { code: string } | null = null, book: unknown = { id: BOOK }) {
    const inserts: unknown[] = [];
    const updates: unknown[] = [];
    const c = {
      from: (table: string) => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "books" ? book : null, error: null }) }) }),
        insert: async (row: unknown) => {
          inserts.push(row);
          return { error: insertError };
        },
        update: (row: unknown) => {
          updates.push(row);
          const chain = { eq: () => chain, is: () => chain, lt: () => chain, select: async () => ({ data: [{ id: "g1" }], error: null }) };
          return chain;
        },
      }),
    };
    return { c, inserts, updates };
  }

  it("non-admins can't grant or revoke; bad ids / reasons are refused before any write", async () => {
    const { c, inserts } = client();
    expect(await grantBookEntitlement({ bookId: BOOK, adminUserId: ADMIN, reason: "support" }, { isAdmin: () => false, client: () => c as never })).toEqual({ ok: false, error: "not_admin" });
    expect(await revokeBookEntitlement({ bookId: BOOK, adminUserId: ADMIN }, { isAdmin: () => false, client: () => c as never })).toEqual({ ok: false, error: "not_admin" });
    expect(await grantBookEntitlement({ bookId: "x", adminUserId: ADMIN, reason: "support" }, { isAdmin: () => true, client: () => c as never })).toEqual({ ok: false, error: "invalid" });
    expect(await grantBookEntitlement({ bookId: BOOK, adminUserId: ADMIN, reason: "  " }, { isAdmin: () => true, client: () => c as never })).toEqual({ ok: false, error: "invalid" });
    expect(inserts).toEqual([]);
    expect(validGrantReason("tester\u0007")).toBe(false);
    expect(validGrantReason("x".repeat(201))).toBe(false);
  });

  it("an admin grant inserts ONE row (never touches books.is_paid); a second is already_granted; revoke stamps revoked_at", async () => {
    const ok = client();
    expect(await grantBookEntitlement({ bookId: BOOK, adminUserId: ADMIN, reason: " support case 12 " }, { isAdmin: () => true, client: () => ok.c as never })).toEqual({ ok: true, status: "granted" });
    expect(ok.inserts).toEqual([{ book_id: BOOK, reason: "support case 12", granted_by: ADMIN }]);
    const dup = client({ code: "23505" });
    expect(await grantBookEntitlement({ bookId: BOOK, adminUserId: ADMIN, reason: "again" }, { isAdmin: () => true, client: () => dup.c as never })).toEqual({ ok: true, status: "already_granted" });
    const missing = client(null, null);
    expect(await grantBookEntitlement({ bookId: BOOK, adminUserId: ADMIN, reason: "x" }, { isAdmin: () => true, client: () => missing.c as never })).toEqual({ ok: false, error: "not_found" });
    const rv = client();
    expect(await revokeBookEntitlement({ bookId: BOOK, adminUserId: ADMIN }, { isAdmin: () => true, client: () => rv.c as never })).toEqual({ ok: true, revoked: 1 });
    expect(Object.keys(rv.updates[0] as object)).toEqual(["revoked_at"]);
  });

  it("no route, server action or client module imports the grant path", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const users = walk(join(process.cwd(), "src")).filter((f) => /entitlements\/grant/.test(readFileSync(f, "utf8")));
    expect(users).toEqual([]);
  });
});

describe("editor preview banner state", () => {
  const view = (over: Partial<StoryRunView> = {}, preview?: number): StoryRunView => {
    const progress = { ...emptyStoryProgress("done"), ...(preview ? { preview: { pages: preview } } : {}) };
    return { runId: "r", state: "done", progress, done: true, aiStatus: "ok", errorCode: null, mode: "live", ...over };
  };

  it("a finished preview on an unentitled book → locked with the page count and the AED 39 unlock", () => {
    const s = storyPreviewState({ latest: view({}, 5), tier: "preview" });
    expect(s).toEqual({ kind: "locked", pages: 5 });
    expect(storyPreviewCopy(s!)).toEqual({ text: "This is a 5-page preview.", cta: "Unlock the full book — AED 39" });
  });

  it("entitled after the preview → Complete my book; full storybooks, running jobs and classic books → nothing", () => {
    expect(storyPreviewState({ latest: view({}, 5), tier: "full" })).toEqual({ kind: "complete" });
    expect(storyPreviewCopy({ kind: "complete" }).cta).toBe("Complete my book");
    expect(storyPreviewState({ latest: view({}), tier: "preview" })).toBeNull();
    expect(storyPreviewState({ latest: view({ state: "writing", done: false }, 5), tier: "preview" })).toBeNull();
    expect(storyPreviewState(undefined)).toBeNull();
    // a missing tier never unlocks: it reads as locked
    expect(storyPreviewState({ latest: view({}, 4) })).toEqual({ kind: "locked", pages: 4 });
  });
});
