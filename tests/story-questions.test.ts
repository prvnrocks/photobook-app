import { describe, expect, it } from "vitest";
import { OCCASIONS, type Occasion } from "@/lib/book/options";
import {
  isStoryTone,
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

describe("storyQuestionsFor", () => {
  it("birthday is an occasion, in the agreed order", () => {
    expect(OCCASIONS).toEqual(["wedding", "travel", "baby", "birthday", "graduation", "family", "other"]);
  });

  it.each(ALL)("%s: one or two short questions with stable unique ids and 3–5 short chips", (occasion) => {
    const questions = storyQuestionsFor(occasion);
    expect(questions.length).toBeGreaterThanOrEqual(1);
    expect(questions.length).toBeLessThanOrEqual(2);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    for (const q of questions) {
      expect(q.id).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(q.id.length).toBeLessThanOrEqual(60);
      expect(q.id.startsWith(`${occasion ?? "other"}.`)).toBe(true);
      expect(q.prompt.trim()).toBe(q.prompt);
      expect(q.prompt.length).toBeGreaterThan(5);
      expect(q.prompt.length).toBeLessThanOrEqual(60);
      expect(q.prompt.endsWith("?")).toBe(true);
      expect(q.placeholder.length).toBeGreaterThan(0);
      expect(q.placeholder.length).toBeLessThanOrEqual(50);
      expect(q.suggestions.length).toBeGreaterThanOrEqual(3);
      expect(q.suggestions.length).toBeLessThanOrEqual(5);
      expect(new Set(q.suggestions).size).toBe(q.suggestions.length);
      for (const chip of q.suggestions) {
        expect(chip.trim()).toBe(chip);
        expect(chip.length).toBeGreaterThan(0);
        expect(chip.length).toBeLessThanOrEqual(30);
        expect(Array.from(chip).length).toBeLessThanOrEqual(STORY_ANSWER_MAX);
      }
    }
  });

  it("ids are unique across all occasions", () => {
    const ids = OCCASIONS.flatMap((o) => storyQuestionsFor(o).map((q) => q.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("travel asks who they travelled with and what made it special", () => {
    const [a, b] = storyQuestionsFor("travel");
    expect(a.id).toBe("travel.companions");
    expect(a.prompt).toMatch(/who .*travel/i);
    expect(b.id).toBe("travel.special");
    expect(b.prompt).toMatch(/special/i);
  });

  it("baby asks for the milestone and memorable firsts", () => {
    const [a, b] = storyQuestionsFor("baby");
    expect(a.id).toBe("baby.milestone");
    expect(a.prompt).toMatch(/milestone/i);
    expect(b.id).toBe("baby.firsts");
    expect(b.prompt).toMatch(/firsts/i);
  });

  it("wedding asks about the occasion and the important moments", () => {
    const [a, b] = storyQuestionsFor("wedding");
    expect(a.id).toBe("wedding.occasion");
    expect(a.prompt).toMatch(/whose day|celebration/i);
    expect(b.id).toBe("wedding.moments");
    expect(b.prompt).toMatch(/moments/i);
  });

  it("no occasion (or an unknown one) gets the Other questions", () => {
    expect(storyQuestionsFor(null)).toEqual(storyQuestionsFor("other"));
    expect(storyQuestionsFor("picnic" as Occasion)).toEqual(storyQuestionsFor("other"));
  });

  it("returns fresh copies (a caller cannot change the catalogue)", () => {
    const first = storyQuestionsFor("travel");
    first[0].suggestions.push("x");
    first.pop();
    expect(storyQuestionsFor("travel")).toHaveLength(2);
    expect(storyQuestionsFor("travel")[0].suggestions).not.toContain("x");
  });

  it.each(ALL)("%s: nothing asks for or suggests sensitive details", (occasion) => {
    const sensitive =
      /\b(age|how old|health|illness|sick|hospital|diagnos|pregnan|religio|faith|pray|salary|income|money|cost|price|address|phone|passport|visa|nationalit|politic|weight|divorce|death|died|passed away|full name|surname|birth ?date|date of birth)\b/;
    expect(wordsOf(occasion)).not.toMatch(sensitive);
  });
});
