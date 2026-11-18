import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BOOK_FONT_CLASSES, BOOK_FONT_VARS } from "@/components/book/book-fonts";
import {
  BOOK_FONT_NAMES,
  BOOK_FONTS,
  BOOK_FONTS_M10B,
  BOOK_FONTS_M30,
  BOOK_ONLY_FONTS,
  bookFontFamily,
  captionFontFamily,
  CAPTION_FONTS,
  FONT_PAIRS,
  fontForText,
  fontWeightFor,
  isBookFont,
  isM10bFont,
} from "@/lib/book/fonts";
import { DESIGN_STYLES } from "@/lib/book/schema";
import { roleFont, STYLE_TOKENS, styleTokens, TEXT_ROLES } from "@/lib/design/styles";

const AR = "أجمل ليلة بدأت بضحكة";

describe("font registry (M10b A3)", () => {
  it("covers classic + M10b faces with unique vars and const names", () => {
    expect(BOOK_FONT_NAMES).toEqual([...CAPTION_FONTS, ...BOOK_FONTS_M10B, ...BOOK_FONTS_M30]);
    expect([...BOOK_ONLY_FONTS]).toEqual([...BOOK_FONTS_M10B, ...BOOK_FONTS_M30]);
    expect([...BOOK_FONTS_M30]).toEqual(["ArchivoBlack", "Poppins"]);
    const defs = Object.values(BOOK_FONTS);
    expect(defs).toHaveLength(12);
    for (const [k, d] of Object.entries(BOOK_FONTS)) expect(d.name).toBe(k);
    expect(new Set(defs.map((d) => d.cssVar)).size).toBe(12);
    const consts = defs.flatMap((d) => [d.printConst, d.screenConst]).filter(Boolean);
    expect(new Set(consts).size).toBe(consts.length);
    for (const d of defs) expect(d.printConst).toMatch(/^print[A-Z]/);
    for (const n of BOOK_ONLY_FONTS) expect(BOOK_FONTS[n].screenConst).toMatch(/^book[A-Z]/);
    for (const n of CAPTION_FONTS) expect(BOOK_FONTS[n].screenConst).toBeNull();
    // doc names must pass the doc FontSchema regex
    for (const n of BOOK_FONT_NAMES) expect(n).toMatch(/^[A-Za-z0-9 ]{1,40}$/);
  });

  it("partners are symmetric within M10b pairs and cross scripts", () => {
    for (const [id, p] of Object.entries(FONT_PAIRS)) {
      expect(BOOK_FONTS[p.latin]).toMatchObject({ script: "latin", pair: id, partner: p.arabic });
      expect(BOOK_FONTS[p.arabic]).toMatchObject({ script: "arabic", pair: id, partner: p.latin });
    }
    for (const n of CAPTION_FONTS) expect(BOOK_FONTS[BOOK_FONTS[n].partner].script).not.toBe(BOOK_FONTS[n].script);
  });

  it("classic chains are exactly captionFontFamily (goldens)", () => {
    for (const n of CAPTION_FONTS) expect(bookFontFamily(n)).toBe(captionFontFamily(n));
    expect(bookFontFamily("Unknown")).toBe(captionFontFamily("Unknown"));
  });

  it("M10b chains: face → partner → Cairo → Inter → generic, each M10b var with a fallback name", () => {
    expect(bookFontFamily("GreatVibes")).toBe(
      'var(--font-great-vibes, "Great Vibes"), var(--font-aref-ruqaa, "Aref Ruqaa"), var(--font-cairo), var(--font-inter), serif',
    );
    expect(bookFontFamily("Bebas")).toBe(
      'var(--font-bebas, "Bebas Neue"), var(--font-lalezar, "Lalezar"), var(--font-cairo), var(--font-inter), sans-serif',
    );
    expect(bookFontFamily("Amiri")).toBe(
      'var(--font-amiri, "Amiri"), var(--font-cormorant, "Cormorant Garamond"), var(--font-cairo), var(--font-inter), serif',
    );
  });

  it("M30 faces: Latin only, one-way Arabic partners already shipped, full chains", () => {
    expect(BOOK_FONTS.ArchivoBlack).toMatchObject({ script: "latin", partner: "Lalezar", weights: [400], italic: false });
    expect(BOOK_FONTS.Poppins).toMatchObject({ script: "latin", partner: "Tajawal", weights: [400, 700], italic: false });
    // the shipped Arabic faces keep their own partners (existing books unchanged)
    expect(BOOK_FONTS.Lalezar.partner).toBe("Bebas");
    expect(BOOK_FONTS.Tajawal.partner).toBe("Playfair");
    expect(bookFontFamily("ArchivoBlack")).toBe(
      'var(--font-archivo-black, "Archivo Black"), var(--font-lalezar, "Lalezar"), var(--font-cairo), var(--font-inter), sans-serif',
    );
    expect(bookFontFamily("Poppins")).toBe('var(--font-poppins, "Poppins"), var(--font-tajawal), var(--font-cairo), var(--font-inter), sans-serif');
    expect(fontForText("Poppins", AR)).toBe("Tajawal");
    expect(fontForText("ArchivoBlack", AR)).toBe("Lalezar");
    expect(fontForText("Poppins", "Beach day")).toBe("Poppins");
    expect(fontWeightFor("Poppins", 600)).toBe(700);
    expect(fontWeightFor("Poppins", 400)).toBe(400);
    expect(fontWeightFor("ArchivoBlack", 700)).toBe(400);
    expect(isBookFont("Poppins") && isBookFont("ArchivoBlack")).toBe(true);
    expect(isM10bFont("Poppins")).toBe(false);
  });

  it("type guards, Arabic switch and weights", () => {
    expect(isBookFont("Lalezar")).toBe(true);
    expect(isBookFont("Comic Sans")).toBe(false);
    expect(isM10bFont("Playfair")).toBe(false);
    expect(fontForText("Cormorant", AR)).toBe("Amiri");
    expect(fontForText("Cormorant", "Beach day")).toBe("Cormorant");
    expect(fontForText("Amiri", "Beach day")).toBe("Amiri");
    expect(fontWeightFor("GreatVibes", 600)).toBe(400);
    expect(fontWeightFor("Cormorant", 600)).toBe(600);
    expect(fontWeightFor("ArefRuqaa", 600)).toBe(700);
    expect(fontWeightFor("Tajawal", 600)).toBe(700);
  });

  it("screen module declares every M10b + M30 var, with book* consts, preload off, no fallback face", () => {
    expect([...BOOK_FONT_VARS].sort()).toEqual(BOOK_ONLY_FONTS.map((n) => BOOK_FONTS[n].cssVar).sort());
    const classes = BOOK_FONT_CLASSES.split(" ");
    for (const v of BOOK_FONT_VARS) expect(classes).toContain(`__variable_${v.slice(2)}`);
    const src = readFileSync(path.join(__dirname, "../src/components/book/book-fonts.ts"), "utf8");
    for (const n of BOOK_ONLY_FONTS) expect(src).toContain(`const ${BOOK_FONTS[n].screenConst} = localFont(`);
    expect(src.match(/preload: false,/g)).toHaveLength(8);
    expect(src.match(/adjustFontFallback: false,/g)).toHaveLength(8);
  });

  it("screen fonts are not loaded globally (root layout), only on book routes", () => {
    const root = readFileSync(path.join(__dirname, "../src/app/layout.tsx"), "utf8");
    expect(root).not.toContain("book-fonts");
    expect(root).not.toContain("BookFonts");
    for (const r of ["b/[slug]", "books/[id]/edit", "dev-editor", "dev-viewer", "dev-book-page"]) {
      expect(readFileSync(path.join(__dirname, "../src/app", r, "layout.tsx"), "utf8")).toContain("<BookFonts>");
    }
  });
});

