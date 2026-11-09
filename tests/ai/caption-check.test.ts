import { describe, expect, it } from "vitest";
import {
  CAPTION_ISSUE_CODES,
  buildCaptionContext,
  captionKey,
  checkBookCaptions,
  checkCaption,
  digitsFromDates,
  nameWords,
  normalizeCaption,
  normalizeNumber,
  type CaptionCheckContext,
  type CaptionIssueCode,
} from "@/lib/ai/caption-check";

// Metadata of a small Abu Dhabi wedding book. Nothing about Paris or Ahmed.
const meta = {
  bookTitle: "Sara & Omar",
  chapters: [
    { title: "The Mehndi Night", place: "Abu Dhabi" },
    { title: "Beach Day", place: "Saadiyat Island" },
  ],
  photoPlaces: ["Corniche", null],
  knownNames: ["Layla"],
  dates: ["2026-10-12T19:30:00+04:00", "2026-10-14T09:00:00+04:00"],
};
const en: CaptionCheckContext = buildCaptionContext({ lang: "en", ...meta });
const ar: CaptionCheckContext = buildCaptionContext({ lang: "ar", ...meta });

const codes = (text: string, ctx: CaptionCheckContext = en): CaptionIssueCode[] =>
  checkCaption(text, ctx).map((i) => i.code);

