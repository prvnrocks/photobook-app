// M11 task 1/3 (M17: emerald & gold values): the app palette data matches globals.css and meets WCAG AA; book-facing tokens are
// unchanged (book text inherits --foreground, Watermark uses font-sans).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, contrastRatio, PALETTE, paletteHex } from "@/lib/app/palette";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));

describe("app palette", () => {
  it("matches the :root custom properties", () => {
    for (const p of PALETTE) {
      if (p.token === "foreground") continue;
      expect(root, p.token).toContain(`  --${p.token}: ${p.hex};\n`);
    }
  });

  it("keeps the book-facing tokens byte-identical", () => {
    expect(root).toContain("  --foreground: oklch(0.145 0 0);\n");
    expect(css).toContain("  --font-sans: var(--font-inter), var(--font-cairo), system-ui, sans-serif;\n");
    expect(css).toContain("  --font-arabic: var(--font-cairo), var(--font-tajawal), sans-serif;\n");
  });

  it("leaves the M16 marketing .theme-home scope byte-identical (M17 only retunes :root)", () => {
    const start = css.indexOf(".theme-home {");
    const block = css.slice(start, css.indexOf("\n}\n", start) + 3);
    expect(createHash("sha256").update(block).digest("hex")).toBe("2131dbdfd6a94f62c467d4dbad3d749d366ab08f4e69797013a1e6a21ac43426");
    // type-eyebrow now reads --accent-text; marketing inherits it from :root and must keep rendering
    // its eyebrows in the same antique gold it set as its own --accent-strong.
    expect(block).toContain("  --accent-strong: #7a5f0e;\n");
    expect(paletteHex("accent-text")).toBe("#7a5f0e");
  });

  it("display font falls through to Cairo before any Latin fallback face", () => {
    const line = css.split("\n").find((l) => l.includes("--font-display:")) ?? "";
    expect(line.indexOf("var(--font-cairo)")).toBeGreaterThan(line.indexOf('"Playfair Display"'));
    expect(line.indexOf("var(--font-cairo)")).toBeLessThan(line.indexOf('"Playfair Display Fallback"'));
    expect(line).not.toContain("var(--font-playfair)");
  });

  it.each(CONTRAST_PAIRS.map((p) => [p.use, p] as const))("%s meets its minimum", (_use, p) => {
    expect(contrastRatio(paletteHex(p.fg), paletteHex(p.bg))).toBeGreaterThanOrEqual(p.min);
  });

  it("computes WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });
});

describe("tracked type utilities reset letter-spacing for RTL (M11 review N12)", () => {
  it.each(["type-display", "type-h1", "type-eyebrow"])("%s: :dir(rtl) plus a [dir=rtl] fallback rule", (name) => {
    const start = css.indexOf(`@utility ${name} {`);
    expect(start).toBeGreaterThan(-1);
    const body = css.slice(start, css.indexOf("\n}\n", start));
    expect(body).toContain("&:dir(rtl) {\n    letter-spacing: 0;");
    // Separate rule, not in one list with :dir() — an unsupported pseudo-class would drop the list.
    expect(body).toContain('&[dir="rtl"],\n  [dir="rtl"] & {\n    letter-spacing: 0;');
  });
});

describe("WhatsApp button colour (user decision 2026-11-11)", () => {
  it("white text on the WhatsApp green (and its hover) meets AA 4.5:1", () => {
    const button = readFileSync(new URL("../src/components/ui/button-variants.ts", import.meta.url), "utf8");
    const line = button.split("\n").find((l) => l.includes("whatsapp:")) ?? "";
    const [bg, hover] = [...line.matchAll(/bg-\[(#[0-9A-Fa-f]{6})\]/g)].map((m) => m[1]);
    expect(line).toContain("text-white");
    expect(contrastRatio("#ffffff", bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", hover)).toBeGreaterThanOrEqual(4.5);
  });
});
