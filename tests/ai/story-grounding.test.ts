import { describe, expect, it } from "vitest";
import {
  BANNED_PHRASES,
  WORD_BOUNDS,
  checkBlock,
  checkPlanText,
  countWords,
  normalizeArabic,
  tokenize,
  type BlockDraft,
  type GroundingContext,
  type GroundingFact,
  type GroundingIssueCode,
  type GroundingPhoto,
} from "@/lib/ai/story/grounding";
import { replayText } from "@/lib/ai/story/replay";
import { NARRATIVE_KINDS } from "@/lib/storybook/schemas";
import type { NarrativeKind } from "@/lib/storybook/types";

// Task 6: the grounding check — the heart of the Narrative Writer. Table-driven, English and Arabic.

const photo = (over: Partial<GroundingPhoto> = {}): GroundingPhoto => ({ place: null, dateLabel: null, evidence: "", ...over });

const EN_PHOTOS = new Map<string, GroundingPhoto>([
  ["p1", photo({ place: "Abu Dhabi", dateLabel: "12 Oct 2026", evidence: "Two people walk along a beach at sunset. . beach . sea . walking on a beach" })],
  ["p2", photo({ evidence: "A long table with candles and plates. . table . candles . plates" })],
  ["p3", photo({ place: "Sheikh Zayed Grand Mosque", dateLabel: "13 Oct 2026", evidence: "White domes under a clear sky. . domes" })],
]);
const EN_FACTS = new Map<string, GroundingFact>([
  ["f1", { kind: "person", text: "Sara — my sister" }],
  ["f2", { kind: "answer", text: "We got engaged on the beach in October 2023 and I felt so nervous" }],
  ["f3", { kind: "place", text: "Lisbon" }],
  ["f4", { kind: "occasion", text: "birthday" }],
  ["f5", { kind: "answer", text: 'My dad always says "keep walking" when we are tired' }],
  ["f6", { kind: "fact", text: "Noor turned three" }],
  ["f7", { kind: "person", text: "Omar" }],
]);
const en = (over: Partial<GroundingContext> = {}): GroundingContext => ({ lang: "en", photos: EN_PHOTOS, bookPhotos: new Set(["p1", "p2", "p3", "p9"]), facts: EN_FACTS, otherTexts: [], ...over });

const AR_PHOTOS = new Map<string, GroundingPhoto>([["p1", photo({ place: "أبوظبي", dateLabel: "12 Oct 2026", evidence: "شخصان يمشيان على الشاطئ عند الغروب" })]]);
const AR_FACTS = new Map<string, GroundingFact>([
  ["f1", { kind: "person", text: "سارة — أختي" }],
  ["f2", { kind: "answer", text: "تخرجت نور في يونيو وكنا سعداء جدا" }],
  ["f4", { kind: "occasion", text: "wedding" }],
  ["f5", { kind: "person", text: "Omar" }],
]);
const ar = (over: Partial<GroundingContext> = {}): GroundingContext => ({ lang: "ar", photos: AR_PHOTOS, bookPhotos: new Set(["p1", "p9"]), facts: AR_FACTS, otherTexts: [], ...over });

const block = (text: string, refs: string[], kind: NarrativeKind = "caption"): BlockDraft => ({
  blockId: "b1",
  kind,
  text,
  photoRefs: refs.filter((r) => r.startsWith("p")),
  factRefs: refs.filter((r) => r.startsWith("f")),
});
const codes = (text: string, refs: string[], ctx: GroundingContext, kind: NarrativeKind = "caption") => [...new Set(checkBlock(block(text, refs, kind), ctx).map((i) => i.code))];

type Row = [what: string, text: string, refs: string[], expected: GroundingIssueCode | null];

