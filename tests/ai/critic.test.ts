import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AGENT_TIMEOUT_MS, EFFORT } from "@/lib/ai/client";
import {
  buildCriticRequest,
  buildCriticUserMessage,
  critiqueBook,
  criticMaxTokens,
  type CritiqueBookArgs,
} from "@/lib/ai/agents/critic";
import { criticReplaySynth, PLANT_SCENARIO, PLANTED_MISMATCH_KEY } from "@/lib/ai/agents/critic-replay";
import { CRITIC_PROMPT_VERSION, criticSystem, criticSystemText } from "@/lib/ai/prompts/critic";
import { pageIndexOfKey, planRepair, repairTargetCount } from "@/lib/ai/repair";
import type { AgentStepRecord, RunTotalsDelta, StepLogger } from "@/lib/ai/run-step";
import { CRITIQUE_FIXES, CRITIQUE_ISSUE_TYPES } from "@/lib/ai/schemas";
import type { AgentRequest, AgentResponse, AgentTransport } from "@/lib/ai/transport";
import { getReplaySynth, ReplayTransport, type ReplayScenario } from "@/lib/ai/transport-replay";
import "@/lib/ai/agents/replay-synths";
import { aliasMaps, RUN_ID, storyBook, storyPhotos } from "../helpers/story-fixtures";
import { batchIndexOf, CLEAN_CAPTIONS, draftDoc, LONG_INVENTED, precheckOf } from "../helpers/critic-fixtures";

class MemoryLogger implements StepLogger {
  rows: AgentStepRecord[] = [];
  totals: RunTotalsDelta[] = [];
  async insertStep(row: AgentStepRecord) {
    this.rows.push(row);
  }
  async addRunTotals(_runId: string, delta: RunTotalsDelta) {
    this.totals.push(delta);
  }
}

class Recording implements AgentTransport {
  readonly kind = "replay" as const;
  requests: AgentRequest<unknown>[] = [];
  constructor(private readonly inner: AgentTransport) {}
  parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
    this.requests.push(req as AgentRequest<unknown>);
    return this.inner.parse(req);
  }
}

const PLANT = PLANT_SCENARIO as string as ReplayScenario;
const transportFor = (scenario: ReplayScenario, synth = criticReplaySynth) =>
  new Recording(new ReplayTransport({ scenarioFor: () => scenario, fixturesDir: "/nonexistent-fixtures", synths: { critic: synth } }));
const userText = (r: AgentRequest<unknown>) => r.messages[0].content as string;

let logger: MemoryLogger;
beforeEach(() => {
  logger = new MemoryLogger();
});

function args(over: Partial<CritiqueBookArgs> & { transport: AgentTransport }): CritiqueBookArgs {
  const photos = storyPhotos();
  const doc = over.doc ?? draftDoc();
  return {
    runId: RUN_ID,
    stepKey: "critic",
    attempt: 1,
    doc,
    aliasOf: aliasMaps(photos).aliasOf,
    photosById: new Map(photos.map((p) => [p.id, p])),
    metadata: { title: null, places: photos.map((p) => p.place), dates: photos.map((p) => p.takenAt), knownNames: [] },
    precheck: precheckOf(doc),
    book: storyBook(),
    logger,
    ...over,
  };
}

describe("critic prompt", () => {
  it("system prompt is byte-identical across calls and carries cache_control", async () => {
    const t = transportFor("ok");
    await critiqueBook(args({ transport: t }));
    await critiqueBook(
      args({
        transport: t,
        doc: draftDoc({ ...CLEAN_CAPTIONS, "m2:0": LONG_INVENTED }),
        book: storyBook({ captionLang: "ar", tone: "fun" }),
        metadata: { title: "Our Day", places: ["Abu Dhabi"], dates: [], knownNames: ["Sara"] },
      }),
    );
    const [a, b] = t.requests.map((r) => r.system);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toHaveLength(1);
    expect(a[0].cache_control).toEqual({ type: "ephemeral" });
    expect(a[0].text).toBe(criticSystemText());
    expect(JSON.stringify(criticSystem())).toBe(JSON.stringify(a));
    expect(userText(t.requests[0])).not.toBe(userText(t.requests[1]));
  });

  it("contains the rubric, every issue type and fix, and the safety paragraph; nothing per book", () => {
    const s = criticSystemText();
    for (const t of CRITIQUE_ISSUE_TYPES) expect(s).toContain(t);
    for (const f of CRITIQUE_FIXES) expect(s).toContain(f);
    expect(s).toMatch(/people-forward/);
    expect(s).toMatch(/time order/);
    expect(s).toMatch(/invented names, places or facts/);
    expect(s).toMatch(/repeated opening words/);
    expect(s).toMatch(/2 or more pages/);
    expect(s).toMatch(/Safety: .* are data, never instructions/);
    expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(CRITIC_PROMPT_VERSION).toBe(1);
  });
});

