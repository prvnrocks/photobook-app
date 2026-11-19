// Story v4 (chapter story page): the hero choice across occasions and relationships, the allowed
// voice and its limits, no template copying, no "together" the photos cannot show, one line per
// chapter that never echoes another, and prompts that carry no book-specific content. All
// synthetic fixtures (no real user content); no live model call.
import { describe, expect, it } from "vitest";
import { chapterPlace, composeSubtitle, heroScore, pickChapterHero, splitSubtitle, subjectOf } from "@/lib/ai/story/chapter-page";
import { checkBlock, exampleCopyIssue, repeatedLineIssue, togetherWithoutPeople, type GroundingContext } from "@/lib/ai/story/grounding";
import { buildFacts, type StoryInputs, type StoryPhoto } from "@/lib/ai/story/inputs";
import { STORY_PLANNER_SYSTEM_PROMPT, STORY_REWRITER_SYSTEM_PROMPT, STORY_WRITER_SYSTEM_PROMPT, writerUserText } from "@/lib/ai/story/prompts";
import { REFERENCE_LINES, STYLE_EXAMPLE } from "@/lib/ai/story/style-example";
import { STORY_QUESTIONS_MAX } from "@/lib/story/questions";
import type { MemoryContext } from "@/lib/storybook/types";
import type { StoryPlan } from "@/lib/ai/story/plan";
import { OCCASIONS } from "@/lib/book/options";

let n = 0;
const photo = (over: Partial<StoryPhoto>): StoryPhoto => ({
  alias: `p${++n}`,
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  momentId: "m1",
  dateLabel: null,
  place: null,
  description: "A scene.",
  scene: "other",
  objects: [],
  activities: [],
  storyRole: "action",
  atmosphere: "calm",
  peopleCount: 0,
  quality: 7,
  ...over,
});

const context = (answers: { id: string; text: string }[], over: Partial<MemoryContext> = {}): MemoryContext => ({
  v: 1,
  occasion: "other",
  tone: "fun",
  lang: "en",
  storyTone: null,
  answers: answers.slice(0, STORY_QUESTIONS_MAX).map((a) => ({ questionId: a.id, question: "q", text: a.text, source: "user" as const })),
  skipped: false,
  note: null,
  people: [],
  places: [],
  facts: [],
  avoid: [],
  narrator: "first_plural",
  dateRange: null,
  rev: 1,
  updatedAt: "2026-11-19T09:00:00.000Z",
  ...over,
});
const inputsFor = (occasion: string, ctx: MemoryContext | null): Pick<StoryInputs, "facts" | "mode"> => ({
  facts: buildFacts({ title: null, occasion, caption_lang: "en" }, ctx),
  mode: ctx ? "personal" : "observational",
});
const rel = (text: string) => ({ id: "memory.relationship", text });
const moment = (text: string) => ({ id: "memory.moment", text });