const EN_ROWS: Row[] = [
  ["a plain caption about what is visible, with a visible count", "The two walk along the beach as the sun goes down.", ["p1"], null],
  ["invented person name", "The light falls on Maria beside the long table tonight.", ["p2"], "ungrounded_name"],
  ["invented place", "The beach in Dubai glows as the sun goes down.", ["p1"], "ungrounded_name"],
  ["a place that IS in the cited photo's metadata", "The beach in Abu Dhabi glows as the sun goes down.", ["p1"], null],
  ["the same place when the cited photo has no place", "The table in Abu Dhabi glows beside the tall candles.", ["p2"], "ungrounded_name"],
  ["a place from a cited user fact", "The long table in Lisbon waits beside the tall candles.", ["p2", "f3"], null],
  ["a name that IS in a cited user fact", "Sara walks along the beach as the sun goes down.", ["p1", "f1"], null],
  ["a listed name whose fact is not cited", "Sara walks along the beach as the sun goes down.", ["p1"], "ungrounded_name"],
  ["a listed name in lower case, not cited", "The evening finds omar walking along the quiet beach.", ["p1"], "ungrounded_name"],
  ["an invented name at the start of a sentence", "The beach is quiet. Layla walks ahead of the waves.", ["p1"], "ungrounded_name"],
  ["title case inside a sentence", "The Golden Hour settles over the beach and the sea.", ["p1"], "ungrounded_name"],
  ["relationship word without a fact", "A mother and her daughter walk along the beach at dusk.", ["p1"], "ungrounded_relationship"],
  ["'friends' without a fact", "The two friends walk along the beach as the sun sets.", ["p1"], "ungrounded_relationship"],
  ["'the couple' without a fact", "The couple walk along the beach as the sun goes down.", ["p1"], "ungrounded_relationship"],
  ["relationship from the user's own fact", "Sara, my sister, walks along the beach as the sun sets.", ["p1", "f1"], null],
  ["invented weekday", "A warm Saturday on the beach as the sun goes down.", ["p1"], "ungrounded_date"],
  ["invented month", "The beach in December as the sun goes slowly down.", ["p1"], "ungrounded_date"],
  ["the month of the cited photo's date", "The beach in October as the sun goes slowly down.", ["p1"], null],
  ["invented year", "The beach in 2019 as the sun goes slowly down.", ["p1"], "ungrounded_date"],
  ["the year of the cited photo's date", "The beach in 2026 as the sun goes slowly down.", ["p1"], null],
  ["invented season", "A long summer evening on the beach beside the sea.", ["p1"], "ungrounded_date"],
  ["invented duration", "After years of waiting the two walk along the beach.", ["p1"], "ungrounded_date"],
  ["invented age", "The child, three years old, sits beside the long table.", ["p2"], "ungrounded_date"],
  ["an age the user gave", "Noor, three years old, sits beside the long table tonight.", ["p2", "f6"], null],
  ["a number stated as fact", "The table was set for forty beside the tall candles.", ["p2"], "ungrounded_number"],
  ["milestone word without a fact", "The long table is set for an anniversary with candles.", ["p2"], "ungrounded_milestone"],
  ["'newborn' without a fact", "A newborn sleeps beside the long table and the candles.", ["p2"], "ungrounded_milestone"],
  ["'graduated' without a fact", "She graduated and the long table was set with candles.", ["p2"], "ungrounded_milestone"],
  ["the occasion the user chose", "The long table is set for a birthday with candles.", ["p2", "f4"], null],
  ["'first birthday' when the user only said birthday", "The long table is set for a first birthday tonight.", ["p2", "f4"], "ungrounded_milestone"],
  ["an event from the user's own answer", "We got engaged on this beach as the sun went down.", ["p1", "f2"], null],
  ["the same event without citing the answer", "We got engaged on this beach as the sun went down.", ["p1"], "ungrounded_milestone"],
  ["invented dialogue in curly quotes", "The two walk on as someone calls “wait for me” behind.", ["p1"], "quoted_speech"],
  ["invented dialogue in straight quotes", 'The two walk on as someone calls "wait for me" behind.', ["p1"], "quoted_speech"],
  ["invented dialogue in guillemets", "The two walk on as someone calls «wait for me» behind.", ["p1"], "quoted_speech"],
  ["reported speech", "The two walk on and she said it was time now.", ["p1"], "quoted_speech"],
  ["a verbatim quote of the user's answer", "The two walk along the beach, “keep walking” in mind.", ["p1", "f5"], null],
  ["the user's words quoted without citing them", "The two walk along the beach, “keep walking” in mind.", ["p1"], "quoted_speech"],
  ["a stated feeling (were thrilled)", "They were thrilled to walk along the beach at sunset.", ["p1"], "stated_feeling"],
  ["a stated feeling (she felt)", "She felt calm as the sun went down over the beach.", ["p1"], "stated_feeling"],
  ["a stated thought (knew)", "The two walk on and they knew the evening was ending.", ["p1"], "stated_feeling"],
  ["a stated feeling of a named person", "Sara was so happy on the beach as the sun set.", ["p1", "f1"], "stated_feeling"],
  ["a feeling as a possession", "Their joy fills the beach as the sun goes down.", ["p1"], "stated_feeling"],
  ["a feeling the user stated in the cited answer", "I felt so nervous on the beach as the sun set.", ["p1", "f2"], null],
  ["atmosphere of the scene is fine", "The evening feels calm and golden over the quiet beach.", ["p1"], null],
  ["a visible expression is fine", "The two smile and lean together on the quiet beach.", ["p1"], null],
];

