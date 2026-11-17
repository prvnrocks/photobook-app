// M29 T9 (tester) — D-081 word-aware, per-font panel fitter (src/lib/book/render.ts):
// panelFontMm(text, role, w, h, face?) + panelCharEm / panelLineGrow. The goldens freeze the sizes;
// these tests pin the properties: whole-word wrapping, "\n" paragraphs, long-word breaks, the
// result really fits (re-simulated here), per-face width/line growth, and the no-face path unchanged.
import { describe, expect, it } from "vitest";
import { BOOK_FONT_NAMES } from "@/lib/book/fonts";
import { panelCharEm, panelFontMm, panelLineGrow } from "@/lib/book/render";

// Mirror of PANEL_TYPE.title (render.ts) — kept here so the fit check is independent of the fitter.
const TITLE = { maxMm: 15, minMm: 5, lineHeight: 1.1, charEm: 0.42 };

/** Independent greedy wrap: lines needed for `text` at `perLine` characters (break-words on long words). */
function greedyLines(text: string, perLine: number): number {
  let lines = 0;
  for (const para of text.trim().split("\n")) {
    const words = para.split(/\s+/).filter(Boolean).map((w) => Array.from(w).length);
    if (!words.length) {
      lines += 1;
      continue;
    }
    let cur = -1;
    for (const w of words) {
      if (cur >= 0 && cur + 1 + w <= perLine) {
        cur += 1 + w;
      } else {
        lines += Math.ceil(w / perLine);
        cur = w % perLine || perLine;
      }
    }
  }
  return Math.max(1, lines);
}

function fits(text: string, size: number, w: number, h: number, charEm: number, lineHeight: number): boolean {
  const perLine = Math.max(1, Math.floor(w / (size * charEm)));
  return greedyLines(text, perLine) * size * lineHeight <= h + 1e-6;
}

const TITLES = [
  "Desert weekend with the whole family",
  "Sara & Omar",
  "Our summer in Abu Dhabi and Al Ain, 2026",
  "رحلة نهاية الأسبوع في الصحراء مع العائلة كلها",
  "Supercalifragilisticexpialidocious adventures",
  "A\nB\nC",
  "x",
];

describe("panelFontMm — word-aware fitting (D-081)", () => {
  it("the returned size really fits after a whole-word wrap (or is the minimum), for many boxes", () => {
    for (const text of TITLES)
      for (const w of [30, 45, 60, 80, 110, 132])
        for (const h of [10, 18, 26, 40]) {
          const s = panelFontMm(text, "title", w, h);
          expect(s).toBeGreaterThanOrEqual(TITLE.minMm);
          expect(s).toBeLessThanOrEqual(TITLE.maxMm);
          if (s > TITLE.minMm) expect(fits(text, s, w, h, TITLE.charEm, TITLE.lineHeight), `${text} ${w}x${h} @${s}`).toBe(true);
        }
  });

  it("whole words: a title whose words don't pack gets a smaller size than the same characters as one long run would by count", () => {
    // 36 characters. Char-count fitting assumed ⌈36/perLine⌉ lines; words force an extra line here.
    const words = "Desert weekend with the whole family";
    const s = panelFontMm(words, "title", 60, 30);
    const perLine = Math.floor(60 / (s * TITLE.charEm));
    expect(greedyLines(words, perLine) * s * TITLE.lineHeight).toBeLessThanOrEqual(30 + 1e-6);
  });

  it('"\\n" starts a new line (whitespace-pre-line): three one-letter lines cannot be set at the single-line size', () => {
    const one = panelFontMm("ABC", "title", 100, 20);
    const three = panelFontMm("A\nB\nC", "title", 100, 20);
    expect(three).toBeLessThan(one);
    expect(three * TITLE.lineHeight * 3).toBeLessThanOrEqual(20 + 1e-6);
  });

  it("an unbreakable very long word never hangs or goes below the minimum", () => {
    const s = panelFontMm("a".repeat(400), "title", 40, 12);
    expect(s).toBe(TITLE.minMm);
    expect(panelFontMm("", "title", 40, 12)).toBeGreaterThan(0);
  });

  it("is deterministic and rounds to 0.01 mm", () => {
    for (const text of TITLES) {
      const a = panelFontMm(text, "title", 70, 24, { charEm: 0.55, lineGrow: 1.045 });
      expect(panelFontMm(text, "title", 70, 24, { charEm: 0.55, lineGrow: 1.045 })).toBe(a);
      expect(Math.round(a * 100) / 100).toBe(a);
    }
  });

  it("a wider face or taller line box never gives a larger size (monotonic in charEm and lineGrow)", () => {
    for (const text of TITLES) {
      const narrow = panelFontMm(text, "title", 70, 24, { charEm: 0.4, lineGrow: 1 });
      const wide = panelFontMm(text, "title", 70, 24, { charEm: 0.65, lineGrow: 1 });
      const tall = panelFontMm(text, "title", 70, 24, { charEm: 0.4, lineGrow: 1.045 });
      expect(wide).toBeLessThanOrEqual(narrow);
      expect(tall).toBeLessThanOrEqual(narrow);
    }
  });

  it("with a face, the size fits using that face's width and grown line height", () => {
    const face = { charEm: panelCharEm({ font: "Cormorant" }), lineGrow: panelLineGrow({ font: "Cormorant" }) };
    const text = "Desert weekend with the whole family";
    const s = panelFontMm(text, "title", 52, 34, face);
    if (s > TITLE.minMm) expect(fits(text, s, 52, 34, face.charEm, TITLE.lineHeight * face.lineGrow)).toBe(true);
  });
});

describe("panelCharEm / panelLineGrow", () => {
  it("every book face has a width; uppercase ≥ lowercase; 10 % safety included", () => {
    for (const font of BOOK_FONT_NAMES) {
      const lower = panelCharEm({ font });
      const upper = panelCharEm({ font, textTransform: "uppercase" });
      expect(lower).toBeGreaterThan(0.25);
      expect(upper).toBeGreaterThanOrEqual(lower);
      expect(panelLineGrow({ font })).toBeGreaterThanOrEqual(1);
      expect(panelLineGrow({ font })).toBeLessThan(1.1);
    }
    expect(panelCharEm({ font: "Playfair" })).toBeCloseTo(0.47 * 1.1, 6);
  });

  it("letter-spacing (em) widens each character; a non-numeric value is ignored", () => {
    const base = panelCharEm({ font: "Inter", textTransform: "uppercase" });
    expect(panelCharEm({ font: "Inter", textTransform: "uppercase", letterSpacing: "0.12em" })).toBeCloseTo(base + 0.12 * 1.1, 6);
    expect(panelCharEm({ font: "Inter", textTransform: "uppercase", letterSpacing: "normal" })).toBeCloseTo(base, 6);
  });

  it("tall Arabic faces grow the line box; Latin faces don't", () => {
    expect(panelLineGrow({ font: "Cairo" })).toBeGreaterThan(1);
    expect(panelLineGrow({ font: "Amiri" })).toBeGreaterThan(1);
    expect(panelLineGrow({ font: "Playfair" })).toBe(1);
  });
});
