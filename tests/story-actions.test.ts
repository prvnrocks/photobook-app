import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryContextSchema } from "@/lib/storybook/schemas";
import type { MemoryContext } from "@/lib/storybook/types";
import { storyQuestionsFor } from "@/lib/story/questions";

vi.mock("server-only", () => ({}));

// Task 5: story step actions + src/lib/db/storybooks.ts against an in-memory `storybooks` table
// (fake admin client). Ownership (getMyBook), auth and the photo list are mocked.

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const BOOK_ID = "22222222-2222-4222-8222-222222222222";
const BOOK_2 = "44444444-4444-4444-8444-444444444444";

const db = vi.hoisted(() => {
  const state = {
    rows: [] as { book_id: string; user_id: string; status: string; context: unknown; context_rev: number; current_version: number }[],
    writes: [] as { op: "insert" | "update"; payload: Record<string, unknown>; filters: Record<string, unknown> }[],
    reads: [] as Record<string, unknown>[],
    /** Next errors per operation (shifted). */
    selectErrors: [] as { code: string; message: string }[],
    writeErrors: [] as { code: string; message: string }[],
    /** Runs once right after the next read — simulates a concurrent writer. */
    afterRead: null as (() => void) | null,
  };
  type Row = { book_id: string; user_id: string; status: string; context: unknown; context_rev: number; current_version: number };
  type DbError = { code: string; message: string };
  const matches = (row: Row, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

  function query(op: "select" | "update", payload?: Record<string, unknown>) {
    const filters: Record<string, unknown> = {};
    let single = false;
    const run = () => {
      if (op === "select") {
        state.reads.push({ ...filters });
        const err = state.selectErrors.shift();
        if (err) return { data: null, error: err };
        const found = state.rows.filter((r) => matches(r, filters)).map((r) => clone({ context: r.context, context_rev: r.context_rev }));
        const hook = state.afterRead;
        state.afterRead = null;
        hook?.();
        return { data: single ? (found[0] ?? null) : found, error: null };
      }
      state.writes.push({ op: "update", payload: clone(payload!), filters: { ...filters } });
      const err = state.writeErrors.shift();
      if (err) return { data: null, error: err };
      const hit = state.rows.filter((r) => matches(r, filters));
      for (const r of hit) Object.assign(r, clone(payload));
      return { data: hit.map((r) => ({ book_id: r.book_id })), error: null };
    };
    const b: Record<string, unknown> = {
      eq: (k: string, v: unknown) => ((filters[k] = v), b),
      select: () => b,
      maybeSingle: () => ((single = true), b),
      then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return b;
  }

  const admin = {
    from: (table: string) => {
      if (table !== "storybooks") throw new Error(`unexpected table ${table}`);
      return {
        select: () => query("select"),
        update: (payload: Record<string, unknown>) => query("update", payload),
        insert: async (payload: Record<string, unknown>) => {
          state.writes.push({ op: "insert", payload: clone(payload), filters: {} });
          const err = state.writeErrors.shift();
          if (err) return { data: null, error: err };
          if (state.rows.some((r) => r.book_id === payload.book_id)) return { data: null, error: { code: "23505", message: "duplicate key" } as DbError };
          state.rows.push({ status: "empty", current_version: 0, context: {}, context_rev: 0, ...clone(payload) } as Row);
          return { data: null, error: null };
        },
      };
    },
  };
  return { state, admin };
});

const mocks = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
  authTimeout: false,
  getMyBook: vi.fn(),
  listReadyPhotosForFinalize: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.admin }));
vi.mock("@/lib/auth/action-user", () => ({
  AUTH_UNAVAILABLE: "unavailable",
  getActionUser: async () => (mocks.authTimeout ? "unavailable" : mocks.user),
}));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook }));
vi.mock("@/lib/db/photos", () => ({ listReadyPhotosForFinalize: mocks.listReadyPhotosForFinalize }));

