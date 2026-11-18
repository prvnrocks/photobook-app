// M30 T11 — ✨ rewrite / shorter / translate / tone for a CHAPTER DESCRIPTION through the existing
// Rewriter agent (target "description"). Replay / hand-written answers only — no live call.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { replayDescription } from "@/lib/ai/agents/caption-writer-replay";
import {
  buildRewriterRequest,
  checkRewrite,
  REWRITER_DESCRIPTION_MAX_TOKENS,
  REWRITER_MAX_TOKENS,
  rewriteCaption,
  rewriteCheckContext,
  type RewriteInput,
} from "@/lib/ai/agents/rewriter";
import { rewriterReplaySynth, SHORT_DESCRIPTION_POOL } from "@/lib/ai/agents/rewriter-replay";
import { buildCaptionContext, checkDescription } from "@/lib/ai/caption-check";
import {
  REWRITER_DESCRIPTIONS_PROMPT_VERSION,
  REWRITER_DESCRIPTIONS_SYSTEM_PROMPT,
  REWRITER_SYSTEM_PROMPT,
  rewriterSystemFor,
} from "@/lib/ai/prompts/rewriter";
import { chapterRewriteContext, isDescriptionRewrite, RewriteBodySchema } from "@/lib/ai/rewrite-request";
import type { AgentStepRecord, RunTotalsDelta, StepLogger } from "@/lib/ai/run-step";
import {
  REWRITE_INSTRUCTIONS,
  RewriteDescriptionOutputAiSchema,
  RewriteOutputAiSchema,
  wordCount,
} from "@/lib/ai/schemas";
import { ReplayTransport, type ReplaySynth } from "@/lib/ai/transport-replay";
import type { BookDoc } from "@/lib/book/types";
import "@/lib/ai/agents/replay-synths";

const RUN_ID = "5b1e0a8c-3f2d-4e6a-9b7c-1d2e3f4a5b6c";
const ARABIC = /[؀-ۿ]/;
const DESCRIPTION = "SECRETDESC the whole family gathered by the water for a long slow lunch. Nobody looked at a clock, and the afternoon drifted by until the light turned gold over the bay and the tables emptied.";
const NOTE = "SECRETNOTE a long table set outdoors beside the sea";
const TITLE = "Our summer by the bay";
const MEMORY_NAME = "Layla";
const CAPTION_IN_BOOK = "Salt air and a table full of stories";
const OTHER_DESCRIPTION = replayDescription("m9", "en");

class MemoryLogger implements StepLogger {
  rows: AgentStepRecord[] = [];
  totals: RunTotalsDelta[] = [];
  async insertStep(row: AgentStepRecord) {
    this.rows.push(row);
  }
  async addRunTotals(runId: string, delta: RunTotalsDelta) {
    if (runId) this.totals.push(delta);
  }
}

function input(over: Partial<RewriteInput> = {}): RewriteInput {
  return {
    target: "description",
    text: DESCRIPTION,
    instruction: "rewrite",
    targetLang: "en",
    book: { occasion: "travel", tone: "nostalgic", captionLang: "en", title: TITLE },
    // The chapter title is AI text: "Ahmed" here must never allowlist the name.
    doc: { chapters: [{ id: "c1", title: "Ahmed's long lunch", dateLabel: "12 Oct 2026", place: "Abu Dhabi" }] },
    chapter: { title: "Ahmed's long lunch", dateLabel: "12 Oct 2026", place: "Abu Dhabi" },
    captions: [CAPTION_IN_BOOK],
    otherDescriptions: [OTHER_DESCRIPTION],
    pagePhotos: [
      { takenAt: "2026-10-12T13:10:00+04:00", place: "Abu Dhabi", analysis: { description: NOTE, scene: "food", mood: "calm", quality: 8, coverWorthy: false } },
    ],
    memory: { v: 1, knownNames: [MEMORY_NAME] },
    ...over,
  };
}

const replay = (synth?: ReplaySynth) =>
  new ReplayTransport({ scenario: "ok", fixturesDir: "/nonexistent", ...(synth ? { synths: { rewriter: synth } } : {}) });
const words = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? "Slow" : "light")).join(" ");

let logger: MemoryLogger;
beforeEach(() => {
  logger = new MemoryLogger();
});

