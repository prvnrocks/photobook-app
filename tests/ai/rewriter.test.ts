import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AGENT_TIMEOUT_MS, EFFORT } from "@/lib/ai/client";
import { buildCaptionContext, checkCaption } from "@/lib/ai/caption-check";
import {
  buildRewriterRequest,
  checkRewrite,
  detectCaptionLang,
  REWRITER_MAX_TOKENS,
  rewriteCaption,
  rewriteCheckContext,
  translateTarget,
  type RewriteInput,
} from "@/lib/ai/agents/rewriter";
import { REWRITE_POOLS, rewriterReplaySynth, SHORT_POOL } from "@/lib/ai/agents/rewriter-replay";
import { REWRITER_PROMPT_VERSION, REWRITER_SYSTEM_PROMPT, rewriterSystem } from "@/lib/ai/prompts/rewriter";
import type { AgentStepRecord, RunTotalsDelta, StepLogger } from "@/lib/ai/run-step";
import { REWRITE_INSTRUCTIONS, RewriteInstructionSchema, wordCount } from "@/lib/ai/schemas";
import type { AgentRequest, AgentResponse, AgentTransport } from "@/lib/ai/transport";
import { LiveTransport } from "@/lib/ai/transport-live";
import { getReplaySynth, ReplayTransport, type ReplayScenario } from "@/lib/ai/transport-replay";
import "@/lib/ai/agents/replay-synths";

const RUN_ID = "5b1e0a8c-3f2d-4e6a-9b7c-1d2e3f4a5b6c";
const fixture = (name: string) => readFileSync(join(process.cwd(), "tests", "fixtures", "ai", "rewriter", name), "utf8");

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

/** Real SDK client whose fetch returns recorded bodies in order (last repeats). */
function clientReturning(files: string[], bodies: Array<Record<string, unknown>> = []) {
  let i = 0;
  const fetchStub = async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const body = fixture(files[Math.min(i++, files.length - 1)]);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return new Anthropic({ apiKey: "test-key-not-real", maxRetries: 0, fetch: fetchStub as typeof fetch });
}

function live(files: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = new LiveTransport({ client: clientReturning(files, bodies), useServerFallbacks: true });
  return { transport, bodies };
}

const userText = (body: Record<string, unknown>) => (body.messages as Array<{ content: string }>)[0].content;

const CAPTION = "We danced together under the warm evening lights until the music finally stopped";
const DESCRIPTION = "Two people dancing under string lights at an outdoor party";
const MEMORY_NAME = "Layla";
const TITLE = "Our summer nights";

function input(over: Partial<RewriteInput> = {}): RewriteInput {
  return {
    text: CAPTION,
    instruction: "shorter",
    targetLang: "en",
    book: { occasion: "wedding", tone: "romantic", captionLang: "en", title: TITLE },
    // Chapter title is AI text: "Ahmed" here must never allowlist the name.
    doc: { chapters: [{ id: "c1", title: "Ahmed's evening", dateLabel: "12 Oct 2026", place: "Abu Dhabi" }] },
    pagePhotos: [
      {
        takenAt: "2026-10-12T21:10:00+04:00",
        place: "Abu Dhabi",
        analysis: { description: DESCRIPTION, scene: "group", mood: "joyful", quality: 8, coverWorthy: true },
      },
    ],
    memory: { v: 1, knownNames: [MEMORY_NAME], captionLength: "short" },
    ...over,
  };
}

let logger: MemoryLogger;
beforeEach(() => {
  logger = new MemoryLogger();
});

