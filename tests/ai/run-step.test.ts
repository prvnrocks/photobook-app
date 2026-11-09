import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { costUsd } from "@/lib/ai/cost";
import { runAgentStep, type AgentStepRecord, type RunTotalsDelta, type StepLogger } from "@/lib/ai/run-step";
import {
  CuratorBatchAiSchema,
  CuratorBatchStrictSchema,
  type CuratorBatch,
} from "@/lib/ai/schemas";
import { cachedSystem, TransportError, type AgentTransport } from "@/lib/ai/transport";
import { ReplayTransport, type ReplayScenario, type ReplaySynth } from "@/lib/ai/transport-replay";

const ALIASES = ["p1", "p2", "p3"];

// Valid for "ok"; strict-invalid (quality 42 passes the lean AI schema) for "invalid".
const curatorSynth: ReplaySynth = (meta, { scenario }) => ({
  photos: (meta.aliases as string[]).map((photoId, i) => ({
    photoId,
    description: `SECRET description of ${photoId}`,
    scene: "group",
    peopleCount: 2,
    mood: "joyful",
    quality: scenario === "invalid" ? 42 : 5 + i,
    coverWorthy: i === 0,
    keep: i !== 2,
    dropReason: i === 2 ? "blurry" : null,
  })),
});

class MemoryLogger implements StepLogger {
  rows: AgentStepRecord[] = [];
  totals: Array<{ runId: string; delta: RunTotalsDelta }> = [];
  async insertStep(row: AgentStepRecord) {
    this.rows.push(row);
  }
  async addRunTotals(runId: string, delta: RunTotalsDelta) {
    this.totals.push({ runId, delta });
  }
}

const toLogOutput = (b: CuratorBatch) =>
  b.photos.map((p) => ({ id: p.photoId, keep: p.keep, reason: p.dropReason, q: p.quality, scene: p.scene, cover: p.coverWorthy }));

let logger: MemoryLogger;
let sleeps: number[];

beforeEach(() => {
  logger = new MemoryLogger();
  sleeps = [];
});

function run(transport: AgentTransport, retries?: number, extra: { deadline?: number; timeoutMs?: number; clock?: () => number } = {}) {
  return runAgentStep({
    runId: "run-1",
    agent: "curator",
    stepKey: "curator:0",
    inputSummary: { aliases: ALIASES, count: ALIASES.length },
    request: {
      agent: "curator",
      system: cachedSystem("Stable curator prompt. ".repeat(120)),
      messages: [{ role: "user", content: "Analyse p1..p3" }],
      schema: CuratorBatchAiSchema,
      effort: "low",
      maxTokens: 3000,
      timeoutMs: extra.timeoutMs,
      scenarioMeta: { aliases: ALIASES },
    },
    strictSchema: CuratorBatchStrictSchema,
    toLogOutput,
    transport,
    logger,
    retry: {
      retries,
      backoffMs: (n) => 100 * (n + 1),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      deadline: extra.deadline,
    },
    now: extra.clock ?? (() => 1000),
  });
}

const replay = (scenario: ReplayScenario | ReplayScenario[]) =>
  new ReplayTransport({
    scenario,
    fixturesDir: mkdtempSync(join(tmpdir(), "rs-")),
    synths: { curator: curatorSynth },
  });

function onlyRow(): AgentStepRecord {
  expect(logger.rows).toHaveLength(1);
  expect(logger.totals).toHaveLength(1);
  const row = logger.rows[0];
  expect(logger.totals[0]).toEqual({
    runId: "run-1",
    delta: {
      costUsd: row.costUsd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
    },
  });
  // D-027: no descriptions in the trace.
  expect(JSON.stringify(row)).not.toContain("SECRET");
  return row;
}