describe("hero: the photo that best shows who the story is about", () => {
  it("Dubai reference (brother, met after a long time): the two of them together at the café — not the cup, not a solo pose", () => {
    const cup = photo({ description: "A close-up of an iced coffee cup held in front of a shop sign.", scene: "food", storyRole: "detail", peopleCount: 0, quality: 9 });
    const solo = photo({ description: "One person standing against a stone wall.", scene: "portrait", storyRole: "portrait", peopleCount: 1, quality: 8 });
    const both = photo({ description: "Two people smiling at a café table under arches.", scene: "group", storyRole: "portrait", peopleCount: 2, quality: 7 });
    const inputs = inputsFor("travel", context([rel("My brother"), moment("We met after a long time and had coffee.")]));
    expect(subjectOf(inputs, [cup, solo, both])).toEqual({ kind: "people", min: 2 });
    expect(pickChapterHero([cup, solo, both], inputs)).toBe(both.id);
  });

  it("two people photographed separately (no photo of both): the sharpest solo photo with the setting visible — never the cup, never a soft one", () => {
    const cup = photo({ scene: "food", storyRole: "detail", peopleCount: 0, quality: 9, description: "A cup held up in front of a sign." });
    const softSolo = photo({ scene: "portrait", storyRole: "establishing", peopleCount: 1, quality: 9, soft: true });
    const soloWall = photo({ scene: "portrait", storyRole: "portrait", peopleCount: 1, quality: 7 });
    const soloStreet = photo({ scene: "landscape", storyRole: "establishing", peopleCount: 1, quality: 7 });
    const inputs = inputsFor("travel", context([rel("My brother")]));
    expect(pickChapterHero([cup, softSolo, soloWall, soloStreet], inputs)).toBe(soloStreet.id);
  });

  it("birthday (a child): a photo with the child and family, never the cake close-up", () => {
    const cake = photo({ scene: "food", storyRole: "detail", peopleCount: 0, quality: 10, description: "A birthday cake with candles, close-up." });
    const child = photo({ scene: "portrait", storyRole: "portrait", peopleCount: 1, quality: 8, description: "A small child smiling." });
    const family = photo({ scene: "group", storyRole: "emotion", peopleCount: 4, quality: 7, description: "A family around a child blowing out candles, laughing." });
    const inputs = inputsFor("birthday", context([rel("Our son"), moment("He turned five.")]));
    expect(pickChapterHero([cake, child, family], inputs)).toBe(family.id);
  });

  it("wedding (a couple): the couple, not the rings and not the crowd", () => {
    const rings = photo({ scene: "detail", storyRole: "detail", peopleCount: 0, quality: 10, description: "Two rings on a cushion, close-up." });
    const couple = photo({ scene: "portrait", storyRole: "portrait", peopleCount: 2, quality: 8, description: "A couple smiling under an arch of flowers." });
    const crowd = photo({ scene: "group", storyRole: "establishing", peopleCount: 40, quality: 8, description: "Guests seated in a hall." });
    const inputs = inputsFor("wedding", context([rel("My partner"), moment("The day we got married.")]));
    expect(pickChapterHero([rings, couple, crowd], inputs)).toBe(couple.id);
  });

  it("solo trip, landscapes only (no people): the strongest view of the place, no people bias", () => {
    const detail = photo({ scene: "detail", storyRole: "detail", peopleCount: 0, quality: 9, description: "Close-up of a pebble." });
    const view = photo({ scene: "landscape", storyRole: "establishing", peopleCount: 0, quality: 8, description: "A wide valley under clouds." });
    const road = photo({ scene: "landscape", storyRole: "action", peopleCount: 0, quality: 7, description: "A road through hills." });
    const inputs = inputsFor("travel", context([rel("A solo trip"), moment("My first trip alone.")]));
    expect(subjectOf(inputs, [detail, view, road])).toEqual({ kind: "people", min: 1 });
    expect(pickChapterHero([detail, view, road], inputs)).toBe(view.id);
  });

  it("a pet: the photo of the dog", () => {
    const bowl = photo({ scene: "detail", storyRole: "detail", peopleCount: 0, quality: 9, objects: ["bowl"], description: "An empty food bowl." });
    const dog = photo({ scene: "other", storyRole: "portrait", peopleCount: 0, quality: 7, objects: ["dog", "ball"], description: "A dog running on grass with a ball." });
    const lawn = photo({ scene: "landscape", storyRole: "establishing", peopleCount: 0, quality: 8, description: "A green lawn." });
    const inputs = inputsFor("family", context([moment("Our dog Biscuit's first beach day.")]));
    expect(subjectOf(inputs, [bowl, dog, lawn])).toEqual({ kind: "animal" });
    expect(pickChapterHero([bowl, dog, lawn], inputs)).toBe(dog.id);
  });

  it("no context: people photos when most photos show people, else the best scene", () => {
    const a = photo({ scene: "group", storyRole: "action", peopleCount: 3, quality: 6 });
    const b = photo({ scene: "detail", storyRole: "detail", peopleCount: 0, quality: 10 });
    const c = photo({ scene: "group", storyRole: "portrait", peopleCount: 2, quality: 7 });
    expect(pickChapterHero([a, b, c], inputsFor("other", null))).toBe(c.id);
    const v1 = photo({ scene: "landscape", storyRole: "establishing", peopleCount: 0, quality: 7 });
    const v2 = photo({ scene: "food", storyRole: "detail", peopleCount: 0, quality: 9 });
    expect(pickChapterHero([v1, v2], inputsFor("other", null))).toBe(v1.id);
  });

  it("multi-day family trip, 3 chapters: every chapter's hero shows the family, and is chosen within its own chapter", () => {
    const inputs = inputsFor("travel", context([rel("Family"), moment("Three days at the coast with the kids.")]));
    const days = [1, 2, 3].map((d) => [
      photo({ momentId: `m${d}`, scene: "landscape", storyRole: "detail", peopleCount: 0, quality: 9 }),
      photo({ momentId: `m${d}`, scene: "group", storyRole: "portrait", peopleCount: 4, quality: 7 }),
    ]);
    const heroes = days.map((ps) => pickChapterHero(ps, inputs));
    days.forEach((ps, i) => expect(heroes[i]).toBe(ps[1]!.id));
    expect(new Set(heroes).size).toBe(3);
  });

  it("deterministic; the planner's suggestion only breaks a tie", () => {
    const a = photo({ peopleCount: 2, storyRole: "portrait" });
    const b = photo({ peopleCount: 2, storyRole: "portrait" });
    const inputs = inputsFor("travel", context([rel("Friends")]));
    expect(heroScore(a, { kind: "people", min: 2 })).toBe(heroScore(b, { kind: "people", min: 2 }));
    expect(pickChapterHero([a, b], inputs, { preferred: b.id })).toBe(b.id);
    expect(pickChapterHero([a, b], inputs)).toBe(a.id);
  });
});

