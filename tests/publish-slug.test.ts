import { describe, expect, it } from "vitest";
import {
  BASE58_ALPHABET,
  isValidSlug,
  makeSlug,
  randomSlugPart,
  slugifyTitle,
  SLUG_MAX_LENGTH,
} from "@/lib/publish/slug";

describe("slugifyTitle", () => {
  it.each([
    ["Sara & Omar's Wedding", "sara-omar-s-wedding"],
    ["Café Noël — Dubaï 2026", "cafe-noel-dubai-2026"],
    ["  --Hello__World--  ", "hello-world"],
    ["ÅNGSTRÖM", "angstrom"],
    ["Ｆｕｌｌ width", "full-width"],
    ["Eid 2026 عيد مبارك", "eid-2026"],
  ])("%j → %j", (input, expected) => {
    expect(slugifyTitle(input)).toBe(expected);
  });

  it.each(["عرس سارة وعمر", "🎉🎂✨", "", "   ", "!!!", "日本の旅"])("%j → empty", (input) => {
    expect(slugifyTitle(input)).toBe("");
  });

  it("caps at 30 chars without a trailing hyphen", () => {
    const s = slugifyTitle("Our amazing summer holiday in the mountains of Oman");
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slugifyTitle("abcdefghijklmnopqrstuvwxyzabc d")).toBe("abcdefghijklmnopqrstuvwxyzabc");
    expect(slugifyTitle("a".repeat(100))).toBe("a".repeat(30));
  });
});

describe("randomSlugPart", () => {
  it("returns n base58 chars", () => {
    for (const n of [1, 10, 22]) {
      const s = randomSlugPart(n);
      expect(s).toHaveLength(n);
      for (const ch of s) expect(BASE58_ALPHABET).toContain(ch);
    }
    expect(randomSlugPart()).toHaveLength(10);
  });

  it("rejects bad n", () => {
    expect(() => randomSlugPart(0)).toThrow();
    expect(() => randomSlugPart(1.5)).toThrow();
  });

  it("is unique and roughly uniform over the alphabet", () => {
    const N = 5000;
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const s = randomSlugPart(10);
      seen.add(s);
      for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(seen.size).toBe(N);
    expect(counts.size).toBe(58);
    const expected = (N * 10) / 58; // ≈ 862
    for (const c of counts.values()) {
      // ±25 % is > 9 sigma for a fair generator; a modulo-biased one (232..255 → first 24 chars)
      // would still pass, so also compare the first and last 24 chars below.
      expect(c).toBeGreaterThan(expected * 0.75);
      expect(c).toBeLessThan(expected * 1.25);
    }
    const first = [...BASE58_ALPHABET.slice(0, 24)].reduce((a, ch) => a + (counts.get(ch) ?? 0), 0);
    const last = [...BASE58_ALPHABET.slice(34)].reduce((a, ch) => a + (counts.get(ch) ?? 0), 0);
    expect(first / last).toBeLessThan(1.06); // biased modulo would give ≈ 1.10
  });
});

describe("makeSlug / isValidSlug", () => {
  it("builds base-random for ASCII titles and random-only for Arabic", () => {
    const a = makeSlug("Sara & Omar");
    expect(a).toMatch(/^sara-omar-[1-9A-HJ-NP-Za-km-z]{10}$/);
    const b = makeSlug("عرس سارة");
    expect(b).toMatch(/^[1-9A-HJ-NP-Za-km-z]{10}$/);
    expect(isValidSlug(a)).toBe(true);
    expect(isValidSlug(b)).toBe(true);
    const long = makeSlug("x".repeat(200));
    expect(long.length).toBe(SLUG_MAX_LENGTH);
    expect(isValidSlug(long)).toBe(true);
  });

  it("every generated slug validates", () => {
    const titles = ["", "A", "Café", "🎉 party 🎉", "a-b-c", "Eid عيد", "x".repeat(31)];
    for (let i = 0; i < 200; i++) expect(isValidSlug(makeSlug(titles[i % titles.length]))).toBe(true);
  });

  it.each([
    "",
    "short",
    "abcdefghi", // 9
    "sara-omar-0OIlabcdef", // excluded base58 chars
    "Sara-omar-abcdefghij", // uppercase base
    "sara--omar-abcdefghij",
    "-sara-abcdefghij",
    "saraabcdefghijk", // no hyphen before random part
    "sara_omar-abcdefghij",
    "../etc/passwdabcdefghij",
    "sara-omar-abcdefghij/x",
    `${"a".repeat(31)}-abcdefghij`,
    "عرس-abcdefghij",
    "sara omar-abcdefghij",
  ])("rejects %j", (s) => {
    expect(isValidSlug(s)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidSlug(undefined)).toBe(false);
    expect(isValidSlug(123)).toBe(false);
    expect(isValidSlug(["abcdefghij"])).toBe(false);
  });
});
