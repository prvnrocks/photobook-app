// Orchestrator (T10) — fully in memory: a fake DB implementing the T5 function shapes, a fake
// clock, and the ReplayTransport (synthesised answers, no fixtures, no network).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("real client must not be used in orchestrator tests");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("admin client must not be used in orchestrator tests");
  },
}));

const orch = await import("@/lib/ai/orchestrator");
const { ReplayTransport } = await import("@/lib/ai/transport-replay");
const { CURATOR_PROMPT_VERSION } = await import("@/lib/ai/agents/curator");
const { autolayout } = await import("@/lib/autolayout");
const { parseBookDoc } = await import("@/lib/book/schema");

type OrchestratorDeps = import("@/lib/ai/orchestrator").OrchestratorDeps;
type AdvanceResult = import("@/lib/ai/orchestrator").AdvanceResult;
type ReplayScenario = import("@/lib/ai/transport-replay").ReplayScenario;
type AgentTransport = import("@/lib/ai/transport").AgentTransport;
type AgentName = import("@/lib/ai/transport").AgentName;
type AgentStepRecord = import("@/lib/ai/run-step").AgentStepRecord;
type BookForRun = import("@/lib/db/books").BookForRun;
type CurationPhotoRow = import("@/lib/db/photos").CurationPhotoRow;
type CurationWrite = import("@/lib/db/photos").CurationWrite;
type RunForTick = import("@/lib/db/agent-runs").RunForTick;
type AiMode = import("@/lib/ai/client").AiMode;
type Json = import("@/lib/supabase/database.types").Json;

const BOOK = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-11-08T10:00:00Z");
/** Fake latency of one model call (advances the fake clock). */
const CALL_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// Fake DB

type FakeRun = RunForTick & { lease_until: number | null; total_cost_usd: number };

function photoRow(n: number, over: Partial<CurationPhotoRow> = {}): CurationPhotoRow {
  const day = Math.floor(n / 50); // 3 days for 150 photos
  const minute = n % 50;
  const landscape = n % 3 === 0;
  return {
    id: pid(n),
    thumb_path: `u/b/${pid(n)}/thumb.jpg`,
    width: landscape ? 4032 : 3024,
    height: landscape ? 3024 : 4032,
    taken_at: new Date(Date.parse("2026-10-10T08:00:00+04:00") + day * 86_400_000 + minute * 600_000).toISOString(),
    date_source: "exif",
    place: null,
    dup_group: n % 25 === 1 || n % 25 === 2 ? 1000 + Math.floor(n / 25) : null,
    blur_score: 300 + (n % 7) * 100,
    ai: null,
    status: "kept",
    drop_reason: null,
    user_override: false,
    original_mime: "image/jpeg",
    camera: "Apple iPhone 15",
    ...over,
  };
}

class FakeDb {
  now = T0;
  book: BookForRun;
  photos: CurationPhotoRow[];
  runs = new Map<string, FakeRun>();
  steps: AgentStepRecord[] = [];
  bookStatusHistory: string[] = [];
  thumbLoads = 0;
  hangNextWriteCuration = false;
  private runSeq = 0;
  private bump = 0;

  constructor(photos: CurationPhotoRow[], book: Partial<BookForRun> = {}) {
    this.photos = photos;
    this.book = {
      id: BOOK,
      user_id: USER,
      title: null,
      occasion: "travel",
      tone: "fun",
      caption_lang: "en",
      is_paid: false,
      max_pages: 20,
      doc: {},
      updated_at: this.stamp(),
      ai_status: "idle",
      ...book,
    };
  }

  stamp(): string {
    return new Date(T0 + ++this.bump).toISOString();
  }

  seedRun(over: Partial<FakeRun>): void {
    const id = `11111111-1111-4111-8111-9${String(++this.runSeq).padStart(11, "0")}`;
    this.runs.set(id, {
      id,
      book_id: BOOK,
      user_id: USER,
      state: "done",
      ai_status: "ok",
      progress: {},
      cursor: {},
      mode: "live",
      trigger: "build",
      attempts: 1,
      error_code: null,
      started_at: new Date(this.now - 3_600_000).toISOString(),
      finished_at: null,
      lease_until: null,
      total_cost_usd: 0,
      ...over,
    });
  }

