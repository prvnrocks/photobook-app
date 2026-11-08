import { describe, expect, it } from "vitest";
import {
  clipCodePoints,
  clipText,
  codePointLength,
  hasLoneSurrogate,
  stripLoneSurrogates,
} from "@/lib/text/clip";

const wellFormed = (s: string) => !hasLoneSurrogate(s);

describe("stripLoneSurrogates / hasLoneSurrogate", () => {
  it("removes unpaired high and low surrogates, keeps pairs", () => {
    expect(stripLoneSurrogates("a\ud83db")).toBe("ab");
    expect(stripLoneSurrogates("a\udc8db")).toBe("ab");
    expect(stripLoneSurrogates("\udc8d\ud83d")).toBe("");
    expect(stripLoneSurrogates("💍 ok")).toBe("💍 ok");
    expect(hasLoneSurrogate("x\ud83d")).toBe(true);
    expect(hasLoneSurrogate("\udc8dx")).toBe(true);
    expect(hasLoneSurrogate("💍")).toBe(false);
    // stateless across calls (global regex lastIndex reset)
    expect(hasLoneSurrogate("x\ud83d")).toBe(true);
    expect(hasLoneSurrogate("x\ud83d")).toBe(true);
  });
});

describe("clipText", () => {
  it("returns short and exact-length strings unchanged", () => {
    expect(clipText("", 10)).toBe("");
    expect(clipText("hello", 5)).toBe("hello");
    expect(clipText("💍💍", 4)).toBe("💍💍");
  });

  it("clips plain text with an ellipsis within maxUnits, trimming trailing space", () => {
    expect(clipText("hello world", 7)).toBe("hello…");
    expect(clipText("hello world", 8)).toBe("hello w…");
    expect(clipText("hello world", 8).length).toBeLessThanOrEqual(8);
  });

  it("never splits a surrogate pair at the cut (the S5 bug)", () => {
    const title = "Sara & Omar 💍💍💍";
    for (let max = 1; max <= title.length; max++) {
      const out = clipText(title, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(wellFormed(out)).toBe(true);
    }
    // old slice(0, 12) → "Sara & Omar \ud83d"
    expect(clipText("Sara & Omar 💍 x", 15)).toBe("Sara & Omar 💍…");
    expect(clipText("Sara & Omar 💍 x", 14)).toBe("Sara & Omar…");
  });

  it("keeps ZWJ family emoji whole", () => {
    const family = "👨‍👩‍👧‍👦"; // 11 UTF-16 units, 1 grapheme
    const s = `Hi ${family} there`;
    expect(clipText(s, 14)).toBe(`Hi…`);
    expect(clipText(s, 15)).toBe(`Hi ${family}…`);
    expect(clipText(s, 15).length).toBe(15);
  });

  it("keeps flags (regional indicator pairs) whole", () => {
    const s = "🇦🇪🇦🇪🇦🇪"; // 3 flags × 4 units
    expect(clipText(s, 9)).toBe("🇦🇪🇦🇪…");
    expect(clipText(s, 8)).toBe("🇦🇪…");
  });

  it("keeps Arabic letters with their diacritics", () => {
    const s = "مُحَمَّد وَسَارَة"; // letters + harakat (combining marks)
    // from max 3 the first grapheme "مُ" + "…" fits; below that it falls back to code points
    for (let max = 3; max < s.length; max++) {
      const out = clipText(s, max);
      expect(out.length).toBeLessThanOrEqual(max);
      // the char before the ellipsis is never a lone combining mark start, and no mark is orphaned
      const head = out.replace(/…$/, "");
      expect(s.startsWith(head)).toBe(true);
      const next = s.slice(head.length, head.length + 1);
      expect(/\p{M}/u.test(next)).toBe(false);
    }
  });

  it("removes lone surrogates from the input even when it fits", () => {
    expect(clipText("ok\ud83d", 10)).toBe("ok");
  });

  it("handles tiny limits and a custom ellipsis", () => {
    expect(clipText("hello", 0)).toBe("");
    expect(clipText("hello", 1)).toBe("h");
    expect(clipText("💍💍", 1)).toBe("");
    expect(clipText("hello world", 8, "...")).toBe("hello...");
    expect(clipText("hello world", 6, "")).toBe("hello");
  });
});

describe("clipCodePoints", () => {
  it("counts code points, not UTF-16 units", () => {
    const s = "💍".repeat(10);
    expect(codePointLength(s)).toBe(10);
    expect(clipCodePoints(s, 10)).toBe(s);
    expect(clipCodePoints(s, 5)).toBe("💍".repeat(4) + "…");
    expect(codePointLength(clipCodePoints(s, 5))).toBe(5);
  });
});
