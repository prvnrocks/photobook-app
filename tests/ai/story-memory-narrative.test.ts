// Story v3 — Memory Narrative Layer (StoryBrief + memory lints + grouping + regenerate). Recorded,
// SYNTHETIC model outputs (tests/fixtures/ai/story/memory-v3.json) through a scripted transport —
// no live API call, no user data. Compares:
//   visual-only generation       no personal context → observational brief, third person, no claims
//   personal-memory generation   the user's own words → a reunion story built on them
//   missing-context generation   the same photos with the context removed → personal text rejected
//   repetitive photographs       30 near-identical café photos → ONE moment, ≤ 40 % set aside, no
//                                repeated beats, no photo-shoot commentary
//   unsupported factual claims   invented relationship / date / conversation / emotion / reason
// and that "Regenerate story" re-runs only brief → plan → write.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({}));
vi.mock("@/lib/auth/current-user", () => ({}));
vi.mock("@/lib/db/photo-analyses", () => ({}));
vi.mock("@/lib/db/photo-organize", () => ({}));
vi.mock("@/lib/db/story-ai-calls", () => ({}));
vi.mock("@/lib/db/storybooks", () => ({}));
vi.mock("@/lib/ai/budget", () => ({}));

import { acceptBrief, allowedEmotionsOf, ruleBrief, type StoryBriefAi } from "@/lib/ai/story/brief";
import { checkBlock, type GroundingContext, type GroundingIssueCode } from "@/lib/ai/story/grounding";
import { buildStoryInputs, groundingFacts, groundingPhoto, type StoryInputs } from "@/lib/ai/story/inputs";
import { memoryLint } from "@/lib/ai/story/memory-lint";
import { StoryPlanSchema } from "@/lib/ai/story/plan";
import { STORY_PLANNER_PROMPT_VERSION } from "@/lib/ai/story/prompts";
import { planStory, regenerateStory, writeStory } from "@/lib/ai/story/service";
import type { AgentRequest } from "@/lib/ai/transport";
import type { OrganizePhotoRow } from "@/lib/db/photo-organize";
import { decidePhotoFilters, type FilterPhoto } from "@/lib/photos/filter";
import { clusterMoments, type MomentPhoto } from "@/lib/photos/moments";
import { StorybookSchema } from "@/lib/storybook/schemas";
import { userEdit } from "@/lib/storybook/versioning";
import type { MemoryContext, NarrativeKind } from "@/lib/storybook/types";
import { BOOK, USER, book, pid, userText, world } from "./story-fixtures";

type Pool = Record<NarrativeKind, string[]>;
const FX = JSON.parse(readFileSync(new URL("../fixtures/ai/story/memory-v3.json", import.meta.url), "utf8")) as {
  reunionBrief: StoryBriefAi;
  inventedBrief: StoryBriefAi;
  writer: {
    personal: Pool;
    observational: Pool;
    commentary: string[];
    unsupported: Record<string, { text: string; factRefs: string[] }>;
    personalInObservational: string[];
    repetitive: string[];
  };
};

// ---------------------------------------------------------------------------- one café visit, 30 near-identical photos

const T0 = Date.parse("2026-05-30T13:47:00Z");
const CAFE_NOTE = "Two people hold iced coffees in the shade of stone arches outside a café.";
const TITLE = "A weekend in Dubai";
/** Photos of the end-to-end books (enough for a closing page and several text blocks). */
const SERVICE_PHOTOS = 16;

