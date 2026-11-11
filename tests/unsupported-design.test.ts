// M10b A19 (review S1): a book whose design style has no layouts makes every doc writer fail with
// the typed UnsupportedDesignError instead of crashing, and the editor save refuses with 422
// unsupported_design. The style is never remapped.
// M10c T10: geometric + scrapbook ship, so every DESIGN_STYLES value is supported. The machinery
// stays (future styles, rolled-back code meeting newer rows) and is exercised with a SIMULATED
// style without layouts (tests/fixtures/simulated-unsupported-style.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/book/book-design", async (orig) =>
  (await import("./fixtures/simulated-unsupported-style")).withSimulatedUnsupported(await orig()),
);
import { autolayout, fillPages, type AutoPhoto } from "@/lib/autolayout";
import {
  assertSupportedDesign,
  isSupportedDesign,
  isUnsupportedDesignError,
  SUPPORTED_DESIGN_STYLES,
  UnsupportedDesignError,
  type BookDesign,
} from "@/lib/book/book-design";
import { devPreviewDoc } from "@/lib/book/dev-preview";
import { relayoutDoc } from "@/lib/book/relayout";
import { DESIGN_STYLES } from "@/lib/book/schema";
import { layoutsFor } from "@/lib/book/spreads";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { bestCoverLayout, bestPageLayout, fullPageLayout } from "@/lib/layouts/fit";
import { simulateUnsupported } from "./fixtures/simulated-unsupported-style";

const FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const;
/** Real styles the code can't lay out (none since M10c T10). */
const UNSUPPORTED = DESIGN_STYLES.filter((s) => !(SUPPORTED_DESIGN_STYLES as readonly string[]).includes(s));
/** Styles simulated as "no layouts" below — each one in turn. */
const SIMULATED = ["geometric", "scrapbook"] as const;

const photo = (n: number): AutoPhoto => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  width: 1500,
  height: 1000,
  takenAt: null,
  dateSource: null,
  place: null,
  status: "kept",
  dupGroup: null,
  blurScore: null,
});

function expectTyped(fn: () => unknown, design: BookDesign) {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(isUnsupportedDesignError(err)).toBe(true);
  expect(err).toBeInstanceOf(UnsupportedDesignError);
  expect((err as UnsupportedDesignError).code).toBe("unsupported_design");
  expect((err as UnsupportedDesignError).design).toEqual(design);
}

describe("supported designs", () => {
  it("every design style is supported since M10c T10 (geometric + scrapbook enabled)", () => {
    expect(UNSUPPORTED).toEqual([]);
    expect([...SUPPORTED_DESIGN_STYLES].sort()).toEqual([...DESIGN_STYLES].sort());
  });

  it("an unknown style string is never supported (the check is an allowlist)", () => {
    const d = { format: "A5_PORTRAIT", designStyle: "vintage" } as unknown as BookDesign;
    expect(isSupportedDesign(d)).toBe(false);
    expectTyped(() => assertSupportedDesign(d), d);
  });

  it("every supported style × format has a cover, a one-photo page and a full-page layout", () => {
    for (const designStyle of SUPPORTED_DESIGN_STYLES) {
      for (const format of FORMATS) {
        const d = { format, designStyle };
        expect(isSupportedDesign(d)).toBe(true);
        expect(() => assertSupportedDesign(d)).not.toThrow();
        expect(layoutsFor(format, designStyle, "cover").length).toBeGreaterThan(0);
        expect(layoutsFor(format, designStyle, "page").some((l) => l.photoCount === 1)).toBe(true);
        expect(typeof bestCoverLayout(d)).toBe("string");
        expect(typeof fullPageLayout(d)).toBe("string");
      }
    }
  });
});

describe.each(SIMULATED.flatMap((s) => FORMATS.map((f) => ({ format: f, designStyle: s }) as BookDesign)))(
  "design without layouts (simulated) $format/$designStyle",
  (design) => {
    beforeEach(() => simulateUnsupported([design.designStyle]));
    afterEach(() => simulateUnsupported([]));

    it("every layout writer throws the typed error (no generic crash)", () => {
      expect(isSupportedDesign(design)).toBe(false);
      expectTyped(() => assertSupportedDesign(design), design);
      expectTyped(() => bestCoverLayout(design), design);
      expectTyped(() => fullPageLayout(design), design);
      expectTyped(() => bestPageLayout(["landscape"], { design }), design);
      expectTyped(() => autolayout([photo(1), photo(2)], { occasion: "travel", title: null, captionLang: "en", isPaid: false, design }), design);
      expectTyped(() => autolayout([], { occasion: "travel", title: null, captionLang: "en", isPaid: false, design }), design);
      expectTyped(() => fillPages([photo(1)], { design }), design);
      const doc = { ...devPreviewDoc(), format: design.format, style: { ...devPreviewDoc().style, designStyle: design.designStyle } };
      expectTyped(() => relayoutDoc(doc, [], { isPaid: false, maxPages: 20, captionLang: "en" }), design);
    });

    it("editor save → unsupported_design (route maps it to 422), before parsing the doc", () => {
      const ids = new Set(Array.from({ length: 16 }, (_, i) => `d${i}`));
      const ctx = { photoIds: ids, maxPages: 20, savedDoc: devPreviewDoc(), design };
      expect(validateEditorDoc(devPreviewDoc(), ctx)).toEqual({ ok: false, code: "unsupported_design" });
      expect(validateEditorDoc({}, ctx)).toEqual({ ok: false, code: "unsupported_design" });
    });
  },
);
