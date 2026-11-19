import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Storybook } from "@/lib/storybook/types";

vi.mock("server-only", () => ({}));

// Task 6: src/lib/db/storybooks.ts (getCurrentStorybook / appendStorybookVersion) and
// src/lib/db/story-ai-calls.ts against in-memory tables (fake admin client).

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const BOOK = "22222222-2222-4222-8222-222222222222";
const PHOTO = "00000000-0000-4000-8000-000000000001";

const db = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    tables: { storybooks: [] as Row[], storybook_versions: [] as Row[], story_ai_calls: [] as Row[] } as Record<string, Row[]>,
    /** table:op → error to return once. */
    fail: new Map<string, { code: string; message: string }>(),
    /** Runs once right before the next op on table:op — simulates a concurrent writer. */
    before: new Map<string, () => void>(),
    ops: [] as string[],
  };
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  function from(table: string) {
    let op = "select";
    let payload: Row | Row[] | null = null;
    const eq: [string, unknown][] = [];
    const gte: [string, unknown][] = [];
    let single = false;
    let returning = false;
    const run = () => {
      const key = `${table}:${op}`;
      state.ops.push(key);
      const hook = state.before.get(key);
      if (hook) {
        state.before.delete(key);
        hook();
      }
      const err = state.fail.get(key);
      if (err) {
        state.fail.delete(key);
        return { data: null, error: err };
      }
      const rows = state.tables[table];
      if (!rows) return { data: null, error: { code: "PGRST205", message: "missing" } };
      const hit = (r: Row) => eq.every(([k, v]) => r[k] === v) && gte.every(([k, v]) => String(r[k]) >= String(v));
      if (op === "insert") {
        for (const row of Array.isArray(payload) ? payload : [payload!]) {
          if (table === "storybooks" && rows.some((r) => r.book_id === row.book_id)) return { data: null, error: { code: "23505", message: "dup" } };
          if (table === "storybook_versions" && rows.some((r) => r.book_id === row.book_id && r.version === row.version)) return { data: null, error: { code: "23505", message: "dup" } };
          rows.push({ ...(table === "storybooks" ? { current_version: 0, status: "empty", context: {}, context_rev: 0 } : {}), created_at: "2026-11-18T10:00:00.000Z", ...clone(row) });
        }
        return { data: null, error: null };
      }
      if (op === "update") {
        const found = rows.filter(hit);
        for (const r of found) Object.assign(r, clone(payload));
        return { data: returning ? found.map((r) => ({ book_id: r.book_id })) : null, error: null };
      }
      if (op === "delete") {
        state.tables[table] = rows.filter((r) => !hit(r));
        return { data: null, error: null };
      }
      const found = rows.filter(hit).map(clone);
      return { data: single ? (found[0] ?? null) : found, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => ((returning = true), b),
      insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
      update: (p: Row) => ((op = "update"), (payload = p), (returning = false), b),
      delete: () => ((op = "delete"), b),
      eq: (k: string, v: unknown) => (eq.push([k, v]), b),
      gte: (k: string, v: unknown) => (gte.push([k, v]), b),
      limit: () => b,
      maybeSingle: () => ((single = true), b),
      then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return b;
  }
  return { state, from };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: db.from }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { countStoryRuns, getTodayStorySpendUsd, recordStoryCall, storyUsageAvailable, type StoryCallRecord } from "@/lib/db/story-ai-calls";
import { appendStorybookVersion, getCurrentStorybook, StorybooksQueryError } from "@/lib/db/storybooks";

const ai = (version: number) => ({ source: "ai" as const, rev: 1, aiVersion: version, editedAt: null });
function storybook(version: number, text = "The quiet lantern glows beside the open door."): Storybook {
  return {
    v: 1,
    bookId: BOOK,
    version,
    parentVersion: version > 1 ? version - 1 : null,
    origin: "ai",
    generator: { pipeline: "balanced-storybook-1", model: "claude-opus-5-5", prompts: { writer: "story-write-1" } },
    format: "A5_PORTRAIT",
    designStyle: "classic",
    lang: "en",
    title: { text: "A story in photographs", provenance: ai(version) },
    subtitle: null,
    coverPhotoId: PHOTO,
    contextRev: null,
    target: { photoShare: 0.65, narrativeShare: 0.35 },
    moments: [{ id: "m1", title: "Scenery", dateLabel: null, place: null, photoIds: [PHOTO], heroPhotoId: PHOTO, beat: "opening", summary: null }],
    chapters: [{ id: "c1", title: { text: "Scenery", provenance: ai(version) }, momentIds: ["m1"], narrativeShare: 0.5 }],
    pages: [{ id: "pg1", kind: "chapter_opener", chapterId: "c1", momentId: "m1", photoIds: [PHOTO], blocks: [{ id: "b1", kind: "caption", text, lang: "en", provenance: ai(version), groundedIn: [PHOTO], factRefs: ["f1"] }], narrativeShare: 0.5, layoutId: null, userLocked: false }],
    facts: [{ id: "f1", kind: "occasion", hash: "0123456789abcdef" }],
    createdAt: "2026-11-18T10:00:00.000Z",
  };
}

beforeEach(() => {
  db.state.tables = { storybooks: [], storybook_versions: [], story_ai_calls: [] };
  db.state.fail.clear();
  db.state.before.clear();
  db.state.ops.length = 0;
});

describe("appendStorybookVersion / getCurrentStorybook", () => {
  it("first version: creates the storybooks row, inserts the version, moves the pointer, status ready", async () => {
    expect(await getCurrentStorybook(BOOK, USER)).toBeNull();
    expect(await appendStorybookVersion(storybook(1), USER)).toBe("ok");
    expect(db.state.tables.storybooks).toMatchObject([{ book_id: BOOK, user_id: USER, current_version: 1, status: "ready" }]);
    expect(db.state.tables.storybook_versions).toMatchObject([{ book_id: BOOK, user_id: USER, version: 1, parent_version: null, origin: "ai", schema_version: 1, generator: { pipeline: "balanced-storybook-1" } }]);
    expect(await getCurrentStorybook(BOOK, USER)).toEqual(storybook(1));
  });

  it("keeps an existing memory-context row (context untouched) and appends current + 1", async () => {
    db.state.tables.storybooks!.push({ book_id: BOOK, user_id: USER, status: "empty", context: { v: 1 }, context_rev: 4, current_version: 0 });
    expect(await appendStorybookVersion(storybook(1), USER)).toBe("ok");
    expect(await appendStorybookVersion(storybook(2, "The amber doorway waits beside the tall window."), USER)).toBe("ok");
    expect(db.state.tables.storybooks![0]).toMatchObject({ context: { v: 1 }, context_rev: 4, current_version: 2, status: "ready" });
    expect((await getCurrentStorybook(BOOK, USER))!.version).toBe(2);
    expect(db.state.tables.storybook_versions).toHaveLength(2); // append-only: version 1 is still there
  });

  it("a stale version number is a conflict and writes nothing", async () => {
    await appendStorybookVersion(storybook(1), USER);
    await appendStorybookVersion(storybook(2), USER);
    db.state.ops.length = 0;
    expect(await appendStorybookVersion(storybook(2), USER)).toBe("conflict");
    expect(await appendStorybookVersion(storybook(4), USER)).toBe("conflict");
    expect(db.state.ops.filter((o) => o.endsWith(":insert") || o.endsWith(":update"))).toEqual([]);
    expect(db.state.tables.storybook_versions).toHaveLength(2);
  });

  it("two appends at once: the unique (book, version) lets one through, the other is a conflict with nothing half-written", async () => {
    await appendStorybookVersion(storybook(1), USER);
    // another writer inserts version 2 and moves the pointer between our read and our insert
    db.state.before.set("storybook_versions:insert", () => {
      db.state.tables.storybook_versions!.push({ book_id: BOOK, user_id: USER, version: 2, content: storybook(2, "Theirs.") });
      db.state.tables.storybooks![0]!.current_version = 2;
    });
    expect(await appendStorybookVersion(storybook(2, "Ours."), USER)).toBe("conflict");
    expect(db.state.tables.storybook_versions).toHaveLength(2);
    expect((await getCurrentStorybook(BOOK, USER))!.pages[0]!.blocks[0]!.text).toBe("Theirs.");
  });

  it("if the pointer does not move, the version row is taken back (never a version that is not current)", async () => {
    await appendStorybookVersion(storybook(1), USER);
    db.state.before.set("storybooks:update", () => void (db.state.tables.storybooks![0]!.current_version = 7));
    expect(await appendStorybookVersion(storybook(2), USER)).toBe("conflict");
    expect(db.state.tables.storybook_versions!.map((r) => r.version)).toEqual([1]);
    db.state.tables.storybooks![0]!.current_version = 1;
    db.state.fail.set("storybooks:update", { code: "57014", message: "timeout" });
    await expect(appendStorybookVersion(storybook(2), USER)).rejects.toMatchObject({ name: "StorybooksQueryError", code: "57014" });
    expect(db.state.tables.storybook_versions!.map((r) => r.version)).toEqual([1]);
  });

  it("refuses an invalid storybook before any write; errors carry a code, never content", async () => {
    const bad = { ...storybook(1), pages: [{ ...storybook(1).pages[0]!, photoIds: ["not-a-uuid"] }] } as Storybook;
    const err = await appendStorybookVersion(bad, USER).catch((e) => e);
    expect(err).toBeInstanceOf(StorybooksQueryError);
    expect(err.message).toBe("append storybook version failed (invalid_storybook)");
    expect(db.state.ops).toEqual([]);
    db.state.fail.set("storybook_versions:insert", { code: "23514", message: "content with The quiet lantern" });
    const dbErr = await appendStorybookVersion(storybook(1), USER).catch((e) => e);
    expect(dbErr.message).toBe("append storybook version failed (23514)");
  });

  it("reads are filtered by user: another user's id finds nothing; unparseable content and missing tables are null", async () => {
    await appendStorybookVersion(storybook(1), USER);
    expect(await getCurrentStorybook(BOOK, OTHER)).toBeNull();
    expect(await getCurrentStorybook("nope", USER)).toBeNull();
    db.state.tables.storybook_versions![0]!.content = { hello: "world" };
    expect(await getCurrentStorybook(BOOK, USER)).toBeNull();
    delete db.state.tables.storybook_versions;
    expect(await getCurrentStorybook(BOOK, USER)).toBeNull();
    delete db.state.tables.storybooks;
    expect(await getCurrentStorybook(BOOK, USER)).toBeNull();
  });
});

describe("story_ai_calls", () => {
  const rec = (over: Partial<StoryCallRecord> = {}): StoryCallRecord =>
    ({ userId: USER, bookId: BOOK, runId: "00000000-0000-4000-8000-000000000901", kind: "write", scope: "book", chapterId: "c1", storybookVersion: 1, model: "claude-opus-5-5", promptVersion: "story-write-1", mode: "live", usage: { input: 1800.4, output: 600, cacheRead: 1500, cacheWrite: 0 }, costUsd: 0.0195, latencyMs: 2345.6, status: "ok", ...over }) as StoryCallRecord;

  it("stores one row per call: tokens, cost, latency, codes — and no text column at all", async () => {
    await recordStoryCall(rec());
    await recordStoryCall(rec({ status: "error", error: "schema_invalid: 3 issue(s)", kind: "repair", costUsd: -1 } as Partial<StoryCallRecord>));
    const [ok, bad] = db.state.tables.story_ai_calls!;
    expect(ok).toEqual({ created_at: expect.any(String), user_id: USER, book_id: BOOK, run_id: "00000000-0000-4000-8000-000000000901", kind: "write", scope: "book", chapter_id: "c1", storybook_version: 1, model: "claude-opus-5-5", prompt_version: "story-write-1", mode: "live", status: "ok", error: null, input_tokens: 1800, output_tokens: 600, cache_read_tokens: 1500, cache_write_tokens: 0, cost_usd: 0.0195, latency_ms: 2346 });
    expect(bad).toMatchObject({ status: "error", kind: "repair", cost_usd: 0 });
    expect(bad!.error).toMatch(/^[a-z_]{3,40}$/);
  });

  it("counts LIVE runs with a usable answer per scope (distinct run ids) for the per-book limits", async () => {
    const run = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await recordStoryCall(rec({ runId: run(1), chapterId: "c1" }));
    await recordStoryCall(rec({ runId: run(1), chapterId: "c2" })); // same write
    await recordStoryCall(rec({ runId: run(2), chapterId: "c1" }));
    await recordStoryCall(rec({ runId: run(3), status: "error", error: "timeout" } as Partial<StoryCallRecord>)); // failed: not counted
    await recordStoryCall(rec({ runId: run(4), mode: "replay" })); // replay: not counted
    await recordStoryCall(rec({ runId: run(5), scope: "chapter" }));
    await recordStoryCall(rec({ runId: run(6), scope: "block", kind: "rewrite", chapterId: null }));
    await recordStoryCall(rec({ runId: run(7), scope: "block", kind: "rewrite", chapterId: null }));
    await recordStoryCall(rec({ runId: run(8), scope: "plan", kind: "plan", chapterId: null, storybookVersion: null }));
    await recordStoryCall(rec({ runId: run(9), userId: OTHER }));
    // Task 7 (2700): + composes (scope "compose").
    expect(await countStoryRuns(BOOK, USER)).toEqual({ plans: 1, writes: 2, chapterRegens: 1, rewrites: 2, composes: 0 });
  });

  it("today's live spend; a missing table means unavailable, zero counts and zero spend", async () => {
    await recordStoryCall(rec({ costUsd: 0.02 }));
    await recordStoryCall(rec({ costUsd: 0.03 }));
    await recordStoryCall(rec({ costUsd: 9, mode: "replay" }));
    expect(await getTodayStorySpendUsd(Date.parse("2026-11-18T12:00:00Z"))).toBeCloseTo(0.05, 6);
    expect(await storyUsageAvailable()).toBe(true);
    delete db.state.tables.story_ai_calls;
    expect(await storyUsageAvailable()).toBe(false);
    expect(await countStoryRuns(BOOK, USER)).toEqual({ plans: 0, writes: 0, chapterRegens: 0, rewrites: 0, composes: 0 });
    expect(await getTodayStorySpendUsd()).toBe(0);
    await expect(recordStoryCall(rec())).rejects.toMatchObject({ name: "StoryAiCallsError", code: "PGRST205" });
  });
});