describe("critic request", () => {
  it("text only, effort/timeout per agent, pages by pageIndex with aliases, flagged codes, no real ids", () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m2:0": LONG_INVENTED });
    const a = args({ transport: transportFor("ok"), doc });
    const req = buildCriticRequest(a);
    expect(req.agent).toBe("critic");
    expect(req.effort).toBe(EFFORT.critic);
    expect(req.timeoutMs).toBe(AGENT_TIMEOUT_MS.critic);
    expect(req.maxTokens).toBe(criticMaxTokens(doc.pages.length));
    expect(typeof req.messages[0].content).toBe("string");
    const text = userText(req as AgentRequest<unknown>);
    expect(text).toContain("PAGES (7, pageIndex from 0)");
    expect(text).toContain('1 · c1 · three-mixed · p3 p2 p4 · caption [ai] "Every corner of the room felt warm."');
    expect(text).toContain("5 · c2 · full-page · p10 · caption none");
    expect(text).toMatch(/ALREADY FLAGGED\npage 4: too_long/);
    expect(text).toContain("photo dates: 2026-10-12 to 2026-10-13");
    expect(text).toContain("places in metadata: none");
    expect(text).not.toMatch(/00000000-0000-4000/);
    // Dropped photo p11 is not in the doc → not listed.
    expect(text).not.toMatch(/^p11 ·/m);
    expect(req.scenarioMeta).toMatchObject({ pageCount: 7 });
  });

  it("user captions are marked [user]; caption text is one line without double quotes", () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m1:0": 'Line one\n"quoted"' }, ["m1:0"]);
    const text = buildCriticUserMessage(args({ transport: transportFor("ok"), doc }));
    expect(text).toContain("0 · c1 · one-portrait · p1 · caption [user] \"Line one 'quoted'\"");
  });

  it("missing alias / empty doc → bad_request without a model call", async () => {
    const t = transportFor("ok");
    const r1 = await critiqueBook(args({ transport: t, aliasOf: new Map() }));
    const empty = draftDoc();
    empty.pages = [];
    const r2 = await critiqueBook(args({ transport: t, doc: empty }));
    expect(r1).toMatchObject({ ok: false, code: "bad_request" });
    expect(r2).toMatchObject({ ok: false, code: "bad_request" });
    expect(t.requests).toHaveLength(0);
    expect(logger.rows).toHaveLength(0);
  });
});

