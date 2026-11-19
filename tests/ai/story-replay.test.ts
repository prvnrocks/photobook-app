import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn(async () => null) }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/db/photo-analyses", () => ({ getTodayPhotoAnalysisSpendUsd: vi.fn(async () => 0), dubaiDayStart: () => "" }));
vi.mock("@/lib/db/photo-organize", () => ({ listPhotosForOrganize: vi.fn(), listVision: vi.fn(), listMoments: vi.fn(), listDuplicateGroups: vi.fn() }));
vi.mock("@/lib/db/story-ai-calls", () => ({ countStoryRuns: vi.fn(), getTodayStorySpendUsd: vi.fn(async () => 0), recordStoryCall: vi.fn(), storyUsageAvailable: vi.fn(async () => false) }));
vi.mock("@/lib/db/storybooks", () => ({ appendStorybookVersion: vi.fn(), getCurrentStorybook: vi.fn(), getMemoryContext: vi.fn() }));
vi.mock("@/lib/ai/budget", () => ({ checkDailyAiBudget: vi.fn(async () => ({ allowed: true, reason: "no_budget" })) }));

import { checkBlock, countWords, tokenize, WORD_BOUNDS } from "@/lib/ai/story/grounding";
import { buildFacts, buildStoryInputs, factHash, factRefsToStore } from "@/lib/ai/story/inputs";
import { StoryPlanSchema } from "@/lib/ai/story/plan";
import { replayText, REPLAY_CLAUSES_PER_BLOCK } from "@/lib/ai/story/replay";
import { planStory, rewriteNarrativeBlock, writeStory } from "@/lib/ai/story/service";
import { StorybookSchema } from "@/lib/storybook/schemas";
import { BOOK, book, memory, photoRows, storedMoments, visionRows, world } from "./story-fixtures";

// Task 6: the whole pipeline in REPLAY mode with the real ReplayTransport (no transport mock):
// what local dev and previews run without an API key.

function replayWorld(over: Parameters<typeof world>[0] = {}) {
  const w = world({ mode: "replay", usageAvailable: async () => false, ...over });
  // no injected transport: the service builds its own ReplayTransport with the story synthesisers
  delete (w.deps as { transport?: unknown }).transport;
  return w;
}

