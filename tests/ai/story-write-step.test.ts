// Task 8: writeStoryStep — the whole-book write of Task 6 in bounded steps (one chapter per request),
// for the storybook job. Same world as tests/ai/story-service.test.ts (no DB, no network).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn(async () => null) }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/db/photo-analyses", () => ({ getTodayPhotoAnalysisSpendUsd: vi.fn(async () => 0), dubaiDayStart: () => "" }));
vi.mock("@/lib/db/photo-organize", () => ({ listPhotosForOrganize: vi.fn(), listVision: vi.fn(), listMoments: vi.fn(), listDuplicateGroups: vi.fn() }));
vi.mock("@/lib/db/story-ai-calls", () => ({ countStoryRuns: vi.fn(), getTodayStorySpendUsd: vi.fn(async () => 0), recordStoryCall: vi.fn(), storyUsageAvailable: vi.fn(async () => false) }));
vi.mock("@/lib/db/storybooks", () => ({ appendStorybookVersion: vi.fn(), getCurrentStorybook: vi.fn(), getMemoryContext: vi.fn() }));
vi.mock("@/lib/ai/budget", () => ({ checkDailyAiBudget: vi.fn(async () => ({ allowed: true, reason: "no_budget" })) }));

import { LIMITS } from "@/lib/ai/limits";
import { newStoryWriteState, planStory, StoryError, storyWriteGroups, writeStory, writeStoryStep, type StoryWriteState } from "@/lib/ai/story/service";
import { TransportError } from "@/lib/ai/transport";
import { StorybookSchema } from "@/lib/storybook/schemas";
import type { Storybook } from "@/lib/storybook/types";
import { userEdit } from "@/lib/storybook/versioning";
import { BOOK, pid, world } from "./story-fixtures";

afterEach(() => vi.restoreAllMocks());

async function planned(over: Parameters<typeof world>[0] = {}) {
  const w = world(over);
  const plan = await planStory(BOOK, { ...w.deps, mode: "off" });
  return { ...w, plan };
}

const textOf = (s: Storybook) => s.pages.flatMap((p) => p.blocks.map((b) => `${b.id}:${b.text}`));
const RUN = pid(777);