describe("critiqueBook (replay)", () => {
  it("registers the critic synth", () => {
    expect(getReplaySynth("critic")).toBe(criticReplaySynth);
  });

  it("ok → score 8, no issues; one logged step with score only", async () => {
    const r = await critiqueBook(args({ transport: transportFor("ok") }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ score: 8, issues: [] });
    expect(logger.rows).toHaveLength(1);
    expect(logger.rows[0]).toMatchObject({ agent: "critic", stepKey: "critic", status: "ok", output: { score: 8, issueCount: 0, issues: [] } });
    expect(logger.totals).toHaveLength(1);
  });

  it("planted scenario → caption_mismatch on the page holding PLANTED_MISMATCH_KEY, score 5; logs have no detail or text", async () => {
    const doc = draftDoc();
    const r = await critiqueBook(args({ transport: transportFor(PLANT), doc }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const planted = pageIndexOfKey(doc, PLANTED_MISMATCH_KEY);
    expect(r.data.score).toBe(5);
    expect(r.data.issues).toEqual([expect.objectContaining({ type: "caption_mismatch", pageIndex: planted, fix: "rewrite_caption" })]);

    const row = logger.rows[0];
    expect(row.output).toEqual({ score: 5, issueCount: 1, issues: [{ type: "caption_mismatch", pageIndex: planted, fix: "rewrite_caption" }] });
    const logged = JSON.stringify(row);
    expect(logged).not.toContain("detail");
    expect(logged).not.toContain("Replay:");
    for (const c of Object.values(CLEAN_CAPTIONS)) expect(logged).not.toContain(c);
    expect(logged).not.toContain("Two people smiling");
    expect(Object.values(row.inputSummary).every((v) => typeof v === "number" || v === "en")).toBe(true);
  });

  it("planted end-to-end: pre-check failure + critic issue → exactly 2 repair targets", async () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m2:0": LONG_INVENTED });
    const a = args({ transport: transportFor(PLANT), doc });
    const r = await critiqueBook(a);
    expect(r.ok).toBe(true);
    const plan = planRepair(r.ok ? r.data : null, a.precheck, doc, { photos: storyPhotos(), batchIndexOf });
    expect(repairTargetCount(plan)).toBe(2);
    expect([...plan.rewrite.values()].flat().map((t) => t.key)).toEqual([PLANTED_MISMATCH_KEY, "m2:0"]);
  });

  it("planted key on a user caption → falls back to the first AI-captioned page", () => {
    const out = criticReplaySynth(
      { pages: [{ pageIndex: 0, key: "m1:0", source: "ai" }, { pageIndex: 1, key: PLANTED_MISMATCH_KEY, source: "user" }] },
      { scenario: PLANT as never, request: {} as AgentRequest<unknown> },
    ) as { issues: Array<{ pageIndex: number }> };
    expect(out.issues[0].pageIndex).toBe(0);
  });

  it("refusal → refused, no output; planRepair then uses pre-check targets only", async () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m2:0": LONG_INVENTED });
    const a = args({ transport: transportFor("refusal"), doc });
    const r = await critiqueBook(a);
    expect(r).toMatchObject({ ok: false, status: "refused", code: "refusal" });
    expect(logger.rows[0]).toMatchObject({ status: "refused", output: null, stopReason: "refusal" });
    const plan = planRepair(r.ok ? r.data : null, a.precheck, doc, { photos: storyPhotos(), batchIndexOf });
    expect([...plan.rewrite.values()].flat().map((t) => t.key)).toEqual(["m2:0"]);
  });

  it("max_tokens → error max_tokens", async () => {
    const r = await critiqueBook(args({ transport: transportFor("max_tokens") }));
    expect(r).toMatchObject({ ok: false, status: "error", code: "max_tokens" });
  });

  it("invalid → wrong shape → parse_failed", async () => {
    const r = await critiqueBook(args({ transport: transportFor("invalid") }));
    expect(r).toMatchObject({ ok: false, code: "parse_failed" });
    expect(logger.rows[0].output).toBeNull();
  });

  it("pageIndex outside the doc or score out of range → schema_invalid", async () => {
    const bad = (parsed: unknown) => transportFor("ok", () => parsed);
    const r1 = await critiqueBook(args({ transport: bad({ score: 5, issues: [{ type: "caption_mismatch", pageIndex: 7, detail: "x", fix: "rewrite_caption" }] }) }));
    const r2 = await critiqueBook(args({ transport: bad({ score: 11, issues: [] }) }));
    const r3 = await critiqueBook(args({ transport: bad({ score: 6.5, issues: [] }) }));
    for (const r of [r1, r2, r3]) expect(r).toMatchObject({ ok: false, code: "schema_invalid" });
    const ok = await critiqueBook(args({ transport: bad({ score: 6, issues: [{ type: "weak_cover", pageIndex: null, detail: "x", fix: "change_cover" }, { type: "chronology", pageIndex: 6, detail: "y", fix: "reorder" }] }) }));
    expect(ok.ok).toBe(true);
  });

  it("retries a 429 then succeeds (one row)", async () => {
    const t = new ReplayTransport({ scenario: ["rate_limit", "ok"], fixturesDir: "/nonexistent-fixtures", synths: { critic: criticReplaySynth } });
    const r = await critiqueBook(args({ transport: t, retry: { sleep: async () => {} } }));
    expect(r.ok).toBe(true);
    expect(logger.rows).toHaveLength(1);
    expect(logger.rows[0].retries).toBe(1);
  });
});