describe("runAgentStep (replay)", () => {
  it("ok → typed data + one ok row with compact output and cost", async () => {
    const res = await run(replay("ok"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.photos.map((p) => p.photoId)).toEqual(ALIASES);
    expect(res.data.photos[0].description).toContain("SECRET"); // returned to the caller, not logged

    const row = onlyRow();
    expect(row).toMatchObject({
      runId: "run-1",
      agent: "curator",
      stepKey: "curator:0",
      attempt: 1,
      retries: 0,
      status: "ok",
      stopReason: "end_turn",
      error: null,
      model: "claude-opus-5-5",
      inputSummary: { aliases: ALIASES, count: 3 },
    });
    expect(row.output).toEqual([
      { id: "p1", keep: true, reason: null, q: 5, scene: "group", cover: true },
      { id: "p2", keep: true, reason: null, q: 6, scene: "group", cover: false },
      { id: "p3", keep: false, reason: "blurry", q: 7, scene: "group", cover: false },
    ]);
    expect(row.cacheWriteTokens).toBeGreaterThan(0);
    expect(row.costUsd).toBe(costUsd("claude-opus-5-5", res.usage));
    expect(row.costUsd).toBeGreaterThan(0);
    expect(res.costUsd).toBe(row.costUsd);
  });

  it("refusal → refused, no parsed data, tokens still billed", async () => {
    const res = await run(replay("refusal"));
    expect(res).toMatchObject({ ok: false, status: "refused", code: "refusal", stopCategory: "general_harms", retryable: false });
    const row = onlyRow();
    expect(row).toMatchObject({ status: "refused", stopReason: "refusal", output: null });
    expect(row.error).toMatch(/^refusal/);
    expect(row.costUsd).toBeGreaterThan(0);
    expect(sleeps).toEqual([]); // refusals are never retried
  });

  it("max_tokens → error max_tokens (checked before parsed output)", async () => {
    const res = await run(replay("max_tokens"));
    expect(res).toMatchObject({ ok: false, status: "error", code: "max_tokens" });
    const row = onlyRow();
    expect(row).toMatchObject({ status: "error", stopReason: "max_tokens", error: "max_tokens", outputTokens: 3000 });
  });

  it("rate_limit then ok → retried with backoff, one ok row with retries=1", async () => {
    const t = replay(["rate_limit", "ok"]);
    const res = await run(t);
    expect(res.ok).toBe(true);
    expect(t.callCount).toBe(2);
    expect(sleeps).toEqual([100]);
    expect(onlyRow()).toMatchObject({ status: "ok", retries: 1 });
  });

  it("server_error exhausted → error row after 1 + 2 attempts, zero cost", async () => {
    const t = replay("server_error");
    const res = await run(t);
    expect(res).toMatchObject({ ok: false, status: "error", code: "server_error", retryable: true, costUsd: 0 });
    expect(t.callCount).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    const row = onlyRow();
    expect(row).toMatchObject({ status: "error", error: "server_error", retries: 2, stopReason: null, inputTokens: 0, costUsd: 0, latencyMs: 0 });
  });

  it("deadline: no retry when backoff + request timeout would pass it (lease budget)", async () => {
    const t = replay("rate_limit");
    // now 1000 + backoff 100 + timeout 60 000 ≥ deadline 61 000 → no retry
    const res = await run(t, 2, { deadline: 61_000, timeoutMs: 60_000 });
    expect(res).toMatchObject({ ok: false, code: "rate_limited", retryable: true });
    expect(t.callCount).toBe(1);
    expect(sleeps).toEqual([]);
    expect(onlyRow()).toMatchObject({ retries: 0, error: "rate_limited" });
  });

  it("deadline: retries while they fit, stops at the first that does not", async () => {
    let clock = 0;
    const inner = replay("server_error");
    // every call "takes" its full 10 s timeout
    const slow: AgentTransport = {
      kind: "replay",
      parse: async (req) => {
        clock += 10_000;
        return inner.parse(req);
      },
    };
    const res = await run(slow, 5, { deadline: 35_000, timeoutMs: 10_000, clock: () => clock });
    expect(res).toMatchObject({ ok: false, code: "server_error" });
    // 10 s + 0.1 s + 10 s < 35 s → retry; 20 s + 0.2 s + 10 s < 35 s → retry; 30 s + … ≥ 35 s → stop
    expect(inner.callCount).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(onlyRow().retries).toBe(2);
  });

  it("retries: 0 → single attempt", async () => {
    const t = replay("rate_limit");
    const res = await run(t, 0);
    expect(res).toMatchObject({ ok: false, code: "rate_limited" });
    expect(t.callCount).toBe(1);
    onlyRow();
  });

  it("strict-invalid output → schema_invalid with issue count only", async () => {
    const res = await run(replay("invalid"));
    expect(res).toMatchObject({ ok: false, status: "error", code: "schema_invalid" });
    const row = onlyRow();
    expect(row.error).toBe("schema_invalid: 3 issue(s)");
    expect(row.output).toBeNull();
    expect(row.stopReason).toBe("end_turn");
  });

  it("AI-schema-invalid output → parse_failed", async () => {
    const t = new ReplayTransport({ scenario: "invalid", fixturesDir: mkdtempSync(join(tmpdir(), "rs-")) });
    const res = await run(t);
    expect(res).toMatchObject({ ok: false, code: "parse_failed" });
    expect(onlyRow().error).toBe("parse_failed");
  });

  it("non-retryable transport errors are not retried; unknown throws are caught", async () => {
    const bad: AgentTransport = {
      kind: "live",
      parse: async () => {
        throw new TransportError("auth", "no key");
      },
    };
    expect(await run(bad)).toMatchObject({ ok: false, code: "auth", retryable: false });
    expect(sleeps).toEqual([]);

    logger = new MemoryLogger();
    const weird: AgentTransport = {
      kind: "live",
      parse: async () => {
        throw new Error("boom");
      },
    };
    expect(await run(weird)).toMatchObject({ ok: false, code: "unknown" });
    onlyRow();
  });

  it("logger failures propagate (no silent calls)", async () => {
    logger.insertStep = async () => {
      throw new Error("db down");
    };
    await expect(run(replay("ok"))).rejects.toThrow("db down");
  });
});
