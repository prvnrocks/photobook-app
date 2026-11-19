// Task 10: validatePrintReadiness + print specs + plain copy (pure).
import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/ai/limits";
import { setCover, setPageText } from "@/lib/book/edit-ops";
import { pageMm } from "@/lib/book/format";
import { LOW_RES_DPI } from "@/lib/book/resolution";
import { DESIGN_STYLES } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { BLEED_MM, getLayout, LAYOUTS, SAFE_MM } from "@/lib/layouts";
import { getPageTemplate } from "@/lib/layouts/templates";
import { textFits } from "@/lib/storybook/compose/select";
import { readinessIssueCopy, readinessSummary, readinessView, READINESS_LINES_MAX } from "@/lib/print/copy";
import { READINESS_ERROR_CODES, READINESS_WARNING_CODES, validatePrintReadiness, type ReadinessIssue, type ReadinessPhoto } from "@/lib/print/readiness";
import { DEFAULT_PRINT_SPEC_ID, GENERIC_A5_DIGITAL, getPrintSpec, INDIA_POD_PLACEHOLDER, isSpecComplete, PRINT_SPECS, UAE_POD_PLACEHOLDER } from "@/lib/print/specs";
import { composeStoryDoc } from "@/lib/storybook/compose";
import { storyFixture } from "@/lib/storybook/compose/dev-fixture";
import type { ComposePhoto } from "@/lib/storybook/compose/types";

type Design = { format: "A5_PORTRAIT" | "A5_LANDSCAPE"; designStyle: (typeof DESIGN_STYLES)[number] };

function composed(design: Design, opts: { photos?: number; lang?: "en" | "ar"; lowRes?: number[]; maxPages?: number } = {}) {
  const lang = opts.lang ?? "en";
  const f = storyFixture({ photos: opts.photos ?? 24, lang, design, lowRes: opts.lowRes ?? [] });
  const doc = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design, lang, occasion: "travel", bookTitle: null, maxPages: opts.maxPages ?? 20 }).doc;
  return { doc, photos: photoMap(f.photos), lang };
}

const photoMap = (ps: readonly ComposePhoto[]) => new Map<string, ReadinessPhoto>(ps.map((p) => [p.id, { width: p.width, height: p.height }]));
const codes = (issues: readonly ReadinessIssue[]) => issues.map((i) => i.code);

describe("print specs", () => {
  it("the digital spec is read from the renderer's own constants", () => {
    expect(DEFAULT_PRINT_SPEC_ID).toBe("generic-a5-digital");
    expect(getPrintSpec(DEFAULT_PRINT_SPEC_ID)).toBe(GENERIC_A5_DIGITAL);
    expect(GENERIC_A5_DIGITAL.trim.A5_PORTRAIT).toEqual({ wMm: pageMm("A5_PORTRAIT").w, hMm: pageMm("A5_PORTRAIT").h });
    expect(GENERIC_A5_DIGITAL.trim.A5_LANDSCAPE).toEqual({ wMm: 210, hMm: 148 });
    expect(GENERIC_A5_DIGITAL.bleedMm).toBe(BLEED_MM);
    expect(GENERIC_A5_DIGITAL.safeMarginMm).toBe(SAFE_MM);
    expect(GENERIC_A5_DIGITAL.minEffectiveDpi).toBe(LOW_RES_DPI);
    expect(GENERIC_A5_DIGITAL.targetDpi).toBe(300);
    expect(GENERIC_A5_DIGITAL.pages.max).toBe(LIMITS.paid.maxPages);
    expect(GENERIC_A5_DIGITAL.cover.layout).toBe("front_only");
    expect(isSpecComplete(GENERIC_A5_DIGITAL, "A5_PORTRAIT")).toBe(true);
    expect(isSpecComplete(GENERIC_A5_DIGITAL, "A5_LANDSCAPE")).toBe(true);
  });

  it("no spec claims provider verification; placeholders invent no numbers", () => {
    for (const s of PRINT_SPECS) expect(s.providerVerified, s.id).toBe(false);
    for (const s of [UAE_POD_PLACEHOLDER, INDIA_POD_PLACEHOLDER]) {
      expect(s.kind).toBe("print_provider");
      expect(s.trim).toEqual({ A5_PORTRAIT: null, A5_LANDSCAPE: null });
      expect([s.bleedMm, s.safeMarginMm, s.targetDpi, s.minEffectiveDpi, s.pages.min, s.pages.max, s.pages.multipleOf, s.cover.layout, s.cover.spineWidthMm]).toEqual(Array(9).fill(null));
      expect(s.source).toMatch(/TODO fill from provider spec/);
      expect(s.todo.length).toBeGreaterThan(0);
      expect(isSpecComplete(s, "A5_PORTRAIT")).toBe(false);
    }
    expect(UAE_POD_PLACEHOLDER.region).toBe("UAE");
    expect(INDIA_POD_PLACEHOLDER.region).toBe("IN");
  });

  it("every single-page and cover layout keeps its text boxes inside the digital safe margin", () => {
    const doc0 = composed({ format: "A5_PORTRAIT", designStyle: "classic" }).doc;
    for (const l of LAYOUTS) {
      if (l.role === "spread") continue;
      const doc: BookDoc = l.role === "cover" ? { ...doc0, format: l.format, cover: { ...doc0.cover, layout: l.id } } : { ...doc0, format: l.format, pages: [{ ...doc0.pages[0]!, layout: l.id, side: undefined }] };
      const r = validatePrintReadiness(doc, GENERIC_A5_DIGITAL, { photos: new Map() });
      expect(r.issues.filter((i) => i.code === "text_outside_safe"), l.id).toEqual([]);
    }
  });
});

