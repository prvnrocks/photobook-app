import { describe, expect, it } from "vitest";
import { OCCASIONS } from "@/lib/book/options";
import { BOOK_FORMATS, DesignStyleSchema } from "@/lib/book/schema";
import {
  DEFAULT_FORM_FORMAT,
  DEFAULT_STYLE_BY_OCCASION,
  defaultStyleFor,
  DESIGN_STYLE_HINTS,
  DESIGN_STYLE_LABELS,
  designLabel,
  effectiveStyle,
  FORM_DESIGN_STYLES,
  FORM_FORMATS,
  FORMAT_SHORT_LABELS,
  isFormDesignStyle,
} from "@/lib/design/defaults";

describe("New book design defaults (D-068)", () => {
  it("occasion defaults: wedding Modern, travel/graduation Geometric, baby/family Scrapbook, other Modern", () => {
    expect(DEFAULT_STYLE_BY_OCCASION).toEqual({
      wedding: "modern",
      travel: "geometric",
      graduation: "geometric",
      baby: "scrapbook",
      family: "scrapbook",
      other: "modern",
    });
    expect(Object.keys(DEFAULT_STYLE_BY_OCCASION).sort()).toEqual([...OCCASIONS].sort());
    for (const o of OCCASIONS) expect(defaultStyleFor(o)).toBe(DEFAULT_STYLE_BY_OCCASION[o]);
  });

  it("before an occasion is picked the style is modern; the default shape is portrait", () => {
    expect(defaultStyleFor(null)).toBe("modern");
    expect(DEFAULT_FORM_FORMAT).toBe("A5_PORTRAIT");
    expect(FORM_FORMATS[0]).toBe("A5_PORTRAIT");
  });

  it("the form offers all four schema styles: Modern, Classic, Geometric, Scrapbook", () => {
    expect(FORM_DESIGN_STYLES).toEqual(["modern", "classic", "geometric", "scrapbook"]);
    expect([...FORM_DESIGN_STYLES].sort()).toEqual([...DesignStyleSchema.options].sort());
    expect([...FORM_FORMATS].sort()).toEqual([...BOOK_FORMATS].sort());
    for (const s of DesignStyleSchema.options) expect(isFormDesignStyle(s)).toBe(true);
    expect(isFormDesignStyle("Modern")).toBe(false);
    expect(isFormDesignStyle(undefined)).toBe(false);
  });

  it("style hints never name another option (e2e picks radios by /Classic/, /Landscape/ …)", () => {
    const names = [...Object.values(DESIGN_STYLE_LABELS), ...Object.values(FORMAT_SHORT_LABELS)];
    for (const s of FORM_DESIGN_STYLES) {
      for (const n of names) {
        if (n !== DESIGN_STYLE_LABELS[s]) expect(DESIGN_STYLE_HINTS[s]).not.toMatch(new RegExp(n, "i"));
      }
    }
  });

  it("a manual pick wins over the occasion default; null follows the occasion", () => {
    expect(effectiveStyle(null, "wedding")).toBe(DEFAULT_STYLE_BY_OCCASION.wedding);
    expect(effectiveStyle(null, "travel")).toBe("geometric");
    expect(effectiveStyle("modern", "baby")).toBe("modern");
    expect(effectiveStyle("classic", "wedding")).toBe("classic");
    expect(effectiveStyle("classic", null)).toBe("classic");
  });

  it("read-only editor label", () => {
    expect(designLabel("A5_LANDSCAPE", "modern")).toBe("A5 Landscape · Modern");
    expect(designLabel("A5_PORTRAIT", "classic")).toBe("A5 Portrait · Classic");
    expect(designLabel("A5_PORTRAIT", undefined)).toBe("A5 Portrait · Classic");
    expect(designLabel("A5_LANDSCAPE", "scrapbook")).toBe("A5 Landscape · Scrapbook");
  });
});
