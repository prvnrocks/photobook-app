// Task 8: the storybook generation job (src/lib/ai/story/run.ts) against an in-memory agent_runs
// table with the same lease / one-active-run rules as migrations 0700 / 0900 / 2800, the REAL
// Task 6 plan + writeStoryStep (scripted transport, tests/ai/story-fixtures.ts) and mocked photo
// analysis / organiser / composer. No DB, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn(async () => null), saveDocIfRev: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/db/photo-analyses", () => ({ getTodayPhotoAnalysisSpendUsd: vi.fn(async () => 0), dubaiDayStart: () => "", loadOwnPhoto: vi.fn(), getCachedAnalysis: vi.fn(), recordAnalysisCall: vi.fn(), countAnalysedPhotos: vi.fn() }));
vi.mock("@/lib/db/photo-organize", () => ({ listPhotosForOrganize: vi.fn(), listVision: vi.fn(), listMoments: vi.fn(), listDuplicateGroups: vi.fn(), listQuality: vi.fn() }));
vi.mock("@/lib/db/story-ai-calls", () => ({ countStoryRuns: vi.fn(), getTodayStorySpendUsd: vi.fn(async () => 0), recordStoryCall: vi.fn(), storyUsageAvailable: vi.fn(async () => false) }));
vi.mock("@/lib/db/storybooks", () => ({ appendStorybookVersion: vi.fn(), getCurrentStorybook: vi.fn(), getMemoryContext: vi.fn() }));
vi.mock("@/lib/ai/budget", () => ({ checkDailyAiBudget: vi.fn(async () => ({ allowed: true, reason: "no_budget" })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import type { AnalyzePhotosResult } from "@/lib/ai/photo-intelligence/analyze";
import { ComposeError } from "@/lib/ai/story/compose";
import type { StoryPlan } from "@/lib/ai/story/plan";
import { advanceStoryRun, cancelStoryRun, MAX_GROUP_ATTEMPTS, parseStoryCursor, startStoryRun, type StoryRunDeps } from "@/lib/ai/story/run";
import { planStory, writeStoryStep } from "@/lib/ai/story/service";
import { TransportError } from "@/lib/ai/transport";
import type { RunCheckpointPatch, RunForTick } from "@/lib/db/agent-runs";
import { outcomeCopy, stageRows, storyErrorCopy, type StoryRunView } from "@/lib/storybook/run/progress";
import type { Json } from "@/lib/supabase/database.types";
import { SupabaseUnavailableError } from "@/lib/supabase/deadline";
import { resolveEntitlement, type BookEntitlement } from "@/lib/entitlements/resolve";
import { BOOK, USER, world } from "./ai/story-fixtures";

// ---------------------------------------------------------------------------- in-memory agent_runs

type Row = RunForTick & { lease_token: string | null; lease_until: number | null };

function runsTable() {
  const rows = new Map<string, Row>();
  let seq = 0;
  let clock = 1_000_000;
  const active = (r: Row) => r.state !== "done" && r.state !== "failed";
  return {
    rows,
    tickClock: (ms: number) => (clock += ms),
    create: vi.fn(async (input: { bookId: string; userId: string; trigger: string; mode: string; dailyCap: number; enforce: boolean }) => {
      if (input.enforce) {
        const used = [...rows.values()].filter((r) => r.user_id === input.userId && r.mode === "live" && (active(r) || r.ai_status === "ok" || r.ai_status === "partial")).length;
        if (used >= input.dailyCap) return { error: "limit" as const, limit: "daily_builds" as const };
      }
      if ([...rows.values()].some((r) => r.book_id === input.bookId && active(r))) return { error: "already_running" as const };
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      rows.set(id, {
        id,
        book_id: input.bookId,
        user_id: input.userId,
        state: input.trigger === "storybook" ? "discovering" : "queued",
        ai_status: null,
        progress: {},
        cursor: {},
        mode: input.mode,
        trigger: input.trigger,
        attempts: 0,
        error_code: null,
        started_at: new Date(clock + seq).toISOString(),
        finished_at: null,
        lease_token: null,
        lease_until: null,
      });
      return { id };
    }),
    claim: vi.fn(async (id: string, secs: number) => {
      const r = rows.get(id);
      if (!r || !active(r) || (r.lease_until !== null && r.lease_until > clock)) return null;
      r.lease_token = `tok-${++seq}`;
      r.lease_until = clock + secs * 1000;
      r.attempts++;
      return r.lease_token;
    }),
    release: vi.fn(async (id: string, token: string) => {
      const r = rows.get(id);
      if (r && r.lease_token === token) {
        r.lease_token = null;
        r.lease_until = null;
      }
    }),
    checkpoint: vi.fn(async (id: string, token: string, patch: RunCheckpointPatch) => {
      const r = rows.get(id);
      if (!r || r.lease_token !== token) return false;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as Record<string, unknown>)[k] = structuredClone(v);
      return true;
    }),
    get: vi.fn(async (id: string) => {
      const r = rows.get(id);
      return r ? structuredClone(r) : null;
    }),
    previous: vi.fn(async (bookId: string, except: string) => {
      const list = [...rows.values()].filter((r) => r.book_id === bookId && r.id !== except && !active(r)).sort((a, b) => b.started_at.localeCompare(a.started_at));
      const r = list[0];
      return r ? { id: r.id, state: r.state, cursor: structuredClone(r.cursor), error_code: r.error_code, started_at: r.started_at } : null;
    }),
    cancel: vi.fn(async (id: string, progress: Json) => {
      const r = rows.get(id);
      if (!r || !active(r)) return false;
      Object.assign(r, { state: "failed", error_code: "cancelled", lease_token: null, lease_until: null, progress, finished_at: new Date(clock).toISOString() });
      return true;
    }),
  };
}

// ---------------------------------------------------------------------------- the world of one book

function entitlement(tier: "preview" | "full"): BookEntitlement {
  return resolveEntitlement({ bookId: BOOK, isPaid: tier === "full", maxPages: tier === "full" ? 100 : 20, orderStatus: tier === "full" ? "paid" : null, hasActiveGrant: false }, { pages: 5, maxRuns: 3 });
}

type Over = { tier?: "preview" | "full"; mode?: "live" | "replay" | "off"; overBudget?: boolean; script?: NonNullable<Parameters<typeof world>[0]>["script"]; analyze?: (ids: readonly string[]) => AnalyzePhotosResult[]; compose?: StoryRunDeps["composeStorybookPages"]; dailyCap?: number; photos?: number };

async function setup(over: Over = {}) {
  const w = world({ script: over.script });
  const table = runsTable();
  const rows = over.photos === 0 ? [] : w.rows;
  const vision = new Set<string>();
  let rulePlan: StoryPlan | null = null;
  const doc = { written: 0, docs: 0 };
  const deps: StoryRunDeps = {
    getBook: async (id) => (id === BOOK ? { id: BOOK, user_id: USER, is_paid: false, doc: {}, format: "A5_PORTRAIT", design_style: "classic" } : null),
    listPhotos: async () => rows,
    listVision: async () => new Map([...vision].map((id) => [id, {}])),
    getCurrentStorybook: async () => w.versions[w.versions.length - 1] ?? null,
    createRunCapped: (i) => table.create({ ...i, dailyCap: over.dailyCap ?? i.dailyCap }),
    claimRun: table.claim,
    releaseRun: table.release,
    checkpointRun: table.checkpoint,
    getRunForTick: table.get,
    getPreviousStoryRun: table.previous,
    cancelStoryRunRow: table.cancel,
    analyzePhotos: vi.fn(async (ids: readonly string[]) => {
      const out = over.analyze ? over.analyze(ids) : ids.map((photoId) => ({ photoId, ok: true as const, analysis: {} as never }));
      for (const r of out) if (r.ok) vision.add(r.photoId);
      return out;
    }),
    clusterPhotosIntoMoments: vi.fn(async () => ({ moments: [1, 2, 3, 4, 5, 6], pending: { quality: 0 } })),
    planStory: vi.fn(async (_bookId: string, opts: { rule: boolean; maxPages?: number }) => {
      // the AI plan comes from the scripted transport; the rule plan from mode "off"
      const plan = await planStory(BOOK, { ...w.deps, ...(opts.maxPages ? { planMaxPages: opts.maxPages } : {}), ...(opts.rule || over.mode === "off" ? { mode: "off" as const } : {}) });
      if (opts.rule) rulePlan = plan;
      return plan;
    }),
    writeStoryStep: vi.fn((bookId, plan, opts) => writeStoryStep(bookId, plan, opts, { ...w.deps, ...(over.mode === "off" ? { mode: "off" as const } : {}) })),
    composeStorybookPages:
      over.compose ??
      vi.fn(async (_bookId: string, opts: { rule: boolean; beforeSave: () => Promise<boolean>; maxPages?: number }) => {
        const saved = await opts.beforeSave();
        if (saved) doc.written++;
        return { pages: opts.maxPages ?? 18, warnings: 0, ai: opts.rule ? ("off" as const) : ("used" as const), saved };
      }),
    // Task 9: Task 8's scenarios run as entitled (full) books; the preview suite sets tier "preview"
    getEntitlement: vi.fn(async () => entitlement(over.tier ?? "full")),
    countPreviewRuns: vi.fn(async () => [...table.rows.values()].filter((r) => r.mode === "live" && r.state === "done" && (r.cursor as { tier?: string }).tier === "preview").length),
    resolveMode: () => over.mode ?? "live",
    isOverDailyAiBudget: async () => over.overBudget === true,
    analysisBatch: () => 8,
    now: () => 0,
  };
  return { w, table, deps, doc, vision, rulePlan: () => rulePlan };
}

async function start(deps: StoryRunDeps) {
  const r = await startStoryRun({ bookId: BOOK, userId: USER }, deps);
  if (!r.ok) throw new Error(r.error);
  return r.runId;
}

/** Ticks until done (each tick does ONE unit of work: budget 0). Returns every view seen. */
async function drive(deps: StoryRunDeps, runId: string, max = 80): Promise<StoryRunView[]> {
  const views: StoryRunView[] = [];
  for (let i = 0; i < max; i++) {
    const r = await advanceStoryRun(runId, { budgetMs: 0 }, deps);
    if ("view" in r) {
      views.push(r.view);
      if (r.view.done) return views;
    } else if ("notFound" in r) throw new Error("not found");
  }
  throw new Error("did not finish");
}

let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------- tests

describe("storybook job: start", () => {
  it("creates ONE storybook run in 'discovering'; a second start (double click / second tab) is already_running", async () => {
    const { deps, table } = await setup();
    const [a, b] = await Promise.all([startStoryRun({ bookId: BOOK, userId: USER }, deps), startStoryRun({ bookId: BOOK, userId: USER }, deps)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toEqual({ ok: false, error: "already_running" });
    expect(table.rows.size).toBe(1);
    const row = [...table.rows.values()][0]!;
    expect(row).toMatchObject({ trigger: "storybook", state: "discovering", mode: "live" });
  });

  it("refuses a book that isn't the user's, has no photos, or holds an edited album — no run row", async () => {
    const other = await setup();
    expect(await startStoryRun({ bookId: BOOK, userId: "someone-else" }, other.deps)).toEqual({ ok: false, error: "not_found" });
    const empty = await setup({ photos: 0 });
    expect(await startStoryRun({ bookId: BOOK, userId: USER }, empty.deps)).toEqual({ ok: false, error: "no_photos" });
    const edited = await setup();
    edited.deps.getBook = async () => ({ id: BOOK, user_id: USER, is_paid: false, doc: { v: 1, meta: { userEdited: true }, pages: [{}] }, format: "A5_PORTRAIT", design_style: "classic" });
    expect(await startStoryRun({ bookId: BOOK, userId: USER }, edited.deps)).toEqual({ ok: false, error: "user_edited" });
    expect(other.table.rows.size + empty.table.rows.size + edited.table.rows.size).toBe(0);
  });

  it("AI off → a rule run; over the daily budget / out of AI builds today → still a run, without AI, and the reason is kept", async () => {
    const off = await setup({ mode: "off" });
    expect((await startStoryRun({ bookId: BOOK, userId: USER }, off.deps)) as { mode: string }).toMatchObject({ ok: true, mode: "rule" });
    const broke = await setup({ overBudget: true });
    const id = await start(broke.deps);
    expect(broke.table.rows.get(id)!.mode).toBe("rule");
    expect(parseStoryCursor(broke.table.rows.get(id)!.cursor)!.notes).toEqual(["budget_exhausted"]);
    const capped = await setup({ dailyCap: 0 });
    const id2 = await start(capped.deps);
    expect(capped.table.rows.get(id2)!.mode).toBe("rule");
    expect(parseStoryCursor(capped.table.rows.get(id2)!.cursor)!.notes).toEqual(["limit_reached"]);
  });
});

describe("storybook job: ticks", () => {
  it("runs the four stages in order, persists every stage in progress, one model call per chapter, then done with the doc composed once", async () => {
    const { deps, table, w, doc } = await setup();
    const runId = await start(deps);
    const views = await drive(deps, runId);
    const states = [...new Set(views.map((v) => v.state))];
    expect(states).toEqual(["discovering", "organizing", "writing", "designing", "done"]);
    // stage 3 was observed chapter by chapter with real counts
    const writingDetails = views.filter((v) => v.state === "writing").map((v) => stageRows(v.progress)[2]!.detail);
    expect(writingDetails).toEqual(expect.arrayContaining(["Chapter 1 of 3", "Chapter 2 of 3", "Chapter 3 of 3", "Closing words"]));
    // planner once + 3 chapters + closing; no call repeated
    expect(w.requests.map((r) => r.agent)).toEqual(["storyteller", "caption_writer", "caption_writer", "caption_writer", "caption_writer"]);
    expect(doc.written).toBe(1);
    const row = table.rows.get(runId)!;
    expect(row).toMatchObject({ state: "done", ai_status: "ok", error_code: null, lease_token: null });
    const last = views.at(-1)!;
    expect(last.progress.outcome).toEqual({ ai: "full", notes: [], warnings: 0 });
    expect(stageRows(last.progress).map((r) => [r.status, r.detail])).toEqual([
      ["done", "24 photos"],
      ["done", "6 moments · 3 chapters"],
      ["done", "3 chapters"],
      ["done", "18 pages"],
    ]);
    expect(outcomeCopy(last.progress.outcome)).toBeNull();
    // the finished cursor drops the written text
    expect(parseStoryCursor(row.cursor)!.write.state!.groups).toEqual({});
  });

  it("progress never carries a percentage (no %, no ratio field) at any point", async () => {
    const { deps, table } = await setup();
    const runId = await start(deps);
    const views = await drive(deps, runId);
    for (const v of views) {
      const json = JSON.stringify(v.progress);
      expect(json).not.toMatch(/%|percent|ratio|fraction/i);
      for (const r of stageRows(v.progress)) expect(`${r.label} ${r.detail ?? ""} ${r.statusText}`).not.toContain("%");
    }
    expect(JSON.stringify(table.rows.get(runId)!.progress).length).toBeLessThan(4096);
  });

  it("a refresh at every stage re-attaches by run id and continues: no stage and no model call is repeated", async () => {
    const { deps, w, table } = await setup();
    const runId = await start(deps);
    // "refresh": a brand-new deps object (new process / new page) on the same table, after each tick
    for (let i = 0; i < 80; i++) {
      const fresh: StoryRunDeps = { ...deps };
      const r = await advanceStoryRun(runId, { budgetMs: 0 }, fresh);
      if ("view" in r && r.view.done) break;
    }
    expect(table.rows.get(runId)!.state).toBe("done");
    expect(w.requests).toHaveLength(5);
    expect(deps.planStory).toHaveBeenCalledTimes(1);
    expect(deps.composeStorybookPages).toHaveBeenCalledTimes(1);
  });

  it("a concurrent tick while one holds the lease answers 'leased' and does nothing", async () => {
    const { deps, table } = await setup();
    const runId = await start(deps);
    await table.claim(runId, 240); // another tick holds the lease
    expect(await advanceStoryRun(runId, { budgetMs: 0 }, deps)).toEqual({ leased: true });
    expect(deps.analyzePhotos).not.toHaveBeenCalled();
  });

  it("a database timeout keeps the run active (503 path) and releases the lease; the next tick goes on", async () => {
    const { deps, table } = await setup();
    const runId = await start(deps);
    const orig = deps.analyzePhotos;
    deps.analyzePhotos = vi.fn(async () => {
      throw new SupabaseUnavailableError("x (SUPABASE_TIMEOUT)");
    });
    await expect(advanceStoryRun(runId, { budgetMs: 0 }, deps)).rejects.toBeInstanceOf(SupabaseUnavailableError);
    expect(table.rows.get(runId)).toMatchObject({ state: "discovering", lease_token: null });
    deps.analyzePhotos = orig;
    const views = await drive(deps, runId);
    expect(views.at(-1)!.state).toBe("done");
  });

  it("dead ticks on one chapter are bounded: after MAX_GROUP_ATTEMPTS reservations it is given up (stalled) and the book still finishes", async () => {
    const { deps, table, w } = await setup();
    const runId = await start(deps);
    // run until writing starts
    while (table.rows.get(runId)!.state !== "writing") await advanceStoryRun(runId, { budgetMs: 0 }, deps);
    const real = deps.writeStoryStep;
    deps.writeStoryStep = vi.fn(async () => {
      throw new SupabaseUnavailableError("tick died (SUPABASE_TIMEOUT)");
    });
    for (let i = 0; i < MAX_GROUP_ATTEMPTS; i++) await expect(advanceStoryRun(runId, { budgetMs: 0 }, deps)).rejects.toBeInstanceOf(SupabaseUnavailableError);
    expect(parseStoryCursor(table.rows.get(runId)!.cursor)!.write.attempts).toEqual({ c1: MAX_GROUP_ATTEMPTS });
    deps.writeStoryStep = real;
    const views = await drive(deps, runId);
    const last = views.at(-1)!;
    expect(last.state).toBe("done");
    expect(last.progress.outcome!.notes).toContain("chapter_failed");
    expect(w.requests.filter((r) => r.agent === "caption_writer")).toHaveLength(3); // c2, c3, closing — c1 never called
  });
});

describe("storybook job: cancel", () => {
  it("Stop marks the run cancelled at once; the next tick makes no call; the doc is never written", async () => {
    const { deps, table, w, doc } = await setup();
    const runId = await start(deps);
    while (table.rows.get(runId)!.state !== "writing") await advanceStoryRun(runId, { budgetMs: 0 }, deps);
    await advanceStoryRun(runId, { budgetMs: 0 }, deps); // chapter 1 written
    const calls = w.requests.length;
    const r = await cancelStoryRun(runId, deps);
    expect("view" in r && r.view).toMatchObject({ state: "failed", errorCode: "cancelled", done: true });
    if (!("view" in r)) throw new Error("unreachable");
    expect(stageRows(r.view.progress)[2]!.status).toBe("failed");
    expect(storyErrorCopy("cancelled")).toMatch(/You stopped this/);
    const after = await advanceStoryRun(runId, { budgetMs: 0 }, deps);
    expect("view" in after && after.view.errorCode).toBe("cancelled");
    expect(w.requests).toHaveLength(calls);
    expect(doc.written).toBe(0);
    // a second Stop is harmless
    expect(await cancelStoryRun(runId, deps)).toMatchObject({ view: { errorCode: "cancelled" } });
  });

  it("Stop while a tick is running: that tick loses its lease and stops — even right before the doc save", async () => {
    let cancelNow: () => Promise<unknown> = async () => undefined;
    const s = await setup({
      compose: vi.fn(async (_b: string, opts: { rule: boolean; beforeSave: () => Promise<boolean> }) => {
        await cancelNow(); // the user taps Stop while the composer works
        const saved = await opts.beforeSave();
        return { pages: 18, warnings: 0, ai: "used" as const, saved };
      }),
    });
    const runId = await start(s.deps);
    cancelNow = () => cancelStoryRun(runId, s.deps);
    const r = await (async () => {
      for (let i = 0; i < 80; i++) {
        const out = await advanceStoryRun(runId, { budgetMs: 0 }, s.deps);
        if ("leased" in out) return out;
        if ("view" in out && out.view.done) return out;
      }
      return null;
    })();
    expect(r).toEqual({ leased: true });
    expect(s.table.rows.get(runId)).toMatchObject({ state: "failed", error_code: "cancelled" });
    // the composer's save was refused: beforeSave answered false
    const composeMock = s.deps.composeStorybookPages as ReturnType<typeof vi.fn>;
    expect(composeMock).toHaveBeenCalledTimes(1);
  });

  it("Try again after a Stop resumes: finished stages (plan, written chapters) are not redone", async () => {
    const { deps, table, w } = await setup();
    const first = await start(deps);
    while (table.rows.get(first)!.state !== "writing") await advanceStoryRun(first, { budgetMs: 0 }, deps);
    await advanceStoryRun(first, { budgetMs: 0 }, deps); // c1
    await advanceStoryRun(first, { budgetMs: 0 }, deps); // c2
    await cancelStoryRun(first, deps);
    expect(w.requests).toHaveLength(3); // plan + c1 + c2

    const second = await start(deps);
    expect(second).not.toBe(first);
    const views = await drive(deps, second);
    expect(views.at(-1)).toMatchObject({ state: "done", errorCode: null });
    expect(deps.planStory).toHaveBeenCalledTimes(1);
    expect(w.requests).toHaveLength(5); // + c3 + closing only
    expect(parseStoryCursor(table.rows.get(second)!.cursor)!.resumedFrom).toBe(first);
  });
});

describe("storybook job: failures", () => {
  it("compose conflicts: retried, then the run fails at 'designing'; Try again composes again without re-planning or re-writing", async () => {
    let fail = true;
    const s = await setup({
      compose: vi.fn(async (_b: string, opts: { rule: boolean; beforeSave: () => Promise<boolean> }) => {
        if (fail) throw new ComposeError("conflict", undefined, true);
        return { pages: 18, warnings: 0, ai: "used" as const, saved: await opts.beforeSave() };
      }),
    });
    const first = await start(s.deps);
    const views = await drive(s.deps, first);
    expect(views.at(-1)).toMatchObject({ state: "failed", errorCode: "conflict" });
    expect(stageRows(views.at(-1)!.progress).map((r) => r.status)).toEqual(["done", "done", "done", "failed"]);
    const calls = s.w.requests.length;
    fail = false;
    const second = await start(s.deps);
    const again = await drive(s.deps, second);
    expect(again.at(-1)!.state).toBe("done");
    expect(s.w.requests).toHaveLength(calls); // no plan / chapter call again
    expect(s.w.versions).toHaveLength(1); // the story was stored once
  });

  it("partial failure still completes: some photos can't be analysed, one chapter fails, the composer reports warnings", async () => {
    const down = new TransportError("server_error", "x", { status: 529 });
    const s = await setup({
      script: { 2: down, 3: down, 4: down }, // chapter 2: first try + 2 retries
      analyze: (ids) => ids.map((photoId, i) => (i === 0 ? { photoId, ok: false as const, error: "no_ai_copy" as const, retryable: false } : { photoId, ok: true as const, analysis: {} as never })),
      compose: vi.fn(async (_b: string, opts: { rule: boolean; beforeSave: () => Promise<boolean> }) => ({ pages: 17, warnings: 3, ai: "used" as const, saved: await opts.beforeSave() })),
    });
    const runId = await start(s.deps);
    const last = (await drive(s.deps, runId)).at(-1)!;
    expect(last.state).toBe("done");
    expect(last.aiStatus).toBe("partial");
    expect(last.progress.outcome).toMatchObject({ ai: "partial", warnings: 3 });
    expect(last.progress.outcome!.notes).toEqual(expect.arrayContaining(["photos_unanalysed", "chapter_failed"]));
    expect(outcomeCopy(last.progress.outcome)).toMatch(/Some chapters have no text yet/);
    const story = s.w.versions.at(-1)!;
    expect(story.pages.filter((p) => p.chapterId === "c2").flatMap((p) => p.blocks)).toEqual([]);
    expect(story.pages.filter((p) => p.chapterId === "c1").flatMap((p) => p.blocks).length).toBeGreaterThan(0);
  });

  it("AI off → a rule book: no analysis, the rule plan, a story without text, the deterministic composer — and honest copy", async () => {
    const s = await setup({ mode: "off" });
    const runId = await start(s.deps);
    const last = (await drive(s.deps, runId)).at(-1)!;
    expect(last).toMatchObject({ state: "done", aiStatus: null, mode: "rule" });
    expect(s.deps.analyzePhotos).not.toHaveBeenCalled();
    expect(s.w.requests).toHaveLength(0);
    expect(s.deps.planStory).toHaveBeenCalledWith(BOOK, { rule: true, maxPages: 100 });
    expect(s.deps.composeStorybookPages).toHaveBeenCalledWith(BOOK, expect.objectContaining({ rule: true }));
    expect(s.w.versions.at(-1)!.pages.flatMap((p) => p.blocks)).toEqual([]);
    expect(last.progress.outcome).toMatchObject({ ai: "none", notes: ["ai_off"] });
    expect(stageRows(last.progress).map((r) => r.status)).toEqual(["skipped", "done", "skipped", "done"]);
    expect(outcomeCopy(last.progress.outcome)).toMatch(/^Made without AI/);
    expect(outcomeCopy(last.progress.outcome)).not.toMatch(/AI wrote|magic/i);
  });

  it("over budget at start → rule book that says AI is taking a break", async () => {
    const s = await setup({ overBudget: true });
    const last = (await drive(s.deps, await start(s.deps))).at(-1)!;
    expect(last.progress.outcome).toMatchObject({ ai: "none", notes: ["budget_exhausted"] });
    expect(outcomeCopy(last.progress.outcome)).toMatch(/AI is taking a break/);
    expect(s.w.requests).toHaveLength(0);
  });

  it("regeneration when no new text can be written keeps the current story (never wipes AI text)", async () => {
    const s = await setup();
    const first = await start(s.deps);
    await drive(s.deps, first);
    expect(s.w.versions).toHaveLength(1);
    // the write limit is used up now: the writer refuses before any call
    s.deps.writeStoryStep = vi.fn(async () => {
      const { StoryError } = await import("@/lib/ai/story/service");
      throw new StoryError("limit_reached");
    });
    const last = (await drive(s.deps, await start(s.deps))).at(-1)!;
    expect(last.state).toBe("done");
    expect(last.progress.outcome!.notes).toEqual(expect.arrayContaining(["limit_reached", "story_kept"]));
    expect(s.w.versions).toHaveLength(1);
    expect(outcomeCopy(last.progress.outcome)).toMatch(/current story was kept/);
  });

  it("no photos left at plan time → the run fails with a plain reason", async () => {
    const s = await setup();
    const runId = await start(s.deps);
    s.deps.planStory = vi.fn(async () => {
      const { StoryError } = await import("@/lib/ai/story/service");
      throw new StoryError("no_photos");
    });
    const last = (await drive(s.deps, runId)).at(-1)!;
    expect(last).toMatchObject({ state: "failed", errorCode: "no_photos" });
    expect(storyErrorCopy("no_photos")).toMatch(/no photos/);
    expect(stageRows(last.progress)[1]!.status).toBe("failed");
  });

  it("another run kind is never ticked or cancelled here", async () => {
    const s = await setup();
    const created = await s.table.create({ bookId: BOOK, userId: USER, trigger: "build", mode: "live", dailyCap: 9, enforce: false });
    const id = (created as { id?: string }).id ?? "";
    expect(id).not.toBe("");
    expect(await advanceStoryRun(id, {}, s.deps)).toEqual({ notFound: true });
    expect(await cancelStoryRun(id, s.deps)).toEqual({ notFound: true });
    expect(s.table.claim).not.toHaveBeenCalled();
  });
});