describe("checkCaption — clean captions", () => {
  it.each([
    ["simple English", "Laughter that filled the whole room"],
    ["sentence-initial capital after a full stop", "We danced. Then we danced again."],
    ["allowlisted names", "Sara and Omar, finally under one sky"],
    ["allowlisted place (case-insensitive)", "Golden light over the corniche and Abu Dhabi"],
    ["possessive of an allowlisted name", "Layla's first steps on the sand"],
    ["known name from memory", "A quiet moment with Layla"],
    ["pronoun I and I'm", "I'm smiling because I was there"],
    ["OK stoplist", "Everything felt OK, then perfect"],
    ["emoji inside", "Sunset smiles 🌅 and salty hair"],
    ["ZWJ emoji", "Family time 👨‍👩‍👧 by the water"],
    ["sentence start after emoji", "Cake first 🎂 Dancing second"],
    ["common word after an em dash", "Our first dance — Pure joy and nerves"],
    ["common word after a colon", "The plan: Just be together"],
    ["allowlisted digits (year)", "October 2026, the night it all began"],
    ["allowlisted day with ordinal", "The 12th felt like forever"],
    ["exactly 18 words", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen"],
    ["label tail with allowlisted place", "Golden hour — Abu Dhabi"],
    ["label tail with allowlisted couple", "Our first dance — Sara & Omar"],
    ["lowercase tail is prose, not attribution", "Sunset — and the sea kept singing"],
    ["inner quotes are not a wrapped caption", "“Yes” was the easiest word that day"],
    ["'as we said' prose is not attribution", "Just as we said goodbye, the sky turned pink"],
  ])("%s", (_name, text) => {
    expect(codes(text)).toEqual([]);
  });

  it.each([
    ["native Arabic", "أجمل ليلة بدأت بضحكة"],
    ["Arabic with tashkeel", "فَرَحٌ يَملأُ المكان"],
    ["Arabic with emoji", "ضحكات لا تنسى 💛"],
    ["Arabic with Arabic-Indic allowed digits", "ليلة ١٢ أكتوبر"],
    ["Arabic with allowlisted Latin name, still ≥ 70% Arabic", "أجمل لحظات العمر مع عائلتنا الكبيرة Layla"],
    ["Arabic question mark", "هل رأيتم أجمل من هذا؟"],
  ])("Arabic: %s", (_name, text) => {
    expect(codes(text, ar)).toEqual([]);
  });
});

describe("checkCaption — failures", () => {
  it.each<[string, string, CaptionIssueCode]>([
    ["empty", "", "empty"],
    ["whitespace only", "   \n ", "empty"],
    ["emoji only", "🎉🎉", "no_letters"],
    ["19 words", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen", "too_long"],
    ["lone surrogate", "Half an emoji \uD83D here", "lone_surrogate"],
    ["Paris not in metadata", "Dreaming of evenings in Paris", "unknown_name"],
    ["Ahmed not in metadata", "Dancing all night with Ahmed", "unknown_name"],
    ["capitalised name after a dash", "Sunset—Paris never looked better", "unknown_name"],
    ["uncommon capital after a colon", "The best part: Ahmed", "unknown_name"],
    ["Arabic letters in an English book", "A night to remember ليلة", "arabic_in_english"],
    ["URL", "See more at https://example.com", "url"],
    ["bare domain", "Book yours at photobook.ae today", "url"],
    ["www", "Find us at www.example", "url"],
    ["@mention", "Thanks @sara for the cake", "mention"],
    ["email", "Write to us: hello@example.org", "mention"],
    ["#hashtag", "Best day ever #blessed", "hashtag"],
    ["Arabic hashtag", "يوم جميل #فرح", "hashtag"],
    ["trailing attribution", "Love is the bridge between two hearts — Rumi", "attribution"],
    ["quoted then dash", "“Love never fails” — unknown", "attribution"],
    ["as X said", "As Oscar Wilde once said, be yourself", "attribution"],
    ["as they say", "Home is where the heart is, as they say", "attribution"],
    ["said X", "Best night of our lives, said Omar", "attribution"],
    ["fully wrapped in quotes", "“Two hearts, one beautiful night”", "wrapped_in_quotes"],
    ["wrapped in straight quotes", '"Forever starts tonight"', "wrapped_in_quotes"],
    ["number not in metadata", "Our 25 favourite people in one room", "unknown_number"],
    ["year not in metadata", "Summer of 1999 all over again", "unknown_number"],
  ])("%s → %s", (_name, text, code) => {
    expect(codes(text)).toContain(code);
  });

  it.each<[string, string, CaptionIssueCode]>([
    ["Latin sentence in an Arabic book", "A night to remember forever", "not_arabic"],
    ["unlisted Latin word in an Arabic book", "ليلة جميلة جداً في Paris", "latin_word"],
    ["mostly Latin even with Arabic", "ليلة wonderful amazing night", "not_arabic"],
    ["Arabic-Indic digits not in metadata", "٢٥ شخصاً في غرفة واحدة", "unknown_number"],
    ["Arabic 'as … said'", "كما قال الشاعر الحب نور", "attribution"],
    ["Arabic quoted then dash", "«الحب لا يفنى» — جبران", "attribution"],
    ["Arabic fully wrapped", "«ليلة لا تنسى»", "wrapped_in_quotes"],
    ["Arabic too long", Array.from({ length: 19 }, () => "فرح").join(" "), "too_long"],
  ])("Arabic: %s → %s", (_name, text, code) => {
    expect(codes(text, ar)).toContain(code);
  });

  it("Paris / Ahmed are allowed once they are in the metadata", () => {
    const ctx = buildCaptionContext({ lang: "en", photoPlaces: ["Paris"], knownNames: ["Ahmed"] });
    expect(codes("Dreaming of evenings in Paris", ctx)).toEqual([]);
    expect(codes("Dancing all night with Ahmed", ctx)).toEqual([]);
    expect(codes("ليلة جميلة جداً في باريس مع عائلتنا Ahmed", { ...ctx, lang: "ar" })).toEqual([]);
  });

  it("a mix of problems reports each code once and never echoes text", () => {
    const issues = checkCaption("Ahmed and Ahmed in Paris #love https://x.io", en);
    const list = issues.map((i) => i.code);
    expect(list).toEqual(expect.arrayContaining(["unknown_name", "hashtag", "url"]));
    expect(new Set(list).size).toBe(list.length);
    for (const i of issues) expect(Object.keys(i)).toEqual(["code"]);
    for (const c of list) expect(CAPTION_ISSUE_CODES).toContain(c);
  });

  it("empty short-circuits other rules", () => {
    expect(codes("")).toEqual(["empty"]);
  });
});

describe("context helpers", () => {
  it("digitsFromDates collects year, month, day without leading zeros", () => {
    expect([...digitsFromDates(["2026-03-07T10:00:00Z", "bad", null, new Date("2025-12-31T00:00:00Z")])].sort()).toEqual(
      ["12", "2025", "2026", "3", "31", "7"].sort(),
    );
  });

  it("normalizeNumber maps Arabic-Indic digits and strips leading zeros", () => {
    expect(normalizeNumber("٠٧")).toBe("7");
    expect(normalizeNumber("۲۰۲۶")).toBe("2026");
    expect(normalizeNumber("0")).toBe("0");
  });

  it("nameWords splits multi-word places and lowercases", () => {
    expect([...nameWords(["Abu Dhabi", "Sara & Omar", "Al-Ain"])]).toEqual(["abu", "dhabi", "sara", "omar", "al", "ain"]);
  });

  it("buildCaptionContext allows digits from the user's title", () => {
    const ctx = buildCaptionContext({ lang: "en", bookTitle: "Class of 2024" });
    expect(codes("The class of 2024 did it", ctx)).toEqual([]);
  });

  it("caller-provided allowDigits are normalised too", () => {
    const ctx: CaptionCheckContext = { lang: "en", allowNames: new Set(), allowDigits: new Set(["07"]) };
    expect(codes("Day 7 of the trip", ctx)).toEqual([]);
  });

  it("normalizeCaption ignores case, punctuation, emoji and tashkeel", () => {
    expect(normalizeCaption("Best  day, EVER! 🎉")).toBe(normalizeCaption("best day ever"));
    expect(normalizeCaption("فَرَحٌ")).toBe(normalizeCaption("فرح"));
  });
});

describe("checkBookCaptions", () => {
  const caps = (texts: string[]) => texts.map((text, i) => ({ key: captionKey("m1", i), text }));

  it("returns an empty map for a clean book", () => {
    const r = checkBookCaptions(caps(["Laughter everywhere", "A quiet hug", "Golden hour"]), en);
    expect(r.size).toBe(0);
  });

  it("flags later duplicates only (normalised)", () => {
    const r = checkBookCaptions(caps(["Best day ever", "A quiet hug", "best day, ever!"]), en);
    expect(r.has("m1:0")).toBe(false);
    expect(r.get("m1:2")).toEqual([{ code: "duplicate", key: "m1:2" }]);
  });

  it("flags the 3rd+ caption with the same opening word", () => {
    const r = checkBookCaptions(
      caps(["Together at last", "Together by the sea", "Together forever", "Smiles all round", "together again"]),
      en,
    );
    expect([...r.keys()]).toEqual(["m1:2", "m1:4"]);
    expect(r.get("m1:2")?.map((i) => i.code)).toEqual(["repeated_opening"]);
  });

  it("Arabic duplicates and openings", () => {
    const r = checkBookCaptions(caps(["أجمل ليلة", "أجمل يوم", "أجمل لحظة", "أَجمل ليلة"]), ar);
    expect(r.get("m1:2")?.map((i) => i.code)).toEqual(["repeated_opening"]);
    expect(r.get("m1:3")?.map((i) => i.code).sort()).toEqual(["duplicate", "repeated_opening"]);
  });

  it("merges per-caption issues with the caption key", () => {
    const r = checkBookCaptions([{ key: captionKey("m2", "heading"), text: "Evenings in Paris" }], en);
    expect(r.get("m2:heading")).toEqual([{ code: "unknown_name", key: "m2:heading" }]);
  });

  it("empty captions are flagged but don't count as duplicates", () => {
    const r = checkBookCaptions(caps(["", ""]), en);
    expect(r.get("m1:0")?.map((i) => i.code)).toEqual(["empty"]);
    expect(r.get("m1:1")?.map((i) => i.code)).toEqual(["empty"]);
  });
});