  run(id: string): FakeRun {
    const r = this.runs.get(id);
    if (!r) throw new Error("no run");
    return r;
  }

  deps(transport: AgentTransport | null, mode: AiMode = "replay"): OrchestratorDeps {
    const tickRow = (r: FakeRun): RunForTick => {
      const { lease_until, total_cost_usd, ...rest } = r;
      void lease_until;
      void total_cost_usd;
      return structuredClone(rest);
    };
    return {
      getBookForRun: async (id) => (id === this.book.id ? structuredClone(this.book) : null),
      setBookAiStatus: async (id, status) => {
        if (id !== this.book.id) throw new Error("bad book");
        this.book.ai_status = status;
        this.book.updated_at = this.stamp();
        this.bookStatusHistory.push(status);
      },
      writeDocIfReplaceable: async (id, doc, pageCount, expected) => {
        if (id !== this.book.id) return { ok: false, reason: "not_found" };
        const { isReplaceableDoc } = await import("@/lib/book/replaceable");
        if (!isReplaceableDoc(this.book.doc)) return { ok: false, reason: "user_edited" };
        if (expected.updatedAt !== this.book.updated_at) return { ok: false, reason: "conflict" };
        void pageCount;
        this.book.doc = structuredClone(doc);
        this.book.updated_at = this.stamp();
        return { ok: true };
      },
      listPhotosForCuration: async (id) => (id === this.book.id ? structuredClone(this.photos) : []),
      writeCuration: async (id, rows: CurationWrite[]) => {
        if (this.hangNextWriteCuration) {
          this.hangNextWriteCuration = false;
          return new Promise<void>(() => undefined); // the process "dies" here
        }
        if (id !== this.book.id) return;
        for (const r of rows) {
          const p = this.photos.find((x) => x.id === r.id);
          if (!p) continue;
          if (r.ai !== undefined) p.ai = structuredClone(r.ai) as Json;
          if (r.status && !p.user_override) {
            p.status = r.status;
            p.drop_reason = r.status === "kept" ? null : (r.dropReason ?? null);
          }
        }
      },
      loadThumbBase64: async (paths) => {
        this.thumbLoads += paths.length;
        return new Map(paths.map((p) => [p, Buffer.from(`img:${p}`).toString("base64")]));
      },
      createRun: async (input) => {
        for (const r of this.runs.values()) {
          if (r.book_id === input.bookId && r.state !== "done" && r.state !== "failed") return { error: "already_running" };
        }
        const id = `11111111-1111-4111-8111-${String(++this.runSeq).padStart(12, "0")}`;
        this.runs.set(id, {
          id,
          book_id: input.bookId,
          user_id: input.userId,
          state: "queued",
          ai_status: null,
          progress: {},
          cursor: {},
          mode: input.mode,
          trigger: input.trigger,
          attempts: 0,
          error_code: null,
          started_at: new Date(this.now).toISOString(),
          finished_at: null,
          lease_until: null,
          total_cost_usd: 0,
        });
        return { id };
      },
      claimRun: async (id, secs) => {
        const r = this.runs.get(id);
        if (!r || r.state === "done" || r.state === "failed") return false;
        if (r.lease_until !== null && r.lease_until >= this.now) return false;
        r.lease_until = this.now + secs * 1000;
        r.attempts++;
        return true;
      },
      releaseRun: async (id) => {
        const r = this.runs.get(id);
        if (r) r.lease_until = null;
      },
      checkpointRun: async (id, patch) => {
        const r = this.run(id);
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) (r as Record<string, unknown>)[k] = structuredClone(v);
        }
        expect(JSON.stringify(r.cursor).length).toBeLessThan(65_536);
        expect(JSON.stringify(r.progress).length).toBeLessThan(4_096);
      },
      getRunForTick: async (id) => {
        const r = this.runs.get(id);
        return r ? tickRow(r) : null;
      },
      getRunForOwner: async (id) => {
        const r = this.runs.get(id);
        if (!r || r.user_id !== USER) return null;
        const { id: rid, book_id, state, ai_status, progress, error_code, mode, trigger, started_at, finished_at } = r;
        return { id: rid, book_id, state, ai_status, progress, error_code, mode, trigger, started_at, finished_at };
      },
      countLiveRuns: async ({ userId, since, triggers }) =>
        [...this.runs.values()].filter(
          (r) =>
            r.user_id === userId &&
            r.mode === "live" &&
            (triggers ?? ["build", "rebuild"]).includes(r.trigger as "build") &&
            r.started_at >= since,
        ).length,
      countLiveRebuilds: async (bookId) =>
        [...this.runs.values()].filter((r) => r.book_id === bookId && r.mode === "live" && r.trigger === "rebuild").length,
      stepLogger: (runId) => ({
        insertStep: async (row) => {
          if (row.runId !== runId) throw new Error("run mismatch");
          // ON CONFLICT (run_id, step_key, attempt) DO NOTHING
          if (this.steps.some((s) => s.runId === row.runId && s.stepKey === row.stepKey && s.attempt === row.attempt)) return;
          this.steps.push(structuredClone(row));
        },
        addRunTotals: async (id) => {
          const r = this.run(id);
          r.total_cost_usd = this.steps.filter((s) => s.runId === id).reduce((n, s) => n + s.costUsd, 0);
        },
      }),
      resolveMode: () => mode,
      transportFor: () => transport,
      now: () => this.now,
    };
  }
}

