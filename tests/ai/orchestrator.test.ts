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

type FakeRun = RunForTick & { lease_until: number | null; lease_token: string | null; total_cost_usd: number };

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
        for (const r of this.runs.values()) {
          if (r.book_id === input.bookId && r.state !== "done" && r.state !== "failed") return { error: "already_running" };
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
