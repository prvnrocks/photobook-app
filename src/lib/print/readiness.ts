// validatePrintReadiness (Task 10): checks a book doc — the structured StorybookDocument the editor,
// viewer and PDF all render — against ONE PrintSpec before an export. Pure, deterministic, never
// throws; no DB, no DOM. Per-sheet issues (sheet 0 = cover, sheet i = doc.pages[i - 1]):
//
//   errors (the PDF is not made until they are fixed — the export route answers 422 not_ready)
//     spec_incomplete     the spec misses numbers for this format (placeholder provider)
//     format_unsupported  the spec has no trim size for the book's format
//     page_count_low / page_count_high / page_count_multiple   interior pages vs the spec / book limit
//     blank_page          a page would print with no photo and no text
//     missing_photo       a slot points at a photo that is gone / not uploaded (prints an empty hole)
//     text_overflow       a storybook text does not fit its panel (it would be clipped)
//     text_outside_safe   a layout text box reaches into the spec's safe margin
//   warnings (shown, never blocking — D-037: low resolution is the user's call)
//     low_dpi             effective resolution below spec.minEffectiveDpi (dpi value in `dpi`)
//     empty_slot          a photo slot left empty (prints the background there)
//     title_may_clip      the cover title is at the fitter's smallest size and may be cut
//     text_tight          a storybook text fills its panel to the last line
//
// The geometry comes from the same modules the renderer uses (layouts, resolution.ts, the storybook
// text fitter), so editor, viewer and PDF agree with what is checked here.

import type { BookDoc, BookFormat, BookPage, Layout } from "@/lib/book/types";
import { pageMm } from "@/lib/book/format";
import { effectiveDpi, layoutSlotMm } from "@/lib/book/resolution";
import { isQuarterTurn } from "@/lib/book/schema";
import { rotatedBoundsPct } from "@/lib/book/slot-geometry";
import { getLayout } from "@/lib/layouts";
import { getPageTemplate } from "@/lib/layouts/templates";
import { pagePhotoIds } from "@/lib/pdf/print-doc";
import { CAPACITY_SLACK, textFits } from "@/lib/storybook/compose/select";
import { isSpecComplete, type PrintSpec } from "./specs/types";

export const READINESS_ERROR_CODES = [
  "spec_incomplete",
  "format_unsupported",
  "page_count_low",
  "page_count_high",
  "page_count_multiple",
  "blank_page",
  "missing_photo",
  "text_overflow",
  "text_outside_safe",
] as const;
export const READINESS_WARNING_CODES = ["low_dpi", "empty_slot", "title_may_clip", "text_tight"] as const;
export type ReadinessErrorCode = (typeof READINESS_ERROR_CODES)[number];
export type ReadinessWarningCode = (typeof READINESS_WARNING_CODES)[number];
export type ReadinessCode = ReadinessErrorCode | ReadinessWarningCode;

export type ReadinessIssue = {
  code: ReadinessCode;
  severity: "error" | "warning";
  /** 0 = cover, i = doc.pages[i - 1]; null = whole book. */
  sheet: number | null;
  slot?: number;
  panel?: number;
  /** low_dpi: the effective dpi (rounded). */
  dpi?: number;
  /** page_count_*: the limit that was crossed. */
  limit?: number;
};

export type ReadinessPhoto = { width: number | null; height: number | null };

export type ReadinessContext = {
  /** Photos the export can use (ready, with an original): id → stored pixel size. */
  photos: ReadonlyMap<string, ReadinessPhoto>;
  /** books.caption_lang. */
  lang?: "en" | "ar";
  /** books.max_pages (also capped by the spec's page max). */
  maxPages?: number;
};

export type PrintReadinessReport = {
  specId: string;
  specLabel: string;
  /** Never true in this repo: no provider spec has been verified against a real provider. */
  providerVerified: boolean;
  /** No errors. */
  ok: boolean;
  /** Sheets the PDF will have (cover + interior pages). */
  sheets: number;
  interiorPages: number;
  issues: ReadinessIssue[];
  errors: number;
  warnings: number;
};

const MM_EPS = 0.01;