const { saveStoryAnswersAction, loadStoryAnswersAction, recommendDesignAction } = await import("@/app/books/story-actions");
const { getMemoryContext, saveMemoryContext, StorybooksQueryError } = await import("@/lib/db/storybooks");

const book = (over: Record<string, unknown> = {}) => ({
  id: BOOK_ID,
  occasion: "travel",
  tone: "fun",
  caption_lang: "en",
  title: "Oman",
  ...over,
});

const stored = (bookId = BOOK_ID) => db.state.rows.find((r) => r.book_id === bookId);
const storedContext = (bookId = BOOK_ID) => MemoryContextSchema.parse(stored(bookId)?.context);
const input = (over: Partial<Parameters<typeof saveStoryAnswersAction>[1]> = {}) => ({
  storyTone: "heartfelt" as const,
  answers: [
    { questionId: "memory.relationship", text: "My sister and the kids" },
    { questionId: "memory.moment", text: "Our first trip together" },
  ],
  skipped: false,
  ...over,
});
const baseContext = (over: Partial<MemoryContext> = {}): Omit<MemoryContext, "rev" | "updatedAt"> => ({
  v: 1,
  occasion: "travel",
  tone: "fun",
  lang: "en",
  storyTone: null,
  answers: [],
  skipped: false,
  note: null,
  people: [],
  places: [],
  facts: [],
  avoid: [],
  narrator: "first_plural",
  dateRange: null,
  ...over,
});

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.state.rows = [];
  db.state.writes = [];
  db.state.reads = [];
  db.state.selectErrors = [];
  db.state.writeErrors = [];
  db.state.afterRead = null;
  mocks.user = { id: OWNER };
  mocks.authTimeout = false;
  mocks.getMyBook.mockReset().mockImplementation(async (id: string) => (id === BOOK_ID ? book() : null));
  mocks.listReadyPhotosForFinalize.mockReset().mockResolvedValue([]);
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorLog.mockRestore();
});