describe("rewriter — chapter description variant (prompt, schema, request)", () => {
  it("variant prompt = base text + DESCRIPTIONS section, its own cached block; the base blocks are the base text", () => {
    expect(REWRITER_DESCRIPTIONS_SYSTEM_PROMPT.startsWith(`${REWRITER_SYSTEM_PROMPT}\n\nDESCRIPTIONS\n`)).toBe(true);
    const section = REWRITER_DESCRIPTIONS_SYSTEM_PROMPT.slice(REWRITER_SYSTEM_PROMPT.length);
    for (const phrase of ['"target: chapter description"', "CHAPTER PHOTOS", "CURRENT DESCRIPTION", "25 to 45 words", "never more than 45 words", "this replaces rule 2", "Do not repeat the chapter title", "too_long = over 45 words", "never take names from it"]) {
      expect(section, phrase).toContain(phrase);
    }
    expect(rewriterSystemFor(true)).toEqual([{ type: "text", text: REWRITER_DESCRIPTIONS_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(rewriterSystemFor(false).map((b) => b.text)).toEqual([REWRITER_SYSTEM_PROMPT]);
    expect(REWRITER_DESCRIPTIONS_PROMPT_VERSION).toBe(1);
  });

  it("variant schema: one `text` field like the base one, with the 45-word hint", () => {
    const base = zodOutputFormat(RewriteOutputAiSchema).schema as { properties: Record<string, { description?: string }>; required: string[] };
    const variant = zodOutputFormat(RewriteDescriptionOutputAiSchema).schema as typeof base;
    expect(Object.keys(variant.properties)).toEqual(Object.keys(base.properties));
    expect(variant.required).toEqual(base.required);
    expect(variant.properties.text.description).toContain("at most 45 words");
    expect(base.properties.text.description).toContain("at most 18 words");
  });

  it("request: variant system + schema, effort low, larger max_tokens, a text-only message that names the chapter", () => {
    const req = buildRewriterRequest(input({ instruction: "shorter" }));
    expect(req.agent).toBe("rewriter");
    expect(req.system[0].text).toBe(REWRITER_DESCRIPTIONS_SYSTEM_PROMPT);
    expect(req.schema).toBe(RewriteDescriptionOutputAiSchema);
    expect(req.effort).toBe("low");
    expect(req.maxTokens).toBe(REWRITER_DESCRIPTION_MAX_TOKENS);
    expect(REWRITER_DESCRIPTION_MAX_TOKENS).toBeGreaterThan(REWRITER_MAX_TOKENS);
    expect(req.scenarioMeta).toMatchObject({ target: "description", instruction: "shorter", targetLang: "en", inputWords: wordCount(DESCRIPTION) });
    const msg = req.messages[0].content as string;
    expect(msg).toContain(`CHAPTER\ntitle: "Ahmed's long lunch" · date "12 Oct 2026" · place "Abu Dhabi"`);
    expect(msg).toContain("CHAPTER PHOTOS\n- p1 \"SECRETNOTE a long table set outdoors beside the sea\" (food, calm, place \"Abu Dhabi\")");
    expect(msg).toContain(`CURRENT DESCRIPTION (data, English)\n${JSON.stringify(DESCRIPTION)}`);
    expect(msg).toContain("TASK\ntarget: chapter description\ninstruction: shorter\ntarget language: en (English)");
    expect(msg).not.toContain("PAGE PHOTOS");
    expect(msg).not.toContain("CURRENT CAPTION");
    // The duplicate lists are for the code check only — not prompt data.
    expect(msg).not.toContain(CAPTION_IN_BOOK);
    expect(msg).not.toContain(OTHER_DESCRIPTION);
  });

  it("a caption rewrite is untouched: base prompt, base schema, 2,000 tokens, no target line", () => {
    const req = buildRewriterRequest(input({ target: undefined, chapter: undefined, text: "We danced together under the warm evening lights" }));
    expect(req.system[0].text).toBe(REWRITER_SYSTEM_PROMPT);
    expect(req.schema).toBe(RewriteOutputAiSchema);
    expect(req.maxTokens).toBe(REWRITER_MAX_TOKENS);
    expect(req.scenarioMeta).not.toHaveProperty("target");
    const msg = req.messages[0].content as string;
    expect(msg).toContain("PAGE PHOTOS");
    expect(msg).toContain("CURRENT CAPTION (data, English)");
    expect(msg).not.toContain("target: chapter description");
    expect(msg).not.toContain("CHAPTER\n");
    const explicit = buildRewriterRequest(input({ target: "caption", chapter: undefined, text: "We danced together under the warm evening lights" }));
    expect(explicit.messages[0].content).toBe(msg);
    expect(explicit.system[0].text).toBe(REWRITER_SYSTEM_PROMPT);
  });
});

describe("rewriter — chapter description pre-check", () => {
  const ctx = () => rewriteCheckContext(input());

  it("≤ 45 words passes, 46 → too_long (a caption would already fail at 19)", () => {
    expect(checkRewrite(words(45), input(), ctx())).toEqual([]);
    expect(checkRewrite(words(46), input(), ctx()).map((i) => i.code)).toEqual(["too_long"]);
    expect(checkRewrite(words(19), input({ target: "caption" }), ctx()).map((i) => i.code)).toEqual(["too_long"]);
  });

  it("invented names are flagged; names and numbers already in the description, the user's title, places and typed names are allowed — never the AI chapter title", () => {
    const code = (t: string, over: Partial<RewriteInput> = {}) => checkRewrite(t, input(over), rewriteCheckContext(input(over))).map((i) => i.code);
    expect(code("A long lunch by the water, and later a walk with Omar through the streets of Lisbon.")).toEqual(["unknown_name"]);
    expect(code("A long lunch by the water with Ahmed, slow and warm.")).toEqual(["unknown_name"]); // only in the AI title
    expect(code("A long lunch by the water with Layla in Abu Dhabi, slow and warm.")).toEqual([]);
    const withName = "Lunch with Omar took all afternoon. Everyone stayed until 7 when the light went gold over the bay.";
    expect(code("A slow lunch with Omar, and at 7 the light turned gold.", { text: withName })).toEqual([]);
    expect(code("A slow lunch with Omar, and at 9 the light turned gold.", { text: withName })).toEqual(["unknown_number"]);
  });

  it("unchanged / not_shorter / duplicates (a caption, another description, the chapter title)", () => {
    const code = (t: string, over: Partial<RewriteInput> = {}) => checkRewrite(t, input(over), rewriteCheckContext(input(over))).map((i) => i.code);
    expect(code(DESCRIPTION.toUpperCase())).toContain("unchanged");
    expect(code(replayDescription("m3", "en"), { instruction: "shorter", text: "A slow lunch by the bay." })).toEqual(["not_shorter"]);
    expect(code(`${CAPTION_IN_BOOK}. That is how the whole long lunch felt to all of us.`)).toEqual(["duplicate"]);
    expect(code(OTHER_DESCRIPTION)).toEqual(["duplicate"]);
    expect(code("Dinner by the water was slow and warm, the kind of evening nobody wants to end.", { chapter: { title: "Dinner by the water", dateLabel: "", place: null } })).toEqual(["duplicate"]);
  });

  it("target script: Arabic for 'ar' (Latin words flagged), no Arabic in 'en'", () => {
    const ar = input({ targetLang: "ar", instruction: "translate" });
    expect(checkRewrite(replayDescription("m2", "ar"), ar, rewriteCheckContext(ar))).toEqual([]);
    expect(checkRewrite(replayDescription("m2", "en"), ar, rewriteCheckContext(ar)).map((i) => i.code)).toContain("not_arabic");
    expect(checkRewrite(replayDescription("m2", "ar"), input(), ctx()).map((i) => i.code)).toContain("arabic_in_english");
  });
});

describe("rewriteCaption — target description (replay)", () => {
  it("rewrite: ok, ≤ 45 words, different from the input, one logged step with counts only", async () => {
    const r = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: true, lang: "en", attempts: 1 });
    if (!r.ok) return;
    expect(wordCount(r.text)).toBeLessThanOrEqual(45);
    expect(wordCount(r.text)).toBeGreaterThanOrEqual(25);
    expect(r.text).not.toBe(DESCRIPTION);
    expect(checkDescription(r.text, buildCaptionContext({ lang: "en" }))).toEqual([]);
    expect(logger.rows).toHaveLength(1);
    expect(logger.rows[0]).toMatchObject({ agent: "rewriter", stepKey: "rewriter", attempt: 1, status: "ok" });
    expect(logger.rows[0].inputSummary).toMatchObject({ target: "description", descriptionsPromptVersion: 1, instruction: "rewrite", sourceLang: "en", targetLang: "en", photoNotes: 1 });
    expect(logger.rows[0].output).toEqual({ lang: "en", words: wordCount(r.text), chars: Array.from(r.text).length });
    const dump = JSON.stringify(logger.rows);
    for (const secret of ["SECRETDESC", "SECRETNOTE", MEMORY_NAME, TITLE, r.text, "Ahmed"]) expect(dump).not.toContain(secret);
  });

  it("every instruction works: shorter is shorter, translate gives the other script, tone stays ≤ 45 words", async () => {
    for (const instruction of REWRITE_INSTRUCTIONS) {
      const targetLang = instruction === "translate" ? "ar" : "en";
      const r = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input({ instruction, targetLang }) });
      expect(r.ok, instruction).toBe(true);
      if (!r.ok) continue;
      expect(wordCount(r.text)).toBeLessThanOrEqual(45);
      expect(ARABIC.test(r.text)).toBe(instruction === "translate");
      if (instruction === "shorter") {
        expect(wordCount(r.text)).toBeLessThan(wordCount(DESCRIPTION));
        expect(Array.from(r.text).length).toBeLessThan(Array.from(DESCRIPTION).length);
      }
    }
    // Arabic → English.
    const back = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input({ text: replayDescription("m4", "ar"), instruction: "translate", targetLang: "en", book: { occasion: "travel", tone: "nostalgic", captionLang: "ar", title: null } }) });
    expect(back).toMatchObject({ ok: true, lang: "en" });
    if (back.ok) expect(ARABIC.test(back.text)).toBe(false);
  });

  it("a 46-word answer is never returned: one retry with the code, then ok — or rewrite_unusable", async () => {
    let calls = 0;
    const longThenOk: ReplaySynth = (meta, ctx) => (++calls === 1 ? { text: words(46) } : rewriterReplaySynth(meta, ctx));
    const transport = replay(longThenOk);
    const seen: string[] = [];
    const spy = { kind: transport.kind, parse: ((req) => (seen.push(req.messages[0].content as string), transport.parse(req))) as typeof transport.parse };
    const r = await rewriteCaption({ ctx: { transport: spy, logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    if (r.ok) expect(wordCount(r.text)).toBeLessThanOrEqual(45);
    expect(seen[1]).toContain("previous attempt failed checks: too_long");
    expect(logger.rows.map((x) => x.attempt)).toEqual([1, 2]);
    expect(logger.rows[0].output).toEqual({ lang: "en", words: 46, chars: words(46).length, issues: ["too_long"] });

    const always = await rewriteCaption({ ctx: { transport: replay(() => ({ text: words(46) })), logger: new MemoryLogger() }, runId: RUN_ID, input: input() });
    expect(always).toEqual({ ok: false, code: "rewrite_unusable", retryable: false, attempts: 2, costUsd: expect.any(Number) });
  });

  it("an answer over 400 units is rejected (never clipped into the book)", async () => {
    const huge = Array.from({ length: 40 }, () => "extraordinarily").join(" ");
    const r = await rewriteCaption({ ctx: { transport: replay(() => ({ text: `A ${huge}` })), logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: false, code: "rewrite_unusable" });
    expect(logger.rows[0].output).toMatchObject({ issues: ["too_long"] });
  });

  it("an invented name is flagged and retried", async () => {
    let calls = 0;
    const synth: ReplaySynth = (meta, ctx) =>
      ++calls === 1 ? { text: "A long lunch by the water, and later a walk with Omar through the streets of Lisbon." } : rewriterReplaySynth(meta, ctx);
    const r = await rewriteCaption({ ctx: { transport: replay(synth), logger }, runId: RUN_ID, input: input() });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(logger.rows[0].output).toMatchObject({ issues: ["unknown_name"] });
    expect(logger.rows[1].inputSummary).toMatchObject({ retryIssues: ["unknown_name"] });
    expect(JSON.stringify(logger.rows)).not.toContain("Lisbon");
  });

  it("shorter on a description nothing in the pool is shorter than → not_shorter → rewrite_unusable", async () => {
    const r = await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: input({ instruction: "shorter", text: "A calm slow lunch." }) });
    expect(r).toMatchObject({ ok: false, code: "rewrite_unusable", attempts: 2 });
  });

  it("refusal / max_tokens / bad input behave like a caption rewrite", async () => {
    const refusal = await rewriteCaption({ ctx: { transport: new ReplayTransport({ scenario: "refusal", fixturesDir: "/nonexistent" }), logger }, runId: RUN_ID, input: input() });
    expect(refusal).toMatchObject({ ok: false, code: "refusal", attempts: 1 });
    const max = await rewriteCaption({ ctx: { transport: new ReplayTransport({ scenario: "max_tokens", fixturesDir: "/nonexistent" }), logger }, runId: RUN_ID, input: input() });
    expect(max).toMatchObject({ ok: false, code: "max_tokens", attempts: 1 });
    const before = logger.rows.length;
    for (const bad of [input({ text: "  " }), input({ target: "bogus" as never }), input({ instruction: "translate", targetLang: "en" })]) {
      expect(await rewriteCaption({ ctx: { transport: replay(), logger }, runId: RUN_ID, input: bad })).toMatchObject({ ok: false, code: "bad_input", attempts: 0 });
    }
    expect(logger.rows).toHaveLength(before);
  });

  it("replay pools: every short description passes the check and is ≤ 14 words", () => {
    for (const lang of ["en", "ar"] as const) {
      for (const line of SHORT_DESCRIPTION_POOL[lang]) {
        expect(checkDescription(line, buildCaptionContext({ lang }))).toEqual([]);
        expect(wordCount(line)).toBeLessThanOrEqual(15);
        expect(ARABIC.test(line)).toBe(lang === "ar");
      }
    }
  });
});