function cafeRows(n = 30): OrganizePhotoRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: pid(i + 1),
    fingerprint: `s1:${String(i).padStart(16, "0")}`,
    phash: i % 3 === 0 ? "ffff0000ffff0000" : i % 3 === 1 ? "ffff0000ffff0001" : "ffff0000ffff0003",
    thumb_path: `${USER}/${BOOK}/IMG_${5000 + i}-thumb.jpg`,
    width: 3000,
    height: 4000,
    // one 11-minute visit: 22 s apart, with two longer pauses that v2 would have split at
    taken_at: new Date(T0 + i * 22_000 + (i >= 10 ? 70_000 : 0) + (i >= 20 ? 80_000 : 0)).toISOString(),
    date_source: "exif",
    lat: null,
    lng: null,
    place: null,
    blur_score: 900,
    ai: null,
    status: "kept",
  }));
}
const cafeVision = (rows: OrganizePhotoRow[]) =>
  new Map<string, unknown>(
    rows.map((r) => [
      r.id,
      { description: CAFE_NOTE, scene: "portrait", objects: ["iced coffee", "stone arches", "bench"], activities: ["drinking iced coffee", "holding a cup"], peopleCount: 2, orientation: "portrait", storyRole: "portrait", atmosphere: { label: "calm", interpretation: true }, model: "claude-sonnet-5-5", promptVersion: "photo-insight-2" },
    ]),
  );

/** The user's own words (wizard "What makes this memory special?"); generic, synthetic. */
const reunion = (over: Partial<MemoryContext> = {}): MemoryContext => ({
  v: 1,
  occasion: "travel",
  tone: "fun",
  lang: "en",
  storyTone: null,
  answers: [
    { questionId: "memory.relationship", question: "Who is in these photos, to you?", text: "My brother", source: "user" },
    { questionId: "memory.moment", question: "One short memory from that time", text: "We met again after a long time.", source: "user" },
  ],
  skipped: false,
  note: null,
  people: [],
  places: [],
  facts: [],
  avoid: [],
  narrator: "first_plural",
  dateRange: null,
  rev: 2,
  updatedAt: "2026-11-19T09:00:00.000Z",
  ...over,
});

const theBook = book({ title: TITLE, occasion: "travel" });
const inputsOf = (context: MemoryContext | null, rows = cafeRows()): StoryInputs =>
  buildStoryInputs({ book: { title: TITLE, occasion: "travel", caption_lang: "en" }, photos: rows, vision: cafeVision(rows), storedMoments: [], duplicateGroups: [], context });

function ctxOf(inputs: StoryInputs, brief = acceptBrief(FX.reunionBrief, inputs, { source: "ai", model: "claude-opus-5-5", promptVersion: STORY_PLANNER_PROMPT_VERSION })): GroundingContext {
  return { lang: "en", photos: new Map(inputs.photos.map((p) => [p.alias, groundingPhoto(p)])), facts: groundingFacts(inputs.facts), otherTexts: [], narrator: inputs.narrator, mode: inputs.mode, allowedEmotions: allowedEmotionsOf(brief) };
}
const codes = (text: string, factRefs: string[], ctx: GroundingContext, kind: NarrativeKind = "paragraph") => [...new Set(checkBlock({ blockId: "b1", kind, text, photoRefs: ["p1"], factRefs }, ctx).map((i) => i.code))];

/** Fact ids a personal text needs, by what it says (f2 title/Dubai, f3 brother, f4 met again / long time / reunion). */
function refsFor(text: string): string[] {
  const out: string[] = [];
  if (/Dubai/.test(text)) out.push("f2");
  if (/brother/i.test(text)) out.push("f3");
  if (/met again|long time|reunion|how long/i.test(text)) out.push("f4");
  return out;
}

/** A scripted writer answering every requested block from a pool (by kind), citing the block's photo. */
function writerFrom(first: Pool, repair: Pool = first, cite = true) {
  const used: Record<string, number> = {};
  return (req: AgentRequest<unknown>, good: unknown) => {
    if (req.agent !== "caption_writer") return good;
    const pool = userText(req).includes("REPAIR —") ? repair : first;
    const meta = req.scenarioMeta as { blocks: { id: string; kind: NarrativeKind; photos: string[] }[]; photos: string[] };
    return {
      blocks: meta.blocks.map((b) => {
        const key = `${pool === repair && repair !== first ? "r" : "f"}:${b.kind}`;
        const i = used[key] ?? 0;
        used[key] = i + 1;
        const text = pool[b.kind][i % pool[b.kind].length]!;
        return { blockId: b.id, text, photoRefs: [b.photos[0] ?? meta.photos[0]!], factRefs: cite ? refsFor(text) : [] };
      }),
    };
  };
}
/** Every call: the planner returns the recorded brief + the grounded outline; the writer the pool. */
function scripted(brief: StoryBriefAi, first: Pool, repair?: Pool, cite = true) {
  const write = writerFrom(first, repair, cite);
  return (req: AgentRequest<unknown>, good: unknown) => (req.agent === "storyteller" ? { ...(good as object), brief } : write(req, good));
}
const allCalls = (fn: (req: AgentRequest<unknown>, good: unknown) => unknown) => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, fn]));

