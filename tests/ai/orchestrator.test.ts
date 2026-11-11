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

type FakeRun = RunForTick & { lease_until: number | null; lease_token: string | null; total_cost_usd: number; critic_score?: number | null };

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
  /** user_memory.prefs returned by getUserMemory (null = none); "throw" simulates a DB error. */
  memory: unknown = null;
  memoryLoads = 0;
  costReads = 0;
  /** Every write outside agent_steps, in order (for "a stale tick writes nothing" checks). */
  writes: string[] = [];
  createCalls: Array<Record<string, unknown>> = [];
  private runSeq = 0;
  private tokenSeq = 0;
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
      format: "A5_PORTRAIT",
      design_style: "classic",
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
      lease_token: null,
      total_cost_usd: 0,
      ...over,
    });
  }

  /** Another tick takes the lease (as claim_agent_run would after expiry). */
  stealLease(id: string, secs = 240): string {
    const r = this.run(id);
    const token = `tok-${++this.tokenSeq}`;
    r.lease_token = token;
    r.lease_until = this.now + secs * 1000;
    return token;
  }

  run(id: string): FakeRun {
    const r = this.runs.get(id);
    if (!r) throw new Error("no run");
    return r;
  }

  deps(transport: AgentTransport | null, mode: AiMode = "replay"): OrchestratorDeps {
    const tickRow = (r: FakeRun): RunForTick => {
      const { lease_until, lease_token, total_cost_usd, ...rest } = r;
      void lease_until;
      void lease_token;
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
        this.writes.push(`ai_status:${status}`);
      },
      writeDocIfReplaceable: async (id, doc, pageCount, expected) => {
        if (id !== this.book.id) return { ok: false, reason: "not_found" };
        // Same guard as the real defaultDeps(): AI runs use isAiReplaceableDoc (D-018 + D-031).
        const { isAiReplaceableDoc } = await import("@/lib/book/replaceable");
        if (!isAiReplaceableDoc(this.book.doc)) return { ok: false, reason: "user_edited" };
        if (expected.updatedAt !== this.book.updated_at) return { ok: false, reason: "conflict" };
        void pageCount;
        this.writes.push("doc");
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
        this.writes.push("curation");
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
      createRunCapped: async (input) => {
        this.createCalls.push({ ...input });
        // agent_runs_one_active_per_book_idx (0900): active runs except rewrite runs
        for (const r of this.runs.values()) {
          if (r.book_id === input.bookId && r.trigger !== "rewrite" && r.state !== "done" && r.state !== "failed") {
            return { error: "already_running" };
          }
        }
        if (input.enforce) {
          const since = new Date(this.now - 24 * 3_600_000).toISOString();
          const live = [...this.runs.values()].filter((r) => r.mode === "live");
          const today = live.filter((r) => r.user_id === input.userId && r.started_at >= since).length;
          if (today >= input.dailyCap) return { error: "limit", limit: "daily_builds" };
          const rebuilds = live.filter((r) => r.book_id === input.bookId && r.trigger === "rebuild").length;
          if (input.trigger === "rebuild" && rebuilds >= input.rebuildCap) return { error: "limit", limit: "rebuilds" };
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
          lease_token: null,
          total_cost_usd: 0,
        });
        return { id };
      },
      claimRun: async (id, secs) => {
        expect(secs).toBeLessThanOrEqual(orch.MAX_LEASE_SECONDS);
        const r = this.runs.get(id);
        if (!r || r.state === "done" || r.state === "failed") return null;
        if (r.lease_until !== null && r.lease_until >= this.now) return null;
        r.attempts++;
        return this.stealLease(id, secs);
      },
      releaseRun: async (id, token) => {
        const r = this.runs.get(id);
        if (r && r.lease_token === token) {
          r.lease_until = null;
          r.lease_token = null;
        }
      },
      checkpointRun: async (id, token, patch) => {
        const r = this.run(id);
        // like 0700: token match only (an expired-but-unclaimed lease still checkpoints)
        if (r.lease_token !== token) return false;
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) (r as Record<string, unknown>)[k] = structuredClone(v);
        }
        // migration 0800: octet_length(cursor::text) ≤ 262144
        expect(Buffer.byteLength(JSON.stringify(r.cursor), "utf8")).toBeLessThan(orch.MAX_CURSOR_BYTES);
        expect(JSON.stringify(r.progress).length).toBeLessThan(4_096);
        return true;
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
      hasFinishedLiveAiRun: async (bookId) =>
        [...this.runs.values()].some(
          (r) => r.book_id === bookId && r.mode === "live" && r.state === "done" && (r.ai_status === "ok" || r.ai_status === "partial"),
        ),
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
      getRunCostUsd: async (id) => {
        this.costReads++;
        return this.run(id).total_cost_usd;
      },
      getUserMemory: async (userId) => {
        this.memoryLoads++;
        if (userId !== USER) return null;
        if (this.memory === "throw") throw new Error("memory db down");
        return structuredClone(this.memory);
      },
      resolveMode: () => mode,
      transportFor: () => transport,
      now: () => this.now,
      sleep: async (ms) => {
        this.now += ms;
      },
    };
  }
}