describe("saveStoryAnswersAction", () => {
  it("stores the user's answers with the server's prompt, source user, and the book's occasion / tone / language", async () => {
    const res = await saveStoryAnswersAction(BOOK_ID, input());
    expect(res).toEqual({
      ok: true,
      context: {
        storyTone: "heartfelt",
        answers: [
          { questionId: "memory.relationship", text: "My sister and the kids" },
          { questionId: "memory.moment", text: "Our first trip together" },
        ],
        skipped: false,
        rev: 1,
      },
    });
    const ctx = storedContext();
    const [, q1, q2] = storyQuestionsFor("travel");
    expect(ctx.answers).toEqual([
      { questionId: q1.id, question: q1.prompt, text: "My sister and the kids", source: "user" },
      { questionId: q2.id, question: q2.prompt, text: "Our first trip together", source: "user" },
    ]);
    expect(ctx).toMatchObject({ v: 1, occasion: "travel", tone: "fun", lang: "en", storyTone: "heartfelt", skipped: false, rev: 1 });
    expect(ctx).toMatchObject({ note: null, people: [], places: [], facts: [], avoid: [], narrator: "first_plural", dateRange: null });
    expect(stored()).toMatchObject({ user_id: OWNER, context_rev: 1, status: "empty", current_version: 0 });
    expect(db.state.writes).toEqual([{ op: "insert", payload: expect.objectContaining({ book_id: BOOK_ID, user_id: OWNER, context_rev: 1 }), filters: {} }]);
    expect(Object.keys(db.state.writes[0].payload).sort()).toEqual(["book_id", "context", "context_rev", "user_id"]);
  });

  it("not the owner's book → not_found and nothing is read or written", async () => {
    mocks.getMyBook.mockResolvedValue(null);
    expect(await saveStoryAnswersAction(BOOK_ID, input())).toEqual({ ok: false, error: "not_found" });
    expect(await saveStoryAnswersAction("not-a-uuid", input())).toEqual({ ok: false, error: "not_found" });
    expect(db.state.writes).toEqual([]);
    expect(db.state.reads).toEqual([]);
    expect(db.state.rows).toEqual([]);
  });

  it("signed out → unauthenticated; auth timeout → unavailable; nothing written, the book is not even looked up", async () => {
    mocks.user = null;
    expect(await saveStoryAnswersAction(BOOK_ID, input())).toEqual({ ok: false, error: "unauthenticated" });
    mocks.authTimeout = true;
    expect(await saveStoryAnswersAction(BOOK_ID, input())).toEqual({ ok: false, error: "unavailable" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
    expect(db.state.writes).toEqual([]);
  });

  it("a question the book's occasion does not ask → invalid, nothing written", async () => {
    for (const questionId of ["wedding.moments", "travel.budget", "travel", "x.y"]) {
      expect(await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId, text: "Hello" }] }))).toEqual({ ok: false, error: "invalid" });
    }
    // also when the answer is blank or the step is skipped: an unknown id is never accepted
    expect(await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "wedding.moments", text: "" }] }))).toEqual({ ok: false, error: "invalid" });
    expect(await saveStoryAnswersAction(BOOK_ID, input({ skipped: true, answers: [{ questionId: "wedding.moments", text: "x" }] }))).toEqual({ ok: false, error: "invalid" });
    // the same question twice
    const twice = [
      { questionId: "memory.relationship", text: "A" },
      { questionId: "memory.relationship", text: "B" },
    ];
    expect(await saveStoryAnswersAction(BOOK_ID, input({ answers: twice }))).toEqual({ ok: false, error: "invalid" });
    expect(db.state.writes).toEqual([]);
  });

  it("v3: the same three questions for every occasion (birthday; unknown / missing occasion → Other)", async () => {
    mocks.getMyBook.mockResolvedValue(book({ occasion: "birthday", tone: null, caption_lang: "ar" }));
    const res = await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "memory.relationship", text: "عيد ميلاد أمي" }] }));
    expect(res.ok).toBe(true);
    expect(storedContext()).toMatchObject({ occasion: "birthday", tone: "fun", lang: "ar" });
    expect(storedContext().answers).toEqual([
      { questionId: "memory.relationship", question: storyQuestionsFor("birthday")[1].prompt, text: "عيد ميلاد أمي", source: "user" },
    ]);
    // a Task 5 question id is no longer asked
    expect(await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "birthday.person", text: "x" }] }))).toEqual({ ok: false, error: "invalid" });

    mocks.getMyBook.mockResolvedValue(book({ occasion: "picnic", tone: "loud", caption_lang: "fr" }));
    expect((await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "memory.occasion", text: "A picnic" }] }))).ok).toBe(true);
    expect(storedContext()).toMatchObject({ occasion: "other", tone: "minimal", lang: "en" });
    mocks.getMyBook.mockResolvedValue(book({ occasion: null }));
    expect((await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "memory.moment", text: "The people" }] }))).ok).toBe(true);
  });

  it("answers are trimmed; blank answers are dropped, never stored as empty entries", async () => {
    const res = await saveStoryAnswersAction(
      BOOK_ID,
      input({
        answers: [
          { questionId: "memory.relationship", text: "   \n\t " },
          { questionId: "memory.moment", text: "  The views \n" },
        ],
      }),
    );
    expect(res).toMatchObject({ ok: true, context: { answers: [{ questionId: "memory.moment", text: "The views" }], skipped: false } });
    expect(storedContext().answers).toEqual([
      { questionId: "memory.moment", question: storyQuestionsFor("travel")[2].prompt, text: "The views", source: "user" },
    ]);

    // everything blank, not skipped: stored as "reached, nothing said"
    const none = await saveStoryAnswersAction(BOOK_ID, input({ storyTone: null, answers: [{ questionId: "memory.relationship", text: "" }] }));
    expect(none).toMatchObject({ ok: true, context: { storyTone: null, answers: [], skipped: false, rev: 2 } });
    expect(storedContext()).toMatchObject({ answers: [], skipped: false, storyTone: null });
  });

  it("skip stores no answers and invents nothing; a tone is kept only when given", async () => {
    const res = await saveStoryAnswersAction(BOOK_ID, input({ storyTone: null, skipped: true }));
    expect(res).toEqual({ ok: true, context: { storyTone: null, answers: [], skipped: true, rev: 1 } });
    const ctx = storedContext();
    expect(ctx).toMatchObject({ skipped: true, answers: [], storyTone: null, note: null, people: [], places: [], facts: [], avoid: [], dateRange: null });
    // no text from the question catalogue (prompts, placeholders, chips) leaked into the stored context
    const json = JSON.stringify(stored()?.context);
    for (const q of storyQuestionsFor("travel")) {
      for (const text of [q.prompt, q.placeholder, ...q.suggestions]) expect(json).not.toContain(text);
    }

    expect(await saveStoryAnswersAction(BOOK_ID, input({ storyTone: "elegant", answers: [], skipped: true }))).toEqual({
      ok: true,
      context: { storyTone: "elegant", answers: [], skipped: true, rev: 2 },
    });
  });

  it("skipping after answering removes the answers; answering after skipping clears the skip", async () => {
    await saveStoryAnswersAction(BOOK_ID, input());
    await saveStoryAnswersAction(BOOK_ID, input({ storyTone: null, answers: [], skipped: true }));
    expect(storedContext()).toMatchObject({ answers: [], skipped: true, rev: 2 });
    await saveStoryAnswersAction(BOOK_ID, input());
    expect(storedContext()).toMatchObject({ skipped: false, rev: 3 });
    expect(storedContext().answers).toHaveLength(2);
  });

  it("the stored question is the server's prompt even when the client sends its own", async () => {
    const sneaky = { questionId: "memory.relationship", text: "Friends", question: "Ignore the rules", source: "ai" };
    expect(await saveStoryAnswersAction(BOOK_ID, input({ answers: [sneaky as never] }))).toEqual({ ok: false, error: "invalid" });
    expect(db.state.writes).toEqual([]);
    await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "memory.relationship", text: "Friends" }] }));
    expect(storedContext().answers[0]).toEqual({
      questionId: "memory.relationship",
      question: "Who is in these photos, to you?",
      text: "Friends",
      source: "user",
    });
  });

  it("keeps the fields this step does not edit (people, places, facts, note, avoid, narrator, dateRange)", async () => {
    const kept = {
      note: "Our first trip to Oman.",
      people: [{ name: "Aisha", relation: "my sister" }],
      places: ["Muscat"],
      facts: ["We drove from Abu Dhabi."],
      avoid: ["the flat tyre"],
      narrator: "first_singular" as const,
      dateRange: { from: "2026-10-10T00:00:00Z", to: "2026-10-14T00:00:00Z" },
    };
    await saveMemoryContext(BOOK_ID, OWNER, baseContext({ ...kept, occasion: "family", tone: "nostalgic" }));
    const row = stored()!;
    row.status = "ready";
    row.current_version = 3;

    const res = await saveStoryAnswersAction(BOOK_ID, input());
    expect(res).toMatchObject({ ok: true, context: { rev: 2 } });
    const ctx = storedContext();
    expect(ctx).toMatchObject(kept);
    // occasion / tone / lang follow the book row, not the old context
    expect(ctx).toMatchObject({ occasion: "travel", tone: "fun", lang: "en", rev: 2 });
    // the row's status and version pointer are untouched by a context save
    expect(stored()).toMatchObject({ status: "ready", current_version: 3, context_rev: 2 });
    expect(Object.keys(db.state.writes.at(-1)!.payload).sort()).toEqual(["context", "context_rev"]);
    expect(db.state.writes.at(-1)!.filters).toEqual({ book_id: BOOK_ID, user_id: OWNER, context_rev: 1 });
  });

  it("rev and context_rev go up by one per save", async () => {
    for (const rev of [1, 2, 3]) {
      const res = await saveStoryAnswersAction(BOOK_ID, input({ storyTone: rev % 2 ? "joyful" : "elegant" }));
      expect(res).toMatchObject({ ok: true, context: { rev } });
      expect(stored()?.context_rev).toBe(rev);
      expect(storedContext().rev).toBe(rev);
    }
    expect(db.state.rows).toHaveLength(1);
  });

  it("rejects over-long and malformed input without writing", async () => {
    const one = (text: string) => input({ answers: [{ questionId: "memory.relationship", text }] });
    expect(await saveStoryAnswersAction(BOOK_ID, one("x".repeat(201)))).toEqual({ ok: false, error: "invalid" });
    expect(await saveStoryAnswersAction(BOOK_ID, one("🎂".repeat(201)))).toEqual({ ok: false, error: "invalid" });
    expect(await saveStoryAnswersAction(BOOK_ID, one("x".repeat(5000)))).toEqual({ ok: false, error: "invalid" });
    expect(await saveStoryAnswersAction(BOOK_ID, one("half \ud83d"))).toEqual({ ok: false, error: "invalid" });
    const four = [...input().answers, { questionId: "memory.occasion", text: "x" }, { questionId: "memory.relationship", text: "y" }];
    expect(await saveStoryAnswersAction(BOOK_ID, input({ answers: four }))).toEqual({ ok: false, error: "invalid" });
    for (const bad of [
      null,
      undefined,
      "text",
      {},
      { ...input(), storyTone: "romantic" },
      { ...input(), skipped: "yes" },
      { ...input(), answers: "x" },
      { ...input(), answers: [{ questionId: 5, text: "x" }] },
      { ...input(), answers: [{ questionId: "memory.relationship", text: 5 }] },
      { ...input(), people: [{ name: "Injected", relation: null }] },
      { ...input(), rev: 99 },
    ]) {
      expect(await saveStoryAnswersAction(BOOK_ID, bad as never)).toEqual({ ok: false, error: "invalid" });
    }
    expect(db.state.writes).toEqual([]);
    expect(mocks.getMyBook).toHaveBeenCalledTimes(3); // only the three trimmed-length / surrogate cases reach the lookup

    // exactly 200 code points (400 UTF-16 units of emoji) is fine, surrounding whitespace not counted
    expect((await saveStoryAnswersAction(BOOK_ID, one(`  ${"🎂".repeat(200)}  `))).ok).toBe(true);
    expect(storedContext().answers[0].text).toBe("🎂".repeat(200));
  });

  it("a database failure → unavailable, and no user text reaches the log", async () => {
    db.state.writeErrors.push({ code: "42P01", message: "relation storybooks does not exist: SECRET-ANSWER" });
    const res = await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "memory.relationship", text: "SECRET-ANSWER" }] }));
    expect(res).toEqual({ ok: false, error: "unavailable" });
    mocks.getMyBook.mockRejectedValue(new Error("boom SECRET-ANSWER"));
    expect(await saveStoryAnswersAction(BOOK_ID, input())).toEqual({ ok: false, error: "unavailable" });
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(logged).not.toContain("SECRET-ANSWER");
    expect(logged).not.toContain(BOOK_ID);
    expect(logged).not.toContain(OWNER);
    expect(logged).toContain("StorybooksQueryError:42P01");
  });
});

