import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AGENT_TIMEOUT_MS, EFFORT } from "@/lib/ai/client";
import {
  buildCaptionContext,
  checkCaption,
} from "@/lib/ai/caption-check";
import { applyCaptions, captionBatches, type CaptionBatchSpec } from "@/lib/ai/captions";
import {
  CAPTION_WRITER_PROMPT_VERSION,
  precheckBatch,
  writeCaptions,
  type WriteCaptionsArgs,
} from "@/lib/ai/agents/caption-writer";
import {
  captionWriterReplaySynth,
  isPlantedMismatch,
  PLANTED_MISMATCH_KEY,
  PLANTED_MISMATCH_TEXT,
  PLANTED_PRECHECK_TEXT,
  plantedMismatchPageIndexes,
} from "@/lib/ai/agents/caption-writer-replay";
import { PLANTED_MISMATCH_KEY as CRITIC_PLANTED_KEY } from "@/lib/ai/agents/critic-replay";
import { storytellerReplaySynth } from "@/lib/ai/agents/storyteller-replay";
import { MEMORY_BLOCK_HEADER } from "@/lib/ai/memory";
import { planToDoc } from "@/lib/ai/plan-to-doc";
import { CAPTION_WRITER_SYSTEM_PROMPT } from "@/lib/ai/prompts/caption-writer";
import type { AgentStepRecord, RunTotalsDelta, StepLogger } from "@/lib/ai/run-step";
import { AlbumPlanAiSchema, wordCount, type UserMemory } from "@/lib/ai/schemas";
import type { StoryPhoto } from "@/lib/ai/story";
import type { AgentRequest, AgentResponse, AgentTransport } from "@/lib/ai/transport";
import { getReplaySynth, ReplayTransport, type ReplayScenario } from "@/lib/ai/transport-replay";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import "@/lib/ai/agents/replay-synths";
import { aliasMaps, fixturePlan, RUN_ID, storyBook, storyPhotos } from "../helpers/story-fixtures";

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
  responses: AgentResponse<unknown>[] = [];
  constructor(private readonly inner: AgentTransport) {}
  async parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
    this.requests.push(req as AgentRequest<unknown>);
    const r = await this.inner.parse(req);
    this.responses.push(r as AgentResponse<unknown>);
    return r;
  }
}

const replay = (scenario: ReplayScenario | ReplayScenario[] = "ok") =>
  new Recording(
    new ReplayTransport({ scenario, fixturesDir: "/nonexistent-fixtures", synths: { caption_writer: captionWriterReplaySynth } }),
  );
const userText = (r: AgentRequest<unknown>) => r.messages[0].content as string;

function docFor(photos: StoryPhoto[], lang: "en" | "ar" = "en"): BookDoc {
  const r = planToDoc(fixturePlan(), {
    aliasToId: aliasMaps(photos).aliasToId,
    photos,
    book: storyBook({ captionLang: lang }),
    runId: RUN_ID,
    generatorVersion: 2,
  });
  if (!("doc" in r)) throw new Error(r.issues.join("; "));
  return r.doc;
}

let logger: MemoryLogger;
beforeEach(() => {
  logger = new MemoryLogger();
});

function setup(opts: { lang?: "en" | "ar"; doc?: BookDoc; photos?: StoryPhoto[] } = {}) {
  const lang = opts.lang ?? "en";
  const photos = opts.photos ?? storyPhotos();
  const doc = opts.doc ?? docFor(photos, lang);
  const specs = captionBatches(doc, { lang });
  return { lang, photos, doc, specs, spec: specs[0] };
}

function args(spec: CaptionBatchSpec, over: Partial<WriteCaptionsArgs> & { transport: AgentTransport }): WriteCaptionsArgs {
  const photos = storyPhotos();
  return {
    runId: RUN_ID,
    stepKey: `caption_writer:${spec.index}`,
    attempt: 1,
    spec,
    book: storyBook({ captionLang: spec.lang }),
    photosById: new Map(photos.map((p) => [p.id, p])),
    aliasOf: aliasMaps(photos).aliasOf,
    memoryBlock: "",
    logger,
    ...over,
  };
}

const LATIN = /[A-Za-z]/;