describe("rewrite request — chapter description body + server-side context", () => {
  const BOOK = "11111111-1111-4111-8111-111111111111";
  const ok = (b: unknown) => RewriteBodySchema.safeParse(b).success;

  it("the request shape: { bookId, target: 'description', chapterId, instruction, text ≤ 400 code points }", () => {
    const body = { bookId: BOOK, target: "description", chapterId: "c1", instruction: "rewrite", text: DESCRIPTION };
    const parsed = RewriteBodySchema.parse(body);
    expect(isDescriptionRewrite(parsed)).toBe(true);
    expect(ok({ ...body, instruction: "shorter" })).toBe(true);
    expect(ok({ ...body, instruction: "translate" })).toBe(true);
    expect(ok({ ...body, instruction: "tone:fun" })).toBe(true);
    expect(ok({ ...body, text: "ب".repeat(400) })).toBe(true);
    expect(ok({ ...body, text: "ب".repeat(401) })).toBe(false);
    expect(ok({ ...body, text: "   " })).toBe(false);
    expect(ok({ ...body, target: "heading" })).toBe(false);
    expect(ok({ ...body, chapterId: "" })).toBe(false);
    expect(ok({ ...body, pageId: "pg1" })).toBe(false); // strict: never both ids
    expect(ok({ bookId: BOOK, target: "description", instruction: "rewrite", text: DESCRIPTION })).toBe(false);
    expect(ok({ ...body, instruction: "longer" })).toBe(false);
  });

  it("the caption body is unchanged (no target; 200 code points)", () => {
    const body = { bookId: BOOK, pageId: "pg1", instruction: "rewrite", text: "A caption" };
    const parsed = RewriteBodySchema.parse(body);
    expect(isDescriptionRewrite(parsed)).toBe(false);
    expect(ok({ ...body, text: "x".repeat(200) })).toBe(true);
    expect(ok({ ...body, text: "x".repeat(201) })).toBe(false);
    expect(ok({ ...body, target: "caption" })).toBe(false);
    expect(ok({ ...body, extra: 1 })).toBe(false);
  });

  it("chapterRewriteContext: the chapter, its photos (description page first, ≤ 8, unique), the book's captions, other descriptions", () => {
    const crop = { x: 0.5, y: 0.5, zoom: 1 };
    const slot = (photoId: string | null) => ({ photoId, crop });
    const caption = (text: string) => ({ text, font: "Poppins", align: "center" as const, source: "ai" as const });
    const doc = {
      chapters: [
        { id: "c1", title: "By the bay", dateLabel: "12 Oct 2026", place: "Abu Dhabi", description: { text: "First one.", source: "ai" as const } },
        { id: "c2", title: "Old town", dateLabel: "", place: null, description: { text: "Second one.", source: "user" as const } },
        { id: "c3", title: "Last day", dateLabel: "", place: null },
      ],
      pages: [
        { id: "p1", chapterId: "c1", layout: "mg-p-full", slots: [slot("a")], caption: null },
        { id: "p2", chapterId: "c1", layout: "mg-p-two-panel", slots: [slot("b"), slot("c")], caption: caption("Salt air and stories") },
        { id: "p3", chapterId: "c1", layout: "mg-p-six-hero", slots: ["d", "e", "f", "g", "h", "a"].map(slot), caption: null },
        { id: "p4", chapterId: "c2", layout: "mg-p-one-headline", slots: [slot("z"), slot(null)], caption: caption("Narrow streets") },
      ],
    } as unknown as Pick<BookDoc, "chapters" | "pages">;
    expect(chapterRewriteContext(doc, "c1")).toEqual({
      chapter: { title: "By the bay", dateLabel: "12 Oct 2026", place: "Abu Dhabi" },
      photoIds: ["b", "c", "a", "d", "e", "f", "g", "h"],
      captions: ["Salt air and stories", "Narrow streets"],
      otherDescriptions: ["Second one."],
    });
    expect(chapterRewriteContext(doc, "c2")?.photoIds).toEqual(["z"]);
    expect(chapterRewriteContext(doc, "c3")).toMatchObject({ photoIds: [], otherDescriptions: ["First one.", "Second one."] });
    expect(chapterRewriteContext(doc, "nope")).toBeNull();
    expect(chapterRewriteContext(null, "c1")).toBeNull();
  });
});