describe("rewriter prompt + request", () => {
  it("system prompt is stable, cached and free of per-call data", () => {
    const a = rewriterSystem();
    expect(a).toEqual(rewriterSystem());
    expect(a).toHaveLength(1);
    expect(a[0].cache_control).toEqual({ type: "ephemeral" });
    expect(REWRITER_PROMPT_VERSION).toBe(1);
    for (const instr of ["rewrite", "shorter", "translate", "tone:romantic", "tone:minimal"]) {
      expect(REWRITER_SYSTEM_PROMPT).toContain(instr);
    }
    expect(REWRITER_SYSTEM_PROMPT).toContain("18 words");
    expect(REWRITER_SYSTEM_PROMPT).not.toContain(MEMORY_NAME);
  });

  it("builds a text-only request with memory and notes in the user message", () => {
    const req = buildRewriterRequest(input(), { attempt: 1 });
    expect(req.agent).toBe("rewriter");
    expect(req.effort).toBe(EFFORT.rewriter);
    expect(req.effort).toBe("low");
    expect(req.maxTokens).toBe(REWRITER_MAX_TOKENS);
    expect(req.timeoutMs).toBe(AGENT_TIMEOUT_MS.rewriter);
    expect(AGENT_TIMEOUT_MS.rewriter).toBe(15_000);
    const msg = req.messages[0].content;
    expect(typeof msg).toBe("string"); // no images (D-037 #8)
    expect(msg).toContain(JSON.stringify(CAPTION));
    expect(msg).toContain(DESCRIPTION);
    expect(msg).toContain(`"${MEMORY_NAME}"`);
    expect(msg).toContain("instruction: shorter");
    expect(msg).toContain("target language: en (English)");
    expect(msg).not.toContain("previous attempt failed");
    expect(req.system[0].text).not.toContain(DESCRIPTION);
  });

  it("instruction list covers every tone; schema accepts only those", () => {
    expect(REWRITE_INSTRUCTIONS).toEqual([
      "rewrite",
      "shorter",
      "translate",
      "tone:romantic",
      "tone:fun",
      "tone:nostalgic",
      "tone:minimal",
    ]);
    expect(RewriteInstructionSchema.safeParse("tone:fun").success).toBe(true);
    expect(RewriteInstructionSchema.safeParse("tone:angry").success).toBe(false);
    expect(RewriteInstructionSchema.safeParse("longer").success).toBe(false);
  });

  it("detects the caption language and translate target", () => {
    expect(detectCaptionLang("Hello there")).toBe("en");
    expect(detectCaptionLang("ضحكات لا تنتهي")).toBe("ar");
    expect(translateTarget("Hello there")).toBe("ar");
    expect(translateTarget("ضحكات لا تنتهي مع Ahmed")).toBe("en");
  });
});

describe("rewriter pre-check", () => {
  it("allows names and numbers from the input caption, not from AI chapter titles", () => {
    const inp = input({ text: "Dinner with Omar on our 10th anniversary", instruction: "rewrite" });
    const ctx = rewriteCheckContext(inp);
    expect(checkRewrite("Our 10th anniversary dinner, Omar smiling", inp, ctx)).toEqual([]);
    expect(checkRewrite("Our anniversary dinner with Ahmed", inp, ctx).map((i) => i.code)).toContain("unknown_name");
    expect(checkRewrite("Dinner in Abu Dhabi with Layla", inp, ctx)).toEqual([]); // place + memory name
    expect(checkRewrite("Our 11th anniversary dinner", inp, ctx).map((i) => i.code)).toContain("unknown_number");
  });

  it("flags unchanged and not-shorter results", () => {
    const inp = input();
    const ctx = rewriteCheckContext(inp);
    expect(checkRewrite(`${CAPTION}.`, { ...inp, instruction: "rewrite" }, ctx).map((i) => i.code)).toContain("unchanged");
    expect(checkRewrite("We danced under the warm evening lights all night until the music finally stopped", inp, ctx).map((i) => i.code)).toContain(
      "not_shorter",
    );
    expect(checkRewrite("Dancing until the music stopped", inp, ctx)).toEqual([]);
  });

  it("enforces the target script", () => {
    const inp = input({ instruction: "translate", targetLang: "ar" });
    const ctx = rewriteCheckContext(inp);
    expect(checkRewrite("Dancing until the music stopped", inp, ctx).map((i) => i.code)).toContain("not_arabic");
    expect(checkRewrite("رقصنا حتى توقفت الموسيقى", inp, ctx)).toEqual([]);
  });
});

