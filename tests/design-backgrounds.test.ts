// Background catalogue (M10a A5): swatch ink contrast, texture lookups, inkFor per background kind.
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_SWATCHES,
  BACKGROUND_VEIL_MAX,
  BACKGROUND_VEIL_MIN,
  DEFAULT_BACKGROUND,
  DEFAULT_BACKGROUND_VEIL,
  INK_COLORS,
  TEXTURES,
  contrastRatio,
  inkFor,
  inkForHex,
  isHexColor,
  isKnownTextureId,
  multiplyHex,
  relativeLuminance,
  swatchById,
  textureById,
  textureSrc,
  type Background,
} from "@/lib/design/backgrounds";

describe("contrast maths (WCAG 2)", () => {
  it("matches known values", () => {
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 6);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 6);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});

describe("BACKGROUND_SWATCHES", () => {
  it("has 16 unique, well-formed swatches incl. the essentials", () => {
    expect(BACKGROUND_SWATCHES).toHaveLength(16);
    expect(new Set(BACKGROUND_SWATCHES.map((s) => s.id)).size).toBe(16);
    expect(new Set(BACKGROUND_SWATCHES.map((s) => s.hex.toUpperCase())).size).toBe(16);
    for (const s of BACKGROUND_SWATCHES) {
      expect(isHexColor(s.hex), s.id).toBe(true);
      expect(s.hex).toBe(s.hex.toUpperCase());
      expect(s.id).toMatch(/^[a-z][a-z-]*$/);
      expect(s.label.length).toBeGreaterThan(0);
    }
    for (const id of ["white", "cream", "warm-sand", "blush", "sage", "sky", "navy", "charcoal", "black"]) {
      expect(swatchById(id), id).toBeDefined();
    }
    expect(swatchById("nope")).toBeUndefined();
  });

  it("each swatch's declared ink reads at ≥ 4.5:1 and is the computed ink", () => {
    for (const s of BACKGROUND_SWATCHES) {
      expect(contrastRatio(s.hex, INK_COLORS[s.ink]), `${s.id} ${s.ink}`).toBeGreaterThanOrEqual(4.5);
      expect(inkForHex(s.hex), s.id).toBe(s.ink);
      expect(inkFor({ kind: "color", hex: s.hex }), s.id).toBe(s.ink);
    }
  });

  it("offers both light and dark backgrounds", () => {
    expect(BACKGROUND_SWATCHES.filter((s) => s.ink === "dark").length).toBeGreaterThanOrEqual(6);
    expect(BACKGROUND_SWATCHES.filter((s) => s.ink === "light").length).toBeGreaterThanOrEqual(4);
  });
});

describe("TEXTURES", () => {
  it("has the six textures, valid fields, readable declared ink on the base colour", () => {
    expect(TEXTURES.map((t) => t.id)).toEqual([
      "paper-cream",
      "paper-white",
      "linen",
      "kraft",
      "watercolour-blush",
      "watercolour-sky",
    ]);
    for (const t of TEXTURES) {
      expect(isHexColor(t.baseHex), t.id).toBe(true);
      expect(contrastRatio(t.baseHex, INK_COLORS[t.ink]), t.id).toBeGreaterThanOrEqual(4.5);
      expect(inkForHex(t.baseHex), t.id).toBe(t.ink);
      expect(t.kind === "tile" ? typeof t.tileMm : t.tileMm, t.id).toBe(t.kind === "tile" ? "number" : undefined);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it("lookups and sources", () => {
    expect(isKnownTextureId("kraft")).toBe(true);
    expect(isKnownTextureId("Kraft")).toBe(false);
    expect(isKnownTextureId("ref3-paper")).toBe(false);
    expect(isKnownTextureId(undefined)).toBe(false);
    expect(textureById("linen")?.kind).toBe("tile");
    expect(textureById("nope")).toBeUndefined();
    const linen = textureById("linen")!;
    expect(textureSrc(linen, "portrait", "screen")).toBe("/design/textures/linen.webp");
    expect(textureSrc(linen, "landscape", "print")).toBe("/design/textures/linen.jpg");
    const sky = textureById("watercolour-sky")!;
    expect(textureSrc(sky, "portrait", "print")).toBe("/design/textures/watercolour-sky-portrait.jpg");
    expect(textureSrc(sky, "landscape", "screen")).toBe("/design/textures/watercolour-sky-landscape.webp");
  });
});

describe("inkFor", () => {
  it("colour: computed from luminance (any hex, v1 string backgrounds too)", () => {
    expect(inkFor({ kind: "color", hex: "#FFFFFF" })).toBe("dark");
    expect(inkFor({ kind: "color", hex: "#0A0A0A" })).toBe("light");
    expect(inkFor("#FFFFFF")).toBe("dark");
    expect(inkFor("#1E2A47")).toBe("light");
    expect(inkFor(DEFAULT_BACKGROUND)).toBe("dark");
  });

  it("texture: declared ink, tint recomputes from the tinted base", () => {
    expect(inkFor({ kind: "texture", textureId: "kraft" })).toBe("dark");
    expect(multiplyHex("#FFFFFF", "#123456")).toBe("#123456");
    expect(multiplyHex("#808080", "#FFFFFF")).toBe("#808080");
    expect(inkFor({ kind: "texture", textureId: "paper-white", tint: "#1E2A47" })).toBe("light");
    expect(inkFor({ kind: "texture", textureId: "paper-white", tint: "#F2D4CF" })).toBe("dark");
  });

  it("photo: the veil colour decides", () => {
    const photo = (veilColor: string): Background => ({
      kind: "photo",
      photoId: "p1",
      veil: DEFAULT_BACKGROUND_VEIL,
      veilColor,
    });
    expect(inkFor(photo("#FFFFFF"))).toBe("dark");
    expect(inkFor(photo("#111111"))).toBe("light");
    expect(BACKGROUND_VEIL_MIN).toBe(0.5);
    expect(BACKGROUND_VEIL_MAX).toBe(0.9);
    expect(DEFAULT_BACKGROUND_VEIL).toBeGreaterThanOrEqual(BACKGROUND_VEIL_MIN);
    expect(DEFAULT_BACKGROUND_VEIL).toBeLessThanOrEqual(BACKGROUND_VEIL_MAX);
  });

  it("malformed input falls back to dark", () => {
    expect(inkFor(null)).toBe("dark");
    expect(inkFor(undefined)).toBe("dark");
    expect(inkFor("red")).toBe("dark");
    expect(inkFor({ kind: "texture", textureId: "nope" } as unknown as Background)).toBe("dark");
    expect(inkFor({ kind: "weird" } as unknown as Background)).toBe("dark");
  });
});
