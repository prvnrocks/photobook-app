// M23 T1: viewer style foundations — class recipes (contrast, import-free, 44 px, no transforms,
// stage geometry untouched, one gold) and viewer-motion.css (reduced-motion guard, only the sheet
// translates, vw- prefix, imported by both server layouts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/app/palette";
import * as VW from "@/components/viewer/viewer-classes";
import * as VWD from "@/components/viewer/viewer-classes.data";

const root = process.cwd();
const recipesSrc = readFileSync(join(root, "src/components/viewer/viewer-classes.ts"), "utf8");
// Code only (line comments stripped) — the header comment names the forbidden modules on purpose.
const recipesCode = recipesSrc.replace(/^\s*\/\/.*$/gm, "");
const css = readFileSync(join(root, "src/components/viewer/viewer-motion.css"), "utf8");
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

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

function srcFiles(dir = join(root, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

const recipes = Object.entries(VW).filter(([, v]) => typeof v === "string") as [string, string][];
const classes = (v: string) => v.split(/\s+/).filter(Boolean);
const TRANSFORM = /(^|\s|:)-?(translate|scale|rotate|skew)-|(^|\s|:)transform(\s|$)/;

describe("viewer-classes contrast", () => {
  it("lists contrast pairs for band, stage, nav, sheets, CTAs, footer and message screens", () => {
    expect(VWD.VW_CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(25);
  });

  it.each(VWD.VW_CONTRAST_PAIRS.map((p) => [p.name, p] as const))("%s ≥ 4.5:1", (_name, p) => {
    expect(p.min).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(p.min);
  });

  it.each(VWD.VW_NONTEXT_PAIRS.map((p) => [p.name, p] as const))("non-text %s ≥ 3:1", (_name, p) => {
    expect(p.min).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(p.min);
  });

  it("class strings use the hexes their contrast pairs claim", () => {
    expect(VW.VW_BAND).toContain("home-leather");
    expect(VW.VW_BAND).toContain("text-[#f2e8d8]");
    expect(VW.VW_TITLE).toContain("text-[#f2e8d8]");
    expect(VW.VW_SUBLINE).toContain("text-[#e3c766]");
    expect(VW.VW_ICON_BTN).toContain("text-[#f2e8d8]");
    expect(VW.VW_ICON_BTN).toContain("focus-visible:ring-[#e3c766]");
    expect(VW.VW_FOOTER).toContain("home-leather");
    expect(VW.VW_FOOTER).toContain("text-[#d7cdb9]");
    expect(VW.VW_NAV_PILL).toContain("bg-white");
    expect(VW.VW_NAV_BTN).toContain("text-[#0e3b2e]");
    expect(VW.VW_COUNTER_PILL).toContain("text-[#0e3b2e]");
    expect(VW.VW_SHEET).toContain("bg-[#faf5ec]");
    expect(VW.VW_CTA_GOLD).toContain("text-[#1b1b1d]");
    expect(VW.VW_END_SHARE_EMERALD).toBe("bg-[#0e3b2e] text-white hover:bg-[#145240]");
    expect(VW.VW_TOAST).toContain("bg-[#0e3b2e]");
    expect(VW.VW_TOAST).toContain("text-white");
    expect(VW.VW_MESSAGE_SEAL).toContain("bg-[#0e3b2e]");
    expect(VW.VW_MESSAGE_SEAL).toContain("text-[#e3c766]");
    expect(VW.VW_MESSAGE_BRAND_LINK).toContain("text-[#f2e8d8]");
    expect(VW.VW_FIELD_LABEL).toContain("text-[#1b1b1d]");
    expect(VW.VW_INPUT).toContain("bg-white");
    expect(VW.VW_INPUT).toContain("text-[#1b1b1d]");
    expect(VW.VW_INPUT).toContain("border-[#8c8270]");
    expect(VW.VW_INPUT).toContain("aria-invalid:border-[#b42318]");
    expect(VW.VW_FIELD_ERROR).toContain("text-[#b42318]");
    expect(VW.VW_SKELETON_PAGE).toContain("bg-[#faf5ec]");
    expect(VW.VW_SHELL_BG).toBe(`bg-[${VWD.VW_STAGE_EDGE}]`);
    expect(VW.VW_NAV_BAR).toContain(`bg-[${VWD.VW_STAGE_EDGE}]`);
    expect(VW.VW_CTA_EMERALD_OUTLINE).toContain("text-[#0e3b2e]");
    expect(VW.VW_CTA_WHATSAPP).toContain("bg-[#0F7A40]");
    expect(VW.VW_CTA_WHATSAPP).toContain("text-white");
    expect(VW.VW_CTA_WHATSAPP).not.toContain("#128C4A");
    expect(VW.VW_MESSAGE_SCREEN).toContain("home-leather");
    expect(VW.VW_MESSAGE_CARD).toContain("bg-[#faf5ec]");
    expect(VW.VW_MESSAGE_EYEBROW).toContain("text-[#7a5f0e]");
  });
});

describe("viewer-classes recipes", () => {
  it("has no imports at all (no cn / button-variants / next/link / zod / use client)", () => {
    expect(recipesSrc).not.toMatch(/^\s*import\s/m);
    expect(recipesSrc).not.toMatch(/from\s+["']/);
    expect(recipesSrc).not.toMatch(/require\(/);
    expect(recipesCode).not.toMatch(/@\/lib\/utils|button-variants|next\/link|zod/);
    expect(recipesCode).not.toMatch(/["']use client["']/);
  });

  it("only gold: every home-foil-fill recipe is VW_CTA_GOLD_LOOK or composed from it", () => {
    const gold = recipes.filter(([, v]) => v.includes("home-foil-fill")).map(([k]) => k);
    expect(gold.sort()).toEqual(["VW_CTA_GOLD", "VW_CTA_GOLD_END_LANDSCAPE", "VW_CTA_GOLD_END_PORTRAIT", "VW_CTA_GOLD_LOOK"]);
    for (const k of gold) {
      const v = VW[k as keyof typeof VW] as string;
      expect(v === VW.VW_CTA_GOLD_LOOK || v.startsWith(`${VW.VW_CTA_GOLD_LOOK} `), k).toBe(true);
    }
  });

  it("gold variants are full alternatives: no utility group twice (no conflicting pairs)", () => {
    // Size / spacing / gap / disabled live only in the variants; the look has none of them.
    for (const c of classes(VW.VW_CTA_GOLD_LOOK)) expect(c, c).not.toMatch(/^(px|py|p|gap|text-\[?\d|text-(xs|sm|base|lg)|disabled:)/);
    const group = (c: string) => c.replace(/-\[[^\]]*\]$|-[^-]+$/, "");
    for (const k of ["VW_CTA_GOLD", "VW_CTA_GOLD_END_PORTRAIT", "VW_CTA_GOLD_END_LANDSCAPE"] as const) {
      const sized = classes(VW[k]).filter((c) => /^(px|py|gap)-|^text-(\[\d|xs|sm|base|lg)/.test(c));
      expect(new Set(sized.map(group)).size, `${k}: ${sized.join(" ")}`).toBe(sized.length);
    }
    expect(VW.VW_CTA_GOLD_END_PORTRAIT).toContain("text-[4.4cqw]");
    expect(VW.VW_CTA_GOLD_END_LANDSCAPE).toContain("text-[3.2cqw]");
  });

  it("VW_NAV_BAR pads its top only; the caller adds one bottom padding", () => {
    expect(classes(VW.VW_NAV_BAR)).toContain("pt-1.5");
    expect(VW.VW_NAV_BAR).not.toMatch(/(^|\s)(py|pb|p)-/);
    expect(VW.VW_NAV_BAR_PB_SAFE).toBe("pb-[max(0.375rem,env(safe-area-inset-bottom))]");
  });

  it("no recipe uses a transform/translate/scale/rotate utility", () => {
    for (const [name, v] of recipes) expect(v, name).not.toMatch(TRANSFORM);
  });

  it("VW_STAGE is paint only: no padding, border, transform, position or sizing", () => {
    for (const c of classes(VW.VW_STAGE)) {
      expect(c, c).not.toMatch(/^(p|px|py|pt|pb|ps|pe|pl|pr)-/);
      expect(c, c).not.toMatch(/^border/);
      expect(c, c).not.toMatch(/^(m|mx|my|mt|mb|ms|me|w|h|min-h|max-h|inset|top|bottom)-/);
      expect(c, c).not.toMatch(/^(relative|absolute|fixed|sticky|ring|shadow|outline)/);
    }
    expect(VW.VW_STAGE).toContain("bg-[radial-gradient(");
    // Two layers: the ground-shadow pool (emerald alpha) over the cream vignette.
    expect(VW.VW_STAGE).toMatch(/rgb\(14_59_46\/0\.\d+\)/);
    expect(VW.VW_STAGE).toContain("#ebe2d0");
  });

  it("VW_BAND pads only by safe-area insets and has no border; its row is a fixed 52 px", () => {
    for (const c of classes(VW.VW_BAND)) {
      if (/^(p|px|py|pt|pb|ps|pe|pl|pr)-/.test(c)) expect(c, c).toMatch(/env\(safe-area-inset-(top|left|right)\)/);
      expect(c, c).not.toMatch(/^border/);
    }
    expect(VW.VW_BAND).toContain("pt-[env(safe-area-inset-top)]");
    expect(VW.VW_BAND).toContain("ps-[env(safe-area-inset-left)]");
    expect(VW.VW_BAND).toContain("pe-[env(safe-area-inset-right)]");
    expect(classes(VW.VW_BAND_ROW)).toContain("h-13");
    expect(VW.VW_BAND_ROW).not.toMatch(/(^|\s)(lg:|sm:)?(h|min-h|py|pt|pb)-(?!13)/);
  });

  it("VW_NAV_PILL: no padding / border (ring hairline), 44 px tall", () => {
    for (const c of classes(VW.VW_NAV_PILL)) {
      expect(c, c).not.toMatch(/^(p|px|py|pt|pb|ps|pe|pl|pr)-/);
      expect(c, c).not.toMatch(/^border/);
    }
    expect(classes(VW.VW_NAV_PILL)).toContain("h-11");
  });

  it("title / subline are one-line, not letter-spaced (Arabic joining)", () => {
    for (const v of [VW.VW_TITLE, VW.VW_SUBLINE]) {
      expect(v).toContain("truncate");
      expect(v).not.toMatch(/tracking-\[0\.\d|tracking-(wide|wider|widest)|uppercase/);
    }
    expect(VW.VW_TITLE).toContain("font-display");
  });

  it("dead recipes stay removed", () => {
    for (const name of ["VW_STAGE_LABEL", "VW_CHAPTER_PILL", "VW_CARD", "VW_CTA_EMERALD"]) expect(Object.keys(VW), name).not.toContain(name);
  });

  it("tappable recipes are 44 px and transitions respect reduced motion", () => {
    const tappable = [
      "VW_ICON_BTN",
      "VW_BAND_TEXT_BTN",
      "VW_FLOAT_BTN",
      "VW_NAV_BTN",
      "VW_CLOSE_BTN",
      "VW_LIST_ROW",
      "VW_LIST_ROW_ACTIVE",
      "VW_CTA_GOLD",
      "VW_CTA_GOLD_END_PORTRAIT",
      "VW_CTA_GOLD_END_LANDSCAPE",
      "VW_CTA_EMERALD_OUTLINE",
      "VW_CTA_WHATSAPP",
      "VW_FOOTER_LINK",
      "VW_MESSAGE_BRAND_LINK",
    ] as const;
    for (const name of tappable) expect(VW[name], name).toMatch(/(^|\s)(min-h-11|size-11)(\s|$)/);
    for (const [name, v] of recipes) {
      if (/(^|\s)transition(-|\s|$)/.test(v)) expect(v, name).toContain("motion-reduce:transition-none");
    }
  });

  it("sheet shape: ivory, rounded top, bottom safe-area", () => {
    expect(VW.VW_SHEET).toContain("rounded-t-3xl");
    expect(VW.VW_SHEET).toContain("safe-area-inset-bottom");
    expect(VW.VW_SHEET).not.toContain("vw-sheet-rise"); // added by ViewerSheet itself
  });
});

describe("viewer recipe module boundaries", () => {
  const files = srcFiles();

  it("viewer-classes.data (test data) is never imported by app code", () => {
    expect(files.filter((f) => /viewer-classes\.data["']/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("viewer-classes does not export test data", () => {
    for (const name of ["VW_CONTRAST_PAIRS", "VW_NONTEXT_PAIRS", "VW_LEATHER_LIGHTEST", "VW_FOIL_DARKEST", "VW_STAGE_EDGE"]) {
      expect(Object.keys(VW), name).not.toContain(name);
    }
  });
});

describe("viewer-motion.css", () => {
  const names = ["vw-chrome-fade", "vw-sheet-rise", "vw-card-in", "vw-skeleton-pulse"];

  it("guards all animation with prefers-reduced-motion: no-preference", () => {
    const guarded = block(cssNoComments, /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/);
    expect(guarded).not.toBe("");
    const outside = cssNoComments.replace(guarded, "");
    expect(outside).not.toMatch(/animation|@keyframes|transition|transform/);
    for (const name of names) {
      expect(guarded).toContain(`.${name}`);
      expect(guarded).toContain(`@keyframes ${name}`);
    }
  });

  it("only vw-sheet-rise translates; the others animate opacity only", () => {
    for (const name of ["vw-chrome-fade", "vw-card-in", "vw-skeleton-pulse"]) {
      const rule = block(cssNoComments, new RegExp(`\\.${name}\\s*\\{`));
      const frames = block(cssNoComments, new RegExp(`@keyframes\\s+${name}\\s*\\{`));
      expect(rule, name).not.toBe("");
      expect(frames, name).toMatch(/opacity/);
      expect(`${rule}${frames}`, name).not.toMatch(/transform|translate|scale|rotate|filter|width|height|margin|padding|top|left/);
    }
    expect(block(cssNoComments, /@keyframes\s+vw-sheet-rise\s*\{/)).toMatch(/translateY/);
    const transforming = [...cssNoComments.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)]
      .map((m) => m[1])
      .filter((n) => /transform|translate|scale/.test(block(cssNoComments, new RegExp(`@keyframes\\s+${n}\\s*\\{`))));
    expect(transforming).toEqual(["vw-sheet-rise"]);
  });

  it("vw-sheet-rise is used only by ViewerSheet", () => {
    const users = srcFiles()
      .filter((f) => /vw-sheet-rise/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.slice(root.length + 1));
    for (const f of users) expect(f).toBe("src/components/viewer/ViewerSheet.tsx");
  });

  it("declares only vw- prefixed classes", () => {
    const selectors = [...cssNoComments.matchAll(/\.([a-zA-Z][\w-]*)\s*\{/g)].map((m) => m[1]);
    expect(selectors.sort()).toEqual([...names].sort());
  });

  it("is imported by the /b/[slug] and /dev-viewer server layouts", () => {
    for (const p of ["src/app/b/[slug]/layout.tsx", "src/app/dev-viewer/layout.tsx"]) {
      const src = readFileSync(join(root, p), "utf8");
      expect(src, p).toMatch(/import\s+["']@\/components\/viewer\/viewer-motion\.css["']/);
      expect(src, p).not.toMatch(/^\s*["']use client["']/);
    }
  });
});