/** ReplayTransport wrapper: counts calls per agent / batch and advances the fake clock. */
class CountingTransport implements AgentTransport {
  readonly kind = "replay" as const;
  calls: Array<{ agent: AgentName; key: string; inFlight: number }> = [];
  inFlight = 0;
  /** Runs inside a call, after the fake latency (e.g. to steal the lease mid-call). */
  onCall: ((agent: AgentName, index: number) => void) | null = null;
  constructor(
    private db: FakeDb,
    private inner: InstanceType<typeof ReplayTransport>,
  ) {}
  async parse<T>(req: Parameters<AgentTransport["parse"]>[0] & { schema: import("zod").ZodType<T> }) {
    const aliases = (req.scenarioMeta?.aliases as string[] | undefined) ?? [];
    this.inFlight++;
    this.calls.push({ agent: req.agent, key: aliases.join(","), inFlight: this.inFlight });
    this.db.now += CALL_MS;
    try {
      const res = await this.inner.parse<T>(req);
      this.onCall?.(req.agent, this.calls.length - 1);
      return res;
    } finally {
      this.inFlight--;
    }
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

    // M4: captions + Critic run for real — no skipped rows on an AI album
    expect(db.steps.filter((s) => s.status === "skipped")).toHaveLength(0);
    expect(transport.count("caption_writer")).toBeGreaterThan(0);
    expect(transport.count("critic")).toBe(1);

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
  it("lease covers the longest request + margin and stays within claim_agent_run's max", async () => {
    const { AGENT_TIMEOUT_MS } = await import("@/lib/ai/client");
    const longest = Math.max(...Object.values(AGENT_TIMEOUT_MS));
    expect(orch.LEASE_SECONDS * 1000).toBeGreaterThanOrEqual(longest + orch.LEASE_MARGIN_MS);
    expect(orch.LEASE_SECONDS).toBeLessThanOrEqual(orch.MAX_LEASE_SECONDS);
  });

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

    // Every real call has its own row: the dead wave's calls (attempt 1) AND their re-runs (attempt 2).
    const keys = db.steps.map((x) => `${x.stepKey}#${x.attempt}`);
    expect(new Set(keys).size).toBe(keys.length);
    const curatorRows = db.steps.filter((x) => x.agent === "curator");
    expect(curatorRows).toHaveLength(20);
    expect(curatorRows).toHaveLength(transport.count("curator"));
    for (const bi of [10, 11, 12, 13, 14]) {
      expect(curatorRows.filter((x) => x.stepKey === `curator:${bi}`).map((x) => x.attempt).sort()).toEqual([1, 2]);
    }
    const sum = db.steps.reduce((n, x) => n + x.costUsd, 0);
    expect(db.run(s.runId).total_cost_usd).toBeCloseTo(sum, 10);
  });

  it("lease expiry mid-tick: the second tick takes over; the first stops, releases nothing, writes nothing", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 30));
    const s = await start(deps);
    let stolen: string | null = null;
    transport.onCall = (agent, i) => {
      if (agent === "curator" && i === 0 && !stolen) {
        db.now += orch.LEASE_SECONDS * 1000 + 1_000; // tick A's lease expires during its call
        stolen = db.stealLease(s.runId); // tick B claims
        db.writes = []; // only what A does AFTER losing the lease matters
      }
    };
    const a = await orch.advance(s.runId, {}, deps);
    expect(a).toEqual({ leased: true });
    expect(db.run(s.runId).lease_token).toBe(stolen); // A did not release B's lease
    expect(db.writes).toEqual([]); // A wrote no curation / doc / ai_status after the call
    expect(db.run(s.runId).cursor).toMatchObject({ batchesDone: [], batchAttempts: [1, 0, 0] });
    // A's real call is still logged (no silent calls)
    expect(db.steps.filter((x) => x.agent === "curator")).toHaveLength(1);

    // B finishes; the batch A called is re-run with a NEW attempt number
    transport.onCall = null;
    db.run(s.runId).lease_token = null;
    db.run(s.runId).lease_until = null;
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    const b0 = db.steps.filter((x) => x.stepKey === "curator:0").map((x) => x.attempt);
    expect(b0).toEqual([1, 2]);
  });

  it("unique attempts on resume: a Storyteller call lost to a stale tick is logged, the re-run is attempt 2", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10));
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps); // curation → yields at storytelling
    transport.onCall = (agent) => {
      if (agent === "storyteller") {
        db.now += orch.LEASE_SECONDS * 1000 + 1_000;
        db.stealLease(s.runId);
      }
    };
    expect(await orch.advance(s.runId, {}, deps)).toEqual({ leased: true });
    transport.onCall = null;
    db.run(s.runId).lease_until = null;
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    const story = db.steps.filter((x) => x.agent === "storyteller").map((x) => [x.stepKey, x.attempt]);
    expect(story).toEqual([
      ["storyteller", 1],
      ["storyteller", 2],
    ]);
    expect(transport.count("storyteller")).toBe(2);
  });

  it("a batch whose attempts were all lost to dead ticks is rule-curated without another call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10));
    const s = await start(deps);
    for (let i = 0; i < orch.MAX_BATCH_ATTEMPTS; i++) {
      transport.onCall = () => {
        db.now += orch.LEASE_SECONDS * 1000 + 1_000;
        db.stealLease(s.runId);
      };
      expect(await orch.advance(s.runId, {}, deps)).toEqual({ leased: true });
      db.run(s.runId).lease_until = null;
    }
    transport.onCall = null;
    const calls = transport.count("curator");
    const { last } = await runToEnd(deps, s.runId);
    expect(transport.count("curator")).toBe(calls);
    expect(last).toMatchObject({ state: "done", errorCode: "curator_attempts" });
    expect(docOf(db).pages.length).toBeGreaterThan(0);
  });

  it("never starts a call that would outlive the lease (lease budget, not just the soft budget)", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10));
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps); // → storytelling
    // A tick whose clock already used most of the lease before work starts (slow DB).
    const slow: OrchestratorDeps = {
      ...deps,
      getRunForTick: async (id) => {
        db.now += (orch.LEASE_SECONDS - 100) * 1000;
        return deps.getRunForTick(id);
      },
    };
    const r = await orch.advance(s.runId, {}, slow);
    expect(r).toMatchObject({ state: "storytelling", done: false });
    expect(transport.count("storyteller")).toBe(0);
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

  /** Not marked userEdited, but one page carries a caption the user typed (D-031). */
  function userCaptionDoc() {
    const doc = autolayout(
      photos150()
        .slice(0, 10)
        .map((p) => ({ id: p.id, width: p.width!, height: p.height!, takenAt: p.taken_at, dateSource: "exif" as const, place: null, status: "kept" as const, dupGroup: null, blurScore: 500 })),
      { occasion: "travel", title: null, captionLang: "en", isPaid: false },
    );
    const i = doc.pages.findIndex((pg) => pg.layout !== "full-page");
    expect(i).toBeGreaterThanOrEqual(0);
    doc.pages[i] = { ...doc.pages[i], caption: { text: "Our first swim", font: "Playfair", align: "center", source: "user" } };
    expect(doc.meta?.userEdited).toBe(false);
    return doc as unknown as Json;
  }

  it("doc with a user caption (userEdited false) → startRun returns user_edited, no run, no transport call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10), { book: { doc: userCaptionDoc() } });
    expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "rebuild" }, deps)).toEqual({ ok: false, error: "user_edited" });
    expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps)).toEqual({ ok: false, error: "user_edited" });
    expect(transport.calls).toHaveLength(0);
    expect(db.runs.size).toBe(0);
    expect(db.writes).not.toContain("doc");
  });

  it("doc gets a user caption mid-run → validating refuses (user_edited), doc untouched", async () => {
    const { db, deps } = setup(photos150().slice(0, 40), { book: { ai_status: "partial" } });
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps);
    const withCaption = userCaptionDoc();
    db.book.doc = withCaption;
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", done: true, errorCode: "user_edited", aiStatus: "failed" });
    expect(db.run(s.runId)).toMatchObject({ ai_status: "failed", error_code: "user_edited" });
    expect(db.book.doc).toEqual(withCaption);
    expect(db.book.ai_status).toBe("partial");
  });

  it("userEdited doc → startRun returns user_edited, no run, no transport call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10), { book: { doc: editedDoc() } });
    expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "rebuild" }, deps)).toEqual({ ok: false, error: "user_edited" });
    expect(transport.calls).toHaveLength(0);
    expect(db.runs.size).toBe(0);
  });

  it("doc edited mid-run → validating sets error_code user_edited, doc untouched, book ai_status kept", async () => {
    const { db, deps } = setup(photos150().slice(0, 40), { book: { ai_status: "partial" } });
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps);
    expect(db.book.ai_status).toBe("planning");
    const edited = editedDoc();
    db.book.doc = edited;
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", done: true, errorCode: "user_edited", aiStatus: "failed" });
    expect(db.run(s.runId)).toMatchObject({ ai_status: "failed", error_code: "user_edited" });
    expect(db.book.doc).toEqual(edited);
    // the previous doc stayed → so does the previous book status (not 'failed')
    expect(db.book.ai_status).toBe("partial");
  });

  it("unexpected exception with a previous album kept → book ai_status restored, not 'failed'", async () => {
    const { db, deps } = setup(photos150().slice(0, 20), { book: { ai_status: "done" } });
    const first = await start(deps);
    await runToEnd(deps, first.runId);
    const before = structuredClone(db.book.doc);
    const s = await start(deps, "rebuild");
    const broken: OrchestratorDeps = {
      ...deps,
      loadThumbBase64: async () => {
        throw new Error("storage down");
      },
    };
    db.photos.forEach((p) => (p.ai = null)); // force curator calls
    const r = await orch.advance(s.runId, {}, broken);
    expect(r).toMatchObject({ state: "failed", errorCode: "internal_error" });
    expect(db.book.doc).toEqual(before);
    expect(db.book.ai_status).toBe("done");
  });

  it("photos removed by the user during the run leave the AI plan; the rest of the plan is used", async () => {
    const { db, deps } = setup(photos150().slice(0, 20));
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps); // curation
    await orch.advance(s.runId, {}, deps); // storyteller → validating → done
    expect(db.run(s.runId).state).toBe("done");

    // Again, with the removal between planning and saving (a write conflict makes the next tick reload).
    const r = await start(deps, "rebuild");
    let conflicts = 1;
    let removed: string | null = null;
    const flaky: OrchestratorDeps = {
      ...deps,
      writeDocIfReplaceable: async (...args) => {
        if (conflicts-- > 0) {
          const doc = args[1] as { pages: Array<{ slots: Array<{ photoId: string }> }> };
          removed = doc.pages[0].slots[0].photoId;
          const p = db.photos.find((x) => x.id === removed)!;
          Object.assign(p, { user_override: true, status: "dropped", drop_reason: "user_removed" });
          return { ok: false, reason: "conflict" };
        }
        return deps.writeDocIfReplaceable(...args);
      },
    };
    const { last } = await runToEnd(flaky, r.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok", errorCode: null });
    const doc = docOf(db);
    expect(doc.meta).toMatchObject({ generator: "ai", runId: r.runId });
    expect(removed).not.toBeNull();
    expect(JSON.stringify(doc)).not.toContain(removed!);
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
    expect(await orch.advance(s.runId, {}, flaky)).toMatchObject({ state: "storytelling", done: false });
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
    // a "build" on a book that already had a finished live AI run is a rebuild (cap bypass closed)
    expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps)).toEqual({
      ok: false,
      error: "limit",
      limit: "rebuilds",
    });
    expect(db.createCalls.at(-1)).toMatchObject({ trigger: "rebuild" });
  });

  it("createRunCapped gets the plan's caps; enforce only for live; limit errors are mapped", async () => {
    const free = setup(photos150().slice(0, 10), { mode: "live" });
    await start(free.deps);
    expect(free.db.createCalls[0]).toEqual({
      bookId: BOOK,
      userId: USER,
      trigger: "build",
      mode: "live",
      dailyCap: 3,
      rebuildCap: 2,
      enforce: true,
    });
    const paid = setup(photos150().slice(0, 10), { mode: "live", book: { is_paid: true, max_pages: 100 } });
    await start(paid.deps);
    expect(paid.db.createCalls[0]).toMatchObject({ dailyCap: 20, rebuildCap: 10, enforce: true });
    const replay = setup(photos150().slice(0, 10));
    await start(replay.deps);
    expect(replay.db.createCalls[0]).toMatchObject({ mode: "replay", enforce: false });
    const off = setup(photos150().slice(0, 10), { mode: "off" });
    await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, off.deps);
    expect(off.db.createCalls[0]).toMatchObject({ mode: "rule", enforce: false });

    for (const limit of ["daily_builds", "rebuilds"] as const) {
      const x = setup(photos150().slice(0, 10), { mode: "live" });
      const deps: OrchestratorDeps = { ...x.deps, createRunCapped: async () => ({ error: "limit", limit }) };
      expect(await orch.startRun({ bookId: BOOK, userId: USER, trigger: "build" }, deps)).toEqual({ ok: false, error: "limit", limit });
      expect(x.transport.calls).toHaveLength(0);
    }
  });

  it("a build on a book whose album the AI made is stored as a rebuild (replay too)", async () => {
    const { db, deps } = setup(photos150().slice(0, 10));
    const s = await start(deps);
    await runToEnd(deps, s.runId);
    expect(docOf(db).meta?.generator).toBe("ai");
    await start(deps, "build");
    expect(db.createCalls.at(-1)).toMatchObject({ trigger: "rebuild", mode: "replay" });
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

describe("orchestrator — D-059 daily AI budget breaker", () => {
  const input = { bookId: BOOK, userId: USER, trigger: "build" as const };

  it("live + over budget → limit budget_exhausted, no run row, no model call, nothing written", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10), { mode: "live" });
    let checks = 0;
    const over: OrchestratorDeps = { ...deps, isOverDailyAiBudget: async () => (checks++, true) };
    expect(await orch.startRun(input, over)).toEqual({ ok: false, error: "limit", limit: "budget_exhausted" });
    expect(await orch.startRun({ ...input, trigger: "rebuild" }, over)).toEqual({ ok: false, error: "limit", limit: "budget_exhausted" });
    expect(checks).toBe(2);
    expect(db.createCalls).toHaveLength(0);
    expect(db.runs.size).toBe(0);
    expect(transport.calls).toHaveLength(0);
    expect(db.writes).toEqual([]);
  });

  it("live + under budget → unchanged (run created)", async () => {
    const { db, deps } = setup(photos150().slice(0, 10), { mode: "live" });
    const under: OrchestratorDeps = { ...deps, isOverDailyAiBudget: async () => false };
    expect(await orch.startRun(input, under)).toMatchObject({ ok: true, mode: "live", state: "queued" });
    expect(db.createCalls).toHaveLength(1);
  });

  it("no budget dep (unset budget) → unchanged", async () => {
    const { db, deps } = setup(photos150().slice(0, 10), { mode: "live" });
    expect(deps.isOverDailyAiBudget).toBeUndefined();
    expect(await orch.startRun(input, deps)).toMatchObject({ ok: true, mode: "live" });
    expect(db.createCalls).toHaveLength(1);
  });

  it("a throwing budget check fails open", async () => {
    const { db, deps } = setup(photos150().slice(0, 10), { mode: "live" });
    const broken: OrchestratorDeps = {
      ...deps,
      isOverDailyAiBudget: async () => {
        throw new Error("boom");
      },
    };
    expect(await orch.startRun(input, broken)).toMatchObject({ ok: true, mode: "live" });
    expect(db.createCalls).toHaveLength(1);
  });

  it("replay and off modes are never refused (they cost nothing) and never check", async () => {
    let checks = 0;
    const replay = setup(photos150().slice(0, 10));
    expect(await orch.startRun(input, { ...replay.deps, isOverDailyAiBudget: async () => (checks++, true) })).toMatchObject({
      ok: true,
      mode: "replay",
    });
    const off = setup(photos150().slice(0, 10), { mode: "off" });
    expect(await orch.startRun(input, { ...off.deps, isOverDailyAiBudget: async () => (checks++, true) })).toMatchObject({
      ok: true,
      mode: "rule",
    });
    expect(checks).toBe(0);
  });

  it("owner / user-edited checks still come first", async () => {
    const { deps } = setup(photos150().slice(0, 10), { mode: "live" });
    const over: OrchestratorDeps = { ...deps, isOverDailyAiBudget: async () => true };
    expect(await orch.startRun({ ...input, userId: "someone-else" }, over)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("orchestrator — AI mode changed during a run", () => {
  it("replay run, server now resolves 'off' → finishes with the rule album, error_code mode_changed, no calls", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 30));
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps); // some curation in replay
    const before = transport.calls.length;
    const off: OrchestratorDeps = { ...deps, resolveMode: () => "off" };
    const r = await orch.advance(s.runId, {}, off);
    expect(r).toMatchObject({ state: "done", done: true, errorCode: "mode_changed" });
    expect(transport.calls.length).toBe(before);
    expect(docOf(db).meta).toMatchObject({ generator: "rule", runId: s.runId });
    expect(db.run(s.runId)).toMatchObject({ state: "done", error_code: "mode_changed" });
    // every photo got a decision; the rest were rule-curated
    expect(db.photos.filter((p) => p.status === "kept").length).toBeGreaterThan(0);
  });

  it("live run, key removed (mode now replay) → same, before any call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 10), { mode: "live" });
    const s = await start(deps);
    const nowReplay: OrchestratorDeps = { ...deps, resolveMode: () => "replay" };
    const r = await orch.advance(s.runId, {}, nowReplay);
    expect(r).toMatchObject({ state: "done", aiStatus: "failed", errorCode: "mode_changed" });
    expect(transport.calls).toHaveLength(0);
    expect(docOf(db).meta?.generator).toBe("rule");
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

  it("prompt cache warm-up: the first tick sends batch 0 alone, then the rest of the wave in parallel", async () => {
    const { transport, deps } = setup(photos150());
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps);
    const first = transport.calls.filter((c) => c.agent === "curator");
    expect(first).toHaveLength(5);
    expect(first[0].inFlight).toBe(1);
    expect(first[1].inFlight).toBe(1); // batch 0 had finished before the others started
    expect(Math.max(...first.slice(1).map((c) => c.inFlight))).toBe(4);
    await orch.advance(s.runId, {}, deps);
    const second = transport.calls.filter((c) => c.agent === "curator").slice(5);
    expect(Math.max(...second.map((c) => c.inFlight))).toBe(5);
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

// ---------------------------------------------------------------------------------------------
// M4 — captions, Critic, repair (T7 + T11)

const { getLayout } = await import("@/lib/layouts");
const { validateBookDoc } = await import("@/lib/book/schema");
const { buildCaptionContext, checkCaption } = await import("@/lib/ai/caption-check");
const { pageCaptionKeys } = await import("@/lib/ai/repair");
const { isPlantedMismatch, PLANTED_PRECHECK_TEXT } = await import("@/lib/ai/agents/caption-writer-replay");
const { wordCount, MAX_QUOTE_WORDS } = await import("@/lib/ai/schemas");
type BookDocT = import("@/lib/book/types").BookDoc;

const hasCaptionArea = (layout: string) => {
  const l = getLayout(layout);
  return Boolean(l && l.role === "page" && l.caption);
};
const captionTexts = (doc: BookDocT) => doc.pages.map((p) => p.caption?.text).filter((t): t is string => typeof t === "string");
const stepsOf = (db: FakeDb, prefix: string) => db.steps.filter((s) => s.stepKey.startsWith(prefix));
const ARABIC = /[؀-ۿ]/;

/** Asserts that no caption / heading text of `doc` (and no Critic detail) appears in steps, progress, cursor. */
function expectNoText(db: FakeDb, runId: string, doc: BookDocT) {
  const steps = JSON.stringify(db.steps.map((s) => [s.output, s.inputSummary, s.error]));
  const run = db.run(runId);
  const cursor = JSON.stringify(run.cursor);
  const progress = JSON.stringify(run.progress);
  const texts = [...captionTexts(doc), ...doc.chapters.map((c) => c.title)];
  expect(texts.length).toBeGreaterThan(0);
  for (const t of texts) {
    expect(steps).not.toContain(t);
    expect(cursor).not.toContain(t);
    expect(progress).not.toContain(t);
  }
  expect(steps).not.toContain("Replay: the caption");
  expect(steps).not.toContain('"detail"');
  // progress: phase + counts only
  for (const [k, v] of Object.entries(run.progress as Record<string, unknown>)) {
    if (k === "phase") expect(typeof v).toBe("string");
    else expect(typeof v).toBe("number");
  }
}

describe("orchestrator — captions (M4)", () => {
  it("English replay book: every captionable page captioned by the AI, ≤ 18 words, doc valid, totals = step sum", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 60));
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok", errorCode: null });
    const doc = docOf(db);
    const captionable = doc.pages.filter((p) => hasCaptionArea(p.layout));
    expect(captionable.length).toBeGreaterThan(0);
    for (const p of captionable) {
      expect(p.caption).toMatchObject({ source: "ai", font: "Playfair", align: "center" });
      expect(wordCount(p.caption!.text)).toBeLessThanOrEqual(MAX_QUOTE_WORDS);
      expect(ARABIC.test(p.caption!.text)).toBe(false);
    }
    for (const p of doc.pages.filter((x) => !hasCaptionArea(x.layout))) expect(p.caption).toBeNull();
    const kept = new Set(db.photos.filter((p) => p.status === "kept").map((p) => p.id));
    expect(validateBookDoc(doc, { photoIds: kept, maxPages: 20 })).toEqual([]);

    const writers = stepsOf(db, "caption_writer:");
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.every((w) => /^caption_writer:\d+$/.test(w.stepKey) && w.status === "ok" && w.attempt === 1)).toBe(true);
    expect(transport.count("caption_writer")).toBe(writers.length);
    expect(stepsOf(db, "critic")).toHaveLength(1);
    expect(db.run(s.runId)).toMatchObject({ critic_score: 8 });

    const progress = (await orch.getProgress(s.runId, deps))!.progress;
    expect(progress.captionsTotal).toBe(captionable.length);
    expect(progress.captionsDone).toBe(captionable.length);

    const sum = db.steps.reduce((n, x) => n + x.costUsd, 0);
    expect(db.run(s.runId).total_cost_usd).toBeCloseTo(sum, 10);
    expectNoText(db, s.runId, doc);
  });

  it("Arabic book: native Arabic captions that pass the Arabic script check, font Cairo", async () => {
    const { db, deps } = setup(photos150().slice(0, 40), { book: { caption_lang: "ar" } });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    const doc = docOf(db);
    const ctx = buildCaptionContext({ lang: "ar" });
    const captioned = doc.pages.filter((p) => p.caption);
    expect(captioned.length).toBe(doc.pages.filter((p) => hasCaptionArea(p.layout)).length);
    for (const p of captioned) {
      expect(p.caption).toMatchObject({ source: "ai", font: "Cairo" });
      const codes = checkCaption(p.caption!.text, ctx).map((i) => i.code);
      expect(codes).not.toContain("not_arabic");
      expect(codes).not.toContain("latin_word");
      expect(/[A-Za-z]/.test(p.caption!.text)).toBe(false);
    }
    expect(doc.chapters.every((c) => ARABIC.test(c.title))).toBe(true); // headings applied
    expectNoText(db, s.runId, doc);
  });

  it("plant_bad_caption: pre-check and Critic each catch theirs, one repair round fixes both, ai_status ok", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 60), {
      scenarioFor: (agent) => (agent === "caption_writer" || agent === "critic" ? "plant_bad_caption" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok", errorCode: null });

    // pre-check caught the planted 22-word caption in batch 0 (codes only in the log)
    const b0 = db.steps.find((x) => x.stepKey === "caption_writer:0")!;
    expect(JSON.stringify(b0.output)).toContain("too_long");
    // the Critic caught the sentinel mismatch
    const critic = db.steps.find((x) => x.agent === "critic")!;
    expect(critic.output).toMatchObject({ score: 5, issues: [{ type: "caption_mismatch" }] });
    expect(db.run(s.runId)).toMatchObject({ critic_score: 5 });

    const repairs = stepsOf(db, "caption_writer:repair:");
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs.every((r) => r.attempt === 1 && r.status === "ok")).toBe(true);
    expect(repairs[0].inputSummary.repairTargets).toBe(2);
    expect(transport.count("caption_writer")).toBe(stepsOf(db, "caption_writer").length);
    expect(transport.count("critic")).toBe(1); // never a second Critic / repair round

    const doc = docOf(db);
    for (const t of captionTexts(doc)) {
      expect(isPlantedMismatch(t)).toBe(false);
      expect(t).not.toBe(PLANTED_PRECHECK_TEXT.en);
    }
    const captionable = doc.pages.filter((p) => hasCaptionArea(p.layout));
    expect(captionable.every((p) => p.caption?.source === "ai")).toBe(true);
    expectNoText(db, s.runId, doc);
  });

  it("Critic refusal → captions kept, no repair of Critic issues, RUN partial but book done (SF5)", async () => {
    const { db, deps } = setup(photos150().slice(0, 40), {
      scenarioFor: (agent) => (agent === "critic" ? "refusal" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "critic_refusal" });
    const doc = docOf(db);
    expect(doc.meta?.generator).toBe("ai");
    expect(doc.pages.filter((p) => hasCaptionArea(p.layout)).every((p) => p.caption?.source === "ai")).toBe(true);
    expect(stepsOf(db, "caption_writer:repair:")).toHaveLength(0);
    expect(db.run(s.runId).critic_score ?? null).toBeNull();
    expect(db.run(s.runId)).toMatchObject({ ai_status: "partial", error_code: "critic_refusal" });
    // SF5: every caption is there → the book is not flagged partial (no misleading banner).
    expect(db.book.ai_status).toBe("done");
    expect((db.run(s.runId).cursor as { criticFailures: number; captionFailures: number })).toMatchObject({
      criticFailures: 1,
      captionFailures: 0,
    });
  });

  it("caption batch refusal → that batch's pages stay null, other batches captioned, partial", async () => {
    const { db, transport, deps } = setup(photos150(), {
      scenarioFor: (agent, i) => (agent === "caption_writer" && i === 0 ? "refusal" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "caption_writer_refusal" });
    const cursor = db.run(s.runId).cursor as { captionBatches: Array<{ keys: string[] }> };
    expect(cursor.captionBatches.length).toBeGreaterThanOrEqual(2);
    const batch0 = new Set(cursor.captionBatches[0].keys);
    const doc = docOf(db);
    const keys = pageCaptionKeys(doc);
    doc.pages.forEach((p, i) => {
      if (!hasCaptionArea(p.layout)) return;
      if (batch0.has(keys[i]!)) expect(p.caption).toBeNull();
      else expect(p.caption?.source).toBe("ai");
    });
    // a refusal is not retried
    expect(db.steps.filter((x) => x.stepKey === "caption_writer:0")).toHaveLength(1);
    expect(transport.count("caption_writer")).toBe(cursor.captionBatches.length);
  });

  it("resume after a dead tick mid-captioning: no duplicate attempts, every real call logged; stale tick writes nothing", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 60));
    const s = await start(deps);
    while (db.run(s.runId).state !== "storytelling") await orch.advance(s.runId, {}, deps); // curation
    let stolen = false;
    transport.onCall = (agent) => {
      if (agent === "caption_writer" && !stolen) {
        stolen = true;
        db.now += orch.LEASE_SECONDS * 1000 + 1_000;
        db.stealLease(s.runId);
        db.writes = [];
      }
    };
    expect(await orch.advance(s.runId, {}, deps)).toEqual({ leased: true });
    expect(db.writes).toEqual([]);
    const cur = db.run(s.runId).cursor as { captionAttempts: number[]; captionBatchesDone: number[]; captions: Record<string, string> };
    expect(cur.captionAttempts[0]).toBe(1); // reserved before the call
    expect(cur.captionBatchesDone).toEqual([]);
    expect(cur.captions).toEqual({});
    expect(stepsOf(db, "caption_writer:0")).toHaveLength(1); // the lost call is still logged

    transport.onCall = null;
    db.run(s.runId).lease_until = null;
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(stepsOf(db, "caption_writer:0").map((x) => x.attempt)).toEqual([1, 2]);
    const keys = db.steps.map((x) => `${x.stepKey}#${x.attempt}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const agent of ["caption_writer", "critic", "storyteller", "curator"] as const) {
      expect(db.steps.filter((x) => x.agent === agent)).toHaveLength(transport.count(agent));
    }
    const sum = db.steps.reduce((n, x) => n + x.costUsd, 0);
    expect(db.run(s.runId).total_cost_usd).toBeCloseTo(sum, 10);
  });

  it("stale lease during the Critic call → the stale tick writes nothing; the re-run is attempt 2", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    await orch.advance(s.runId, {}, deps);
    transport.onCall = (agent) => {
      if (agent === "critic") {
        db.now += orch.LEASE_SECONDS * 1000 + 1_000;
        db.stealLease(s.runId);
        db.writes = [];
      }
    };
    expect(await orch.advance(s.runId, {}, deps)).toEqual({ leased: true });
    expect(db.writes).toEqual([]);
    expect(db.run(s.runId).state).toBe("critiquing");
    expect(db.run(s.runId).critic_score ?? null).toBeNull();
    transport.onCall = null;
    db.run(s.runId).lease_until = null;
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(db.steps.filter((x) => x.agent === "critic").map((x) => x.attempt)).toEqual([1, 2]);
  });

  it("caption, Critic and repair calls never start when they don't fit in the lease", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    const slow: OrchestratorDeps = {
      ...deps,
      getRunForTick: async (id) => {
        db.now += (orch.LEASE_SECONDS - 100) * 1000;
        return deps.getRunForTick(id);
      },
    };
    // Tiny soft budget → each tick stops after its first model call.
    const states: string[] = [];
    for (let t = 0; t < 30; t++) {
      const r = await orch.advance(s.runId, { budgetMs: 1 }, deps);
      if ("state" in r) states.push(r.state);
      if ("done" in r && r.done) break;
      if ("state" in r && (r.state === "captioning" || r.state === "critiquing")) {
        const before = transport.calls.length;
        const x = await orch.advance(s.runId, { budgetMs: 1 }, slow);
        expect(x).toMatchObject({ state: r.state, done: false });
        expect(transport.calls.length).toBe(before);
      }
    }
    expect(states).toContain("captioning");
    expect(states).toContain("critiquing");
    expect(states.at(-1)).toBe("done");
  });

  it("memory snapshot: loaded once, keys in Storyteller + Caption Writer input_summary, 'short' → ≤ 10 words, stripped at finish", async () => {
    const { db, deps } = setup(photos150().slice(0, 40));
    db.memory = { v: 1, captionLength: "short", tonePreference: "romantic", knownNames: ["Zubaida"], junk: "x" };
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(db.memoryLoads).toBe(1);
    const story = db.steps.find((x) => x.agent === "storyteller")!;
    expect(story.inputSummary.memoryKeys).toEqual(expect.arrayContaining(["captionLength", "tonePreference", "knownNames"]));
    const writer = db.steps.find((x) => x.stepKey === "caption_writer:0")!;
    expect(writer.inputSummary.memoryKeys).toEqual(expect.arrayContaining(["captionLength", "tonePreference", "knownNames"]));
    const doc = docOf(db);
    const texts = captionTexts(doc);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(wordCount(t)).toBeLessThanOrEqual(10);
    const stored = JSON.stringify(db.run(s.runId).cursor);
    expect(stored).not.toContain("Zubaida");
    expect(JSON.stringify(db.steps)).not.toContain("Zubaida");
  });

  it("memory load error → run continues without memory", async () => {
    const { db, deps } = setup(photos150().slice(0, 20));
    db.memory = "throw";
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(db.steps.find((x) => x.agent === "storyteller")!.inputSummary.memoryKeys).toEqual([]);
    expect(db.steps.find((x) => x.stepKey === "caption_writer:0")!.inputSummary.memoryKeys).toEqual([]);
  });

  it("rule album (Storyteller refused) → one skipped caption_writer step 'rule_album', no captions, no Critic", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 30), {
      scenarioFor: (agent) => (agent === "storyteller" ? "refusal" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "storyteller_refusal" });
    const skipped = db.steps.filter((x) => x.status === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ agent: "caption_writer", inputSummary: { reason: "rule_album" }, costUsd: 0 });
    expect(transport.count("caption_writer")).toBe(0);
    expect(transport.count("critic")).toBe(0);
    expect(docOf(db).pages.every((p) => p.caption === null)).toBe(true);
    expect((await orch.getProgress(s.runId, deps))!.progress).toMatchObject({ captionsTotal: 0, captionsDone: 0 });
  });

  it("finished cursor holds no caption / heading / critique / memory text", async () => {
    const { db, deps } = setup(photos150().slice(0, 40), {
      scenarioFor: (agent) => (agent === "critic" ? "plant_bad_caption" : "ok"),
    });
    const s = await start(deps);
    await runToEnd(deps, s.runId);
    const cursor = db.run(s.runId).cursor as Record<string, unknown>;
    expect(cursor).toMatchObject({ captions: {}, headings: {}, critique: null, memory: null, album: { kind: "ai" } });
    expect(JSON.stringify(cursor)).not.toContain('"title"');
    expectNoText(db, s.runId, docOf(db));
  });

  it("captions follow their page through a mid-run photo removal; changed pages get null", async () => {
    const { db, deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    let removed: string | null = null;
    let conflicts = 1;
    const flaky: OrchestratorDeps = {
      ...deps,
      writeDocIfReplaceable: async (...args) => {
        if (conflicts-- > 0) {
          const doc = args[1] as unknown as BookDocT;
          const i = doc.pages.findIndex((p) => p.slots.length >= 2 && p.caption);
          removed = doc.pages[i].slots[0].photoId;
          Object.assign(db.photos.find((x) => x.id === removed)!, { user_override: true, status: "dropped", drop_reason: "user_removed" });
          return { ok: false, reason: "conflict" };
        }
        return deps.writeDocIfReplaceable(...args);
      },
    };
    const { last } = await runToEnd(flaky, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    const doc = docOf(db);
    expect(JSON.stringify(doc)).not.toContain(removed!);
    const captioned = doc.pages.filter((p) => p.caption);
    expect(captioned.length).toBeGreaterThan(0);
    // the re-fitted page lost its caption (its photos changed)
    const refit = doc.pages.filter((p) => p.slots.some((sl) => db.photos.find((x) => x.id === sl.photoId)) && !p.caption && hasCaptionArea(p.layout));
    expect(refit.length).toBeGreaterThanOrEqual(1);
  });

  it("an in-flight pre-M4 cursor (no caption fields) still parses and finishes", async () => {
    const { db, deps } = setup(photos150().slice(0, 20));
    const s = await start(deps);
    await orch.advance(s.runId, { budgetMs: 1 }, deps); // curation done, at storytelling
    const run = db.run(s.runId);
    const legacy = structuredClone(run.cursor) as Record<string, unknown>;
    for (const k of Object.keys(legacy)) if (/^(memory|caption|critic|critique|repair|coverSwap|headings)/.test(k)) delete legacy[k];
    expect(Object.keys(legacy)).not.toContain("captions");
    run.cursor = legacy as Json;
    run.state = "critiquing"; // a pre-M4 run that had passed the placeholder captioning state
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done" });
    expect(last).not.toMatchObject({ errorCode: "bad_cursor" });
    expect(orch.parseCursor(legacy)).not.toBeNull();
  });

  it("cursor worst case (paid, 500 photos, 100 pages / moments, Arabic, max memory) stays under 256 KB", () => {
    const rows = Array.from({ length: 500 }, (_, i) => photoRow(i + 1));
    const cursor = orch.initialCursor(rows.map(orch.toCurationPhoto), 500, "done");
    const ar = (n: number) => "ب".repeat(n);
    cursor.album = {
      kind: "ai",
      plan: {
        title: ar(60),
        subtitle: ar(120),
        coverPhotoId: "p1",
        moments: Array.from({ length: 100 }, (_, m) => ({
          id: `m${m + 1}`,
          title: ar(80),
          dateLabel: "12 Oct 2026 – 14 Oct 2026",
          place: ar(80),
          pages: [{ layoutId: "grid-4", photoIds: [1, 2, 3, 4].map((k) => `p${m * 5 + k}`) }],
        })),
      },
    };
    cursor.memory = {
      v: 1,
      tonePreference: "romantic",
      captionLength: "long",
      language: "ar",
      knownNames: Array.from({ length: 20 }, (_, i) => `${ar(38)}${String(i).padStart(2, "0")}`),
      avoid: Array.from({ length: 10 }, (_, i) => `${ar(58)}${String(i).padStart(2, "0")}`),
    };
    cursor.captionBatches = Array.from({ length: 10 }, (_, b) => ({
      moments: Array.from({ length: 10 }, (_, k) => `m${b * 10 + k + 1}`),
      keys: Array.from({ length: 10 }, (_, k) => `m${b * 10 + k + 1}:0`),
    }));
    cursor.captionAttempts = Array(10).fill(2);
    cursor.captionBatchesDone = Array.from({ length: 10 }, (_, i) => i);
    for (let m = 1; m <= 100; m++) {
      cursor.captions[`m${m}:0`] = ar(200);
      cursor.headings[`m${m}`] = ar(60);
      cursor.captionIssues[`m${m}:0`] = ["too_long", "unknown_name", "latin_word", "duplicate", "repeated_opening"];
    }
    cursor.critique = { score: 4, issues: Array.from({ length: 50 }, (_, i) => ({ type: "caption_mismatch" as const, pageIndex: i, fix: "rewrite_caption" as const })) };
    cursor.repairTargets = Array.from({ length: 100 }, (_, m) => ({ batch: Math.floor(m / 10), key: `m${m + 1}:0`, codes: ["too_long", "caption_mismatch"] }));
    cursor.repairAttempts = Array(10).fill(1);
    cursor.repairBatchesDone = Array.from({ length: 10 }, (_, i) => i);
    cursor.failures = Array(20).fill("caption_writer_context_window_exceeded");
    const bytes = Buffer.byteLength(JSON.stringify(cursor), "utf8");
    expect(bytes).toBeLessThan(orch.MAX_CURSOR_BYTES);
    expect(bytes).toBeGreaterThan(50_000); // sanity: the worst case really is big
    // round-trips without losing caption state
    const parsed = orch.parseCursor(JSON.parse(JSON.stringify(cursor)))!;
    expect(Object.keys(parsed.captions)).toHaveLength(100);
    expect(parsed.album).toMatchObject({ kind: "ai", plan: { moments: expect.any(Array) } });
    expect(parsed.memory?.knownNames).toHaveLength(20);
  });
});

describe("orchestrator — M4 review fixes", () => {
  /** Ticks with a tiny soft budget until the stored run state is `state` (each tick stops after one call). */
  async function advanceUntil(deps: OrchestratorDeps, db: FakeDb, runId: string, state: string) {
    for (let t = 0; t < 30 && db.run(runId).state !== state; t++) await orch.advance(runId, { budgetMs: 1 }, deps);
    expect(db.run(runId).state).toBe(state);
  }

  it("SF1 cursorByteLimit: env AI_MAX_CURSOR_BYTES (positive, never above the DB check), else the DB limit", () => {
    expect(orch.cursorByteLimit({})).toBe(orch.MAX_CURSOR_BYTES);
    expect(orch.cursorByteLimit({ AI_MAX_CURSOR_BYTES: "1000" })).toBe(1000);
    expect(orch.cursorByteLimit({ AI_MAX_CURSOR_BYTES: "abc" })).toBe(orch.MAX_CURSOR_BYTES);
    expect(orch.cursorByteLimit({ AI_MAX_CURSOR_BYTES: "-5" })).toBe(orch.MAX_CURSOR_BYTES);
    expect(orch.cursorByteLimit({ AI_MAX_CURSOR_BYTES: "999999999" })).toBe(orch.MAX_CURSOR_BYTES);
    expect(orch.cursorBytes({ a: "é" })).toBe(Math.ceil(Buffer.byteLength('{"a":"é"}') * orch.CURSOR_SIZE_FACTOR));
  });

  it("SF1: a captioning checkpoint over the cursor limit drops caption work and finishes with the AI album (partial, cursor_too_large)", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 60));
    const s = await start(deps);
    await advanceUntil(deps, db, s.runId, "captioning");
    const run = db.run(s.runId);
    expect((run.cursor as { album: { plan?: unknown } }).album.plan).toBeTruthy();
    expect((run.cursor as { captions: object }).captions).toEqual({});
    // Room for the plan + bookkeeping, not for a batch of captions.
    const limit = orch.cursorBytes(run.cursor) + 200;
    const small: OrchestratorDeps = { ...deps, maxCursorBytes: () => limit };
    const { last } = await runToEnd(small, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "cursor_too_large" });
    const doc = docOf(db);
    expect(doc.meta?.generator).toBe("ai"); // the AI album is never lost
    expect(doc.pages.every((p) => p.caption === null)).toBe(true);
    expect(transport.count("caption_writer")).toBeGreaterThan(0);
    expect(transport.count("critic")).toBe(0); // pending caption work dropped
    expect(db.book.ai_status).toBe("partial");
    const cursor = db.run(s.runId).cursor as { captionFailures: number; failures: string[] };
    expect(cursor.failures).toContain("cursor_too_large");
    expect(orch.cursorBytes(db.run(s.runId).cursor)).toBeLessThanOrEqual(limit);
  });

  it("SF1: before captioning (no caption work to shed) an oversized cursor fails the run, the rule album is still written", async () => {
    const { db, deps } = setup(photos150().slice(0, 20));
    const s = await start(deps);
    const { last } = await runToEnd({ ...deps, maxCursorBytes: () => 100 }, s.runId);
    expect(last).toMatchObject({ state: "failed", errorCode: "cursor_too_large" });
    expect(docOf(db).pages.length).toBeGreaterThan(0);
  });

  it("SF5: Critic budget skip → run partial (run_budget), book done; one skipped critic row", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    const pricey: OrchestratorDeps = {
      ...deps,
      getRunCostUsd: async (id) => (db.run(id).state === "critiquing" ? 1.49 : deps.getRunCostUsd(id)),
    };
    const { last } = await runToEnd(pricey, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "run_budget" });
    expect(transport.count("critic")).toBe(0);
    const skipped = db.steps.filter((x) => x.status === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ agent: "critic", stepKey: "critic:skipped", inputSummary: { reason: "run_budget" }, costUsd: 0 });
    const doc = docOf(db);
    expect(doc.pages.filter((p) => hasCaptionArea(p.layout)).every((p) => p.caption?.source === "ai")).toBe(true);
    expect(db.book.ai_status).toBe("done");
  });

  it("SF6: no AI caption survived → Critic skipped ('no_captions'), no Critic call", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 40), {
      scenarioFor: (agent) => (agent === "caption_writer" ? "refusal" : "ok"),
    });
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "caption_writer_refusal" });
    expect(transport.count("critic")).toBe(0);
    const skipped = db.steps.filter((x) => x.status === "skipped");
    expect(skipped.map((x) => [x.agent, x.inputSummary.reason])).toEqual([["critic", "no_captions"]]);
    expect((db.run(s.runId).cursor as { criticFailures: number }).criticFailures).toBe(0);
  });

  it("SF7: run budget reached before captioning → no Caption Writer call, AI album without captions, run_budget", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    const pricey: OrchestratorDeps = {
      ...deps,
      getRunCostUsd: async (id) => (db.run(id).state === "captioning" ? 1.45 : deps.getRunCostUsd(id)),
    };
    const { last } = await runToEnd(pricey, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "run_budget" });
    expect(transport.count("caption_writer")).toBe(0);
    expect(transport.count("critic")).toBe(0);
    const doc = docOf(db);
    expect(doc.meta?.generator).toBe("ai");
    expect(doc.pages.every((p) => p.caption === null)).toBe(true);
    expect(db.book.ai_status).toBe("partial");
    const progress = (await orch.getProgress(s.runId, deps))!.progress;
    expect(progress.captionsDone).toBe(progress.captionsTotal); // the bar completes
  });

  it("SF7: paid books get the higher cap (same spend still captions)", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 40), { book: { is_paid: true, max_pages: 100 } });
    const s = await start(deps);
    const spent: OrchestratorDeps = { ...deps, getRunCostUsd: async () => 1.45 };
    const { last } = await runToEnd(spent, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(transport.count("caption_writer")).toBeGreaterThan(0);
    expect(transport.count("critic")).toBe(1);
    void db;
  });

  it("SF7: repair over budget → flagged captions become null without a repair call (run_budget)", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 60), {
      scenarioFor: (agent) => (agent === "caption_writer" || agent === "critic" ? "plant_bad_caption" : "ok"),
    });
    const s = await start(deps);
    const pricey: OrchestratorDeps = {
      ...deps,
      getRunCostUsd: async (id) => (db.run(id).state === "repairing" ? 1.49 : deps.getRunCostUsd(id)),
    };
    const { last } = await runToEnd(pricey, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "partial", errorCode: "run_budget" });
    expect(stepsOf(db, "caption_writer:repair:")).toHaveLength(0);
    expect(transport.count("critic")).toBe(1);
    const doc = docOf(db);
    for (const t of captionTexts(doc)) {
      expect(isPlantedMismatch(t)).toBe(false);
      expect(t).not.toBe(PLANTED_PRECHECK_TEXT.en);
    }
    expect(doc.pages.some((p) => hasCaptionArea(p.layout) && p.caption === null)).toBe(true);
    expect(db.book.ai_status).toBe("partial");
  });

  it("SF7: a normal run reads the run spend before caption / Critic calls and stays ok", async () => {
    const { db, deps } = setup(photos150().slice(0, 40));
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(db.costReads).toBeGreaterThanOrEqual(2);
  });

  it("skipped rows are idempotent: a tick dying right after the insert does not write a second row", async () => {
    const { db, deps } = setup(photos150().slice(0, 30), {
      scenarioFor: (agent) => (agent === "storyteller" ? "refusal" : "ok"),
    });
    const s = await start(deps);
    let skippedInserts = 0;
    let killed = false;
    const dying: OrchestratorDeps = {
      ...deps,
      stepLogger: (runId) => {
        const inner = deps.stepLogger(runId);
        return {
          ...inner,
          insertStep: async (row) => {
            if (row.status === "skipped") {
              skippedInserts++;
              if (!killed) {
                killed = true;
                db.now += orch.LEASE_SECONDS * 1000 + 1_000;
                db.stealLease(s.runId); // the tick's next checkpoint fails: it "dies" here
              }
            }
            return inner.insertStep(row);
          },
        };
      },
    };
    for (let t = 0; t < 20; t++) {
      const r = await orch.advance(s.runId, {}, dying);
      if ("leased" in r) db.run(s.runId).lease_until = null;
      if ("done" in r && r.done) break;
    }
    expect(db.run(s.runId).state).toBe("done");
    expect(killed).toBe(true);
    expect(skippedInserts).toBe(1);
    expect(db.steps.filter((x) => x.status === "skipped").map((x) => x.stepKey)).toEqual(["caption_writer:skipped"]);
  });
});

describe("orchestrator — rewrite runs are never build runs (M5 review B1)", () => {
  const RW = "99999999-9999-4999-8999-999999999999";
  /** A ✨ rewrite run row as create_rewrite_run_capped writes it (or, worst case, an old 'queued' one). */
  function addRewriteRun(db: FakeDb, state: string) {
    db.runs.set(RW, {
      id: RW,
      book_id: BOOK,
      user_id: USER,
      state,
      ai_status: null,
      progress: {},
      cursor: {},
      mode: "live",
      trigger: "rewrite",
      attempts: 0,
      error_code: null,
      started_at: new Date(db.now).toISOString(),
      finished_at: null,
      lease_until: null,
      lease_token: null,
      total_cost_usd: 0,
    } as FakeRun);
  }

  it.each(["rewriting", "queued"])("advance on a rewrite run (state %s) → notFound, never claimed, nothing run or written", async (state) => {
    const { db, transport, deps } = setup(photos150().slice(0, 20));
    addRewriteRun(db, state);
    const claims: string[] = [];
    const spied: OrchestratorDeps = {
      ...deps,
      claimRun: async (id, secs) => {
        claims.push(id);
        return deps.claimRun(id, secs);
      },
    };
    expect(await orch.advance(RW, {}, spied)).toEqual({ notFound: true });
    expect(claims).toEqual([]);
    const run = db.run(RW);
    expect(run).toMatchObject({ state, attempts: 0, lease_token: null, cursor: {}, trigger: "rewrite" });
    expect(transport.calls).toHaveLength(0);
    expect(db.steps).toHaveLength(0);
    expect(db.writes).toEqual([]);
    expect(db.bookStatusHistory).toEqual([]);
  });

  it("a run whose trigger turns into a rewrite between claim and tick is still refused (defence in depth)", async () => {
    const { db, transport, deps } = setup(photos150().slice(0, 20));
    addRewriteRun(db, "rewriting");
    let reads = 0;
    const flipping: OrchestratorDeps = {
      ...deps,
      // First read (pre-claim) says build; the tick's read sees the real row.
      getRunForTick: async (id) => {
        const row = await deps.getRunForTick(id);
        return row && reads++ === 0 ? { ...row, trigger: "build" } : row;
      },
    };
    expect(await orch.advance(RW, {}, flipping)).toEqual({ notFound: true });
    expect(transport.calls).toHaveLength(0);
    expect(db.writes).toEqual([]);
    expect(db.run(RW).lease_token).toBeNull(); // released
  });

  it("getProgress (GET /api/ai/runs/[id]) → null for a rewrite run, so the route answers 404", async () => {
    const { db, deps } = setup(photos150().slice(0, 20));
    addRewriteRun(db, "rewriting");
    expect(await orch.getProgress(RW, deps)).toBeNull();
    const s = await start(deps);
    expect(await orch.getProgress(s.runId, deps)).toMatchObject({ state: "queued" });
  });

  it("a build started while a rewrite is in flight is a normal build and runs to the end", async () => {
    const { db, deps } = setup(photos150().slice(0, 20));
    addRewriteRun(db, "rewriting");
    const s = await start(deps);
    const { last } = await runToEnd(deps, s.runId);
    expect(last).toMatchObject({ state: "done", aiStatus: "ok" });
    expect(db.run(RW)).toMatchObject({ state: "rewriting", attempts: 0 });
  });
});