describe("rewriteCaption with recorded API responses", () => {
  it("EN shorter → ok, sends only allowed params with server-side fallbacks", async () => {
    const { transport, bodies } = live(["en-shorter.message.json"]);
    const r = await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: true, text: "Dancing under warm lights until the music stopped", lang: "en", attempts: 1 });
    if (r.ok) expect(wordCount(r.text)).toBeLessThan(wordCount(CAPTION));

    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(REWRITER_MAX_TOKENS);
    expect((body.output_config as { effort: string }).effort).toBe("low");
    expect(body.fallbacks).toBe("default");
    for (const forbidden of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "budget_tokens"]) {
      expect(body, forbidden).not.toHaveProperty(forbidden);
    }
    expect((body.messages as Array<{ role: string }>).every((m) => m.role === "user")).toBe(true);

    expect(logger.rows).toHaveLength(1);
    expect(logger.rows[0]).toMatchObject({ agent: "rewriter", stepKey: "rewriter", attempt: 1, status: "ok", error: null });
    expect(logger.rows[0].output).toEqual({ lang: "en", words: 8, chars: 49 });
  });

  it("EN → AR translate returns native Arabic script", async () => {
    const text = "Laughing together over a long family dinner";
    const inp = input({ text, instruction: "translate", targetLang: translateTarget(text), memory: null });
    const { transport, bodies } = live(["en-to-ar.message.json"]);
    const r = await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: inp });
    expect(r).toMatchObject({ ok: true, lang: "ar" });
    if (r.ok) {
      expect(detectCaptionLang(r.text)).toBe("ar");
      expect(r.text).not.toMatch(/[A-Za-z]/);
      expect(checkCaption(r.text, buildCaptionContext({ lang: "ar" }))).toEqual([]);
    }
    expect(userText(bodies[0])).toContain("target language: ar (Arabic)");
    expect(userText(bodies[0])).toContain("instruction: translate");
    expect(logger.rows[0].inputSummary).toMatchObject({ instruction: "translate", sourceLang: "en", targetLang: "ar" });
  });

  it("tone change → ok", async () => {
    const inp = input({ text: "Quiet smiles around the table", instruction: "tone:fun" });
    const { transport, bodies } = live(["tone-fun.message.json"]);
    const r = await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: inp });
    expect(r).toMatchObject({ ok: true, text: "Smiles, snacks and zero chill at this table", lang: "en" });
    expect(userText(bodies[0])).toContain("instruction: tone:fun");
  });

  it("refusal → code refusal, no retry", async () => {
    const { transport, bodies } = live(["refusal.message.json", "en-shorter.message.json"]);
    const r = await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: false, code: "refusal", attempts: 1 });
    expect(bodies).toHaveLength(1);
    expect(logger.rows).toHaveLength(1);
    expect(logger.rows[0]).toMatchObject({ status: "refused", stopReason: "refusal", output: null });
    expect(logger.rows[0].error).toBe("refusal: general_harms");
  });

  it("max_tokens → code max_tokens, no retry, truncated JSON never used", async () => {
    const { transport, bodies } = live(["max-tokens.message.json", "en-shorter.message.json"]);
    const r = await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: false, code: "max_tokens", attempts: 1 });
    expect(bodies).toHaveLength(1);
    expect(logger.rows[0]).toMatchObject({ status: "error", stopReason: "max_tokens", error: "max_tokens" });
  });

  it("pre-check fail → one retry with issue codes → fail = rewrite_unusable", async () => {
    const { transport, bodies } = live(["precheck-fail-1.message.json", "precheck-fail-2.message.json", "en-shorter.message.json"]);
    const r = await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: false, code: "rewrite_unusable", attempts: 2 });
    expect(bodies).toHaveLength(2);
    expect(userText(bodies[0])).not.toContain("previous attempt failed");
    expect(userText(bodies[1])).toContain("previous attempt failed checks: unknown_name");
    expect(logger.rows.map((x) => [x.stepKey, x.attempt, x.status])).toEqual([
      ["rewriter", 1, "ok"],
      ["rewriter", 2, "ok"],
    ]);
    expect(logger.rows[0].output).toMatchObject({ issues: ["unknown_name"] });
    expect(logger.rows[1].output).toMatchObject({ issues: expect.arrayContaining(["too_long", "unknown_name"]) });
    expect(logger.rows[1].inputSummary).toMatchObject({ retryIssues: ["unknown_name"] });
    if (!r.ok) expect(r.costUsd).toBeGreaterThan(0);
  });

  it("pre-check fail → retry succeeds", async () => {
    const { transport } = live(["precheck-fail-1.message.json", "en-shorter.message.json"]);
    const r = await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: true, attempts: 2, text: "Dancing under warm lights until the music stopped" });
  });

  it("bad input never calls the model", async () => {
    const { transport, bodies } = live(["en-shorter.message.json"]);
    const cases: RewriteInput[] = [
      input({ text: "   " }),
      input({ instruction: "translate", targetLang: "en" }), // already English
      input({ instruction: "louder" as never }),
    ];
    for (const c of cases) {
      expect(await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: c })).toMatchObject({ ok: false, code: "bad_input", attempts: 0 });
    }
    expect(bodies).toHaveLength(0);
    expect(logger.rows).toHaveLength(0);
  });

  it("log payload never contains caption text, photo notes, memory values or title", async () => {
    const { transport } = live(["precheck-fail-1.message.json", "en-shorter.message.json"]);
    await rewriteCaption({ ctx: { transport, logger }, runId: RUN_ID, input: input() });
    const dump = JSON.stringify({ rows: logger.rows, totals: logger.totals });
    for (const secret of [
      CAPTION,
      "danced",
      "Dancing",
      "Ahmed",
      "Paris",
      DESCRIPTION,
      "string lights",
      MEMORY_NAME,
      TITLE,
      "Abu Dhabi",
    ]) {
      expect(dump, secret).not.toContain(secret);
    }
    expect(logger.rows[0].inputSummary).toEqual({
      promptVersion: 1,
      instruction: "shorter",
      sourceLang: "en",
      targetLang: "en",
      inputWords: 13,
      inputChars: CAPTION.length,
      photoNotes: 1,
      memoryKeys: ["captionLength", "knownNames"],
      retryIssues: [],
    });
  });
});