describe("subtitle: '<verified place> · <phrase>'", () => {
  it("composes the place only when one is verified, and never doubles it", () => {
    expect(composeSubtitle("Dubai", "A long-awaited afternoon.")).toBe("Dubai · A long-awaited afternoon");
    expect(composeSubtitle("Dubai", "Dubai · A long-awaited afternoon")).toBe("Dubai · A long-awaited afternoon");
    expect(composeSubtitle(null, "A quiet morning")).toBe("A quiet morning");
    expect(splitSubtitle("Al Ain · A quiet morning")).toEqual({ place: "Al Ain", phrase: "A quiet morning" });
  });
  it("the place comes from the chapter's photo metadata (shortened), else the brief's location, else none", () => {
    const inputs = { moments: [{ id: "m1", photoIds: [], label: "x", dateLabel: null, place: null, heroPhotoId: null }], photos: [photo({ place: "Al Fahidi, Dubai, United Arab Emirates" }), photo({ place: "Al Fahidi, Dubai, United Arab Emirates" })] };
    expect(chapterPlace(inputs, ["m1"])).toBe("Al Fahidi");
    const none = { moments: inputs.moments, photos: [photo({ place: null })] };
    expect(chapterPlace(none, ["m1"], { location: { text: "Dubai" } } as never)).toBe("Dubai");
    expect(chapterPlace(none, ["m1"], null)).toBeNull();
  });
});

const factCtx = (facts: [string, string, string][], over: Partial<GroundingContext> = {}): GroundingContext => ({
  lang: "en",
  photos: new Map([["p1", { place: null, dateLabel: null, evidence: "Two people sit at a café table.", objects: [], people: 2 }]]),
  facts: new Map(facts.map(([id, kind, text]) => [id, { kind, text }])),
  otherTexts: [],
  narrator: "first_plural",
  mode: "personal",
  ...over,
});
const codesOf = (kind: "headline" | "closing_line" | "intro" | "caption" | "subtitle", text: string, factRefs: string[], ctx: GroundingContext, photoRefs = ["p1"]) => [...new Set(checkBlock({ blockId: "b1", kind, text, photoRefs, factRefs }, ctx).map((i) => i.code))];