/** ReplayTransport wrapper: counts calls per agent / batch and advances the fake clock. */
class CountingTransport implements AgentTransport {
  readonly kind = "replay" as const;
  calls: Array<{ agent: AgentName; key: string }> = [];
  constructor(
    private db: FakeDb,
    private inner: InstanceType<typeof ReplayTransport>,
  ) {}
  async parse<T>(req: Parameters<AgentTransport["parse"]>[0] & { schema: import("zod").ZodType<T> }) {
    const aliases = (req.scenarioMeta?.aliases as string[] | undefined) ?? [];
    this.calls.push({ agent: req.agent, key: aliases.join(",") });
    this.db.now += CALL_MS;
    return this.inner.parse<T>(req);
  }
  count(agent: AgentName): number {
    return this.calls.filter((c) => c.agent === agent).length;
  }
}

function setup(
  photos: CurationPhotoRow[],
  opts: {
    book?: Partial<BookForRun>;
    mode?: AiMode;
    scenarioFor?: (agent: AgentName, perAgentIndex: number) => ReplayScenario;
  } = {},
) {
  const db = new FakeDb(photos, opts.book);
  const perAgent = new Map<AgentName, number>();
  const replay = new ReplayTransport({
    fixturesDir: "/nonexistent-orchestrator-fixtures",
    scenarioFor: (agent) => {
      const i = perAgent.get(agent) ?? 0;
      perAgent.set(agent, i + 1);
      return opts.scenarioFor ? opts.scenarioFor(agent, i) : "ok";
    },
  });
  const transport = new CountingTransport(db, replay);
  const deps = db.deps(opts.mode === "off" ? null : transport, opts.mode ?? "replay");
  return { db, transport, deps };
}

const photos150 = () => Array.from({ length: 150 }, (_, i) => photoRow(i + 1));

async function runToEnd(deps: OrchestratorDeps, runId: string, maxTicks = 10): Promise<{ last: AdvanceResult; ticks: number }> {
  let last: AdvanceResult = { leased: true };
  for (let t = 1; t <= maxTicks; t++) {
    last = await orch.advance(runId, {}, deps);
    if ("done" in last && last.done) return { last, ticks: t };
  }
  return { last, ticks: maxTicks + 1 };
}

async function start(deps: OrchestratorDeps, trigger: "build" | "rebuild" = "build") {
  const r = await orch.startRun({ bookId: BOOK, userId: USER, trigger }, deps);
  if (!r.ok) throw new Error(`start failed: ${r.error}`);
  return r;
}

const docOf = (db: FakeDb) => {
  const p = parseBookDoc(db.book.doc);
  if (!p.ok) throw new Error("doc does not parse");
  return p.doc;
};

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});
afterEach(() => {
  for (const s of consoleSpies) {
    expect(s).not.toHaveBeenCalled();
    s.mockRestore();
  }
});