// ---------------------------------------------------------------------------- replay mode

class Recording implements AgentTransport {
  readonly kind = "replay" as const;
  requests: AgentRequest<unknown>[] = [];
  constructor(private readonly inner: AgentTransport) {}
  parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
    this.requests.push(req as AgentRequest<unknown>);
    return this.inner.parse(req);
  }
}
const replay = (scenario: ReplayScenario = "ok") =>
  new Recording(new ReplayTransport({ scenario, fixturesDir: "/nonexistent-fixtures", synths: { rewriter: rewriterReplaySynth } }));

describe("rewriter replay", () => {
  it("is registered with the replay registry", () => {
    expect(getReplaySynth("rewriter")).toBe(rewriterReplaySynth);
  });

  it("every pool line passes the pre-check in its language", () => {
    for (const lang of ["en", "ar"] as const) {
      const ctx = buildCaptionContext({ lang });
      const lines = [...Object.values(REWRITE_POOLS[lang]).flat(), ...SHORT_POOL[lang]];
      for (const l of lines) expect(checkCaption(l, ctx), l).toEqual([]);
      expect(new Set(lines).size).toBe(lines.length);
    }
  });

  it("is deterministic and works offline", async () => {
    const a = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input({ instruction: "rewrite" }) });
    const b = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input({ instruction: "rewrite" }) });
    expect(a.ok).toBe(true);
    expect(a).toEqual(b);
  });

  it("shorter is actually shorter; translate yields the target script; tone uses its pool", async () => {
    const short = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input() });
    expect(short.ok).toBe(true);
    if (short.ok) {
      expect(wordCount(short.text)).toBeLessThan(wordCount(CAPTION));
      expect(short.text.length).toBeLessThan(CAPTION.length);
    }

    const ar = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input({ instruction: "translate", targetLang: "ar" }) });
    expect(ar).toMatchObject({ ok: true, lang: "ar" });
    if (ar.ok) expect(detectCaptionLang(ar.text)).toBe("ar");

    const arText = "ضحكنا كثيراً حول طاولة العشاء الطويلة";
    const en = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input({ text: arText, instruction: "translate", targetLang: "en" }) });
    expect(en).toMatchObject({ ok: true, lang: "en" });
    if (en.ok) expect(en.text).not.toMatch(/[؀-ۿ]/);

    const fun = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input({ instruction: "tone:fun" }) });
    if (fun.ok) expect(REWRITE_POOLS.en.fun).toContain(fun.text);
    else throw new Error("tone rewrite failed in replay");
  });

  it("a retry (attempt 2) picks a different line", () => {
    const meta = { instruction: "rewrite", targetLang: "en", tone: "fun", inputWords: 5, inputChars: 30, inputHash: 7 };
    const ctx = { scenario: "ok" as const, request: {} as AgentRequest<unknown> };
    const one = rewriterReplaySynth({ ...meta, attempt: 1 }, ctx);
    const two = rewriterReplaySynth({ ...meta, attempt: 2 }, ctx);
    expect(one).not.toEqual(two);
    expect(rewriterReplaySynth({ ...meta, attempt: 1 }, ctx)).toEqual(one);
  });

  it("replay refusal / invalid map to refusal / rewrite_unusable", async () => {
    const refused = await rewriteCaption({ ctx: { transport: replay("refusal"), logger }, runId: RUN_ID, input: input() });
    expect(refused).toMatchObject({ ok: false, code: "refusal" });

    const t = replay("invalid");
    const invalid = await rewriteCaption({ ctx: { transport: t, logger }, runId: RUN_ID, input: input() });
    expect(invalid).toMatchObject({ ok: false, code: "rewrite_unusable", attempts: 2 });
    expect(t.requests).toHaveLength(2);
  });

  it("transient transport errors are retried, then reported as retryable", async () => {
    const t = replay("rate_limit");
    const r = await rewriteCaption({
      ctx: { transport: t, logger, retry: { retries: 1, sleep: async () => {} } },
      runId: RUN_ID,
      input: input(),
    });
    expect(r).toMatchObject({ ok: false, code: "rate_limited", retryable: true, attempts: 1 });
    expect(t.requests).toHaveLength(2);
    expect(logger.rows).toHaveLength(1);
  });
});
