import { describe, expect, it } from "vitest";
import {
  countOrientations,
  orientationOf,
  preferredLanguage,
  suggestCaptionLang,
  suggestFormat,
  toneForOccasion,
  type OrientationCounts,
} from "@/lib/design/infer";

// M13 T3 (D-070): setup inference for the photos-first start.

describe("suggestFormat", () => {
  it.each<[string, OrientationCounts, "A5_PORTRAIT" | "A5_LANDSCAPE"]>([
    ["no photos", {}, "A5_PORTRAIT"],
    ["4 landscape only (below the minimum)", { landscape: 4 }, "A5_PORTRAIT"],
    ["5 landscape only", { landscape: 5 }, "A5_LANDSCAPE"],
    ["exactly 60% landscape (6/10)", { landscape: 6, portrait: 4 }, "A5_LANDSCAPE"],
    ["just under 60% (59/100)", { landscape: 59, portrait: 41 }, "A5_PORTRAIT"],
    ["3 of 5 landscape = 60%", { landscape: 3, portrait: 2 }, "A5_LANDSCAPE"],
    ["square photos count against landscape", { landscape: 6, square: 5 }, "A5_PORTRAIT"],
    ["unknown (no size / no EXIF) counts against landscape", { landscape: 6, unknown: 5 }, "A5_PORTRAIT"],
    ["all unknown", { unknown: 40 }, "A5_PORTRAIT"],
    ["mostly portrait", { landscape: 10, portrait: 30 }, "A5_PORTRAIT"],
    ["40 photos, 30 landscape", { landscape: 30, portrait: 8, square: 2 }, "A5_LANDSCAPE"],
    ["negative / NaN counts ignored", { landscape: 5, portrait: -10, square: Number.NaN }, "A5_LANDSCAPE"],
    ["infinite count ignored", { landscape: 5, portrait: Number.POSITIVE_INFINITY }, "A5_LANDSCAPE"],
  ])("%s", (_name, counts, expected) => {
    expect(suggestFormat(counts)).toBe(expected);
  });
});

describe("orientationOf", () => {
  it.each<[string, unknown, unknown, unknown, string]>([
    ["landscape pixels, no EXIF (WhatsApp)", 1600, 1200, undefined, "landscape"],
    ["portrait pixels, no EXIF", 1200, 1600, undefined, "portrait"],
    ["square", 1000, 1000, undefined, "square"],
    ["almost square stays square", 1040, 1000, undefined, "square"],
    ["EXIF 6 rotates stored landscape to portrait", 4032, 3024, 6, "portrait"],
    ["EXIF 8 rotates stored landscape to portrait", 4032, 3024, 8, "portrait"],
    ["EXIF 1 keeps it", 4032, 3024, 1, "landscape"],
    ["EXIF 3 (180°) keeps it", 4032, 3024, 3, "landscape"],
    ["garbage EXIF value ignored", 4032, 3024, "6", "landscape"],
    ["missing width", null, 1000, undefined, "unknown"],
    ["zero height", 1000, 0, undefined, "unknown"],
    ["NaN", Number.NaN, 1000, undefined, "unknown"],
  ])("%s", (_name, w, h, exif, expected) => {
    expect(orientationOf(w, h, exif)).toBe(expected);
  });

  it("countOrientations feeds suggestFormat", () => {
    const photos = [
      ...Array.from({ length: 4 }, () => ({ width: 1600, height: 1200 })),
      { width: 1200, height: 1600 },
      { width: undefined, height: undefined },
    ];
    const counts = countOrientations(photos);
    expect(counts).toEqual({ landscape: 4, portrait: 1, square: 0, unknown: 1 });
    expect(suggestFormat(counts)).toBe("A5_LANDSCAPE"); // 4/6 = 67%, 6 photos
  });
});

describe("suggestCaptionLang", () => {
  it.each<[string, string | null | undefined, "en" | "ar"]>([
    ["Arabic UAE", "ar-AE", "ar"],
    ["bare ar", "ar", "ar"],
    ["upper case", "AR-ae", "ar"],
    ["underscore locale", "ar_AE", "ar"],
    ["Arabic Saudi header", "ar-SA,ar;q=0.9,en-US;q=0.8,en;q=0.7", "ar"],
    ["Arabic Egypt", "ar-EG", "ar"],
    ["English UAE first, Arabic second", "en-AE,en;q=0.9,ar-AE;q=0.8", "en"],
    ["q-values reorder (Arabic preferred)", "en;q=0.5,ar;q=0.9", "ar"],
    ["q=0 Arabic is not acceptable", "ar;q=0,en;q=0.1", "en"],
    ["wildcard skipped", "*,ar;q=0.5", "ar"],
    ["Mapudungun (arn) is not Arabic", "arn-CL", "en"],
    ["French", "fr-FR,fr;q=0.9", "en"],
    ["Hindi India", "hi-IN", "en"],
    ["empty", "", "en"],
    ["null", null, "en"],
    ["undefined", undefined, "en"],
    ["garbage", ";;,,q=", "en"],
    ["bad q value", "ar;q=abc", "en"],
  ])("%s", (_name, locale, expected) => {
    expect(suggestCaptionLang(locale)).toBe(expected);
  });

  it("memory wins over the locale", () => {
    expect(suggestCaptionLang("en-US", "ar")).toBe("ar");
    expect(suggestCaptionLang("ar-AE", "en")).toBe("en");
  });

  it("invalid memory falls back to the locale", () => {
    expect(suggestCaptionLang("ar-AE", "fr" as never)).toBe("ar");
    expect(suggestCaptionLang("ar-AE", null)).toBe("ar");
  });

  it("ignores absurdly long headers", () => {
    expect(preferredLanguage(`ar,${"x".repeat(2000)}`)).toBeNull();
  });

  it("preferredLanguage keeps header order on ties", () => {
    expect(preferredLanguage("en-GB,ar")).toBe("en");
    expect(preferredLanguage("ar,en-GB")).toBe("ar");
  });
});

describe("toneForOccasion", () => {
  it.each([
    ["wedding", "romantic"],
    ["travel", "fun"],
    ["baby", "nostalgic"],
    ["graduation", "fun"],
    ["family", "nostalgic"],
    ["other", "minimal"],
  ] as const)("%s → %s", (occasion, tone) => {
    expect(toneForOccasion(occasion)).toBe(tone);
  });

  it("unknown / missing occasion → the 'other' default", () => {
    expect(toneForOccasion(null)).toBe("minimal");
    expect(toneForOccasion(undefined)).toBe("minimal");
    expect(toneForOccasion("birthday" as never)).toBe("minimal");
  });

  it("a remembered tone wins (D-032); invalid memory is ignored", () => {
    expect(toneForOccasion("wedding", "fun")).toBe("fun");
    expect(toneForOccasion("wedding", "sad" as never)).toBe("romantic");
    expect(toneForOccasion("wedding", null)).toBe("romantic");
  });
});
