// M22 T2: editor style foundations — class recipes (contrast, import-free, 44 px, no transforms) and
// editor-motion.css (reduced-motion guard, opacity/box-shadow only outside the sheet).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/app/palette";
import * as ED from "@/components/editor/editor-classes";

const root = process.cwd();
const recipesSrc = readFileSync(join(root, "src/components/editor/editor-classes.ts"), "utf8");
// Code only (line comments stripped) — the header comment names the forbidden modules on purpose.
const recipesCode = recipesSrc.replace(/^\s*\/\/.*$/gm, "");
const css = readFileSync(join(root, "src/components/editor/editor-motion.css"), "utf8");
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first `{…}` block whose prelude matches `prelude` (brace-matched). */
function block(source: string, prelude: RegExp): string {
  const m = prelude.exec(source);
  if (!m) return "";
  const open = source.indexOf("{", m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return "";
}

const stringRecipes = Object.entries(ED).filter(([, v]) => typeof v === "string") as [string, string][];

describe("editor-classes contrast", () => {
  it("lists contrast pairs covering band, chips, pills, CTAs and stage", () => {
    expect(ED.ED_CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(20);
    for (const tone of ED.ED_CHIP_TONES_LIST) {
      expect(ED.ED_CONTRAST_PAIRS.some((p) => p.fg === ED.ED_CHIP_COLORS[tone].text && p.bg === ED.ED_LEATHER_LIGHTEST)).toBe(true);
    }
  });

  it.each(ED.ED_CONTRAST_PAIRS.map((p) => [p.name, p] as const))("%s ≥ 4.5:1", (_name, p) => {
    expect(p.min).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(p.min);
  });

  it("chip tone classes use the colours in ED_CHIP_COLORS", () => {
    for (const tone of ED.ED_CHIP_TONES_LIST) {
      const c = ED.ED_CHIP_COLORS[tone];
      expect(ED.ED_CHIP_TONE[tone]).toContain(`text-[${c.text}]`);
      expect(ED.ED_CHIP_TONE[tone]).toContain(`bg-[${c.bg}]`);
      expect(ED.ED_CHIP_DOT[tone]).toContain(`bg-[${c.dot}]`);
    }
  });

  it("class strings use the hexes their contrast pairs claim", () => {
    expect(ED.ED_PILL_ACTIVE).toContain("bg-[#0e3b2e]");
    expect(ED.ED_PILL_ACTIVE).toContain("text-[#f2e8d8]");
    expect(ED.ED_PILL).toContain("text-[#0e3b2e]");
    expect(ED.ED_CTA_EMERALD).toContain("bg-[#0e3b2e]");
    expect(ED.ED_CTA_EMERALD).toContain("text-white");
    expect(ED.ED_CTA_GOLD).toContain("home-foil-fill");
    expect(ED.ED_CTA_GOLD).toContain("text-[#1b1b1d]");
    expect(ED.ED_BAND).toContain("home-leather");
    expect(ED.ED_BAND).toContain("text-[#f2e8d8]");
    expect(ED.ED_BAND_EYEBROW).toContain("text-[#e3c766]");
  });
});

describe("editor-classes recipes", () => {
  it("has no imports at all (no cn / button-variants / next/link / use client)", () => {
    expect(recipesSrc).not.toMatch(/^\s*import\s/m);
    expect(recipesSrc).not.toMatch(/from\s+["']/);
    expect(recipesCode).not.toMatch(/@\/lib\/utils|button-variants|next\/link/);
    expect(recipesCode).not.toMatch(/["']use client["']/);
  });

  it("only gold is Share: ED_CTA_GOLD is the one recipe with home-foil-fill", () => {
    const gold = stringRecipes.filter(([, v]) => v.includes("home-foil-fill")).map(([k]) => k);
    expect(gold).toEqual(["ED_CTA_GOLD"]);
  });

  it("no recipe uses a transform/translate/scale/rotate utility", () => {
    for (const [name, v] of stringRecipes) {
      expect(v, name).not.toMatch(/(^|\s|:)-?(translate|scale|rotate|skew)-|(^|\s|:)transform(\s|$)/);
    }
  });

  it("tappable recipes are 44 px and transitions respect reduced motion", () => {
    for (const name of ["ED_BAND_ICON_BTN", "ED_PILL", "ED_PILL_ACTIVE", "ED_CTA_GOLD", "ED_CTA_EMERALD", "ED_CTA_QUIET", "ED_DANGER_QUIET"] as const) {
      expect(ED[name], name).toMatch(/(^|\s)(min-h-11|size-11)(\s|$)/);
    }
    for (const [name, v] of stringRecipes) {
      if (/(^|\s)transition(-|\s|$)/.test(v)) expect(v, name).toContain("motion-reduce:transition-none");
    }
  });

  it("phone band row fits in 64 px; side panel widths; sheet shape", () => {
    expect(ED.ED_BAND_ROW).toMatch(/(^|\s)h-14(\s|$)/);
    expect(ED.ED_BAND_ROW).toContain("lg:");
    expect(ED.ED_SIDE_PANEL).toContain("lg:w-80");
    expect(ED.ED_SIDE_PANEL).toContain("xl:w-96");
    expect(ED.ED_SHEET).toContain("rounded-t-3xl");
    expect(ED.ED_SHEET).toContain("before:content-['']");
    expect(ED.ED_SHEET).toContain("safe-area-inset-bottom");
  });

  it("page frame never pads or borders the aspect box", () => {
    expect(ED.ED_PAGE_FRAME).not.toMatch(/(^|\s)(p|px|py|pt|pb|ps|pe|border)(-|\s|$)/);
    expect(ED.ED_PAGE_FRAME).toContain("shadow-");
  });
});

describe("editor-motion.css", () => {
  it("guards all animation with prefers-reduced-motion: no-preference", () => {
    expect(cssNoComments).toMatch(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/);
    const guarded = block(cssNoComments, /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/);
    const outside = cssNoComments.replace(guarded, "");
    expect(outside).not.toMatch(/animation|@keyframes|transition|transform/);
    for (const name of ["ed-page-in", "ed-select-glow", "ed-save-pulse", "ed-sheet-rise"]) {
      expect(guarded).toContain(`.${name}`);
      expect(guarded).toContain(`@keyframes ${name}`);
    }
  });

  it("ed-page-in / ed-select-glow / ed-save-pulse never transform", () => {
    for (const name of ["ed-page-in", "ed-select-glow", "ed-save-pulse"]) {
      const rule = block(cssNoComments, new RegExp(`\\.${name}\\s*\\{`));
      const frames = block(cssNoComments, new RegExp(`@keyframes\\s+${name}\\s*\\{`));
      expect(rule, name).not.toBe("");
      expect(frames, name).not.toBe("");
      expect(`${rule}${frames}`, name).not.toMatch(/transform|translate|scale|rotate/);
    }
    expect(block(cssNoComments, /@keyframes\s+ed-page-in\s*\{/)).toMatch(/opacity/);
    expect(block(cssNoComments, /@keyframes\s+ed-select-glow\s*\{/)).toMatch(/box-shadow/);
    expect(block(cssNoComments, /@keyframes\s+ed-save-pulse\s*\{/)).toMatch(/opacity/);
  });

  it("ed-page-in lasts ≤ 200 ms; ed-select-glow pulses once", () => {
    const ms = Number(block(cssNoComments, /\.ed-page-in\s*\{/).match(/animation:\s*ed-page-in\s+(\d+)ms/)?.[1]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(200);
    expect(block(cssNoComments, /\.ed-select-glow\s*\{/)).not.toMatch(/infinite/);
  });

  it("declares only ed- prefixed classes", () => {
    const selectors = [...cssNoComments.matchAll(/\.([a-zA-Z][\w-]*)\s*\{/g)].map((m) => m[1]);
    expect(selectors.length).toBeGreaterThan(0);
    for (const s of selectors) expect(s.startsWith("ed-")).toBe(true);
  });
});