// ---------------------------------------------------------------------------- the brief

describe("StoryBrief (v3): built from the sources, every claim traced", () => {
  it("personal memory: the recorded reunion brief is kept — theme, the user's occasion wording, Dubai from the title, 'my brother', 3 traced facts, warm and nostalgic", () => {
    const inputs = inputsOf(reunion());
    expect(inputs.mode).toBe("personal");
    expect(inputs.facts.map((f) => [f.id, f.kind, f.questionId ?? null])).toEqual([
      ["f1", "occasion", null],
      ["f2", "title", null],
      ["f3", "answer", "memory.relationship"],
      ["f4", "answer", "memory.moment"],
    ]);
    const brief = acceptBrief(FX.reunionBrief, inputs, { source: "ai", model: "claude-opus-5-5", promptVersion: STORY_PLANNER_PROMPT_VERSION });
    expect(brief).toMatchObject({
      mode: "personal",
      source: "ai",
      centralTheme: "Reuniting with my brother after a long time",
      occasion: { text: "reunion", source: "user", factRefs: ["f4"] }, // the book's stored occasion stays "travel"
      location: { text: "Dubai", source: "title", factRefs: ["f2"] },
      relationships: [{ text: "my brother", factRef: "f3" }],
      emotionalDirection: { text: "warm and nostalgic", source: "user", factRefs: ["f3", "f4"] },
      narrativeArc: [
        { beat: "opening", text: "The long-awaited reunion" },
        { beat: "middle", text: "Spending time together" },
        { beat: "closing", text: "A memory to carry forward" },
      ],
    });
    expect(brief.verifiedFacts.map((v) => [v.text, v.source])).toEqual([
      ["The people are brothers", "user"],
      ["They met after a long time", "user"],
      ["They spent time together over coffee", "photos"],
    ]);
    expect(brief.verifiedFacts[2]!.photoIds).toEqual([pid(1), pid(2)].filter((id) => inputs.photos.some((p) => p.id === id)));
    expect(brief.unsupportedAssumptions).toEqual(expect.arrayContaining(["Exact duration apart", "Specific conversations", "Reasons for separation", "what anyone said, word for word or in summary"]));
    expect(allowedEmotionsOf(brief)).toEqual(new Set(["nostalgic"]));
  });

  it("missing context: the same recorded brief, context removed → observational, no relationships, the book's occasion, neutral direction, only photo facts", () => {
    const inputs = inputsOf(null);
    expect(inputs.mode).toBe("observational");
    expect(inputs.narrator).toBe("third");
    const brief = acceptBrief(FX.reunionBrief, inputs, { source: "ai", model: "claude-opus-5-5", promptVersion: STORY_PLANNER_PROMPT_VERSION });
    expect(brief.relationships).toEqual([]);
    expect(brief.occasion).toEqual({ text: "travel", source: "book", factRefs: ["f1"] });
    expect(brief.emotionalDirection.source).toBe("neutral");
    expect(allowedEmotionsOf(brief).size).toBe(0);
    expect(brief.verifiedFacts.map((v) => v.source)).toEqual(["photos"]);
    expect(brief.centralTheme).not.toMatch(/brother|reunit/i);
    expect(brief.unsupportedAssumptions).toEqual(expect.arrayContaining(["who the people are to each other", "why this day mattered to anyone"]));
  });

  it("a skipped step or a context with only a tone is observational too; a stored legacy answer is personal", () => {
    expect(inputsOf(reunion({ answers: [], skipped: true })).mode).toBe("observational");
    expect(inputsOf(reunion({ answers: [], storyTone: "joyful" })).mode).toBe("observational");
    expect(inputsOf(reunion({ answers: [{ questionId: "travel.companions", question: "Who did you travel with?", text: "My brother", source: "user" }] })).mode).toBe("personal");
  });

  it("unsupported claims in a brief are dropped: an invented cousin, ten years, a feeling, a birthday, a guessed place, an unknown moment", () => {
    const inputs = inputsOf(reunion());
    const brief = acceptBrief(FX.inventedBrief, inputs, { source: "ai", model: "claude-opus-5-5", promptVersion: STORY_PLANNER_PROMPT_VERSION });
    const rule = ruleBrief(inputs, { promptVersion: STORY_PLANNER_PROMPT_VERSION });
    expect(brief.relationships).toEqual([{ text: "My brother", factRef: "f3" }]); // the rule value: the user's own words
    expect(brief.verifiedFacts.map((v) => v.text)).toEqual(["Iced coffee at a café with stone arches"]);
    expect(brief.occasion).toEqual({ text: "travel", source: "book", factRefs: ["f1"] });
    expect(brief.location).toBeNull();
    expect(brief.centralTheme).toBe(rule.centralTheme);
    expect(brief.momentGroups).toEqual(rule.momentGroups);
    expect(brief.narrativeArc).toEqual(rule.narrativeArc);
    expect(brief.emotionalDirection).toEqual(rule.emotionalDirection);
    expect(StoryPlanSchema.shape.brief.safeParse(brief).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------- writer lints

describe("writer output: visual-only vs personal vs missing context (v3 lints)", () => {
  const personal = ctxOf(inputsOf(reunion()));
  const observational = ctxOf(inputsOf(null), ruleBrief(inputsOf(null), { promptVersion: STORY_PLANNER_PROMPT_VERSION }));

  it("personal-memory text built on the user's words passes in personal mode", () => {
    const p = FX.writer.personal;
    for (const kind of ["intro", "paragraph", "caption", "closing"] as const) for (const text of p[kind]) expect([kind, text, codes(text, refsFor(text), personal, kind)]).toEqual([kind, text, []]);
  });

  it("visual-only (observational) text passes without any fact; the same text style is fine in personal mode too", () => {
    const o = FX.writer.observational;
    for (const kind of ["intro", "paragraph", "caption", "closing"] as const) for (const text of o[kind]) expect([kind, text, codes(text, [], observational, kind)]).toEqual([kind, text, []]);
  });

  it("missing context: personal claims are rejected — relationship, reunion, 'we', feelings", () => {
    const [rel, feel] = FX.writer.personalInObservational;
    expect(codes(rel!, [], observational)).toEqual(expect.arrayContaining(["ungrounded_relationship", "wrong_voice"]));
    expect(codes(feel!, [], observational)).toEqual(expect.arrayContaining(["stated_feeling", "wrong_voice"]));
    // the personal pool, cited or not, never passes in observational mode
    for (const text of [...FX.writer.personal.intro, ...FX.writer.personal.paragraph.slice(0, 2), ...FX.writer.personal.closing]) expect(codes(text, [], observational).length).toBeGreaterThan(0);
  });

  it("photo-shoot commentary is rejected in every mode ('The cups got their close-ups first', 'Then the portraits took over', 'shot after shot')", () => {
    for (const text of FX.writer.commentary) {
      expect(codes(text, [], personal)).toContain("photo_commentary");
      expect(codes(text, [], observational)).toContain("photo_commentary");
    }
    expect(memoryLint("Then the portraits took over.", "en", { citedFactTexts: [] })).toEqual([{ code: "photo_commentary", detail: "camera_subject" }]);
    expect(memoryLint("The cups got their close-ups first.", "en", { citedFactTexts: [] })).toEqual([{ code: "photo_commentary", detail: "camera_subject" }]);
    expect(memoryLint("The coffee came first, then a bench in the shade.", "en", { citedFactTexts: [] })).toEqual([]);
    // pose / gesture descriptions are photo-shoot commentary too
    for (const pose of ["A thumbs up by the green sign.", "One foot against the wall, cup in hand.", "A hand over the mouth, the coffee in the other.", "Head resting on one hand under the arches.", "My brother crossed both legs in the shade."])
      expect(memoryLint(pose, "en", { citedFactTexts: [] })).toEqual([{ code: "photo_commentary", detail: "pose" }]);
  });

  it.each<[string, GroundingIssueCode]>([
    ["relationship", "ungrounded_relationship"],
    ["date", "ungrounded_date"],
    ["conversation", "unsupported_claim"],
    ["catching_up", "unsupported_claim"],
    ["emotion", "claimed_emotion"],
    ["separation", "unsupported_claim"],
    ["generic", "generic_language"],
  ])("unsupported factual claim — %s — is rejected (%s) even when it cites the user's facts", (key, code) => {
    const c = FX.writer.unsupported[key]!;
    expect(codes(c.text, c.factRefs, personal)).toContain(code);
  });

  it("emotions: only from the user's words — the brief's user-supported direction allows 'nostalgic' in personal mode, never in observational mode", () => {
    const text = "The afternoon had a nostalgic ease to it, iced coffee in the shade of the arches and nowhere else that needed us.";
    expect(codes(text, ["f4"], personal)).toEqual([]);
    expect(codes(text, [], personal)).toContain("claimed_emotion"); // no fact cited
    expect(codes(text, [], observational)).toContain("claimed_emotion");
  });

  it("repetitive photographs: a repeated beat across blocks of the chapter is rejected", () => {
    const [a, b] = FX.writer.repetitive;
    const issues = checkBlock({ blockId: "b2", kind: "paragraph", text: b!, photoRefs: ["p2"], factRefs: [] }, { ...personal, chapterTexts: [a!] }).map((i) => i.code);
    expect(issues).toContain("near_duplicate");
  });
});

// ---------------------------------------------------------------------------- grouping + filters

describe("repetitive photographs: one visit is one moment, filters stay calibrated", () => {
  it("30 near-identical photos of one 11-minute café visit form ONE moment (no invented separate events)", () => {
    const rows = cafeRows();
    const vision = cafeVision(rows);
    const photos: MomentPhoto[] = rows.map((r) => {
      const v = vision.get(r.id) as { scene: string; objects: string[]; activities: string[]; description: string };
      return { id: r.id, takenAt: r.taken_at, dateSource: "exif", lat: null, lng: null, place: null, vision: v, quality: 60, qualityFlags: [], keep: true };
    });
    const { moments } = clusterMoments(photos);
    expect(moments).toHaveLength(1);
    expect(moments[0]!.label).toBe("At the café");
    expect(inputsOf(reunion()).moments).toHaveLength(1);
  });

  it("near-identical bursts keep about one in 2–3 and never more than 40 % of the book is set aside", () => {
    const rows = cafeRows();
    const fps: FilterPhoto[] = rows.map((r, i) => ({ id: r.id, fingerprint: r.fingerprint, imageSha256: null, phash: r.phash, takenAt: r.taken_at, dateSource: "exif", width: 3000, height: 4000, quality: 60 + (i % 5), blurScore: null, status: "kept", userOverride: false, color: "#a08060", vision: { scene: "portrait", objects: ["iced coffee"], activities: ["drinking iced coffee"] }, variance: 1500, flat: false }));
    const out = decidePhotoFilters(fps, []);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(Math.floor(rows.length * 0.4));
    expect(out.every((d) => d.reason === "similar")).toBe(true);
  });
});

// ---------------------------------------------------------------------------- the service end to end (scripted transport)

describe("planStory + writeStory with the brief (recorded outputs)", () => {
  it("personal memory: ONE planner call returns brief + outline; the writer sees the brief; a connected reunion story is stored with its brief", async () => {
    const rows = cafeRows(SERVICE_PHOTOS);
    const w = world({ rows, listVision: async () => cafeVision(rows), moments: [], context: reunion(), theBook, script: allCalls(scripted(FX.reunionBrief, FX.writer.personal)) });
    const plan = await planStory(BOOK, w.deps);
    expect(w.requests.map((r) => r.agent)).toEqual(["storyteller"]);
    expect(userText(w.requests[0]!)).toContain("MODE: personal");
    expect(plan.chapters).toHaveLength(1); // one visit → one chapter: opening, middle and closing beats inside it
    expect(plan.brief).toMatchObject({ mode: "personal", source: "ai", occasion: { text: "reunion" }, relationships: [{ text: "my brother" }] });

    const result = await writeStory(BOOK, plan, {}, w.deps);
    const writerText = userText(w.requests[1]!);
    expect(writerText).toContain("STORY BRIEF (MODE personal)");
    expect(writerText).toContain('relationships the user gave: "my brother" (f3)');
    expect(writerText).toContain('emotional direction: "warm and nostalgic"');
    expect(writerText).toMatch(/NEVER CLAIM: .*"Specific conversations"/);
    expect(writerText).toMatch(/THIS PART CARRIES: opening: The long-awaited reunion → middle: Spending time together → closing: A memory to carry forward/);
    expect(result.issues.map((i) => `${i.blockId}:${i.code}:${i.detail ?? ""}`)).toEqual([]);
    const s = result.storybook;
    expect(StorybookSchema.safeParse(s).success).toBe(true);
    expect(s.brief).toEqual(plan.brief);
    const texts = s.pages.flatMap((p) => p.blocks.map((b) => b.text)).join(" ");
    expect(texts).toMatch(/met again after a long time/);
    expect(texts).toMatch(/brother/);
    expect(texts).not.toMatch(/close-?ups?|portraits?|shots?|poses?|camera/i);
    expect(s.pages.at(-1)).toMatchObject({ kind: "closing" });
  });

  it("missing context: the same photos without the user's words → observational prompt, personal text rejected, observations stored", async () => {
    const rows = cafeRows(SERVICE_PHOTOS);
    // the model (wrongly) writes the personal story first; the one repair call writes observations
    const w = world({ rows, listVision: async () => cafeVision(rows), moments: [], context: null, theBook, script: allCalls(scripted(FX.reunionBrief, FX.writer.personal, FX.writer.observational, false)) });
    const plan = await planStory(BOOK, w.deps);
    expect(plan.brief).toMatchObject({ mode: "observational", relationships: [], emotionalDirection: { source: "neutral" } });
    const result = await writeStory(BOOK, plan, {}, w.deps);
    const first = userText(w.requests[1]!);
    expect(first).toContain("MODE: observational");
    expect(first).toContain("NARRATOR: third");
    expect(first).toContain("relationships the user gave: none");
    expect(w.requests.filter((r) => userText(r).includes("REPAIR —")).length).toBeGreaterThan(0);
    const texts = result.storybook.pages.flatMap((p) => p.blocks.map((b) => b.text));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t).not.toMatch(/\b(?:we|our|my|brother|reunion)\b/i);
      expect(FX.writer.observational.intro.concat(FX.writer.observational.paragraph, FX.writer.observational.caption, FX.writer.observational.closing, FX.writer.observational.pull_quote)).toContain(t);
    }
  });

  it("photo-shoot commentary from the model is repaired once, then dropped — never stored", async () => {
    const rows = cafeRows(SERVICE_PHOTOS);
    const commentary: Pool = { intro: [`${FX.writer.commentary[0]} It was the start of the afternoon by the arches.`], paragraph: FX.writer.commentary, caption: ["Shot after shot by the wall."], pull_quote: ["Every angle by the arches."], closing: [`${FX.writer.commentary[2]} The afternoon by the arches ended there, with the cups empty.`] };
    const w = world({ rows, listVision: async () => cafeVision(rows), moments: [], context: reunion(), theBook, script: allCalls(scripted(FX.reunionBrief, commentary)) });
    const plan = await planStory(BOOK, w.deps);
    const result = await writeStory(BOOK, plan, {}, w.deps);
    expect(result.issues.some((i) => i.code === "photo_commentary")).toBe(true);
    const texts = result.storybook.pages.flatMap((p) => p.blocks.map((b) => b.text)).join(" ");
    expect(texts).not.toMatch(/close-?ups?|portraits?|shot after shot|every angle|kept clicking/i);
  });

  it("Regenerate story: reuses the stored analyses and moments, keeps the layout and the user's own text; only brief → plan → write", async () => {
    const rows = cafeRows(SERVICE_PHOTOS);
    const listVision = vi.fn(async () => cafeVision(rows));
    const w = world({ rows, listVision, moments: [], context: reunion(), theBook, script: allCalls(scripted(FX.reunionBrief, FX.writer.personal)) });
    const plan = await planStory(BOOK, w.deps);
    await writeStory(BOOK, plan, {}, w.deps);
    // the user edits one block in the editor → a user-owned block in version 2
    const v1 = w.versions.at(-1)!;
    const edited = structuredClone(v1);
    const page = edited.pages.find((p) => p.blocks.some((b) => b.kind === "paragraph"))!;
    const block = page.blocks.find((b) => b.kind === "paragraph")!;
    block.text = "Edited by hand: the coffee was my idea.";
    block.provenance = userEdit(block.provenance, "2026-11-19T10:00:00.000Z");
    w.versions.push({ ...edited, version: 2, parentVersion: 1, origin: "user" });

    const before = { requests: w.requests.length, photos: w.reads.photos.mock.calls.length, vision: listVision.mock.calls.length };
    const { plan: next, result } = await regenerateStory(BOOK, plan, w.deps);
    const calls = w.requests.slice(before.requests);
    // one planner call (brief + titles / arcs on the FIXED chapters), then one writer call per group
    expect(calls.map((r) => r.agent)).toEqual(["storyteller", ...Array.from({ length: calls.length - 1 }, () => "caption_writer")]);
    expect(calls.length - 1).toBe(next.chapters.length + (next.closing ? 1 : 0));
    expect(userText(calls[0]!)).toContain("FIXED CHAPTERS (keep these moments together, in this order): c1 = m1");
    // no image is ever sent: the stored analyses (text) are read, not re-made
    for (const r of calls) for (const m of r.messages) expect(typeof m.content).toBe("string");
    expect(listVision.mock.calls.length).toBeGreaterThan(before.vision); // stored analyses read
    // the layout is identical; the user's block survives byte-identical
    expect(next.skeleton).toEqual(plan.skeleton);
    expect(next.moments).toEqual(plan.moments);
    const kept = result.storybook.pages.flatMap((p) => p.blocks).find((b) => b.id === block.id)!;
    expect(kept.text).toBe("Edited by hand: the coffee was my idea.");
    expect(kept.provenance.source).toBe("user");
    expect(result.storybook.version).toBe(3);
    expect(result.storybook.brief).toMatchObject({ mode: "personal", generator: { promptVersion: STORY_PLANNER_PROMPT_VERSION } });
  });

  it("a stale pinned plan (the moments changed) is ignored: the book is planned from scratch", async () => {
    const rows = cafeRows(SERVICE_PHOTOS);
    const w = world({ rows, listVision: async () => cafeVision(rows), moments: [], context: reunion(), theBook, script: allCalls(scripted(FX.reunionBrief, FX.writer.personal)) });
    const plan = await planStory(BOOK, w.deps);
    const stale = { ...plan, moments: plan.moments.map((m) => ({ ...m, label: "Elsewhere" })) };
    await planStory(BOOK, { ...w.deps, pinned: stale });
    expect(userText(w.requests.at(-1)!)).not.toContain("FIXED CHAPTERS");
  });
});