describe("style tokens (M10b A3)", () => {
  it("defines every design style and role", () => {
    expect(Object.keys(STYLE_TOKENS).sort()).toEqual([...DESIGN_STYLES].sort());
    for (const s of DESIGN_STYLES) for (const r of TEXT_ROLES) expect(STYLE_TOKENS[s].fonts[r]).toBeDefined();
    expect(styleTokens(undefined).id).toBe("classic");
  });

  it("every role's Arabic face is an Arabic face (the Latin face's partner)", () => {
    for (const s of DESIGN_STYLES)
      for (const r of TEXT_ROLES) {
        const t = STYLE_TOKENS[s].fonts[r];
        expect(BOOK_FONTS[t.latin].script).toBe("latin");
        expect(BOOK_FONTS[t.arabic].script).toBe("arabic");
        expect(BOOK_FONTS[t.latin].partner).toBe(t.arabic);
      }
  });

  it("classic = current rendering (Playfair / Cairo, title 600)", () => {
    expect(roleFont("classic", "title", "Our summer")).toMatchObject({
      font: "Playfair",
      fontFamily: captionFontFamily("Playfair"),
      fontWeight: 600,
    });
    expect(roleFont("classic", "caption", AR).fontFamily).toBe(captionFontFamily("Cairo"));
    expect(roleFont("classic", "caption", "2024", { captionLang: "ar" }).font).toBe("Cairo");
    expect(roleFont("classic", "caption", "2024", { captionLang: "en" }).font).toBe("Playfair");
  });

  it("modern: script title, serif year/subtitle/caption, display chapter; Arabic pairs", () => {
    expect(roleFont("modern", "title", "Our summer")).toMatchObject({ font: "GreatVibes", fontWeight: 400 });
    expect(roleFont("modern", "title", AR).font).toBe("ArefRuqaa");
    expect(roleFont("modern", "year", "2026")).toMatchObject({ font: "Cormorant", fontWeight: 600 });
    expect(roleFont("modern", "subtitle", "Abu Dhabi").font).toBe("Cormorant");
    expect(roleFont("modern", "chapter", "Day one")).toMatchObject({ font: "Bebas", textTransform: "uppercase" });
    expect(roleFont("modern", "chapter", AR).font).toBe("Lalezar");
    expect(roleFont("modern", "caption", AR).font).toBe("Amiri");
  });

  it("a doc font overrides the token; Latin overrides switch to their Arabic partner", () => {
    expect(roleFont("modern", "caption", "Hi", { override: "Bebas" }).font).toBe("Bebas");
    expect(roleFont("modern", "caption", AR, { override: "Bebas" }).font).toBe("Lalezar");
    expect(roleFont("modern", "caption", "Hi", { override: "Tajawal" }).font).toBe("Tajawal");
    expect(roleFont("modern", "caption", "Hi", { override: "Nope" }).font).toBe("Cormorant");
  });
});

import { V2_CAPTION_FONTS } from "@/lib/book/fonts-v2";
describe("fonts-v2 version rule", () => {
  it("lists exactly the M10b + M30 registry font ids", () => {
    expect([...V2_CAPTION_FONTS].sort()).toEqual([...BOOK_ONLY_FONTS].sort());
  });
});