const AR_ROWS: Row[] = [
  ["a plain Arabic caption", "الضوء الذهبي يمتد فوق الشاطئ الهادئ عند الغروب", ["p1"], null],
  ["a place from the cited photo's metadata", "الضوء الذهبي يمتد فوق شاطئ أبوظبي عند الغروب", ["p1"], null],
  ["relationship words without a fact", "أم وابنتها تمشيان على الشاطئ الهادئ عند الغروب", ["p1"], "ungrounded_relationship"],
  ["'my friends' without a fact", "أصدقائي يمشون على الشاطئ الهادئ عند غروب الشمس", ["p1"], "ungrounded_relationship"],
  ["relationship from the user's own fact", "سارة أختي تمشي على الشاطئ الهادئ عند الغروب", ["p1", "f1"], null],
  ["a listed person whose fact is not cited", "سارة تمشي على الشاطئ الهادئ عند غروب الشمس", ["p1"], "ungrounded_name"],
  ["a Latin-script name that is not in a cited fact", "تمشي Maria على الشاطئ الهادئ عند غروب الشمس", ["p1"], "ungrounded_name"],
  ["invented month", "الشاطئ الهادئ في ديسمبر عند غروب الشمس الذهبي", ["p1"], "ungrounded_date"],
  ["the month of the cited photo's date", "الشاطئ الهادئ في أكتوبر عند غروب الشمس الذهبي", ["p1"], null],
  ["invented year in Arabic digits", "الشاطئ الهادئ في ٢٠١٩ عند غروب الشمس الذهبي", ["p1"], "ungrounded_date"],
  ["invented weekday", "مساء الجمعة على الشاطئ الهادئ عند غروب الشمس", ["p1"], "ungrounded_date"],
  ["invented season", "مساء الصيف على الشاطئ الهادئ عند غروب الشمس", ["p1"], "ungrounded_date"],
  ["invented age", "طفلة عمرها قليل تمشي على الشاطئ عند الغروب", ["p1"], "ungrounded_date"],
  ["a number stated as fact", "خمسة قوارب تنتظر قرب الشاطئ الهادئ عند الغروب", ["p1"], "ungrounded_number"],
  ["milestone word without a fact", "حفل زفاف على الشاطئ الهادئ عند غروب الشمس", ["p1"], "ungrounded_milestone"],
  ["the occasion the user chose", "حفل زفاف على الشاطئ الهادئ عند غروب الشمس", ["p1", "f4"], null],
  ["'birthday' without a fact", "عيد ميلاد على الشاطئ الهادئ عند غروب الشمس", ["p1"], "ungrounded_milestone"],
  ["an event from the user's own answer", "تخرجت نور وكنا سعداء على الشاطئ عند الغروب", ["p1", "f2"], null],
  ["a stated feeling", "كانت سعيدة وهي تمشي على الشاطئ عند الغروب", ["p1"], "stated_feeling"],
  ["a stated feeling (verb)", "شعرت بالهدوء وهي تمشي على الشاطئ عند الغروب", ["p1"], "stated_feeling"],
  ["invented dialogue", "تمشيان على الشاطئ «هيا بنا» عند غروب الشمس", ["p1"], "quoted_speech"],
  ["reported speech", "قالت إن الشاطئ هادئ جدا عند غروب الشمس", ["p1"], "quoted_speech"],
  ["'door' is not 'father' (باب)", "الباب الخشبي القديم يطل على الشاطئ عند الغروب", ["p1"], null],
  ["'far' is not 'Eid' (بعيد)", "الأفق البعيد يمتد فوق الشاطئ الهادئ عند الغروب", ["p1"], null],
  ["'found' is not 'grandfather' (وجد)", "وجد الضوء طريقه فوق الشاطئ الهادئ عند الغروب", ["p1"], null],
];

