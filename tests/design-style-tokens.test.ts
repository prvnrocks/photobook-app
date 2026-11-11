// M10c T3: geometric + scrapbook style tokens (D-068). Classic and modern tokens are frozen
// byte-for-byte (their rendering is covered by the m9 / m10b goldens); new styles use only the
// existing faces, every chain ends in an Arabic face, and Arabic never gets letter-spacing.
import { describe, expect, it } from "vitest";
import { BOOK_FONTS, bookFontFamily } from "@/lib/book/fonts";
import { isStickerId, STICKERS } from "@/lib/design/stickers";
import { roleFont, STYLE_TOKENS, TEXT_ROLES } from "@/lib/design/styles";

const AR = "رحلة العائلة إلى أبوظبي";
const MIXED = "Eid عيد سعيد";

// Frozen copies of the pre-M10c tokens. Do not edit: a change here changes shipped books.
const CLASSIC_FROZEN =
  '{"id":"classic","fonts":{"title":{"latin":"Playfair","arabic":"Cairo","weight":600},"subtitle":{"latin":"Playfair","arabic":"Cairo","weight":400},"year":{"latin":"Playfair","arabic":"Cairo","weight":400},"chapter":{"latin":"Playfair","arabic":"Cairo","weight":600},"caption":{"latin":"Playfair","arabic":"Cairo","weight":400}}}';
const MODERN_FROZEN =
  '{"id":"modern","fonts":{"title":{"latin":"GreatVibes","arabic":"ArefRuqaa","weight":400},"subtitle":{"latin":"Cormorant","arabic":"Amiri","weight":400},"year":{"latin":"Cormorant","arabic":"Amiri","weight":600},"chapter":{"latin":"Bebas","arabic":"Lalezar","weight":400,"uppercase":true},"caption":{"latin":"Cormorant","arabic":"Amiri","weight":400}}}';

const NEW = ["geometric", "scrapbook"] as const;
const HEX = /^#[0-9A-F]{6}$/;

describe("style tokens (M10c T3)", () => {
  it("classic and modern tokens are byte-identical to the frozen copies", () => {
    expect(JSON.stringify(STYLE_TOKENS.classic)).toBe(CLASSIC_FROZEN);
    expect(JSON.stringify(STYLE_TOKENS.modern)).toBe(MODERN_FROZEN);
  });

  it("classic and modern resolve without letter-spacing (render models unchanged)", () => {
    for (const s of ["classic", "modern"] as const)
      for (const r of TEXT_ROLES)
        for (const t of ["Our summer", AR, MIXED, "2026"]) expect(roleFont(s, r, t)).not.toHaveProperty("letterSpacing");
  });

  it("geometric and scrapbook are real tokens, not modern copies", () => {
    for (const s of NEW) {
      expect(STYLE_TOKENS[s].id).toBe(s);
      expect(STYLE_TOKENS[s].fonts).not.toBe(STYLE_TOKENS.modern.fonts);
      expect(JSON.stringify(STYLE_TOKENS[s].fonts)).not.toBe(JSON.stringify(STYLE_TOKENS.modern.fonts));
    }
  });

  it("D-068 faces: no new fonts; scrapbook Bebas titles/labels + Cormorant captions; geometric Cormorant title + Bebas chapter", () => {
    const allowed = new Set(["Cormorant", "Amiri", "Bebas", "Lalezar", "GreatVibes", "ArefRuqaa"]);
    for (const s of NEW) for (const r of TEXT_ROLES) {
      const t = STYLE_TOKENS[s].fonts[r];
      expect(allowed.has(t.latin) && allowed.has(t.arabic)).toBe(true);
    }
    const sb = STYLE_TOKENS.scrapbook.fonts;
    expect([sb.title.latin, sb.chapter.latin, sb.year.latin]).toEqual(["Bebas", "Bebas", "Bebas"]);
    expect([sb.title.arabic, sb.chapter.arabic, sb.year.arabic]).toEqual(["Lalezar", "Lalezar", "Lalezar"]);
    expect([sb.caption.latin, sb.caption.arabic]).toEqual(["Cormorant", "Amiri"]);
    const g = STYLE_TOKENS.geometric.fonts;
    expect(["GreatVibes", "Cormorant"]).toContain(g.title.latin);
    expect([g.chapter.latin, g.chapter.arabic]).toEqual(["Bebas", "Lalezar"]);
    expect([g.caption.latin, g.caption.arabic]).toEqual(["Cormorant", "Amiri"]);
  });

  it("every chain of the new styles ends in an Arabic face, never uppercase-transforms", () => {
    for (const s of NEW)
      for (const r of TEXT_ROLES) {
        const t = STYLE_TOKENS[s].fonts[r];
        expect(BOOK_FONTS[t.arabic].script).toBe("arabic");
        expect(t.uppercase).toBeUndefined();
        for (const text of ["Our summer", AR]) {
          const f = roleFont(s, r, text);
          expect(f.fontFamily).toBe(bookFontFamily(f.font));
          expect(f.fontFamily).toContain("var(--font-cairo)");
          expect(f).not.toHaveProperty("textTransform");
        }
        expect(roleFont(s, r, AR).font).toBe(t.arabic);
      }
  });

  it("letter-spacing only on Latin text in a Latin face — never on Arabic or mixed text", () => {
    expect(roleFont("scrapbook", "year", "14 June 2026").letterSpacing).toBe("0.12em");
    expect(roleFont("geometric", "subtitle", "Abu Dhabi").letterSpacing).toBe("0.18em");
    for (const s of NEW)
      for (const r of TEXT_ROLES) {
        expect(roleFont(s, r, AR)).not.toHaveProperty("letterSpacing");
        expect(roleFont(s, r, MIXED)).not.toHaveProperty("letterSpacing");
        expect(roleFont(s, r, "٢٠٢٦", { captionLang: "ar" })).not.toHaveProperty("letterSpacing");
        // an Arabic override face on Latin text: no tracking either
        expect(roleFont(s, r, "Hi", { override: "Lalezar" })).not.toHaveProperty("letterSpacing");
      }
  });

  it("scrapbook subtitle is Cormorant italic; Amiri has no italic so Arabic stays upright", () => {
    expect(roleFont("scrapbook", "subtitle", "these moments").fontStyle).toBe("italic");
    expect(roleFont("scrapbook", "subtitle", AR)).toMatchObject({ font: "Amiri", fontStyle: "normal" });
  });

  it("palettes: hex colours, a real plate sticker, print-safe shadows", () => {
    for (const s of NEW) {
      const p = STYLE_TOKENS[s].palette!;
      for (const c of [p.background, p.ink, p.muted, p.accent, p.frame, p.tape, p.plate.tint, ...p.stickerTints]) expect(c).toMatch(HEX);
      expect(isStickerId(p.plate.id)).toBe(true);
      expect(STICKERS[p.plate.id].kind).toBe("plate");
      const sh = STYLE_TOKENS[s].shadows!;
      for (const v of [sh.soft, sh.lifted]) {
        expect(v).toMatch(/mm/);
        expect(v).not.toMatch(/filter|blur\(|drop-shadow/);
      }
    }
    expect(STYLE_TOKENS.classic.palette).toBeUndefined();
    expect(STYLE_TOKENS.modern.palette).toBeUndefined();
  });
});
