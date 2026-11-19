import { describe, expect, it } from "vitest";
import { OCCASIONS, type Occasion } from "@/lib/book/options";
import {
  isStoryTone,
  LEGACY_QUESTION_MAP,
  MEMORY_QUESTION_IDS,
  migrateStoryAnswers,
  occasionPrefill,
  STORY_QUESTIONS_MAX,
  STORY_ANSWER_MAX,
  STORY_TONE_LABELS,
  STORY_TONES,
  storyQuestionsFor,
} from "@/lib/story/questions";

const ALL: (Occasion | null)[] = [...OCCASIONS, null];
const wordsOf = (o: Occasion | null) =>
  storyQuestionsFor(o)
    .map((q) => `${q.id} ${q.prompt} ${q.placeholder} ${q.suggestions.join(" ")}`)
    .join(" ")
    .toLowerCase();

describe("story tones", () => {
  it("three tones with the exact labels", () => {
    expect(STORY_TONES).toEqual(["heartfelt", "joyful", "elegant"]);
    expect(STORY_TONE_LABELS).toEqual({
      heartfelt: "Heartfelt & personal",
      joyful: "Joyful & playful",
      elegant: "Elegant & timeless",
    });
    expect(isStoryTone("joyful")).toBe(true);
    expect(isStoryTone("romantic")).toBe(false);
    expect(isStoryTone(null)).toBe(false);
  });

  it("answers are limited to 200 code points", () => {
    expect(STORY_ANSWER_MAX).toBe(200);
  });
});

describe("storyQuestionsFor (v3: What makes this memory special?)", () => {
  it("birthday is an occasion, in the agreed order", () => {
    expect(OCCASIONS).toEqual(["wedding", "travel", "baby", "birthday", "graduation", "family", "other"]);
  });

  it.each(ALL)("%s: three short optional questions — occasion, relationship, one memory — with stable ids", (occasion) => {
    const questions = storyQuestionsFor(occasion);
    expect(questions).toHaveLength(STORY_QUESTIONS_MAX);
    expect(questions.map((q) => q.id)).toEqual(["memory.occasion", "memory.relationship", "memory.moment"]);
    expect(questions.map((q) => q.kind)).toEqual(["occasion", "relationship", "moment"]);
    for (const q of questions) {
      expect(q.id).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(q.prompt.trim()).toBe(q.prompt);
      expect(q.prompt.length).toBeGreaterThan(5);
      expect(q.prompt.length).toBeLessThanOrEqual(60);
      expect(q.hint.length).toBeGreaterThan(0);
      expect(q.placeholder.length).toBeGreaterThan(0);
      expect(q.placeholder.length).toBeLessThanOrEqual(50);
      for (const chip of q.suggestions) {
        expect(chip.trim()).toBe(chip);
        expect(chip.length).toBeLessThanOrEqual(30);
      }
    }
  });

  it("relationship chips are short and only suggestions (my brother, my partner, friends, family …); the other fields have none", () => {
    const [occasion, relationship, moment] = storyQuestionsFor("travel");
    expect(relationship!.suggestions).toEqual(expect.arrayContaining(["My brother", "My partner", "Friends", "Family"]));
    expect(relationship!.suggestions.length).toBeLessThanOrEqual(5);
    expect(occasion!.suggestions).toEqual([]);
    expect(moment!.suggestions).toEqual([]);
    expect(relationship!.hint).toMatch(/never guess/i);
  });

  it("the occasion field starts as the step-2 occasion; none / Other start empty", () => {
    expect(occasionPrefill("travel")).toBe("Travel");
    expect(occasionPrefill("birthday")).toBe("Birthday");
    expect(occasionPrefill("other")).toBe("");
    expect(occasionPrefill(null)).toBe("");
  });

  it("Task 5 answers load under the v3 questions (the user's own text, unchanged); a v3 answer wins", () => {
    expect(migrateStoryAnswers([{ questionId: "travel.companions", text: "My brother" }, { questionId: "travel.special", text: "We met again after a long time." }])).toEqual([
      { questionId: "memory.relationship", text: "My brother" },
      { questionId: "memory.moment", text: "We met again after a long time." },
    ]);
    expect(migrateStoryAnswers([{ questionId: "other.about", text: "A year of little moments" }])).toEqual([{ questionId: "memory.occasion", text: "A year of little moments" }]);
    expect(migrateStoryAnswers([{ questionId: "memory.moment", text: "new" }, { questionId: "travel.special", text: "old" }])).toEqual([{ questionId: "memory.moment", text: "new" }]);
    expect(migrateStoryAnswers([{ questionId: "unknown.thing", text: "x" }])).toEqual([]);
    // every Task 5 id has a home
    for (const id of Object.keys(LEGACY_QUESTION_MAP)) expect(Object.values(MEMORY_QUESTION_IDS)).toContain(LEGACY_QUESTION_MAP[id]);
  });

  it("returns fresh copies (a caller cannot change the catalogue)", () => {
    const first = storyQuestionsFor("travel");
    first[1]!.suggestions.push("x");
    first.pop();
    expect(storyQuestionsFor("travel")).toHaveLength(3);
    expect(storyQuestionsFor("travel")[1]!.suggestions).not.toContain("x");
  });

  it.each(ALL)("%s: nothing asks for or suggests sensitive details", (occasion) => {
    const sensitive =
      /\b(age|how old|health|illness|sick|hospital|diagnos|pregnan|religio|faith|pray|salary|income|money|cost|price|address|phone|passport|visa|nationalit|politic|weight|divorce|death|died|passed away|full name|surname|birth ?date|date of birth)\b/;
    expect(wordsOf(occasion)).not.toMatch(sensitive);
  });
});