describe("grounding: English", () => {
  it.each(EN_ROWS)("%s", (_what, text, refs, expected) => {
    const got = codes(text, refs, en());
    if (expected === null) expect(got).toEqual([]);
    else expect(got).toContain(expected);
  });

  it("an accepted row stays accepted only because of what it cites (no global allow-list)", () => {
    expect(codes("Sara, my sister, walks along the beach as the sun sets.", ["p1", "f7"], en())).toEqual(expect.arrayContaining(["ungrounded_name", "ungrounded_relationship"]));
  });

  it("issues carry a category as detail, never the offending text", () => {
    const issues = checkBlock(block("The light falls on Maria in Lisbon during a Saturday anniversary “hello” tonight.", ["p2"]), en());
    expect(issues.length).toBeGreaterThan(3);
    for (const i of issues) {
      expect(i.blockId).toBe("b1");
      expect(i.detail ?? "").toMatch(/^[a-z_]*$/);
      expect(JSON.stringify(i)).not.toMatch(/Maria|Lisbon|Saturday|hello/i);
    }
  });
});

describe("grounding: Arabic", () => {
  it.each(AR_ROWS)("%s", (_what, text, refs, expected) => {
    const got = codes(text, refs, ar());
    if (expected === null) expect(got).toEqual([]);
    else expect(got).toContain(expected);
  });

  it("normalises hamza, ta marbuta, diacritics and Arabic-Indic digits", () => {
    expect(normalizeArabic("أُخْتِي إلى مدرسةٍ ٢٠٢٦")).toBe("اختي الي مدرسه 2026");
    expect(tokenize("سارة، أختي.").map((t) => t.norm)).toEqual(["ساره", "اختي"]);
  });
});

describe("grounding: stock phrases", () => {
  it("has at least 25 English entries and Arabic ones", () => {
    expect(BANNED_PHRASES.filter((p) => !p.id.startsWith("ar_")).length).toBeGreaterThanOrEqual(25);
    expect(BANNED_PHRASES.filter((p) => p.id.startsWith("ar_")).length).toBeGreaterThanOrEqual(8);
    expect(new Set(BANNED_PHRASES.map((p) => p.id)).size).toBe(BANNED_PHRASES.length);
  });

  it.each(BANNED_PHRASES.map((p) => [p.id, p.example] as const))("%s is rejected", (id, example) => {
    const arabic = id.startsWith("ar_");
    const text = arabic ? `الضوء الذهبي يمتد فوق الشاطئ، ${example}، عند الغروب` : `The long table and the candles, ${example}, wait there.`;
    expect(codes(text, [arabic ? "p1" : "p2"], arabic ? ar() : en(), "paragraph")).toContain("banned_phrase");
  });

  it.each(["Memories That Will Last A Lifetime", "UNFORGETTABLE", "Time Stood Still"])("case-insensitive: %s", (phrase) => {
    expect(codes(`The long table and the candles, ${phrase.toLowerCase()}, wait there.`, ["p2"], en())).toContain("banned_phrase");
    expect(checkPlanText("t", "title", phrase, { lang: "en", facts: [], metadata: [], evidence: [] }).map((i) => i.code)).toContain("banned_phrase");
  });
});

