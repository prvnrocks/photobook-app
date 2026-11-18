// M30 T2: colourway catalogue + magazine / editorial style tokens (D-090).
import { describe, expect, it } from "vitest";
import { BOOK_FONTS, bookFontFamily } from "@/lib/book/fonts";
import { DESIGN_STYLES, EDITORIAL_COLOURWAY_IDS, MAGAZINE_COLOURWAY_IDS, STYLE_COLOURWAY_IDS } from "@/lib/book/schema";
import { COLOURWAYS, colourwaysFor, defaultColourway, resolveColourway } from "@/lib/design/colourways";
import { isStickerId, STICKERS } from "@/lib/design/stickers";
import { roleFont, STYLE_TOKENS, styleCaptionFont, TEXT_ROLES } from "@/lib/design/styles";

const HEX = /^#[0-9A-F]{6}$/;
const AR = "رحلة العائلة إلى أبوظبي";
const MIXED = "Eid عيد سعيد";
const M30 = ["magazine", "editorial"] as const;
const OLD = ["classic", "modern", "geometric", "scrapbook"] as const;

/** WCAG 2 relative luminance + contrast ratio of two #RRGGBB colours. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("colourways (M30 T2)", () => {
  it("contrast helper is the WCAG formula", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });

  it("every schema id has exactly one colourway, in schema order", () => {
    expect(colourwaysFor("magazine").map((c) => c.id)).toEqual([...MAGAZINE_COLOURWAY_IDS]);
    expect(colourwaysFor("editorial").map((c) => c.id)).toEqual([...EDITORIAL_COLOURWAY_IDS]);
    for (const s of DESIGN_STYLES) expect(colourwaysFor(s).map((c) => c.id)).toEqual([...STYLE_COLOURWAY_IDS[s]]);
    expect(Object.keys(COLOURWAYS).sort()).toEqual(["editorial", "magazine"]);
    expect(COLOURWAYS.magazine).toHaveLength(6);
    expect(COLOURWAYS.editorial).toHaveLength(6);
  });

  it("literal upper-case hex only (no color-mix / var), a label per colourway, distinct accents per style", () => {
    for (const s of M30) {
      const list = colourwaysFor(s);
      for (const c of list) {
        expect(Object.keys(c).sort()).toEqual(["accent", "accentOnLight", "id", "label", "onPanel", "panel"]);
        for (const v of [c.accent, c.accentOnLight, c.panel, c.onPanel]) expect(v, `${s}/${c.id}`).toMatch(HEX);
        expect(c.label).toMatch(/^[A-Z][a-z]+$/);
      }
      expect(new Set(list.map((c) => c.accent)).size).toBe(list.length);
      expect(new Set(list.map((c) => c.accentOnLight)).size).toBe(list.length);
      expect(new Set(list.map((c) => c.label)).size).toBe(list.length);
    }
  });

  it("contrast: accentOnLight on white ≥ 4.5, onPanel on panel ≥ 4.5, accent on panel ≥ 3; panels are dark", () => {
    for (const s of M30)
      for (const c of colourwaysFor(s)) {
        const at = `${s}/${c.id}`;
        expect(contrast(c.accentOnLight, "#FFFFFF"), at).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.onPanel, c.panel), at).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.accent, c.panel), at).toBeGreaterThanOrEqual(3);
        expect(luminance(c.panel), at).toBeLessThan(0.05);
      }
  });

  it("defaults: magazine → lime, editorial → ink; none for the older styles", () => {
    expect(defaultColourway("magazine")!.id).toBe("lime");
    expect(defaultColourway("editorial")!.id).toBe("ink");
    for (const s of OLD) {
      expect(defaultColourway(s)).toBeNull();
      expect(colourwaysFor(s)).toEqual([]);
    }
    expect(defaultColourway(undefined)).toBeNull();
  });

  it("resolveColourway: known id, default for absent / unknown / other-style ids, null for older styles", () => {
    expect(resolveColourway("magazine", "sky")!.id).toBe("sky");
    expect(resolveColourway("editorial", "cobalt")!.id).toBe("cobalt");
    expect(resolveColourway("magazine", undefined)!.id).toBe("lime");
    expect(resolveColourway("magazine", null)!.id).toBe("lime");
    expect(resolveColourway("magazine", "nope")!.id).toBe("lime");
    expect(resolveColourway("magazine", "ink")!.id).toBe("lime"); // an editorial id
    expect(resolveColourway("editorial", "lime")!.id).toBe("ink"); // a magazine id
    expect(resolveColourway("editorial", undefined)!.id).toBe("ink");
    // the shared ids resolve per style, to different colours
    expect(resolveColourway("magazine", "teal")!.accent).not.toBe(resolveColourway("editorial", "teal")!.accent);
    expect(resolveColourway("magazine", "coral")).toBe(colourwaysFor("magazine")[3]);
    for (const s of OLD) expect(resolveColourway(s, "lime")).toBeNull();
    expect(resolveColourway(undefined, "lime")).toBeNull();
    expect(resolveColourway(null, undefined)).toBeNull();
  });
});

describe("magazine + editorial style tokens (M30 T2)", () => {
  it("magazine faces: Archivo Black masthead (caps), Poppins 700 title/chapter, Poppins 400 tracked subtitle/year, Poppins 400 caption/body", () => {
    expect(roleFont("magazine", "masthead", "Adventure")).toEqual({
      font: "ArchivoBlack",
      fontFamily: bookFontFamily("ArchivoBlack"),
      fontWeight: 400,
      fontStyle: "normal",
      textTransform: "uppercase",
    });
    for (const r of ["title", "chapter"] as const) {
      expect(roleFont("magazine", r, "Life is one change")).toEqual({ font: "Poppins", fontFamily: bookFontFamily("Poppins"), fontWeight: 700, fontStyle: "normal" });
    }
    expect(roleFont("magazine", "subtitle", "Travel magazine")).toMatchObject({ font: "Poppins", fontWeight: 400, letterSpacing: "0.06em" });
    expect(roleFont("magazine", "year", "November 2026")).toMatchObject({ font: "Poppins", fontWeight: 400, letterSpacing: "0.14em" });
    for (const r of ["caption", "body"] as const) {
      expect(roleFont("magazine", r, "A quiet morning")).toEqual({ font: "Poppins", fontFamily: bookFontFamily("Poppins"), fontWeight: 400, fontStyle: "normal" });
    }
  });

  it("editorial faces: Poppins 700 masthead/title/chapter in sentence case, Poppins 400 elsewhere, no tracking", () => {
    for (const r of TEXT_ROLES) {
      const f = roleFont("editorial", r, "The Foodie Week");
      const heavy = r === "masthead" || r === "title" || r === "chapter";
      expect(f, r).toEqual({ font: "Poppins", fontFamily: bookFontFamily("Poppins"), fontWeight: heavy ? 700 : 400, fontStyle: "normal" });
      expect(STYLE_TOKENS.editorial.fonts[r].uppercase).toBeUndefined();
      expect(STYLE_TOKENS.editorial.fonts[r].uppercaseLatin).toBeUndefined();
    }
  });

  it("Arabic: partner faces at shipped weights, never letter-spacing or uppercase", () => {
    expect(roleFont("magazine", "masthead", AR)).toEqual({ font: "Lalezar", fontFamily: bookFontFamily("Lalezar"), fontWeight: 400, fontStyle: "normal" });
    expect(roleFont("magazine", "title", AR)).toMatchObject({ font: "Tajawal", fontWeight: 700 });
    expect(roleFont("editorial", "masthead", AR)).toMatchObject({ font: "Tajawal", fontWeight: 700 });
    expect(roleFont("editorial", "body", AR)).toMatchObject({ font: "Tajawal", fontWeight: 400 });
    for (const s of M30)
      for (const r of TEXT_ROLES) {
        const t = STYLE_TOKENS[s].fonts[r];
        expect(BOOK_FONTS[t.latin].script).toBe("latin");
        expect(BOOK_FONTS[t.arabic].script).toBe("arabic");
        expect(BOOK_FONTS[t.latin].partner).toBe(t.arabic);
        expect(BOOK_FONTS[t.latin].weights).toContain(t.weight);
        expect(BOOK_FONTS[t.arabic].weights).toContain(t.weight);
        // the unconditional `uppercase` flag (modern, frozen) is never used by the M30 styles
        expect(t.uppercase).toBeUndefined();
        expect(t.italic).toBeUndefined();
        expect(roleFont(s, r, AR).font).toBe(t.arabic);
        const arabicCases = [
          roleFont(s, r, AR),
          roleFont(s, r, MIXED),
          roleFont(s, r, "٢٠٢٦", { captionLang: "ar" }),
          roleFont(s, r, "2026", { captionLang: "ar" }),
          roleFont(s, r, AR, { override: "Poppins" }),
          roleFont(s, r, AR, { override: "ArchivoBlack" }),
          roleFont(s, r, "Hi", { override: "Lalezar" }), // Arabic face on Latin text
        ];
        for (const f of arabicCases) {
          expect(f, `${s}/${r}`).not.toHaveProperty("letterSpacing");
          expect(f, `${s}/${r}`).not.toHaveProperty("textTransform");
          expect(f.fontFamily).toBe(bookFontFamily(f.font));
        }
        // every chain reaches an Arabic face and the Cairo / Inter tail
        for (const text of ["Our summer", AR]) {
          const fam = roleFont(s, r, text).fontFamily;
          expect(fam).toMatch(/var\(--font-(tajawal|lalezar)/);
          // (Tajawal is a classic face: its chain is the classic one, Tajawal → Cairo → generic)
          expect(fam).toContain("var(--font-cairo)");
          expect(fam.endsWith(", sans-serif")).toBe(true);
        }
      }
  });

  it("styleCaptionFont: Poppins / Tajawal for both styles; older styles unchanged", () => {
    for (const s of M30) {
      expect(styleCaptionFont(s, "en")).toBe("Poppins");
      expect(styleCaptionFont(s, null)).toBe("Poppins");
      expect(styleCaptionFont(s, "ar")).toBe("Tajawal");
    }
    expect(styleCaptionFont("classic", "en")).toBe("Playfair");
    expect(styleCaptionFont("classic", "ar")).toBe("Cairo");
    expect(styleCaptionFont("modern", "ar")).toBe("Amiri");
    expect(styleCaptionFont("scrapbook", "en")).toBe("Cormorant");
  });

  it("palettes: white page, near-black ink, readable muted grey, white frame, real plate, shared shadows", () => {
    for (const s of M30) {
      const p = STYLE_TOKENS[s].palette!;
      for (const c of [p.background, p.ink, p.muted, p.accent, p.frame, p.tape, p.plate.tint, ...p.stickerTints]) expect(c).toMatch(HEX);
      expect(p.background).toBe("#FFFFFF");
      expect(p.frame).toBe("#FFFFFF");
      expect(contrast(p.ink, "#FFFFFF")).toBeGreaterThanOrEqual(15);
      expect(contrast(p.muted, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.muted, "#FFFFFF")).toBeLessThan(contrast(p.ink, "#FFFFFF"));
      expect(p.stickerTints.length).toBeGreaterThanOrEqual(3);
      expect(isStickerId(p.plate.id)).toBe(true);
      expect(STICKERS[p.plate.id].kind).toBe("plate");
      expect(p.tape).toBe(STYLE_TOKENS.geometric.palette!.tape);
      // palette.accent = the default colourway on white pages
      expect(p.accent).toBe(defaultColourway(s)!.accentOnLight);
      expect(STYLE_TOKENS[s].shadows).toBe(STYLE_TOKENS.scrapbook.shadows);
    }
  });

  it("the four older styles are frozen (tokens, palettes, the unconditional modern uppercase)", () => {
    expect(JSON.stringify(STYLE_TOKENS.geometric)).toBe(
      '{"id":"geometric","fonts":{"title":{"latin":"Cormorant","arabic":"Amiri","weight":600,"letterSpacingEm":0.01},"subtitle":{"latin":"Bebas","arabic":"Lalezar","weight":400,"letterSpacingEm":0.18},"year":{"latin":"Bebas","arabic":"Lalezar","weight":400,"letterSpacingEm":0.16},"chapter":{"latin":"Bebas","arabic":"Lalezar","weight":400,"letterSpacingEm":0.05},"caption":{"latin":"Cormorant","arabic":"Amiri","weight":400},"masthead":{"latin":"Cormorant","arabic":"Amiri","weight":600,"letterSpacingEm":0.01},"body":{"latin":"Cormorant","arabic":"Amiri","weight":400}},"palette":{"background":"#FFFFFF","ink":"#1F2328","muted":"#5E636B","accent":"#235A5E","frame":"#FFFFFF","plate":{"id":"plate-label","tint":"#1F2328"},"tape":"#E9D9B6","stickerTints":["#235A5E","#D9A84E","#1F2328","#B65A4E"]},"shadows":{"soft":{"dxMm":0.7,"dyMm":0.9,"color":"rgba(0, 0, 0, 0.14)"},"lifted":{"dxMm":1.1,"dyMm":1.5,"color":"rgba(0, 0, 0, 0.17)"}}}',
    );
    expect(JSON.stringify(STYLE_TOKENS.scrapbook)).toBe(
      '{"id":"scrapbook","fonts":{"title":{"latin":"Bebas","arabic":"Lalezar","weight":400,"letterSpacingEm":0.03},"subtitle":{"latin":"Cormorant","arabic":"Amiri","weight":400,"italic":true},"year":{"latin":"Bebas","arabic":"Lalezar","weight":400,"letterSpacingEm":0.12},"chapter":{"latin":"Bebas","arabic":"Lalezar","weight":400,"letterSpacingEm":0.03},"caption":{"latin":"Cormorant","arabic":"Amiri","weight":400},"masthead":{"latin":"Bebas","arabic":"Lalezar","weight":400,"letterSpacingEm":0.03},"body":{"latin":"Cormorant","arabic":"Amiri","weight":400}},"palette":{"background":"#F6F0E4","ink":"#2A2622","muted":"#6B5F52","accent":"#B65A4E","frame":"#FBF8F1","plate":{"id":"plate-label","tint":"#232326"},"tape":"#E9D9B6","stickerTints":["#B98A5E","#B65A4E","#7E9A6E","#D9A84E"]},"shadows":{"soft":{"dxMm":0.7,"dyMm":0.9,"color":"rgba(0, 0, 0, 0.14)"},"lifted":{"dxMm":1.1,"dyMm":1.5,"color":"rgba(0, 0, 0, 0.17)"}}}',
    );
    for (const s of OLD) for (const r of TEXT_ROLES) expect(STYLE_TOKENS[s].fonts[r].uppercaseLatin).toBeUndefined();
    // modern chapter keeps its unconditional uppercase (m10b goldens), Arabic included
    expect(roleFont("modern", "chapter", AR)).toMatchObject({ font: "Lalezar", textTransform: "uppercase" });
    expect(roleFont("modern", "chapter", "Day one")).toMatchObject({ font: "Bebas", textTransform: "uppercase" });
  });
});