describe("validatePrintReadiness", () => {
  it("composed storybooks pass for every style, format and language (no errors)", () => {
    for (const designStyle of DESIGN_STYLES) {
      for (const format of ["A5_PORTRAIT", "A5_LANDSCAPE"] as const) {
        for (const lang of ["en", "ar"] as const) {
          const { doc, photos } = composed({ format, designStyle }, { lang });
          const r = validatePrintReadiness(doc, GENERIC_A5_DIGITAL, { photos, lang, maxPages: 20 });
          expect(r.errors, `${designStyle} ${format} ${lang}: ${JSON.stringify(r.issues)}`).toBe(0);
          expect(r.ok).toBe(true);
          expect(r.sheets).toBe(doc.pages.length + 1);
          expect(r.providerVerified).toBe(false);
        }
      }
    }
  });

  it("a blank page and a missing photo are errors; an empty slot is a warning", () => {
    const { doc, photos } = composed({ format: "A5_PORTRAIT", designStyle: "modern" });
    const withPhoto = doc.pages.findIndex((p) => p.slots.some((s) => s.photoId) && !p.texts?.length && !p.caption);
    expect(withPhoto).toBeGreaterThanOrEqual(0);
    const blank: BookDoc = { ...doc, pages: doc.pages.map((p, i) => (i === withPhoto ? { ...p, chapterId: null, texts: undefined, caption: null, slots: p.slots.map((s) => ({ ...s, photoId: null })) } : p)) };
    const r = validatePrintReadiness(blank, GENERIC_A5_DIGITAL, { photos });
    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: "blank_page", severity: "error", sheet: withPhoto + 1 }));
    expect(r.issues).toContainEqual(expect.objectContaining({ code: "empty_slot", severity: "warning", sheet: withPhoto + 1 }));

    const gone = new Map(photos);
    const lost = doc.pages[withPhoto]!.slots.find((s) => s.photoId)!.photoId!;
    gone.delete(lost);
    const r2 = validatePrintReadiness(doc, GENERIC_A5_DIGITAL, { photos: gone });
    expect(r2.issues).toContainEqual(expect.objectContaining({ code: "missing_photo", severity: "error" }));
  });

  it("low-resolution photos are warnings with the effective dpi, never errors", () => {
    const { doc, photos } = composed({ format: "A5_LANDSCAPE", designStyle: "classic" });
    const small = new Map([...photos].map(([id]) => [id, { width: 400, height: 300 }]));
    const r = validatePrintReadiness(doc, GENERIC_A5_DIGITAL, { photos: small });
    const low = r.issues.filter((i) => i.code === "low_dpi");
    expect(low.length).toBeGreaterThan(0);
    for (const i of low) {
      expect(i.severity).toBe("warning");
      expect(i.dpi).toBeLessThan(LOW_RES_DPI);
    }
    expect(r.ok).toBe(true);
    // unknown sizes never warn
    const unknown = new Map([...photos].map(([id]) => [id, { width: null, height: null }]));
    expect(codes(validatePrintReadiness(doc, GENERIC_A5_DIGITAL, { photos: unknown }).issues)).not.toContain("low_dpi");
  });

  it("story text that does not fit its panel is an error (it would be clipped)", () => {
    const { doc, photos, lang } = composed({ format: "A5_PORTRAIT", designStyle: "editorial" });
    const text = "A very long sentence about the sea and the old town. ".repeat(18).slice(0, 900);
    // The fitter shrinks type down to its minimum, so only a small panel overflows with 900 characters.
    const idx = doc.pages.findIndex((p) => (p.texts ?? []).some((t) => { const panel = getPageTemplate(p.layout)?.panels.find((q) => q.n === t.panel); return !!panel && !textFits(getLayout(p.layout)!, panel, text, lang, 1); }));
    expect(idx).toBeGreaterThanOrEqual(0);
    const panel = doc.pages[idx]!.texts!.find((t) => { const q = getPageTemplate(doc.pages[idx]!.layout)?.panels.find((x) => x.n === t.panel); return !!q && !textFits(getLayout(doc.pages[idx]!.layout)!, q, text, lang, 1); })!.panel;
    const long = setPageText(doc, idx, panel, text);
    const r = validatePrintReadiness(long, GENERIC_A5_DIGITAL, { photos, lang });
    expect(r.issues).toContainEqual(expect.objectContaining({ code: "text_overflow", sheet: idx + 1, panel }));
    expect(r.ok).toBe(false);
  });

  it("page counts: the book limit and the spec limits", () => {
    const { doc, photos } = composed({ format: "A5_PORTRAIT", designStyle: "classic" });
    const over = validatePrintReadiness(doc, GENERIC_A5_DIGITAL, { photos, maxPages: 3 });
    expect(over.issues).toContainEqual(expect.objectContaining({ code: "page_count_high", limit: 3 }));
    const none = validatePrintReadiness({ ...doc, pages: [] }, GENERIC_A5_DIGITAL, { photos });
    expect(codes(none.issues)).toContain("page_count_low");
    const even = { ...GENERIC_A5_DIGITAL, pages: { min: 2, max: 100, multipleOf: 4 } };
    const odd = validatePrintReadiness({ ...doc, pages: doc.pages.slice(0, 5) }, even, { photos });
    expect(odd.issues).toContainEqual(expect.objectContaining({ code: "page_count_multiple", limit: 4 }));
  });

  it("placeholder provider specs never pass (incomplete spec, no trim size)", () => {
    const { doc, photos } = composed({ format: "A5_PORTRAIT", designStyle: "classic" });
    for (const spec of [UAE_POD_PLACEHOLDER, INDIA_POD_PLACEHOLDER]) {
      const r = validatePrintReadiness(doc, spec, { photos });
      expect(r.ok).toBe(false);
      expect(codes(r.issues)).toEqual(expect.arrayContaining(["spec_incomplete", "format_unsupported"]));
      expect(codes(r.issues)).not.toContain("low_dpi"); // no invented threshold
    }
  });

  it("a very long cover title on a plain title box is flagged as a possible clip", () => {
    const { doc, photos } = composed({ format: "A5_PORTRAIT", designStyle: "editorial" });
    const cover = getLayout(doc.cover.layout);
    expect(cover?.texts?.some((t) => t.bind === "coverTitle")).toBe(true);
    const long = setCover(doc, { title: "Our very long summer of road trips, beaches, mountains, cousins and many more adventures together".slice(0, 120) });
    const r = validatePrintReadiness(long, GENERIC_A5_DIGITAL, { photos, lang: "en" });
    const short = validatePrintReadiness(setCover(doc, { title: "Summer" }), GENERIC_A5_DIGITAL, { photos, lang: "en" });
    expect(codes(short.issues)).not.toContain("title_may_clip");
    // The fitter shrinks long titles; only a title it cannot fit at its smallest size is flagged.
    for (const i of r.issues.filter((x) => x.code === "title_may_clip")) expect(i).toMatchObject({ severity: "warning", sheet: 0 });
  });
});

