// M22 T2: editor style foundations — class recipes (contrast, import-free, 44 px, no transforms) and
// editor-motion.css (reduced-motion guard, opacity/box-shadow only outside the sheet).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/app/palette";
import * as ED from "@/components/editor/editor-classes";
import * as EDD from "@/components/editor/editor-classes.data";
import * as EDS from "@/components/editor/editor-server-classes";
import * as TOOLS from "@/components/editor/tools/tool-classes";

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

const stringRecipes = [...Object.entries(ED), ...Object.entries(EDS)].filter(([, v]) => typeof v === "string") as [string, string][];
const toolRecipes = Object.entries(TOOLS).filter(([, v]) => typeof v === "string") as [string, string][];
const toolbarSrc = readFileSync(join(root, "src/components/editor/EditorToolbar.tsx"), "utf8");
/** Source without comments (block + line), so names mentioned in comments don't count. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** Every .ts/.tsx file under src (for import guards). */
function srcFiles(dir = join(root, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe("editor-classes contrast", () => {
  it("lists contrast pairs covering band, chips, pills, CTAs and stage", () => {
    expect(EDD.ED_CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(20);
    for (const tone of EDD.ED_CHIP_TONES_LIST) {
      expect(EDD.ED_CONTRAST_PAIRS.some((p) => p.fg === EDD.ED_CHIP_COLORS[tone].text && p.bg === EDD.ED_LEATHER_LIGHTEST)).toBe(true);
    }
  });

  it.each(EDD.ED_CONTRAST_PAIRS.map((p) => [p.name, p] as const))("%s ≥ 4.5:1", (_name, p) => {
    expect(p.min).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(p.min);
  });

  it("chip tone classes use the colours in ED_CHIP_COLORS", () => {
    for (const tone of EDD.ED_CHIP_TONES_LIST) {
      const c = EDD.ED_CHIP_COLORS[tone];
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
    // The ≥ lg side panel is the panel host itself (EditorToolbar), lg-prefixed.
    expect(toolbarSrc).toContain("lg:w-80");
    expect(toolbarSrc).toContain("xl:w-96");
    expect(ED.ED_SHEET).toContain("rounded-t-3xl");
    expect(ED.ED_SHEET).toContain("before:content-['']");
    expect(ED.ED_SHEET).toContain("safe-area-inset-bottom");
  });

  it("page frame never pads or borders the aspect box", () => {
    expect(ED.ED_PAGE_FRAME).not.toMatch(/(^|\s)(p|px|py|pt|pb|ps|pe|border)(-|\s|$)/);
    expect(ED.ED_PAGE_FRAME).toContain("shadow-");
  });
});

describe("recipe module boundaries (N3)", () => {
  const files = srcFiles();
  const importers = (mod: RegExp) => files.filter((f) => mod.test(readFileSync(f, "utf8")));

  it("editor-classes.data (test data) is never imported by app code", () => {
    expect(importers(/editor-classes\.data["']/)).toEqual([]);
  });

  it("editor-server-classes is only imported by modules without \"use client\"", () => {
    const users = importers(/editor-server-classes["']/);
    expect(users.length).toBeGreaterThan(0);
    for (const f of users) expect(readFileSync(f, "utf8"), f).not.toMatch(/^\s*["']use client["']/);
  });

  it("editor-classes no longer exports test data, server-only or unused recipes", () => {
    for (const name of ["ED_CONTRAST_PAIRS", "ED_CHIP_COLORS", "ED_CHIP_TONES_LIST", "ED_LEATHER", "ED_LEATHER_LIGHTEST", "ED_CARD", "ED_SIDE_PANEL"]) {
      expect(Object.keys(ED), name).not.toContain(name);
    }
  });

  it("chip hexes in the data module match the class strings", () => {
    expect(EDD.ED_LEATHER_LIGHTEST).toBe("#1f5443");
  });

  it("ED_STAGE_HOST paints the stage without structural child selectors (N4)", () => {
    expect(ED.ED_STAGE_HOST).toContain("bg-[radial-gradient");
    expect(ED.ED_STAGE_HOST).not.toMatch(/\[&/);
    expect(ED.ED_STAGE_BARE).not.toMatch(/(^|\s)bg-/);
  });
});

describe("tool-classes (N1)", () => {
  it("is import-free and the only tool recipe module", () => {
    const src = readFileSync(join(root, "src/components/editor/tools/tool-classes.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(files().some((f) => f.endsWith("tool-tile-classes.ts"))).toBe(false);
  });

  it("option / tile / segment recipes focus with an outline, never a ring (never clashes with the selected ring)", () => {
    for (const name of ["TOOL_OPTION", "TOOL_OPTION_ACTIVE", "TOOL_TILE", "TOOL_TILE_ACTIVE", "TOOL_PHOTO_TILE", "TOOL_PHOTO_TILE_ACTIVE", "SEG", "SEG_ACTIVE"] as const) {
      expect(TOOLS[name], name).toContain("focus-visible:outline-2");
      expect(TOOLS[name], name).not.toMatch(/focus-visible:ring/);
    }
  });

  it("TOOL_WELL_SURFACE has no padding; TOOL_WELL = surface + p-3", () => {
    expect(TOOLS.TOOL_WELL_SURFACE).not.toMatch(/(^|\s)p[xyse]?-/);
    expect(TOOLS.TOOL_WELL).toBe(`${TOOLS.TOOL_WELL_SURFACE} p-3`);
  });

  it("no tool recipe transforms; transitions respect reduced motion; no gold", () => {
    for (const [name, v] of toolRecipes) {
      expect(v, name).not.toMatch(/(^|\s|:)-?(translate|scale|rotate|skew)-|(^|\s|:)transform(\s|$)/);
      expect(v, name).not.toContain("home-foil");
      if (/(^|\s)transition(-|\s|$)/.test(v)) expect(v, name).toContain("motion-reduce:transition-none");
    }
  });

  function files() {
    return srcFiles(join(root, "src/components/editor/tools"));
  }
});

describe("editor-motion.css", () => {
  it("guards all animation with prefers-reduced-motion: no-preference", () => {
    expect(cssNoComments).toMatch(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/);
    const guarded = block(cssNoComments, /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/);
    const outside = cssNoComments.replace(guarded, "");
    expect(outside).not.toMatch(/animation|@keyframes|transition|transform/);
    for (const name of ["ed-page-in", "ed-panel-in", "ed-select-glow", "ed-select-glow-inset", "ed-save-pulse", "ed-sheet-rise"]) {
      expect(guarded).toContain(`.${name}`);
      expect(guarded).toContain(`@keyframes ${name}`);
    }
  });

  it("ed-page-in / ed-panel-in / ed-select-glow / ed-save-pulse never transform", () => {
    for (const name of ["ed-page-in", "ed-panel-in", "ed-select-glow", "ed-select-glow-inset", "ed-save-pulse"]) {
      const rule = block(cssNoComments, new RegExp(`\\.${name}\\s*\\{`));
      const frames = block(cssNoComments, new RegExp(`@keyframes\\s+${name}\\s*\\{`));
      expect(rule, name).not.toBe("");
      expect(frames, name).not.toBe("");
      expect(`${rule}${frames}`, name).not.toMatch(/transform|translate|scale|rotate/);
    }
    expect(block(cssNoComments, /@keyframes\s+ed-page-in\s*\{/)).toMatch(/opacity/);
    expect(block(cssNoComments, /@keyframes\s+ed-panel-in\s*\{/)).toMatch(/opacity/);
    expect(block(cssNoComments, /@keyframes\s+ed-select-glow\s*\{/)).toMatch(/box-shadow/);
    expect(block(cssNoComments, /@keyframes\s+ed-save-pulse\s*\{/)).toMatch(/opacity/);
    // Photo slots clip outward shadows: the inset variant draws inside the element.
    expect(block(cssNoComments, /@keyframes\s+ed-select-glow-inset\s*\{/)).toMatch(/box-shadow:\s*inset/);
    expect(block(cssNoComments, /\.ed-select-glow-inset\s*\{/)).not.toMatch(/infinite/);
  });

  it("ed-page-in lasts ≤ 200 ms; ed-select-glow pulses once", () => {
    const ms = Number(block(cssNoComments, /\.ed-page-in\s*\{/).match(/animation:\s*ed-page-in\s+(\d+)ms/)?.[1]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(200);
    expect(block(cssNoComments, /\.ed-select-glow\s*\{/)).not.toMatch(/infinite/);
  });

  it("the tool panel host (crop box + pages dnd grid inside) never gets a translating animation (S1)", () => {
    const code = stripComments(toolbarSrc);
    const host = code.slice(code.indexOf("export function EditorPanelHost"));
    expect(host).toContain("ed-panel-in");
    expect(code).not.toContain("ed-sheet-rise");
    // No translating classes or transform utilities anywhere in the toolbar / panel host.
    expect(code).not.toMatch(/(^|\s|:|")-?(translate|scale|rotate|skew)-|(^|\s|:|")transform(\s|"|$)/);
    // Only sheets without crop / dnd inside may use ed-sheet-rise.
    const risers = srcFiles().filter((f) => /ed-sheet-rise/.test(stripComments(readFileSync(f, "utf8")))).map((f) => f.slice(root.length + 1));
    for (const f of risers) expect(f).toMatch(/src\/components\/editor\/(MoreSheet|SpreadPreviewSheet|UpgradeSheet)\.tsx$/);
  });

  it("declares only ed- prefixed classes", () => {
    const selectors = [...cssNoComments.matchAll(/\.([a-zA-Z][\w-]*)\s*\{/g)].map((m) => m[1]);
    expect(selectors.length).toBeGreaterThan(0);
    for (const s of selectors) expect(s.startsWith("ed-")).toBe(true);
  });
});