describe("grounding: repetition across the storybook", () => {
  it("rejects an opening already used by another block", () => {
    const ctx = en({ otherTexts: ["The two walk along the beach before the light fades away."] });
    expect(codes("The two walk beside the sea under a pale sky.", ["p1"], ctx)).toEqual(["repetition"]);
    expect(checkBlock(block("The two walk beside the sea under a pale sky.", ["p1"]), ctx)[0]).toMatchObject({ code: "repetition", detail: "opening" });
  });

  it("rejects a 4-word sequence used anywhere in another block", () => {
    const ctx = en({ otherTexts: ["Soft light settles on the long table near the candles."] });
    expect(checkBlock(block("Evening comes and light settles on the plates and candles.", ["p2"]), ctx)).toEqual([{ blockId: "b1", code: "repetition", detail: "sequence" }]);
    expect(codes("Evening comes and light rests upon the plates and candles.", ["p2"], ctx)).toEqual([]);
  });

  it("a place name from the cited metadata may appear in two blocks", () => {
    const ctx = en({ otherTexts: ["White domes rise at Sheikh Zayed Grand Mosque in clear morning light."] });
    expect(codes("Under a clear sky, Sheikh Zayed Grand Mosque stands very still.", ["p3"], ctx)).toEqual([]);
  });

  it("Arabic: same opening / same sequence", () => {
    const ctx = ar({ otherTexts: ["الضوء الذهبي يمتد فوق البحر الواسع قبل المساء"] });
    expect(codes("الضوء الذهبي يمتد فوق الشاطئ الهادئ عند الغروب", ["p1"], ctx)).toEqual(["repetition"]);
  });
});

describe("grounding: sources", () => {
  const TEXT = "The two walk along the beach as the sun goes down.";
  it("a block must cite its sources", () => {
    expect(checkBlock(block(TEXT, []), en())).toContainEqual({ blockId: "b1", code: "no_refs" });
  });
  it("anything but a closing needs a photo", () => {
    expect(checkBlock(block("Sara, my sister, is here beside the sea this evening.", ["f1"]), en())).toContainEqual({ blockId: "b1", code: "no_refs", detail: "no_photo" });
  });
  it("a closing may cite facts only", () => {
    const closing = `${replayText("en", 1, 8)} Sara, my sister, is there in every one of them.`;
    expect(codes(closing, ["f1"], en(), "closing")).toEqual([]);
  });
  it("a photo of another chapter, an unknown photo and an unknown fact are rejected", () => {
    expect(checkBlock(block(TEXT, ["p9"]), en())).toContainEqual({ blockId: "b1", code: "ref_outside_chapter", detail: "photo" });
    expect(checkBlock(block(TEXT, ["p77"]), en())).toContainEqual({ blockId: "b1", code: "unknown_ref", detail: "photo" });
    expect(checkBlock(block(TEXT, ["p1", "f99"]), en())).toContainEqual({ blockId: "b1", code: "unknown_ref", detail: "fact" });
  });
  it("too many references are rejected", () => {
    const many = Array.from({ length: 13 }, (_, i) => `p${i + 20}`);
    expect(codes(TEXT, ["p1", ...many], en())).toContain("too_many_refs");
  });
  it("an empty block is rejected", () => {
    expect(checkBlock(block("   ", ["p1"]), en())).toEqual([{ blockId: "b1", code: "empty" }]);
  });
  it("things the user asked not to mention are rejected", () => {
    expect(codes("The long table with candles and plates waits there.", ["p2"], en({ avoid: ["candles"] }))).toEqual(["avoided_topic"]);
  });
});

describe("grounding: hard word bounds at the edges", () => {
  const words = (lang: "en" | "ar", n: number) => `${replayText(lang, 1, 12)} ${replayText(lang, 2, 12)} ${replayText(lang, 3, 12)}`.split(/\s+/).slice(0, n).join(" ");

  it("counts whitespace-separated words in both scripts", () => {
    expect(countWords("The two walk — along the beach.")).toBe(6);
    expect(countWords("الضوء الذهبي يمتد فوق الشاطئ")).toBe(5);
    expect(countWords(words("en", 70))).toBe(70);
    expect(countWords(words("ar", 70))).toBe(70);
  });

  it.each(NARRATIVE_KINDS.flatMap((kind) => (["en", "ar"] as const).map((lang) => [kind, lang] as const)))("%s (%s): min − 1 rejected, min and max accepted, max + 1 rejected", (kind, lang) => {
    const { min, max } = WORD_BOUNDS[kind];
    const ctx = lang === "en" ? en() : ar();
    const at = (n: number) => codes(words(lang, n), ["p1"], ctx, kind);
    expect(at(min - 1)).toEqual(["too_short"]);
    expect(at(min)).toEqual([]);
    expect(at(max)).toEqual([]);
    expect(at(max + 1)).toEqual(["too_long"]);
  });

  it("the bounds are the ones in the brief", () => {
    expect(WORD_BOUNDS).toMatchObject({ intro: { min: 30, max: 70, target: [35, 65] }, paragraph: { min: 20, max: 60, target: [25, 55] }, caption: { min: 5, max: 18 }, pull_quote: { min: 5, max: 18 }, closing: { min: 30, max: 70, target: [35, 65] } });
  });
});