describe("replay end to end", () => {
  it.each(["en", "ar"] as const)("planStory → writeStory → rewriteNarrativeBlock on a 24-photo book (%s)", async (lang) => {
    const w = replayWorld({ theBook: book({ caption_lang: lang }) });
    const plan = await planStory(BOOK, w.deps);
    expect(StoryPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan).toMatchObject({ source: "ai", fallbackReason: null, photoCount: 24, closing: true, lang });
    expect(plan.chapters).toHaveLength(3);
    expect(plan.skeleton.balance.narrativeShare).toBeLessThanOrEqual(0.4); // v4: the 35 % target is a ceiling

    // the plan survives a JSON round trip (it may come back from a client)
    const result = await writeStory(BOOK, JSON.parse(JSON.stringify(plan)), {}, w.deps);
    const s = result.storybook;
    expect(StorybookSchema.safeParse(s).success).toBe(true);
    expect(result.issues).toEqual([]);
    expect(s.chapters).toHaveLength(3);
    expect(s).toMatchObject({ version: 1, origin: "ai", lang });
    expect(result.balance.narrativeShare).toBeLessThanOrEqual(0.4);
    const blocks = s.pages.flatMap((p) => p.blocks);
    expect(blocks.map((b) => b.id)).toEqual(plan.skeleton.pages.flatMap((p) => p.blocks.map((b) => b.id)));
    // v4: chapter story pages (intro + subtitle + headline + closing line), captions, the closing page — no paragraphs
    expect(blocks.map((b) => b.kind)).toEqual(expect.arrayContaining(["intro", "subtitle", "headline", "closing_line", "caption", "closing"]));
    expect(blocks.some((b) => b.kind === "paragraph")).toBe(false);
    for (const b of blocks) {
      expect(b.groundedIn.length).toBeGreaterThan(0);
      const words = countWords(b.kind === "subtitle" ? b.text.replace(/^[^·]+ · /, "") : b.text);
      expect(words).toBeGreaterThanOrEqual(WORD_BOUNDS[b.kind].min);
      expect(words).toBeLessThanOrEqual(WORD_BOUNDS[b.kind].max);
    }
    // every photo is placed exactly once
    expect(s.pages.flatMap((p) => p.photoIds).sort()).toEqual(w.rows.map((r) => r.id).sort());

    const target = blocks.find((b) => b.kind === "caption")!;
    const rewrite = await rewriteNarrativeBlock(`${BOOK}/${target.id}`, { kind: "shorter" }, {}, w.deps);
    expect(rewrite.stored).toBe(true);
    expect(StorybookSchema.safeParse(rewrite.storybook).success).toBe(true);
    expect(rewrite.storybook!.version).toBe(2);
    expect(countWords(rewrite.proposal.text)).toBeLessThan(countWords(target.text));

    const regen = await writeStory(BOOK, plan, { chapterId: "c3" }, w.deps);
    expect(regen.storybook.version).toBe(3);
    expect(regen.issues).toEqual([]);
    expect(w.versions).toHaveLength(3);
    // replay with the usage table missing records nothing and is never refused
    expect(w.records).toEqual([]);
  });

  it("replay records usage (mode replay, cost 0) when the table exists", async () => {
    const w = replayWorld({ usageAvailable: async () => true });
    await planStory(BOOK, w.deps);
    expect(w.records).toMatchObject([{ kind: "plan", mode: "replay", costUsd: 0, status: "ok" }]);
    expect(w.records[0]!.usage.input).toBeGreaterThan(0);
  });

  it("replay ignores the per-book limits and the budget (it costs nothing)", async () => {
    const w = replayWorld({ counts: { plans: 99, writes: 99, chapterRegens: 99, rewrites: 99 }, budgetExhausted: async () => true });
    const plan = await planStory(BOOK, w.deps);
    expect(plan.source).toBe("ai");
    expect((await writeStory(BOOK, plan, {}, w.deps)).storybook.version).toBe(1);
  });

  it.each([5, 10, 40, 60])("%i photos: valid storybook, chapter count by the rules, balance reported", async (n) => {
    const rows = photoRows(n, 4);
    const w = replayWorld({ rows });
    const plan = await planStory(BOOK, w.deps);
    const { storybook, balance, issues } = await writeStory(BOOK, plan, {}, w.deps);
    expect(issues).toEqual([]);
    expect(StorybookSchema.safeParse(storybook).success).toBe(true);
    expect(storybook.chapters.length).toBe(n < 10 ? 1 : n < 20 ? 2 : n < 40 ? 3 : 4);
    expect(storybook.pages.some((p) => p.kind === "closing")).toBe(n >= 10);
    expect(storybook.pages.length).toBeLessThanOrEqual(20);
    if (n >= 10) expect(balance.narrativeShare).toBeLessThanOrEqual(0.4);
  });
});

describe("replay text", () => {
  it.each(["en", "ar"] as const)("%s: 100 blocks × full length share no opening and no 4-word sequence, and pass grounding", (lang) => {
    const texts = Array.from({ length: 100 }, (_, i) => replayText(lang, i + 1, REPLAY_CLAUSES_PER_BLOCK));
    const openings = new Set<string>();
    const grams = new Set<string>();
    for (const t of texts) {
      const norms = tokenize(t).map((x) => x.norm);
      const opening = norms.slice(0, 3).join(" ");
      expect(openings.has(opening)).toBe(false);
      openings.add(opening);
      const own = new Set<string>();
      for (let i = 0; i + 4 <= norms.length; i++) own.add(norms.slice(i, i + 4).join(" "));
      for (const g of own) expect(grams.has(g), g).toBe(false);
      for (const g of own) grams.add(g);
    }
    const photos = new Map([["p1", { place: null, dateLabel: null, evidence: "" }]]);
    for (const [i, t] of texts.slice(0, 40).entries()) {
      expect(checkBlock({ blockId: `b${i + 1}`, kind: "paragraph", text: t, photoRefs: ["p1"], factRefs: [] }, { lang, photos, facts: new Map(), otherTexts: texts.filter((_, j) => j !== i) })).toEqual([]);
    }
  });
});