function issue(code: ReadinessCode, sheet: number | null, extra: Omit<ReadinessIssue, "code" | "severity" | "sheet"> = {}): ReadinessIssue {
  const severity = (READINESS_ERROR_CODES as readonly string[]).includes(code) ? "error" : "warning";
  return { code, severity, sheet, ...extra };
}

/** True when the box (in % of the page) keeps `margin` mm from every trim edge. */
function insideMargin(b: { x0: number; y0: number; x1: number; y1: number }, margin: number, format: BookFormat): boolean {
  const pmm = pageMm(format);
  return (
    (b.x0 / 100) * pmm.w >= margin - MM_EPS &&
    (b.y0 / 100) * pmm.h >= margin - MM_EPS &&
    ((100 - b.x1) / 100) * pmm.w >= margin - MM_EPS &&
    ((100 - b.y1) / 100) * pmm.h >= margin - MM_EPS
  );
}

/** Text boxes of a single-page / cover layout that leave the safe margin (spreads span two pages — their halves are covered by the layout tests). */
function safeAreaIssues(layout: Layout, margin: number, format: BookFormat, sheet: number): ReadinessIssue[] {
  if (layout.role === "spread") return [];
  const out: ReadinessIssue[] = [];
  const pmm = pageMm(format);
  for (const t of layout.texts ?? []) {
    const deg = isQuarterTurn(t.rotate) ? 0 : (t.rotate ?? 0);
    if (!insideMargin(rotatedBoundsPct(t.box, deg, pmm), margin, format)) {
      out.push(issue("text_outside_safe", sheet, t.bind === "pageText" ? { panel: t.n ?? 0 } : {}));
    }
  }
  const c = layout.caption;
  if (c && !insideMargin({ x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h }, margin, format)) {
    out.push(issue("text_outside_safe", sheet, { panel: -1 }));
  }
  return out;
}

function lowDpiIssues(
  layout: Layout,
  slots: readonly { photoId: string | null; crop?: { zoom: number } }[],
  format: BookFormat,
  ctx: ReadinessContext,
  minDpi: number,
  sheet: number,
): ReadinessIssue[] {
  const out: ReadinessIssue[] = [];
  layout.slots.forEach((_s, i) => {
    const id = slots[i]?.photoId;
    if (!id) return;
    const p = ctx.photos.get(id);
    if (!p) return;
    const mm = layoutSlotMm(layout.id, i, format);
    if (!mm) return;
    const dpi = effectiveDpi(p.width, p.height, mm.w, mm.h, slots[i]?.crop?.zoom ?? 1);
    if (dpi !== null && dpi < minDpi) out.push(issue("low_dpi", sheet, { slot: i, dpi: Math.round(dpi) }));
  });
  return out;
}