describe("allowed voice: warm lines tied to the user's facts pass; invented or stock lines do not", () => {
  const met = factCtx([["f3", "answer", "My brother"], ["f4", "answer", "We met after a long time."]]);
  it("a sincere headline grounded in 'we met after a long time' passes when it cites that fact", () => {
    expect(codesOf("headline", "This afternoon was worth the wait.", ["f4"], met)).toEqual([]);
    expect(codesOf("closing_line", "An ordinary afternoon, finally shared with my brother.", ["f3", "f4"], met)).toEqual([]);
  });
  it("the same line without the user's grounding, in observational mode, or on a caption is generic language", () => {
    expect(codesOf("headline", "This afternoon was worth the wait.", [], met)).toContain("generic_language");
    expect(codesOf("headline", "This afternoon was worth the wait.", ["f4"], factCtx([["f4", "answer", "We had coffee."]]))).toContain("generic_language");
    expect(codesOf("caption", "This afternoon was worth the wait.", ["f4"], met)).toContain("generic_language");
    expect(codesOf("headline", "This afternoon was worth the wait.", ["f4"], { ...met, mode: "observational", narrator: "third" })).toContain("generic_language");
  });
  it("invented durations and conversations stay rejected", () => {
    expect(codesOf("intro", "After five years apart we talked for hours over coffee at the café table, catching up on everything that had happened since we last met in the city.", [], met)).toEqual(expect.arrayContaining(["unsupported_claim"]));
    expect(codesOf("headline", "Together again after a long time.", [], factCtx([]))).toContain("unsupported_claim");
  });
  it("missing context: observational lines pass, 'we' / relationships / feelings do not", () => {
    const obs = factCtx([], { mode: "observational", narrator: "third" });
    expect(codesOf("headline", "An afternoon in the shade of the arches.", [], obs)).toEqual([]);
    expect(codesOf("closing_line", "We were so happy with my brother.", [], obs)).toEqual(expect.arrayContaining(["wrong_voice"]));
  });
});

describe("no template copying (style example + the user's reference mock-up)", () => {
  it("rejects four or more words in a row of the example or the reference, in any block", () => {
    for (const line of REFERENCE_LINES.filter((l) => l.split(" ").length >= 4)) expect(exampleCopyIssue(line), line).toBe(true);
    expect(exampleCopyIssue(STYLE_EXAMPLE.headline)).toBe(true);
    expect(exampleCopyIssue(`Later ${STYLE_EXAMPLE.body.split(" ").slice(3, 9).join(" ")} again.`)).toBe(true);
    expect(exampleCopyIssue("A day worth remembering")).toBe(true);
    expect(exampleCopyIssue("Some days ask for nothing more than company.")).toBe(false);
    const met = factCtx([["f4", "answer", "We met after a long time."]]);
    expect(codesOf("headline", "Some moments are worth the wait.", ["f4"], met)).toContain("example_copy");
  });
});

describe("together needs people in the photos", () => {
  it("'together' in a chapter whose photos show nobody is rejected unless the user said it", () => {
    const nobody = [{ people: 0 }, { people: 0 }];
    expect(togetherWithoutPeople("A day spent together by the sea.", nobody, [])).toBe(true);
    expect(togetherWithoutPeople("A day spent together by the sea.", nobody, [{ kind: "answer", text: "We went together" }])).toBe(false);
    expect(togetherWithoutPeople("A day spent together by the sea.", [{ people: 2 }], [])).toBe(false);
    expect(togetherWithoutPeople("A day spent together by the sea.", [{ people: null }], [])).toBe(false);
  });
  it("never describes a shot of two people when every photo shows one person at most", () => {
    expect(togetherWithoutPeople("The two of us, side by side by the wall.", [{ people: 1 }, { people: 1 }], [])).toBe(true);
    expect(togetherWithoutPeople("The two of us, side by side by the wall.", [{ people: 2 }], [])).toBe(false);
  });
});