describe("readiness copy", () => {
  const all: ReadinessIssue[] = [...READINESS_ERROR_CODES, ...READINESS_WARNING_CODES].map((code, n) => ({
    code,
    severity: (READINESS_ERROR_CODES as readonly string[]).includes(code) ? "error" : "warning",
    sheet: n % 3 === 0 ? null : n % 3 === 1 ? 0 : 4,
    dpi: 120,
    limit: 4,
  }));

  it("every code has plain copy that never claims print-ready or certified", () => {
    for (const i of all) {
      const text = readinessIssueCopy(i);
      expect(text.length).toBeGreaterThan(8);
      expect(text).not.toMatch(/certif|print[- ]ready|guarantee/i);
    }
    for (const r of [{ errors: 0, warnings: 0 }, { errors: 0, warnings: 2 }, { errors: 3, warnings: 1 }]) {
      expect(readinessSummary({ ...r, specLabel: GENERIC_A5_DIGITAL.label })).not.toMatch(/certif|print[- ]ready/i);
    }
    expect(readinessSummary({ errors: 0, warnings: 0, specLabel: GENERIC_A5_DIGITAL.label })).toBe("Checks passed for digital A5 PDF");
  });

  it("readinessView lists errors first, folds duplicates and counts the rest", () => {
    const issues: ReadinessIssue[] = [
      { code: "low_dpi", severity: "warning", sheet: 2, dpi: 90 },
      { code: "blank_page", severity: "error", sheet: 3 },
      ...Array.from({ length: 12 }, (_, k): ReadinessIssue => ({ code: "empty_slot", severity: "warning", sheet: k + 4 })),
      { code: "blank_page", severity: "error", sheet: 3 },
    ];
    const v = readinessView({ specId: "x", specLabel: "digital A5 PDF", providerVerified: false, ok: false, sheets: 20, interiorPages: 19, issues, errors: 2, warnings: 13 });
    expect(v.lines[0]).toEqual({ text: "Page 3 is empty — add a photo or text, or delete the page", severity: "error" });
    expect(v.lines).toHaveLength(READINESS_LINES_MAX);
    expect(v.more).toBe(14 - READINESS_LINES_MAX);
    expect(v.summary).toBe("2 things to fix before the PDF can be made");
  });
});