function hasText(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/** Bindings that print text from the doc on a page (chapter title / description come from doc.chapters). */
const CHAPTER_BINDINGS = new Set(["chapterTitle", "chapterDescription"]);

function pageIssues(doc: BookDoc, index: number, spec: PrintSpec, ctx: ReadinessContext, lang: "en" | "ar"): ReadinessIssue[] {
  const page: BookPage = doc.pages[index]!;
  const sheet = index + 1;
  const layout = getLayout(page.layout);
  if (!layout) return [issue("blank_page", sheet)];
  const out: ReadinessIssue[] = [];
  const rightHalf = layout.role === "spread" && page.side === "right";

  // Photos: missing ones are holes in the print; empty slots print the background.
  if (!rightHalf) {
    layout.slots.forEach((_s, i) => {
      const id = page.slots[i]?.photoId ?? null;
      if (id === null) out.push(issue("empty_slot", sheet, { slot: i }));
      else if (!ctx.photos.has(id)) out.push(issue("missing_photo", sheet, { slot: i }));
    });
    if (spec.minEffectiveDpi !== null) out.push(...lowDpiIssues(layout, page.slots, doc.format, ctx, spec.minEffectiveDpi, sheet));
  }

  // Blank: nothing printed but the background.
  const shown = pagePhotoIds(doc.pages, index).filter((id): id is string => id !== null && ctx.photos.has(id));
  const texts = (page.texts ?? []).some((t) => hasText(t.text));
  const chapter = page.chapterId ? doc.chapters.find((c) => c.id === page.chapterId) : undefined;
  const chapterText = !!chapter && hasText(chapter.title) && (layout.texts ?? []).some((t) => CHAPTER_BINDINGS.has(t.bind));
  if (shown.length === 0 && !texts && !hasText(page.caption?.text) && !chapterText) out.push(issue("blank_page", sheet));

  // Storybook texts: the same fitter the composer and the page-text tool use.
  const template = getPageTemplate(page.layout);
  if (template) {
    const panels = new Map(template.panels.map((p) => [p.n, p]));
    for (const t of page.texts ?? []) {
      const panel = panels.get(t.panel);
      if (!panel) continue;
      if (!textFits(layout, panel, t.text, lang, 1)) out.push(issue("text_overflow", sheet, { panel: t.panel }));
      else if (!textFits(layout, panel, t.text, lang, CAPACITY_SLACK)) out.push(issue("text_tight", sheet, { panel: t.panel }));
    }
    const cap = panels.get(-1);
    if (cap && page.caption && hasText(page.caption.text) && !rightHalf && !textFits(layout, cap, page.caption.text, lang, 1)) {
      out.push(issue("text_overflow", sheet, { panel: -1 }));
    }
  }

  if (spec.safeMarginMm !== null) out.push(...safeAreaIssues(layout, spec.safeMarginMm, doc.format, sheet));
  return out;
}

function coverIssues(doc: BookDoc, spec: PrintSpec, ctx: ReadinessContext, lang: "en" | "ar"): ReadinessIssue[] {
  const layout = getLayout(doc.cover.layout);
  if (!layout) return [];
  const out: ReadinessIssue[] = [];
  if (layout.slots.length > 0) {
    const id = doc.cover.photoId;
    if (id === null) out.push(issue("empty_slot", 0, { slot: 0 }));
    else if (!ctx.photos.has(id)) out.push(issue("missing_photo", 0, { slot: 0 }));
    else if (spec.minEffectiveDpi !== null) {
      out.push(...lowDpiIssues(layout, [{ photoId: id }], doc.format, ctx, spec.minEffectiveDpi, 0));
    }
  }
  // Title: plain boxes only (plates / quarter turns size differently); the fitter never truncates —
  // at its smallest size a long title can still run past the box.
  const title = layout.texts?.find((t) => t.bind === "coverTitle");
  if (title && !title.plate && !title.rotate && hasText(doc.cover.title)) {
    const fits = textFits(layout, { n: 0, rect: title.box, font: title.font }, doc.cover.title, lang, title.fit ?? 1);
    if (!fits) out.push(issue("title_may_clip", 0));
  }
  if (spec.safeMarginMm !== null) out.push(...safeAreaIssues(layout, spec.safeMarginMm, doc.format, 0));
  return out;
}

export function validatePrintReadiness(doc: BookDoc, spec: PrintSpec, ctx: ReadinessContext): PrintReadinessReport {
  const issues: ReadinessIssue[] = [];
  const lang = ctx.lang === "ar" ? "ar" : "en";
  const interior = doc.pages.length;

  if (spec.trim[doc.format] === null) issues.push(issue("format_unsupported", null));
  if (!isSpecComplete(spec, doc.format)) issues.push(issue("spec_incomplete", null));

  const min = spec.pages.min ?? 1;
  const caps = [spec.pages.max, ctx.maxPages].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  const max = caps.length > 0 ? Math.min(...caps) : null;
  if (interior < min) issues.push(issue("page_count_low", null, { limit: min }));
  if (max !== null && interior > max) issues.push(issue("page_count_high", null, { limit: max }));
  const multiple = spec.pages.multipleOf;
  if (multiple !== null && multiple > 1 && interior % multiple !== 0) issues.push(issue("page_count_multiple", null, { limit: multiple }));

  issues.push(...coverIssues(doc, spec, ctx, lang));
  for (let i = 0; i < interior; i++) issues.push(...pageIssues(doc, i, spec, ctx, lang));

  const errors = issues.filter((i) => i.severity === "error").length;
  return {
    specId: spec.id,
    specLabel: spec.label,
    providerVerified: spec.providerVerified,
    ok: errors === 0,
    sheets: interior + 1,
    interiorPages: interior,
    issues,
    errors,
    warnings: issues.length - errors,
  };
}