describe("grounding: script", () => {
  it("Arabic text in an English book and English text in an Arabic book are rejected", () => {
    expect(codes("الضوء الذهبي يمتد فوق الشاطئ الهادئ عند الغروب", ["p1"], en())).toContain("wrong_script");
    expect(codes("The two walk along the beach as the sun goes down.", ["p1"], ar())).toContain("wrong_script");
  });
  it("a name the user typed in the other script does not make the text wrong", () => {
    expect(codes("يمشي Omar على الشاطئ الهادئ عند غروب الشمس", ["p1", "f5"], ar())).toEqual([]);
  });
});

describe("grounding: outline titles and arcs", () => {
  const ctx = { lang: "en" as const, facts: [{ kind: "place", text: "Lisbon" }, { kind: "person", text: "Sara — my sister" }], metadata: ["Abu Dhabi", "12 Oct 2026", "Walking on a beach"], evidence: ["Two people walk along a beach."] };
  it.each([
    ["Evening by the sea", null],
    ["A week in Lisbon", null],
    ["Sara and the sea", null],
    ["Abu Dhabi in October", null],
    ["A week in Porto", "ungrounded_name"],
    ["Maria and the sea", "ungrounded_name"],
    ["Golden Evening Light", "ungrounded_name"],
    ["Our wedding day", "ungrounded_milestone"],
    ["With my mother", "ungrounded_relationship"],
    ["December light", "ungrounded_date"],
    ["Moments like these", "banned_phrase"],
    ["x".repeat(61), "too_long"],
    ["   ", "empty"],
  ] as const)("title %j → %s", (title, expected) => {
    const got = checkPlanText("c1:title", "title", title, ctx).map((i) => i.code);
    if (expected === null) expect(got).toEqual([]);
    else expect(got).toContain(expected);
  });
  it("a title naming a place that is not in the facts or metadata is rejected even when another chapter has it", () => {
    expect(checkPlanText("c2:title", "title", "A week in Lisbon", { ...ctx, facts: [] }).map((i) => i.code)).toEqual(["ungrounded_name"]);
  });
  it("an arc follows the same rules and may be longer", () => {
    expect(checkPlanText("c1:arc", "arc", "The walk along the beach, from the first light to the evening.", ctx)).toEqual([]);
    expect(checkPlanText("c1:arc", "arc", "They were thrilled to see Porto.", ctx).map((i) => i.code).sort()).toEqual(["stated_feeling", "ungrounded_name"]);
    expect(checkPlanText("c1:arc", "arc", "a".repeat(201), ctx).map((i) => i.code)).toContain("too_long");
  });
  it("Arabic titles", () => {
    const arCtx = { lang: "ar" as const, facts: [{ kind: "person", text: "سارة — أختي" }], metadata: ["أبوظبي"], evidence: [] };
    expect(checkPlanText("t", "title", "مساء على الشاطئ", arCtx)).toEqual([]);
    expect(checkPlanText("t", "title", "مع سارة في أبوظبي", arCtx)).toEqual([]);
    expect(checkPlanText("t", "title", "مع أمي على الشاطئ", arCtx).map((i) => i.code)).toEqual(["ungrounded_relationship"]);
    expect(checkPlanText("t", "title", "Evening by the sea", arCtx).map((i) => i.code)).toEqual(["wrong_script"]);
  });
});