// ---------------------------------------------------------------------------------------------

describe("orchestrator — full replay run", () => {
  it("150 photos reach done in ≤ 5 ticks with an AI doc, ai_status ok, totals = sum of steps", async () => {
    const { db, transport, deps } = setup(photos150());
    const started = await start(deps);
    expect(started).toMatchObject({ mode: "replay", state: "queued" });
    expect(transport.calls).toHaveLength(0);

    const { last, ticks } = await runToEnd(deps, started.runId);
    expect(ticks).toBeLessThanOrEqual(5);
    expect(last).toMatchObject({ state: "done", done: true, aiStatus: "ok", errorCode: null });

    expect(docOf(db).meta).toMatchObject({ generator: "ai", runId: started.runId, userEdited: false });
    expect(transport.count("curator")).toBe(15);
    expect(transport.count("storyteller")).toBe(1);

    const run = db.run(started.runId);
    expect(run).toMatchObject({ state: "done", ai_status: "ok", error_code: null });
    expect(run.finished_at).not.toBeNull();
    const sum = db.steps.reduce((n, s) => n + s.costUsd, 0);
    expect(sum).toBeGreaterThan(0);
    expect(run.total_cost_usd).toBeCloseTo(sum, 10);

    // captioning + critiquing are M4: skipped rows, no transport call
    const skipped = db.steps.filter((s) => s.status === "skipped").map((s) => s.agent);
    expect(skipped.sort()).toEqual(["caption_writer", "critic"]);

    expect(db.book.ai_status).toBe("done");
    expect(db.bookStatusHistory).toEqual(["analyzing", "planning", "done"]);
    expect(db.photos.every((p) => (p.ai as { v?: number } | null)?.v === CURATOR_PROMPT_VERSION)).toBe(true);

    // progress after the run; the AI plan is not kept in the cursor once finished
    const progress = await orch.getProgress(started.runId, deps);
    expect(progress).toMatchObject({ state: "done", done: true, aiStatus: "ok", mode: "replay" });
    expect(progress?.progress).toMatchObject({ photosTotal: 150, photosDone: 150, batchesTotal: 15, batchesDone: 15 });
    expect(JSON.stringify(run.cursor)).not.toContain('"title"');
  });

  it("privacy: step outputs / input summaries contain no descriptions", async () => {
    const { db, deps } = setup(photos150().slice(0, 30));
    const s = await start(deps);
    await runToEnd(deps, s.runId);
    const logged = JSON.stringify(db.steps.map((x) => [x.output, x.inputSummary, x.error]));
    expect(logged).not.toContain('"description"');
    expect(logged).not.toContain("synthetic replay note");
    expect(JSON.stringify(db.run(s.runId).cursor)).not.toContain("synthetic replay note");
  });

  it("advance on a finished run returns its final state without claiming", async () => {
    const { deps } = setup(photos150().slice(0, 10));
    const s = await start(deps);
    await runToEnd(deps, s.runId);
    const again = await orch.advance(s.runId, {}, deps);
    expect(again).toMatchObject({ state: "done", done: true, aiStatus: "ok" });
    expect(await orch.advance("11111111-1111-4111-8111-000000009999", {}, deps)).toEqual({ notFound: true });
  });
});

