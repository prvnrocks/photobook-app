// Storybook v2 narrative quality: the writer must tell a story, not list the frame. Synthetic
// recorded fixtures (tests/fixtures/ai/story/narrative-v2.json — invented text, no user content);
// no live model call.
import { describe, expect, it } from "vitest";
import { checkBlock, genderedIssue, inventoryIssue, nearDuplicateIssue, type GroundingContext } from "@/lib/ai/story/grounding";
import fixture from "../fixtures/ai/story/narrative-v2.json";

const photos = new Map([["p1", { place: null, dateLabel: null, evidence: "Two people sit on a bench under palm trees . bench . palm tree . umbrella . towel . cooler . sandals . cup . table . lantern . door", objects: fixture.objects }]]);
const ctx = (over: Partial<GroundingContext> = {}): GroundingContext => ({ lang: "en", photos, facts: new Map(), otherTexts: [], ...over });
const block = (text: string, kind: "paragraph" | "intro" | "caption" = "paragraph") => ({ blockId: "b1", kind, text, photoRefs: ["p1"], factRefs: [] });

describe("inventory lint", () => {
  it.each(fixture.inventory)("rejects an inventory of the frame: %s", (text) => {
    expect(inventoryIssue(text, "paragraph", fixture.objects)).not.toBeNull();
    expect(checkBlock(block(text), ctx()).map((i) => i.code)).toContain("inventory");
  });
  it.each(fixture.narrative)("accepts storytelling with one anchor: %s", (text) => {
    expect(inventoryIssue(text, "paragraph", fixture.objects)).toBeNull();
  });
  it("a caption is one line: four concrete things in it is a list", () => {
    expect(inventoryIssue("A cup, a lantern, a towel and sandals on the table.", "caption", fixture.objects)).not.toBeNull();
    expect(inventoryIssue("The coffee came first, the plans came later.", "caption", fixture.objects)).toBeNull();
  });
  it("Arabic text is not linted for inventories (documented limit)", () => {
    expect(checkBlock({ ...block("جلسنا على المقعد تحت النخيل، ثم جاءت القهوة وبدأ الصباح ببطء، ولم يكن أحد منا مستعجلًا أبدًا في ذلك اليوم الهادئ."), photoRefs: ["p1"] }, ctx({ lang: "ar" })).map((i) => i.code)).not.toContain("inventory");
  });
});

describe("gender is never inferred from a photo", () => {
  it("he / she / man / woman are rejected unless the user's own facts give such a word", () => {
    const text = "Later he settles in by the window while the light moves across the room and the afternoon slows down.";
    expect(genderedIssue(text, [])).toBe(true);
    expect(checkBlock(block(text), ctx()).map((i) => i.code)).toContain("gendered_word");
    expect(genderedIssue(text, [{ kind: "person", text: "Omar — my husband" }])).toBe(false);
    expect(genderedIssue("She laughed at the view.", [{ kind: "person", text: "Omar — my husband" }])).toBe(true);
    expect(genderedIssue("We settled in by the window and stayed until the light changed.", [])).toBe(false);
  });
});

describe("near-duplicates and repeated beats inside a chapter", () => {
  it("a paraphrase of another block of the chapter is rejected; a different beat is not", () => {
    const [a, b] = fixture.paraphrase as [string, string];
    expect(nearDuplicateIssue(b, [a])).not.toBeNull();
    expect(checkBlock(block(b), ctx({ chapterTexts: [a] })).map((i) => i.code)).toContain("near_duplicate");
    expect(nearDuplicateIssue(fixture.narrative[1]!, [fixture.narrative[0]!])).toBeNull();
  });
  it("'again' / 'another round' twice in a chapter is a repeated beat", () => {
    expect(nearDuplicateIssue("Another round of photos by the lantern before the light went.", ["We tried the pose again by the door."])).toBe("beat");
    expect(nearDuplicateIssue("Another round of photos by the lantern before the light went.", ["We tried the pose by the door."])).toBeNull();
  });
});

describe("light narrative framing (v2) without invented facts", () => {
  const facts = new Map([["f1", { kind: "answer", text: "After a long time, we finally went out together" }]]);
  it("first-person framing in the narrator's voice passes; the same verb for someone else, or a strong feeling, does not", () => {
    const framing = "We wanted one more photo before leaving, so we stayed by the bench while the coffee went cold beside us.";
    expect(checkBlock(block(framing), ctx({ narrator: "first_plural" })).map((i) => i.code)).not.toContain("stated_feeling");
    expect(checkBlock(block(framing), ctx({ narrator: "third" })).map((i) => i.code)).toContain("stated_feeling");
    const strong = "We were so happy to sit by the bench while the coffee went cold beside us and the morning went on.";
    expect(checkBlock(block(strong), ctx({ narrator: "first_plural" })).map((i) => i.code)).toContain("stated_feeling");
  });
  it("the user's own answer can carry the story when it is cited", () => {
    const text = "After a long time, we finally went out together, and the bench under the palms was where the day began for us.";
    expect(checkBlock({ ...block(text), factRefs: ["f1"] }, ctx({ facts, narrator: "first_plural" }))).toEqual([]);
  });
  it("invented facts are still rejected: a name, a relationship, a date", () => {
    const codes = checkBlock(block("Sara and her husband came back in March to the same bench under the palms by the sea."), ctx({ narrator: "first_plural" })).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["ungrounded_name", "ungrounded_relationship", "ungrounded_date"]));
  });
});