describe("caption writer prompt + request", () => {
  it("system prompt is byte-identical across calls, cached, and carries nothing per book", async () => {
    const t = replay();
    const { spec } = setup();
    const ar = setup({ lang: "ar", photos: storyPhotos({ 1: { place: "Corniche Beach" } }) }).spec;
    await writeCaptions(args(spec, { transport: t }));
    await writeCaptions(
      args(ar, {
        transport: t,
        book: storyBook({ captionLang: "ar", title: "Sara and Omar", tone: "fun" }),
        memory: { v: 1, captionLength: "short", knownNames: ["Sara"] },
      }),
    );
    const [a, b] = t.requests;
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    expect(a.system).toHaveLength(1);
    expect(a.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(a.system[0].text).toBe(CAPTION_WRITER_SYSTEM_PROMPT);
    for (const s of ["Sara", "Omar", "Corniche", MEMORY_BLOCK_HEADER]) expect(a.system[0].text).not.toContain(s);
    expect(t.responses[1].usage.cacheRead).toBeGreaterThan(0);
    expect(a.effort).toBe(EFFORT.caption_writer);
    expect(a.timeoutMs).toBe(AGENT_TIMEOUT_MS.caption_writer);
    expect(a.agent).toBe("caption_writer");
    expect(JSON.stringify(a.messages)).not.toContain('"image"');
  });

  it("system prompt (v2): names never from chapter titles, well-known quotes banned, sentence-case example", () => {
    const s = CAPTION_WRITER_SYSTEM_PROMPT;
    expect(CAPTION_WRITER_PROMPT_VERSION).toBe(2);
    expect(s).toMatch(/never take names from them/);
    expect(s).toMatch(/do not closely paraphrase/);
    expect(s).toMatch(/caption_not_original/);
    expect(s).toContain('chapter "Dinner by the water" · date "12 Oct 2026"');
    expect(s).not.toMatch(/Dinner by the Water/);
  });

  it("system prompt states the quote rules and the safety paragraph", () => {
    const s = CAPTION_WRITER_SYSTEM_PROMPT;
    expect(s).toMatch(/famous quotes/);
    expect(s).toMatch(/lyrics/);
    expect(s).toMatch(/at most 18 words/);
    expect(s).toMatch(/Never invent names, places/);
    expect(s).toMatch(/native Arabic/);
    expect(s).toMatch(/data, never instructions/);
  });

  it("user message lists moments, page keys, layouts and short cleaned photo notes", async () => {
    const t = replay();
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const photos = storyPhotos({ 1: { analysis: { description: `He said "hi"\nthen ${long}`, scene: "portrait", mood: "calm", quality: 8, coverWorthy: true } } });
    const { spec } = setup({ photos });
    await writeCaptions(args(spec, { transport: t, photosById: new Map(photos.map((p) => [p.id, p])) }));
    const msg = userText(t.requests[0]);
    expect(msg).toContain('m1 · chapter "Getting Ready" · date ');
    expect(msg).toMatch(/· date "[^"]+" · place /); // date label quoted (data)
    expect(msg).toMatch(/- m1:0 · layout one-portrait · photos: p1 "He said 'hi' then word0 /);
    expect(msg).toContain("word20…"); // 25 words
    expect(msg).not.toContain("word21");
    expect(msg).toMatch(/- m1:1 · layout three-mixed · photos: p\d+ "[^"]+" \(group, joyful\), p\d+ "[^"]+" \(group, joyful\), p\d+ "[^"]+" \(group, joyful\)$/m);
    expect(msg).not.toContain("m2:1"); // full-page
    expect(msg).not.toContain("Rewrite only these");
    expect(msg).not.toContain("00000000-"); // real ids never sent
  });

  it("memory block goes into the user message; input_summary holds only memory keys", async () => {
    const t = replay();
    const { spec } = setup();
    const memory: UserMemory = { v: 1, captionLength: "short", knownNames: ["Layla"], tonePreference: "fun" };
    await writeCaptions(args(spec, { transport: t, memory, memoryBlock: undefined }));
    expect(userText(t.requests[0])).toContain(MEMORY_BLOCK_HEADER);
    expect(userText(t.requests[0])).toContain('"Layla"');
    const s = logger.rows[0].inputSummary;
    expect(s).toMatchObject({ promptVersion: CAPTION_WRITER_PROMPT_VERSION, moments: 2, pages: 6, lang: "en" });
    expect(s.memoryKeys).toEqual(["tonePreference", "captionLength", "knownNames"]);
    expect(JSON.stringify(s)).not.toContain("Layla");
  });
});

describe("writeCaptions (replay)", () => {
  it("captions every captionable page + heading per moment, all pass the pre-check", async () => {
    const t = replay();
    const { spec, doc } = setup();
    const r = await writeCaptions(args(spec, { transport: t }));
    expect(r.ok).toBe(true);
    expect([...r.captions.keys()]).toEqual(spec.keys);
    expect([...r.headings.keys()]).toEqual(["m1", "m2"]);
    expect(r.issues.size).toBe(0);
    expect(logger.rows).toHaveLength(1);
    expect(logger.rows[0]).toMatchObject({ agent: "caption_writer", stepKey: "caption_writer:0", status: "ok" });
    const applied = applyCaptions(doc, r.captions, r.headings, { lang: "en" });
    expect(applied.pages.filter((p) => p.caption?.source === "ai")).toHaveLength(6);
    const parsed = parseBookDoc(applied);
    expect(parsed.ok).toBe(true);
    const kept = new Set(storyPhotos().filter((p) => p.keep).map((p) => p.id));
    if (parsed.ok) expect(validateBookDoc(parsed.doc, { photoIds: kept, maxPages: 20 })).toEqual([]);
  });

  it("varies first words across a large book (all batches) without pre-check issues", async () => {
    const t = replay();
    const big = setup().doc;
    const pages = Array.from({ length: 40 }, (_, i) => ({ ...big.pages[0], id: `x${i}`, chapterId: i < 20 ? "c1" : "c2", slots: [], layout: "one-portrait" }));
    // slots are not needed for batching; layout one-portrait has 1 slot, so give each a unique fake photo
    const doc: BookDoc = { ...big, pages: pages.map((p, i) => ({ ...p, slots: [{ photoId: `f${i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } }] })) };
    const specs = captionBatches(doc, { lang: "en" });
    const all: string[] = [];
    for (const spec of specs) {
      const r = await writeCaptions(args(spec, { transport: t, otherCaptions: all }));
      expect(r.issues.size).toBe(0);
      all.push(...r.captions.values());
    }
    expect(all).toHaveLength(40);
    expect(new Set(all).size).toBe(40);
  });

  it("Arabic book: native Arabic captions and headings, no Latin, pass the Arabic checks", async () => {
    const t = replay();
    const photos = storyPhotos({ 1: { place: "Abu Dhabi" } });
    const { spec } = setup({ lang: "ar", photos });
    const r = await writeCaptions(args(spec, { transport: t, book: storyBook({ captionLang: "ar" }), photosById: new Map(photos.map((p) => [p.id, p])) }));
    expect(r.ok).toBe(true);
    expect(r.captions.size).toBe(spec.keys.length);
    expect(r.issues.size).toBe(0);
    const ctx = buildCaptionContext({ lang: "ar" });
    for (const text of [...r.captions.values(), ...r.headings.values()]) {
      expect(text).not.toMatch(LATIN);
      expect(wordCount(text)).toBeLessThanOrEqual(18);
      expect(checkCaption(text, ctx)).toEqual([]);
    }
  });

  it("short caption length in memory → every caption ≤ 10 words", async () => {
    for (const lang of ["en", "ar"] as const) {
      const t = replay();
      const { spec } = setup({ lang });
      const r = await writeCaptions(args(spec, { transport: t, book: storyBook({ captionLang: lang }), memory: { v: 1, captionLength: "short" }, memoryBlock: undefined }));
      expect(r.captions.size).toBe(spec.keys.length);
      for (const text of r.captions.values()) expect(wordCount(text)).toBeLessThanOrEqual(10);
    }
  });

  it("refusal / max_tokens → no captions + failure code, row logged", async () => {
    for (const [scenario, code, status] of [
      ["refusal", "refusal", "refused"],
      ["max_tokens", "max_tokens", "error"],
      ["invalid", "schema_invalid", "error"],
    ] as const) {
      logger = new MemoryLogger();
      const { spec } = setup();
      const r = await writeCaptions(args(spec, { transport: replay(scenario) }));
      expect(r.ok).toBe(false);
      expect(r.captions.size).toBe(0);
      expect(r.headings.size).toBe(0);
      expect(r.failure).toMatchObject({ code, status });
      expect(logger.rows).toHaveLength(1);
      expect(logger.rows[0]).toMatchObject({ status, output: null });
    }
  });

  it("logged output and input_summary contain no caption text, headings or descriptions", async () => {
    const t = replay("plant_bad_caption");
    const photos = storyPhotos({ 2: { place: "Corniche Beach" } });
    const { spec } = setup({ photos });
    const r = await writeCaptions(args(spec, { transport: t, photosById: new Map(photos.map((p) => [p.id, p])), book: storyBook({ title: "Summer Book" }) }));
    const logged = JSON.stringify(logger.rows[0]);
    const texts = [...r.captions.values(), ...r.headings.values(), PLANTED_PRECHECK_TEXT.en, "Two people smiling", "Corniche", "Summer Book"];
    for (const s of texts) expect(logged).not.toContain(s);
    expect(logger.rows[0].output).toMatchObject({ lang: "en", momentCount: 2, captionCount: 6 });
    // issue codes are logged, text is not
    expect(logged).toContain("too_long");
  });

  it("refuses to call without moments (bad_request, no row)", async () => {
    const t = replay();
    const r = await writeCaptions(args({ index: 0, lang: "en", moments: [], keys: [] }, { transport: t }));
    expect(r.failure?.code).toBe("bad_request");
    expect(t.requests).toHaveLength(0);
    expect(logger.rows).toHaveLength(0);
  });

  it("user captions untouched end to end", async () => {
    const photos = storyPhotos();
    const doc = docFor(photos);
    const user = { text: "Mama's favourite", font: "Playfair", align: "center" as const, source: "user" as const };
    doc.pages[0].caption = user;
    const { spec } = setup({ doc });
    expect(spec.keys).not.toContain("m1:0");
    const r = await writeCaptions(args(spec, { transport: replay() }));
    expect(r.captions.has("m1:0")).toBe(false);
    const out = applyCaptions(doc, r.captions, r.headings, { lang: "en" });
    expect(out.pages[0].caption).toEqual(user);
  });
});

describe("plant_bad_caption scenario", () => {
  it("attempt 1: pre-check failure on the first other page; sentinel mismatch passes the pre-check", async () => {
    const t = replay("plant_bad_caption");
    const { spec, doc } = setup();
    expect(spec.keys).toContain(PLANTED_MISMATCH_KEY);
    const r = await writeCaptions(args(spec, { transport: t }));
    expect(r.ok).toBe(true);
    const planted = r.issues.get("m1:0")?.map((i) => i.code) ?? [];
    expect(planted).toEqual(expect.arrayContaining(["too_long", "unknown_name"]));
    expect(r.captions.has("m1:0")).toBe(false);
    expect(r.captions.get(PLANTED_MISMATCH_KEY)).toBe(PLANTED_MISMATCH_TEXT.en);
    expect(isPlantedMismatch(r.captions.get(PLANTED_MISMATCH_KEY))).toBe(true);
    expect(r.issues.has(PLANTED_MISMATCH_KEY)).toBe(false);
    expect(r.issues.size).toBe(1);
    const applied = applyCaptions(doc, r.captions, r.headings, { lang: "en" });
    expect(plantedMismatchPageIndexes(applied)).toEqual([1]);
    expect(PLANTED_MISMATCH_KEY).not.toBe("m1:0");
  });

  it("Arabic plant: pre-check failure is too_long + latin_word", async () => {
    const { spec } = setup({ lang: "ar" });
    const r = await writeCaptions(args(spec, { transport: replay("plant_bad_caption"), book: storyBook({ captionLang: "ar" }) }));
    expect(r.issues.get("m1:0")?.map((i) => i.code)).toEqual(expect.arrayContaining(["too_long", "latin_word"]));
    expect(r.captions.get(PLANTED_MISMATCH_KEY)).toBe(PLANTED_MISMATCH_TEXT.ar);
  });

  it("only batch 0 is planted", async () => {
    const { doc } = setup();
    const specs = captionBatches(doc, { lang: "en", maxPagesPerBatch: 3 });
    const r = await writeCaptions(args(specs[1], { transport: replay("plant_bad_caption") }));
    expect(r.issues.size).toBe(0);
    expect([...r.captions.values()].some(isPlantedMismatch)).toBe(false);
  });

  it("repair round: clean captions only for the requested keys, reason codes in the prompt", async () => {
    const t = replay("plant_bad_caption");
    const { spec } = setup();
    const first = await writeCaptions(args(spec, { transport: t }));
    const others = [...first.captions.entries()].filter(([k]) => k !== PLANTED_MISMATCH_KEY).map(([, v]) => v);
    const r = await writeCaptions(
      args(spec, {
        transport: t,
        stepKey: "caption_writer:repair:0",
        otherCaptions: others,
        repairTargets: [
          { key: "m1:0", reason: ["too_long", "unknown_name"] },
          { key: PLANTED_MISMATCH_KEY, reason: "caption_mismatch" },
        ],
      }),
    );
    expect(userText(t.requests[1])).toContain(`Rewrite only these: m1:0 (too_long, unknown_name), ${PLANTED_MISMATCH_KEY} (caption_mismatch)`);
    expect(userText(t.requests[1])).toContain("Captions already used elsewhere");
    expect(r.ok).toBe(true);
    expect([...r.captions.keys()].sort()).toEqual(["m1:0", PLANTED_MISMATCH_KEY].sort());
    expect(r.issues.size).toBe(0);
    expect(r.headings.size).toBe(0); // headings not targeted
    expect([...r.captions.values()].some(isPlantedMismatch)).toBe(false);
    expect(logger.rows[1].inputSummary).toMatchObject({ repairTargets: 2 });
    // CLAUDE.md: caption rewrites run at effort low; full batches at medium.
    expect(t.requests[0].effort).toBe(EFFORT.caption_writer);
    expect(t.requests[1].effort).toBe(EFFORT.caption_repair);
    expect(EFFORT.caption_repair).toBe("low");
  });

  it("critic replay imports the same PLANTED_MISMATCH_KEY", () => {
    expect(CRITIC_PLANTED_KEY).toBe(PLANTED_MISMATCH_KEY);
  });

  it("other agents treat plant_bad_caption like ok", async () => {
    const t = new ReplayTransport({ scenario: "plant_bad_caption", fixturesDir: "/nonexistent-fixtures", synths: { storyteller: storytellerReplaySynth } });
    const r = await t.parse({
      agent: "storyteller",
      system: [{ type: "text", text: "s" }],
      messages: [{ role: "user", content: "x" }],
      schema: AlbumPlanAiSchema,
      effort: "medium",
      maxTokens: 100,
      scenarioMeta: { photos: [{ alias: "p1", ms: 1, orientation: "portrait", quality: 8, cover: true, place: null }], maxPages: 20 },
    });
    expect(r.parsed).not.toBeNull();
    expect(r.stopReason).toBe("end_turn");
  });

  it("synth is registered for caption_writer", () => {
    expect(getReplaySynth("caption_writer")).toBe(captionWriterReplaySynth);
  });
});

describe("precheckBatch", () => {
  it("drops unknown keys, flags missing keys and duplicates of other batches", () => {
    const { spec } = setup();
    const photos = storyPhotos();
    const data = {
      moments: [
        {
          momentId: "m1",
          heading: "Getting ready",
          pageCaptions: [
            { pageIndex: 0, text: "Soft light and softer smiles" },
            { pageIndex: 1, text: "Soft light and softer smiles" },
            { pageIndex: 9, text: "Not a page" },
          ],
        },
        { momentId: "m9", heading: "Ghost", pageCaptions: [{ pageIndex: 0, text: "Ghost line" }] },
      ],
    };
    const r = precheckBatch(data, {
      spec,
      book: storyBook(),
      photosById: new Map(photos.map((p) => [p.id, p])),
      otherCaptions: ["Soft light and softer smiles"],
    });
    expect(r.captions.size).toBe(0);
    expect(r.issues.get("m1:0")?.map((i) => i.code)).toEqual(["duplicate"]);
    expect(r.issues.get("m1:2")?.map((i) => i.code)).toEqual(["empty"]);
    expect(r.issues.get("m2:heading")?.map((i) => i.code)).toEqual(["empty"]);
    expect([...r.issues.keys()].some((k) => k.startsWith("other:") || k.startsWith("m9"))).toBe(false);
    expect(r.headings.get("m1")).toBe("Getting ready");
  });

  it("allows knownNames from memory and photo places", () => {
    const { spec } = setup();
    const photos = storyPhotos({ 1: { place: "Abu Dhabi" } });
    const data = {
      moments: [{ momentId: "m1", heading: "Getting ready", pageCaptions: [{ pageIndex: 0, text: "Layla smiling in Abu Dhabi" }, { pageIndex: 1, text: "Laughing with Omar" }] }],
    };
    const r = precheckBatch(data, { spec, book: storyBook(), photosById: new Map(photos.map((p) => [p.id, p])), memory: { v: 1, knownNames: ["Layla"] } });
    expect(r.captions.get("m1:0")).toBe("Layla smiling in Abu Dhabi");
    expect(r.issues.get("m1:1")?.map((i) => i.code)).toEqual(["unknown_name"]);
  });
});