describe("writeStoryStep", () => {
  it("one group per step: pending until the last group, whose step stores the SAME storybook writeStory stores — one call per group in total", async () => {
    const a = await planned();
    const whole = (await writeStory(BOOK, a.plan, {}, a.deps)).storybook;

    const b = await planned();
    expect(storyWriteGroups(b.plan)).toEqual(["c1", "c2", "c3", "closing"]);
    let state: StoryWriteState = newStoryWriteState(RUN);
    for (let i = 0; i < 3; i++) {
      const r = await writeStoryStep(BOOK, b.plan, { state }, b.deps);
      expect(r.kind).toBe("pending");
      expect(r.written).toBe(i + 1);
      expect(r.total).toBe(4);
      state = r.state;
      expect(b.requests).toHaveLength(i + 1);
      expect(b.versions).toHaveLength(0); // nothing stored while pending
    }
    const done = await writeStoryStep(BOOK, b.plan, { state }, b.deps);
    expect(done.kind).toBe("done");
    expect(done.written).toBe(4);
    expect(b.requests).toHaveLength(4);
    expect(b.versions).toHaveLength(1);
    if (done.kind !== "done") throw new Error("unreachable");
    expect(StorybookSchema.safeParse(done.result.storybook).success).toBe(true);
    expect(textOf(done.result.storybook)).toEqual(textOf(whole));
    // a step with every group answered only assembles (a retried final tick): no call, one more version
    const replay = await writeStoryStep(BOOK, b.plan, { state: done.state }, b.deps);
    expect(replay.kind).toBe("done");
    expect(b.requests).toHaveLength(4);
    // every call of the job is recorded under ONE run id → counts as one write for the per-book limit
    expect(new Set(b.records.map((r) => r.runId))).toEqual(new Set([RUN]));
    expect(b.records.map((r) => r.scope)).toEqual(["book", "book", "book", "book"]);
  });

  it("a repeated step with the same state (a retried tick) never repeats a finished group's call", async () => {
    const w = await planned();
    const first = await writeStoryStep(BOOK, w.plan, { state: newStoryWriteState(RUN) }, w.deps);
    const again = await writeStoryStep(BOOK, w.plan, { state: first.state }, w.deps);
    expect(Object.keys(again.state.groups)).toEqual(["c1", "c2"]);
    // retrying with the OLD state (checkpoint lost) re-asks only c1, never more
    const lost = await writeStoryStep(BOOK, w.plan, { state: newStoryWriteState(RUN) }, w.deps);
    expect(Object.keys(lost.state.groups)).toEqual(["c1"]);
    expect(w.requests).toHaveLength(3);
  });

  it("the input state is not mutated; a malformed state is refused before anything happens", async () => {
    const w = await planned();
    const state = newStoryWriteState(RUN);
    const frozen = structuredClone(state);
    await writeStoryStep(BOOK, w.plan, { state }, w.deps);
    expect(state).toEqual(frozen);
    await expect(writeStoryStep(BOOK, w.plan, { state: { ...state, groups: { c1: { status: "ok", blocks: [["x1", {}]], issues: [] } } } as unknown as StoryWriteState }, w.deps)).rejects.toMatchObject({ code: "invalid_instruction" });
    expect(w.requests).toHaveLength(1);
  });

  it("a failed chapter is kept as failed in the state and reported at the end; the others are written", async () => {
    const w = await planned();
    const down = new TransportError("server_error", "x", { status: 529 });
    const script = world({ script: { 1: down, 2: down, 3: down } });
    const deps = { ...w.deps, transport: script.deps.transport };
    let state = newStoryWriteState(RUN);
    let r;
    do {
      r = await writeStoryStep(BOOK, w.plan, { state }, deps);
      state = r.state;
    } while (r.kind === "pending");
    expect(state.groups.c2).toEqual({ status: "failed", code: "model_error", detail: "server_error" });
    expect(r.result.issues).toEqual([{ blockId: "c2", code: "chapter_failed", detail: "server_error" }]);
    expect(r.result.storybook.pages.filter((p) => p.chapterId === "c1").flatMap((p) => p.blocks).length).toBeGreaterThan(0);
  });

  it("skip: a group given up on (dead ticks) is reported as stalled and never called", async () => {
    const w = await planned();
    let state = newStoryWriteState(RUN);
    let r = await writeStoryStep(BOOK, w.plan, { state, skip: ["c1"] }, w.deps);
    expect(r.state.groups.c1).toEqual({ status: "failed", code: "model_error", detail: "stalled" });
    expect(Object.keys(r.state.groups)).toEqual(["c1", "c2"]);
    state = r.state;
    while (r.kind === "pending") {
      r = await writeStoryStep(BOOK, w.plan, { state }, w.deps);
      state = r.state;
    }
    expect(r.result.issues).toContainEqual({ blockId: "c1", code: "chapter_failed", detail: "stalled" });
    expect(w.requests).toHaveLength(3); // c2, c3, closing
  });

  it("the per-book write limit is checked once per job: a resumed step of the same job is not a new write", async () => {
    // the book has used 1 of 2 free writes before, and THIS job's first call made it 2
    const counts = { writes: LIMITS.free.maxStoryWrites };
    const w = await planned({ counts });
    const first = { ...newStoryWriteState(RUN), okCalls: 1, groups: {} };
    const r = await writeStoryStep(BOOK, w.plan, { state: first }, w.deps);
    expect(r.kind).toBe("pending");
    // a fresh job (no ok call yet) at the limit is refused before any call
    await expect(writeStoryStep(BOOK, w.plan, { state: newStoryWriteState() }, w.deps)).rejects.toMatchObject({ code: "limit_reached" });
    expect(w.requests).toHaveLength(1);
  });

  it("textless: no model call in any AI mode — the plan's photo pages are stored without text (AI off / over budget)", async () => {
    for (const mode of ["off", "live", "replay"] as const) {
      const w = await planned({ mode });
      const r = await writeStoryStep(BOOK, w.plan, { state: newStoryWriteState(), textless: true }, w.deps);
      expect(r.kind).toBe("done");
      if (r.kind !== "done") continue;
      expect(w.requests).toHaveLength(0);
      expect(w.records).toHaveLength(0);
      expect(r.result.storybook.pages.flatMap((p) => p.blocks)).toEqual([]);
      expect(r.result.storybook.pages.some((p) => p.photoIds.length > 0)).toBe(true);
      expect(StorybookSchema.safeParse(r.result.storybook).success).toBe(true);
    }
  });

  it("textless after some chapters were written keeps them (budget ran out mid-job)", async () => {
    const w = await planned();
    const one = await writeStoryStep(BOOK, w.plan, { state: newStoryWriteState(RUN) }, w.deps);
    const r = await writeStoryStep(BOOK, w.plan, { state: one.state, textless: true }, w.deps);
    if (r.kind !== "done") throw new Error("expected done");
    expect(w.requests).toHaveLength(1);
    expect(r.result.storybook.pages.filter((p) => p.chapterId === "c1").flatMap((p) => p.blocks).length).toBeGreaterThan(0);
    expect(r.result.storybook.pages.filter((p) => p.chapterId === "c2").flatMap((p) => p.blocks)).toEqual([]);
  });

  it("merging with the current version keeps a user-edited block byte-identical (regeneration)", async () => {
    const w = await planned();
    const first = (await writeStory(BOOK, w.plan, {}, w.deps)).storybook;
    const edited = structuredClone(first);
    const page = edited.pages.find((p) => p.blocks.length > 0 && p.kind !== "chapter_opener")!;
    page.blocks[0] = { ...page.blocks[0]!, text: "Our own words, kept.", provenance: userEdit(page.blocks[0]!.provenance, "2026-11-18T11:00:00.000Z") };
    w.versions[0] = structuredClone(edited);
    let state = newStoryWriteState(RUN);
    let r;
    do {
      r = await writeStoryStep(BOOK, w.plan, { state }, w.deps);
      state = r.state;
    } while (r.kind === "pending");
    const kept = r.result.storybook.pages.find((p) => p.id === page.id)!.blocks.find((b) => b.id === page.blocks[0]!.id);
    expect(kept).toEqual(page.blocks[0]);
    expect(r.result.storybook.origin).toBe("merge");
  });

  it("AI off without textless → ai_off (like writeStory)", async () => {
    const w = await planned({ mode: "off" });
    await expect(writeStoryStep(BOOK, w.plan, { state: newStoryWriteState() }, w.deps)).rejects.toBeInstanceOf(StoryError);
  });
});