describe("loadStoryAnswersAction", () => {
  it("nothing stored → empty defaults with rev 0", async () => {
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual({ ok: true, context: { storyTone: null, answers: [], skipped: false, rev: 0 } });
    expect(db.state.writes).toEqual([]);
  });

  it("returns what was saved (answers, tone, skip)", async () => {
    const saved = await saveStoryAnswersAction(BOOK_ID, input({ storyTone: "joyful" }));
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual(saved);
    const skipped = await saveStoryAnswersAction(BOOK_ID, input({ storyTone: null, answers: [], skipped: true }));
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual(skipped);
    expect(skipped).toMatchObject({ context: { skipped: true, answers: [], rev: 2 } });
  });

  it("v3: answers stay after the occasion changed (the questions no longer depend on it)", async () => {
    await saveStoryAnswersAction(BOOK_ID, input());
    mocks.getMyBook.mockResolvedValue(book({ occasion: "wedding" }));
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual({ ok: true, context: { storyTone: "heartfelt", answers: input().answers, skipped: false, rev: 1 } });
  });

  it("v3: Task 5 answers (legacy question ids) still load, under the matching new question, unchanged", async () => {
    const legacy = MemoryContextSchema.parse({
      ...baseContext({
        answers: [
          { questionId: "travel.companions", question: "Who did you travel with?", text: "My brother", source: "user" },
          { questionId: "travel.special", question: "What made this trip special?", text: "We met again after a long time.", source: "user" },
        ],
        storyTone: "joyful",
      }),
      rev: 1,
      updatedAt: "2026-11-19T10:00:00Z",
    });
    db.state.rows.push({ book_id: BOOK_ID, user_id: OWNER, status: "ready", context: legacy, context_rev: 1, current_version: 1 });
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual({
      ok: true,
      context: { storyTone: "joyful", answers: [{ questionId: "memory.relationship", text: "My brother" }, { questionId: "memory.moment", text: "We met again after a long time." }], skipped: false, rev: 1 },
    });
  });

  it("v3: an occasion answer equal to the step-2 occasion (the field's prefill) is not stored; a changed one is", async () => {
    await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "memory.occasion", text: " travel " }] }));
    expect(storedContext().answers).toEqual([]);
    await saveStoryAnswersAction(BOOK_ID, input({ answers: [{ questionId: "memory.occasion", text: "Seeing my brother again" }] }));
    expect(storedContext().answers).toEqual([{ questionId: "memory.occasion", question: "What was the occasion?", text: "Seeing my brother again", source: "user" }]);
  });

  it("same guards as saving", async () => {
    expect(await loadStoryAnswersAction("nope")).toEqual({ ok: false, error: "not_found" });
    mocks.getMyBook.mockResolvedValue(null);
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual({ ok: false, error: "not_found" });
    expect(db.state.reads).toEqual([]);
    mocks.user = null;
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual({ ok: false, error: "unauthenticated" });
    mocks.authTimeout = true;
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual({ ok: false, error: "unavailable" });
  });

  it("table missing or an unreadable stored context → empty defaults; another database error → unavailable", async () => {
    db.state.selectErrors.push({ code: "PGRST205", message: "not in schema cache" });
    expect(await loadStoryAnswersAction(BOOK_ID)).toMatchObject({ ok: true, context: { rev: 0 } });
    db.state.rows.push({ book_id: BOOK_ID, user_id: OWNER, status: "empty", context: { note: "old shape" }, context_rev: 4, current_version: 0 });
    expect(await loadStoryAnswersAction(BOOK_ID)).toMatchObject({ ok: true, context: { rev: 0, answers: [] } });
    db.state.selectErrors.push({ code: "57014", message: "timeout" });
    expect(await loadStoryAnswersAction(BOOK_ID)).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("recommendDesignAction", () => {
  const sized = (n: number, width: number | null, height: number | null) => Array.from({ length: n }, () => ({ width, height }));

  it("recommends from the book's ready photos and occasion; writes nothing", async () => {
    mocks.listReadyPhotosForFinalize.mockResolvedValue([...sized(7, 1600, 1200), ...sized(3, 1200, 1600), ...sized(2, null, null)]);
    expect(await recommendDesignAction(BOOK_ID)).toEqual({
      ok: true,
      recommendation: { format: "A5_LANDSCAPE", formatReason: "mostly_landscape", designStyle: "magazine", styleReason: "occasion_default" },
    });
    expect(mocks.listReadyPhotosForFinalize).toHaveBeenCalledWith(BOOK_ID);
    expect(db.state.writes).toEqual([]);
    expect(db.state.reads).toEqual([]);
  });

  it("no photos → default shape; unknown occasion → default style", async () => {
    mocks.getMyBook.mockResolvedValue(book({ occasion: "picnic" }));
    expect(await recommendDesignAction(BOOK_ID)).toEqual({
      ok: true,
      recommendation: { format: "A5_PORTRAIT", formatReason: "no_photos", designStyle: "modern", styleReason: "occasion_default" },
    });
    mocks.getMyBook.mockResolvedValue(book({ occasion: "birthday" }));
    expect(await recommendDesignAction(BOOK_ID)).toMatchObject({ recommendation: { designStyle: "scrapbook" } });
  });

  it("owner-checked: other people's books, signed-out users and failures get no photo read", async () => {
    mocks.getMyBook.mockResolvedValue(null);
    expect(await recommendDesignAction(BOOK_ID)).toEqual({ ok: false, error: "not_found" });
    expect(await recommendDesignAction("nope")).toEqual({ ok: false, error: "not_found" });
    mocks.user = null;
    expect(await recommendDesignAction(BOOK_ID)).toEqual({ ok: false, error: "unauthenticated" });
    mocks.authTimeout = true;
    expect(await recommendDesignAction(BOOK_ID)).toEqual({ ok: false, error: "unavailable" });
    expect(mocks.listReadyPhotosForFinalize).not.toHaveBeenCalled();

    mocks.authTimeout = false;
    mocks.user = { id: OWNER };
    mocks.getMyBook.mockResolvedValue(book());
    mocks.listReadyPhotosForFinalize.mockRejectedValue(new Error("db down"));
    expect(await recommendDesignAction(BOOK_ID)).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("db/storybooks", () => {
  it("getMemoryContext: null for no row, {} context, unparsable context, missing table, bad ids", async () => {
    expect(await getMemoryContext(BOOK_ID, OWNER)).toBeNull();
    db.state.rows.push({ book_id: BOOK_ID, user_id: OWNER, status: "empty", context: {}, context_rev: 0, current_version: 0 });
    expect(await getMemoryContext(BOOK_ID, OWNER)).toBeNull();
    db.state.rows[0].context = { v: 1, answers: "nope" };
    expect(await getMemoryContext(BOOK_ID, OWNER)).toBeNull();
    for (const code of ["42P01", "PGRST205"]) {
      db.state.selectErrors.push({ code, message: "missing" });
      expect(await getMemoryContext(BOOK_ID, OWNER)).toBeNull();
    }
    const reads = db.state.reads.length;
    expect(await getMemoryContext("nope", OWNER)).toBeNull();
    expect(await getMemoryContext(BOOK_ID, "nope")).toBeNull();
    expect(db.state.reads.length).toBe(reads);
    db.state.selectErrors.push({ code: "57014", message: "timeout" });
    await expect(getMemoryContext(BOOK_ID, OWNER)).rejects.toBeInstanceOf(StorybooksQueryError);
  });

  it("every query is filtered by book and owner: another user's row is neither read nor changed", async () => {
    await saveMemoryContext(BOOK_ID, OWNER, baseContext({ facts: ["Owner fact."] }));
    expect(await getMemoryContext(BOOK_ID, OTHER)).toBeNull();
    expect(await getMemoryContext(BOOK_2, OWNER)).toBeNull();
    for (const read of db.state.reads) expect(Object.keys(read).sort()).toEqual(["book_id", "user_id"]);
    // a save under the wrong user finds no row, its insert hits the primary key, and it gives up
    await expect(saveMemoryContext(BOOK_ID, OTHER, baseContext({ facts: ["Intruder."] }))).rejects.toMatchObject({ code: "conflict" });
    expect(storedContext().facts).toEqual(["Owner fact."]);
    expect(stored()).toMatchObject({ user_id: OWNER, context_rev: 1 });
  });

  it("saveMemoryContext validates before writing and sets rev / updatedAt itself", async () => {
    const before = Date.now();
    const saved = await saveMemoryContext(BOOK_ID, OWNER, { ...baseContext(), rev: 77, updatedAt: "2000-01-01T00:00:00Z" } as never);
    expect(saved.rev).toBe(1);
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(storedContext()).toEqual(saved);

    const writes = db.state.writes.length;
    const aiAnswer = { questionId: "memory.relationship", question: "Who did you travel with?", text: "A family of four", source: "ai" };
    await expect(saveMemoryContext(BOOK_ID, OWNER, baseContext({ answers: [aiAnswer as never] }))).rejects.toMatchObject({ code: "invalid_context" });
    await expect(saveMemoryContext(BOOK_ID, OWNER, { ...baseContext(), observations: [] } as never)).rejects.toMatchObject({ code: "invalid_context" });
    await expect(saveMemoryContext(BOOK_ID, OWNER, baseContext({ facts: ["bad \ud83d"] }))).rejects.toMatchObject({ code: "invalid_context" });
    await expect(saveMemoryContext("nope", OWNER, baseContext())).rejects.toMatchObject({ code: "bad_id" });
    expect(db.state.writes.length).toBe(writes);
    expect(storedContext()).toEqual(saved);
  });

  it("continues from context_rev when the stored context is {} or unreadable", async () => {
    db.state.rows.push({ book_id: BOOK_ID, user_id: OWNER, status: "drafting", context: {}, context_rev: 6, current_version: 2 });
    const saved = await saveMemoryContext(BOOK_ID, OWNER, baseContext());
    expect(saved.rev).toBe(7);
    expect(stored()).toMatchObject({ context_rev: 7, status: "drafting", current_version: 2 });
  });

  it("two saves at once: the loser retries on top of the winner's revision", async () => {
    await saveMemoryContext(BOOK_ID, OWNER, baseContext());
    db.state.afterRead = () => {
      const row = stored()!;
      row.context_rev = 2;
      row.context = { ...(row.context as object), rev: 2, facts: ["Written by the other save."] };
    };
    const saved = await saveMemoryContext(BOOK_ID, OWNER, baseContext({ storyTone: "joyful" }));
    expect(saved.rev).toBe(3);
    expect(stored()?.context_rev).toBe(3);
    expect(db.state.writes.filter((w) => w.op === "update").map((w) => w.filters.context_rev)).toEqual([1, 2]);

    // first save of a book racing another first save: the insert conflicts, the retry updates
    db.state.rows = [];
    db.state.afterRead = () => {
      db.state.rows.push({ book_id: BOOK_ID, user_id: OWNER, status: "empty", context: {}, context_rev: 0, current_version: 0 });
    };
    expect((await saveMemoryContext(BOOK_ID, OWNER, baseContext())).rev).toBe(1);
    expect(db.state.rows).toHaveLength(1);
  });

  it("database errors surface as StorybooksQueryError with the code only", async () => {
    db.state.writeErrors.push({ code: "23514", message: "check storybooks_context_size violated" });
    await expect(saveMemoryContext(BOOK_ID, OWNER, baseContext())).rejects.toMatchObject({ name: "StorybooksQueryError", code: "23514", message: "save memory context failed (23514)" });
    db.state.selectErrors.push({ code: "42P01", message: "missing" });
    await expect(saveMemoryContext(BOOK_ID, OWNER, baseContext())).rejects.toMatchObject({ code: "42P01" });
  });
});