describe("story inputs", () => {
  const rows = photoRows(8);
  const base = { book: book({ title: "Sisters on the road" }), photos: rows, vision: visionRows(rows), storedMoments: storedMoments(rows), duplicateGroups: [], context: memory() };

  it("aliases in story order; metadata comes from the photo row, descriptions from the stored analysis", () => {
    const inputs = buildStoryInputs(base);
    expect(inputs.photos.map((p) => p.alias)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    expect(inputs.moments.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(inputs.photos[0]).toMatchObject({ id: rows[0]!.id, momentId: "m1", place: "Abu Dhabi", dateLabel: "12 Oct 2026", description: "Two people walk along a beach near the water.", storyRole: "establishing", atmosphere: "calm" });
    expect(inputs).toMatchObject({ lang: "en", occasion: "travel", storyTone: "heartfelt", narrator: "first_plural", contextRev: 3 });
  });

  it("every answer, person, place and fact is one fact with an id, a kind and its text; the occasion and the user's title too", () => {
    const facts = buildStoryInputs(base).facts;
    expect(facts.map((f) => [f.id, f.kind, f.text])).toEqual([
      ["f1", "occasion", "travel"],
      ["f2", "title", "Sisters on the road"],
      ["f3", "answer", "My sister Sara and me"],
      ["f4", "person", "Sara — my sister"],
      ["f5", "place", "Abu Dhabi"],
      ["f6", "fact", "We drove along the coast road"],
    ]);
    expect(facts[2]!.question).toBe("Who did you travel with?");
    expect(facts[0]!.hash).toBe(factHash("occasion", "travel"));
    expect(facts[0]!.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a skipped / missing memory context gives no user facts; narrator defaults to third person, tone to none", () => {
    const inputs = buildStoryInputs({ ...base, book: book({ occasion: "other" }), context: null });
    expect(inputs).toMatchObject({ facts: [], storyTone: null, narrator: "third", contextRev: null, avoid: [] });
    const skipped = buildStoryInputs({ ...base, book: book({ occasion: "other" }), context: memory({ skipped: true, answers: [], people: [], places: [], facts: [], storyTone: null }) });
    expect(skipped.facts).toEqual([]);
    expect(skipped.storyTone).toBeNull();
  });

  it("fact ids are stable across versions: a known fact keeps its id, a new one gets the next free id, a removed one stays traceable while cited", () => {
    const first = buildFacts(base.book, memory());
    const known = first.map((f) => ({ id: f.id, kind: f.kind, hash: f.hash }));
    const changed = memory({ people: [{ name: "Noor", relation: null }, { name: "Sara", relation: "my sister" }], facts: [] });
    const next = buildFacts(base.book, changed, known);
    expect(next.map((f) => [f.id, f.text])).toEqual([
      ["f1", "travel"],
      ["f2", "Sisters on the road"],
      ["f3", "My sister Sara and me"],
      ["f7", "Noor"],
      ["f4", "Sara — my sister"],
      ["f5", "Abu Dhabi"],
    ]);
    const stored = factRefsToStore(next, known, new Set(["f6", "f4"]));
    expect(stored.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f7", "f4", "f5", "f6"]);
    expect(factRefsToStore(next, known, new Set()).map((f) => f.id)).not.toContain("f6");
  });

  it("photos without a timestamp or place have no date label / place (nothing is guessed)", () => {
    const bare = rows.map((r) => ({ ...r, taken_at: null, place: null }));
    const inputs = buildStoryInputs({ ...base, photos: bare, storedMoments: [] });
    expect(inputs.photos.every((p) => p.dateLabel === null && p.place === null)).toBe(true);
    expect(inputs.photos).toHaveLength(8);
  });
});