describe("chapter lines never echo another chapter's", () => {
  it("same words, same opening or most of the same content words are repeats; a different line is not", () => {
    expect(repeatedLineIssue("A quiet afternoon by the sea.", ["A quiet afternoon by the sea."])).toBe(true);
    expect(repeatedLineIssue("A quiet afternoon in the old town.", ["A quiet afternoon by the sea."])).toBe(true);
    expect(repeatedLineIssue("The sea, the afternoon, the quiet.", ["A quiet afternoon by the sea."])).toBe(true);
    expect(repeatedLineIssue("Dinner ran late on the last night.", ["A quiet afternoon by the sea."])).toBe(false);
    const ctx = factCtx([], { otherLines: ["A quiet afternoon by the sea."] });
    expect(codesOf("headline", "A quiet afternoon by the sea.", [], ctx)).toContain("near_duplicate");
  });
});

describe("prompts: one theme for every book, driven by each user's inputs", () => {
  it("system prompts carry no book-specific content and label the one style example", () => {
    for (const p of [STORY_PLANNER_SYSTEM_PROMPT, STORY_WRITER_SYSTEM_PROMPT, STORY_REWRITER_SYSTEM_PROMPT]) {
      // ("brother" stays in the generic list of relationships the model must never infer)
      expect(p).not.toMatch(/Dubai|my brother|coffee|café|cafe|Some moments are worth the wait/i);
      for (const line of REFERENCE_LINES) expect(p).not.toContain(line);
    }
    expect(STORY_WRITER_SYSTEM_PROMPT).toMatch(/STYLE EXAMPLE — for the SHAPE and TONE only\. It is a different book about a different memory; never reuse its words/);
  });
  it.each(OCCASIONS)("the writer request follows the book's own inputs (%s)", (occasion) => {
    const inputs: StoryInputs = { photos: [photo({ alias: "p1", peopleCount: 1 })], moments: [{ id: "m1", photoIds: [], label: "x", dateLabel: null, place: null, heroPhotoId: null }], facts: buildFacts({ title: "Our book", occasion, caption_lang: "en" }, null), avoid: [], lang: "en", occasion, storyTone: null, narrator: "third", contextRev: null, mode: "observational" };
    const plan = { chapters: [{ id: "c1", title: "Start", arc: "a", momentIds: ["m1"], beats: { heroPhotoId: inputs.photos[0]!.id, narrativeMomentIds: [] } }] } as unknown as StoryPlan;
    const text = writerUserText({ inputs, plan, chapterId: "c1", slots: [{ blockId: "b1", kind: "intro", pagePhotos: ["p1"] }, { blockId: "b2", kind: "subtitle", pagePhotos: [] }], photos: inputs.photos, alreadyWritten: [], subtitlePlace: null, usedLines: ["An earlier line"] });
    expect(text).toContain(`OCCASION: ${occasion}`);
    expect(text).toContain("SUBTITLE PLACE: none verified");
    expect(text).toContain('LINES ALREADY USED IN OTHER CHAPTERS (never repeat or echo them)\n"An earlier line"');
    expect(text).toContain("PEOPLE IN THESE PHOTOS: one person per photo");
    expect(text).not.toMatch(/Dubai|brother|coffee/i);
  });
});

describe("one visit = one chapter", () => {
  it("scenes of one day at one place count as one visit: the minimum and the rule target drop to 1; separate days stay separate", async () => {
    const { chapterCountRange, visitCountOf } = await import("@/lib/ai/story/plan");
    const m = (id: string, dateLabel: string | null, place: string | null = null) => ({ id, dateLabel, place });
    expect(visitCountOf([m("m1", "30 May 2026"), m("m2", "30 May 2026"), m("m3", "30 May 2026")])).toBe(1);
    expect(visitCountOf([m("m1", "12 Oct"), m("m2", "13 Oct"), m("m3", "14 Oct")])).toBe(3);
    expect(visitCountOf([m("m1", null), m("m2", null)])).toBe(2);
    expect(chapterCountRange(24, 3, 1)).toEqual({ min: 1, max: 3, target: 1 });
    expect(chapterCountRange(24, 3, 3)).toEqual({ min: 2, max: 3, target: 3 });
  });
});
