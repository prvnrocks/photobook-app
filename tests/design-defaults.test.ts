import { describe, expect, it } from "vitest";
import { OCCASIONS } from "@/lib/book/options";
import { BOOK_FORMATS, DesignStyleSchema } from "@/lib/book/schema";
import {
  DEFAULT_FORM_FORMAT,
  DEFAULT_STYLE_BY_OCCASION,
  defaultStyleFor,
  designLabel,
  effectiveStyle,
  FORM_DESIGN_STYLES,
  FORM_FORMATS,
  isFormDesignStyle,
} from "@/lib/design/defaults";

describe("New book design defaults (D-065)", () => {
  it("every occasion defaults to modern for now", () => {
    for (const o of OCCASIONS) expect(DEFAULT_STYLE_BY_OCCASION[o]).toBe("modern");
    expect(Object.keys(DEFAULT_STYLE_BY_OCCASION).sort()).toEqual([...OCCASIONS].sort());
  });

  it("before an occasion is picked the style is modern; the default shape is portrait", () => {
    expect(defaultStyleFor(null)).toBe("modern");
    expect(DEFAULT_FORM_FORMAT).toBe("A5_PORTRAIT");
    expect(FORM_FORMATS[0]).toBe("A5_PORTRAIT");
  });

  it("the form offers Modern then Classic only, all valid schema styles", () => {
    expect(FORM_DESIGN_STYLES).toEqual(["modern", "classic"]);
    for (const s of FORM_DESIGN_STYLES) expect(DesignStyleSchema.safeParse(s).success).toBe(true);
    expect([...FORM_FORMATS].sort()).toEqual([...BOOK_FORMATS].sort());
    expect(isFormDesignStyle("geometric")).toBe(false);
    expect(isFormDesignStyle("scrapbook")).toBe(false);
    expect(isFormDesignStyle(undefined)).toBe(false);
  });

  it("a manual pick wins over the occasion default; null follows the occasion", () => {
    expect(effectiveStyle(null, "wedding")).toBe(DEFAULT_STYLE_BY_OCCASION.wedding);
    expect(effectiveStyle("classic", "wedding")).toBe("classic");
    expect(effectiveStyle("classic", null)).toBe("classic");
  });

  it("read-only editor label", () => {
    expect(designLabel("A5_LANDSCAPE", "modern")).toBe("A5 Landscape · Modern");
    expect(designLabel("A5_PORTRAIT", "classic")).toBe("A5 Portrait · Classic");
    expect(designLabel("A5_PORTRAIT", undefined)).toBe("A5 Portrait · Classic");
  });
});