describe("orchestrator — resume and leases", () => {
  it("a tick killed mid-wave resumes without re-calling finished batches or duplicating steps", async () => {
    const { db, transport, deps } = setup(photos150());
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps); // wave 1
    await orch.advance(s.runId, {}, deps); // wave 2
    expect(db.run(s.runId).cursor).toMatchObject({ batchesDone: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });

    // Tick 3 "dies" after its model calls, before writing / checkpointing (lease never released).
    db.hangNextWriteCuration = true;
    void orch.advance(s.runId, {}, deps);
    await vi.waitFor(() => expect(transport.count("curator")).toBe(15));
    await new Promise((r) => setTimeout(r, 10));
    expect(await orch.advance(s.runId, {}, deps)).toEqual({ leased: true });

    db.now += orch.LEASE_SECONDS * 1000 + 1_000; // lease expires
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });

    // batches 0–9 called once; the dead wave (10–14) re-ran once
    const perBatch = new Map<string, number>();
    for (const c of transport.calls.filter((x) => x.agent === "curator")) perBatch.set(c.key, (perBatch.get(c.key) ?? 0) + 1);
    expect(perBatch.size).toBe(15);
    expect([...perBatch.values()].filter((n) => n === 1)).toHaveLength(10);
    expect([...perBatch.values()].filter((n) => n === 2)).toHaveLength(5);

    const keys = db.steps.map((x) => `${x.stepKey}#${x.attempt}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(db.steps.filter((x) => x.agent === "curator")).toHaveLength(15);
  });

  it("two concurrent advance calls → one gets { leased: true }", async () => {
    const { deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    const [a, b] = await Promise.all([orch.advance(s.runId, {}, deps), orch.advance(s.runId, {}, deps)]);
    const leased = [a, b].filter((r) => "leased" in r);
    expect(leased).toHaveLength(1);
  });

  it("startRun refuses a second active run for the book", async () => {
    const { deps } = setup(photos150().slice(0, 10));
    await start(deps);
    expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps)).toEqual({
      ok: false,
      error: "already_running",
    });
  });

  it("not the owner → not_found, no run created", async () => {
    const { db, deps } = setup(photos150().slice(0, 10));
    const r = await orch.startRun({ bookId: BOOK, userId: "44444444-4444-4444-8444-444444444444", trigger: "build" }, deps);
    expect(r).toEqual({ ok: false, error: "not_found" });
    expect(db.runs.size).toBe(0);
  });
});

describe("orchestrator — fallbacks", () => {
  it("Storyteller refusal → rule album, ai_status partial (run and book)", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 40), {
      scenarioFor: (agent) => (agent === "storyteller" ? "refusal" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "storyteller_refusal" });
    expect(transport.count("storyteller")).toBe(1); // a refusal is not retried
    expect(docOf(db).meta).toMatchObject({ generator: "rule", runId: s.runId });
    expect(db.book.ai_status).toBe("partial");
  });

  it("Storyteller 'invalid' then ok → exactly 2 storyteller steps, AI doc used", async () => {
    const { db, deps } = setup(photos150().slice(0, 40), {
      scenarioFor: (agent, i) => (agent === "storyteller" && i === 0 ? "invalid" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    const story = db.steps.filter((x) => x.agent === "storyteller");
    expect(story.map((x) => [x.stepKey, x.attempt])).toEqual([
      ["storyteller", 1],
      ["storyteller", 2],
    ]);
    expect(story[1].inputSummary.previousIssueCount).toBeGreaterThan(0);
    expect(docOf(db).meta?.generator).toBe("ai");
  });

  it("Storyteller invalid twice → rule album, partial", async () => {
    const { db, deps } = setup(photos150().slice(0, 20), {
      scenarioFor: (agent) => (agent === "storyteller" ? "invalid" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ aiStatus: "partial", errorCode: "storyteller_invalid" });
    expect(db.steps.filter((x) => x.agent === "storyteller")).toHaveLength(2);
    expect(docOf(db).meta?.generator).toBe("rule");
  });

  it("a Curator batch refusal → that batch rule-curated (no notes), ai_status partial", async () => {
    const { db, deps } = setup(photos150().slice(0, 30), {
      scenarioFor: (agent, i) => (agent === "curator" && i === 0 ? "refusal" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "curator_refusal" });
    expect(db.photos.filter((p) => p.ai === null)).toHaveLength(10);
    expect(db.steps.filter((x) => x.agent === "curator" && x.status === "refused")).toHaveLength(1);
    expect(docOf(db).meta?.generator).toBe("ai");
    expect(db.book.ai_status).toBe("partial");
  });

  it("every AI step fails → rule album, ai_status failed", async () => {
    const { db, deps } = setup(photos150().slice(0, 20), { scenarioFor: () => "refusal" });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "failed" });
    expect(docOf(db).meta?.generator).toBe("rule");
    expect(db.book.ai_status).toBe("failed");
  });

  it("an unexpected exception → failed run, rule album written when the book had none", async () => {
    const { db, deps } = setup(photos150().slice(0, 20));
    const s = await start(deps);
    const broken: OrchestratorDeps = {
      ...deps,
      loadThumbBase64: async () => {
        throw new Error("storage down: u/b/secret-path");
      },
    };
    const r = await orch.advance(s.runId, {}, broken);
    expect(r).toMatchObject({ state: "failed", done: true, aiStatus: "failed", errorCode: "internal_error" });
    expect(docOf(db).meta).toMatchObject({ generator: "rule", runId: s.runId });
    expect(db.book.ai_status).toBe("failed");
    expect(db.run(s.runId).lease_until).toBeNull();
  });
});

describe("orchestrator — user edits", () => {
  function editedDoc() {
    const doc = autolayout(
      photos150()
        .slice(0, 10)
        .map((p) => ({ id: p.id, width: p.width!, height: p.height!, takenAt: p.taken_at, dateSource: "exif" as const, place: null, status: "kept" as const, dupGroup: null, blurScore: 500 })),
      { occasion: "travel", title: null, captionLang: "en", isPaid: false },
    );
    return { ...doc, meta: { ...doc.meta!, userEdited: true } } as unknown as Json;
  }

  it("userEdited doc → startRun returns user_edited, no run, no transport call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10), { book: { doc: editedDoc() } });
    expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "rebuild" }, deps)).toEqual({ ok: false, error: "user_edited" });
    expect(transport.calls).toHaveLength(0);
    expect(db.runs.size).toBe(0);
  });

  it("doc edited mid-run → validating sets error_code user_edited, doc untouched", async () => {
    const { db, deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps);
    const edited = editedDoc();
    db.book.doc = edited;
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", done: true, errorCode: "user_edited" });
    expect(db.book.doc).toEqual(edited);
  });

  it("write conflict → retried on the next tick", async () => {
    const { db, deps } = setup(photos150().slice(0, 10));
    const s = await start(deps);
    let conflicts = 1;
    const flaky: OrchestratorDeps = {
      ...deps,
      writeDocIfReplaceable: async (...args) => {
        if (conflicts-- > 0) return { ok: false, reason: "conflict" };
        return deps.writeDocIfReplaceable(...args);
      },
    };
    const first = await orch.advance(s.runId, {}, flaky);
    expect(first).toMatchObject({ state: "validating", done: false });
    const second = await orch.advance(s.runId, {}, flaky);
    expect(second).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(docOf(db).meta?.generator).toBe("ai");
  });
});

describe("orchestrator — limits", () => {
  it("daily cap (3 free live builds) → limit daily_builds, no run, no transport call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10), { mode: "live" });
    for (let i = 0; i < 3; i++) db.seedRun({ book_id: null });
    const r = await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps);
    expect(r).toEqual({ ok: false, error: "limit", limit: "daily_builds" });
    expect(transport.calls).toHaveLength(0);
    expect(db.runs.size).toBe(3);
  });

  it("daily cap ignores replay runs and runs older than 24 h", async () => {
    const { db, deps } = setup(photos150().slice(0, 10), { mode: "live" });
    for (let i = 0; i < 3; i++) db.seedRun({ mode: "replay" });
    for (let i = 0; i < 3; i++) db.seedRun({ started_at: new Date(T0 - 25 * 3_600_000).toISOString() });
    const r = await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps);
    expect(r).toMatchObject({ ok: true, mode: "live" });
  });

  it("rebuild cap (2 free) → limit rebuilds, no transport call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10), { mode: "live" });
    for (let i = 0; i < 2; i++) db.seedRun({ trigger: "rebuild", started_at: new Date(T0 - 48 * 3_600_000).toISOString() });
    const r = await orch.startRun({ bookId: BOOK, userId: USER, trigger: "rebuild" }, deps);
    expect(r).toEqual({ ok: false, error: "limit", limit: "rebuilds" });
    expect(transport.calls).toHaveLength(0);
    // a plain build is still allowed
    expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps)).toMatchObject({ ok: true });
  });

  it("paid book → 20/day", async () => {
    const { db, deps } = setup(photos150().slice(0, 10), { mode: "live", book: { is_paid: true, max_pages: 100 } });
    for (let i = 0; i < 19; i++) db.seedRun({ book_id: null });
    expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps)).toMatchObject({ ok: true });
  });

  it("analysed-photo cap: 200 ready photos on free → 150 sent to the Curator, the rest rule-curated", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => photoRow(i + 1));
    const { db, transport, deps } = setup(rows);
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId, 15);
    expect(last).toMatchObject({ state: "done" });
    const sent = transport.calls.filter((c) => c.agent === "curator").flatMap((c) => c.key.split(","));
    expect(sent).toHaveLength(150);
    expect(new Set(sent).size).toBe(150);
    expect(db.photos.filter((p) => p.ai !== null)).toHaveLength(150);
    expect((await orch.getProgress(s.runId, deps))?.progress.photosCapped).toBe(50);
  });

  it("rebuild after a full run: 0 Curator calls, 1 Storyteller call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    await runToEnd(deps, s.runId);
    const curatorBefore = transport.count("curator");
    // user toggles a photo
    db.photos[3].user_override = true;
    db.photos[3].status = "dropped";
    db.photos[3].drop_reason = "user_removed";
    const r = await start(deps, "rebuild");
    const { last } = await runToEnd(deps, r.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(transport.count("curator")).toBe(curatorBefore);
    expect(transport.count("storyteller")).toBe(2);
    const used = JSON.stringify(docOf(db));
    expect(used).not.toContain(db.photos[3].id);
  });
});

describe("orchestrator — AI off and curation guarantees", () => {
  it("mode off → startRun completes synchronously with the rule album, run mode 'rule', no transport", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 30), { mode: "off" });
    const r = await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps);
    expect(r).toMatchObject({ ok: true, mode: "rule", state: "done" });
    expect(transport.calls).toHaveLength(0);
    const run = db.run((r as { runId: string }).runId);
    expect(run).toMatchObject({ mode: "rule", state: "done", ai_status: null });
    expect(docOf(db).meta).toMatchObject({ generator: "rule", runId: run.id });
    expect(db.book.ai_status).toBe("idle");
    expect(db.steps).toHaveLength(0);
    expect(db.photos.every((p) => p.ai === null)).toBe(true);
  });

  it("user_override photos never change status", async () => {
    const rows = photos150().slice(0, 20);
    // user kept a screenshot-looking photo (the Curator would drop it) and removed a sharp one
    Object.assign(rows[0], { user_override: true, original_mime: "image/png", camera: null, width: 1179, height: 2556 });
    Object.assign(rows[1], { user_override: true, status: "dropped", drop_reason: "user_removed" });
    const { db, deps } = setup(rows);
    const s = await start(deps);
    await runToEnd(deps, s.runId);
    expect(db.photos[0]).toMatchObject({ status: "kept", user_override: true });
    expect(db.photos[1]).toMatchObject({ status: "dropped", drop_reason: "user_removed" });
    // notes are still stored for override photos
    expect(db.photos[0].ai).not.toBeNull();
    expect(JSON.stringify(docOf(db))).not.toContain(rows[1].id);
  });

  it("at least one photo is kept even if the Curator drops everything", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      photoRow(i + 1, { original_mime: "image/png", camera: null, width: 1179, height: 2556, dup_group: null }),
    );
    const { db, deps } = setup(rows);
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done" });
    expect(db.photos.filter((p) => p.status === "kept")).toHaveLength(1);
    expect(docOf(db).pages.length).toBeGreaterThan(0);
  });

  it("tick timing: one Curator wave per tick when calls are slow, Storyteller starts on a fresh tick", async () => {
    const { db, deps } = setup(photos150());
    const s = await start(deps);
    const r1 = await orch.advance(s.runId, {}, deps);
    expect(r1).toMatchObject({ state: "curating", done: false, progress: { batchesDone: 5, batchesTotal: 15 } });
    await orch.advance(s.runId, {}, deps);
    const r3 = await orch.advance(s.runId, {}, deps);
    expect(r3).toMatchObject({ state: "storytelling", done: false });
    expect(db.steps.filter((x) => x.agent === "storyteller")).toHaveLength(0);
    const r4 = await orch.advance(s.runId, {}, deps);
    expect(r4).toMatchObject({ state: "done", done: true });
  });
});
