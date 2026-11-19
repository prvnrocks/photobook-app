// validatePageLayout (Task 7): checks ONE composed (or user-edited) page against the storybook
// layout rules. Pure, deterministic, never throws. Errors are what must not reach print unflagged
// (overflowing text, an unsuitable crop, too few pixels for a full-bleed hero, a text outside the
// safe area, a framed / turned element running into the bleed, an empty slot, a template that is
// not approved for the book's style + format, duplicate element ids); warnings are worth showing.
//
// Context is optional piece by piece: without photo sizes the crop / DPI checks are skipped (the
// renderer then shows the photo as stored), without a language both EN and AR faces are not
// guessed — the text decides its face exactly like the renderer (roleFont on the text itself).

import type { BookDesign } from "@/lib/book/book-design";
import { pageMm } from "@/lib/book/format";
import { isQuarterTurn } from "@/lib/book/schema";
import { rotatedBoundsPct } from "@/lib/book/slot-geometry";
import type { BookPage } from "@/lib/book/types";
import { getLayout, SAFE_MM } from "@/lib/layouts";
import { getPageTemplate, MIN_DPI, TARGET_DPI } from "@/lib/layouts/templates";
import { CAPACITY_SLACK, cropLoss, CROP_REJECT, CROP_WARN, cutsSubject, photoShape, slotAspect, slotDpi, textFits } from "./select";
import type { ComposePhoto, LayoutErrorCode, LayoutIssue, LayoutWarningCode, PageLayoutReport } from "./types";

export type ValidatePageContext = {
  /** The book's format + design style: the template must be approved for it. Default = the layout's own. */
  design?: BookDesign;
  /** Photos by id (sizes, focus). Absent = crop / DPI / missing-photo checks are skipped. */
  photos?: ReadonlyMap<string, ComposePhoto>;
  /** The book's caption language (books.caption_lang). */
  lang?: "en" | "ar";
};

const MM_EPS = 0.01;

export function validatePageLayout(page: BookPage, ctx: ValidatePageContext = {}): PageLayoutReport {
  const errors: LayoutIssue<LayoutErrorCode>[] = [];
  const warnings: LayoutIssue<LayoutWarningCode>[] = [];
  const layout = getLayout(page.layout);
  const template = getPageTemplate(page.layout);
  const design = ctx.design ?? (layout ? { format: layout.format, designStyle: layout.style } : undefined);
  if (!layout || !template || !design || template.style !== design.designStyle || template.format !== design.format) {
    errors.push({ code: "template_not_approved" });
    if (!layout) return { ok: false, errors, warnings };
  }
  const lang = ctx.lang ?? "en";
  const pmm = pageMm(layout.format);

  // --- element ids ---------------------------------------------------------------------------------
  const ids = new Set<string>();
  for (const t of page.texts ?? []) {
    if (ids.has(t.id)) errors.push({ code: "duplicate_element_id", panel: t.panel });
    ids.add(t.id);
  }
  const placed = new Set<string>();
  page.slots.forEach((s, i) => {
    if (s.photoId === null) return;
    if (placed.has(s.photoId)) errors.push({ code: "duplicate_element_id", slot: i });
    placed.add(s.photoId);
  });

  // --- photos ----------------------------------------------------------------------------------------
  const rightHalf = layout.role === "spread" && page.side === "right";
  if (!rightHalf) {
    layout.slots.forEach((_, i) => {
      const s = page.slots[i];
      if (!s || s.photoId === null || (ctx.photos && !ctx.photos.has(s.photoId))) {
        errors.push({ code: "missing_photo", slot: i });
        return;
      }
      const p = ctx.photos?.get(s.photoId);
      if (!p) return;
      const shape = photoShape(p);
      if (shape.ratio === null) return;
      const pref = layout.prefers[i] ?? "any";
      if (pref !== "any" && shape.orient !== "square" && pref !== shape.orient) warnings.push({ code: "orientation_miss", slot: i });
      const aspect = slotAspect(layout, i);
      const loss = cropLoss(shape.ratio, aspect, s.crop.zoom);
      if (loss > CROP_REJECT) errors.push({ code: "crop_excessive", slot: i });
      else if (loss > CROP_WARN) warnings.push({ code: "crop_heavy", slot: i });
      if (p.focus && cutsSubject(shape.ratio, aspect, p.focus, s.crop, s.crop.zoom)) warnings.push({ code: "crop_subject", slot: i });
      const dpi = slotDpi(layout, i, p, s.crop.zoom);
      if (dpi !== null && dpi < MIN_DPI) {
        if (template?.fullBleed) errors.push({ code: "dpi_too_low", slot: i });
        else warnings.push({ code: "low_dpi", slot: i });
      } else if (dpi !== null && dpi < TARGET_DPI) warnings.push({ code: "dpi_below_target", slot: i });
    });
  }

  // --- safe area / bleed -----------------------------------------------------------------------------
  const inside = (b: { x0: number; y0: number; x1: number; y1: number }, margin: number) =>
    (b.x0 / 100) * pmm.w >= margin - MM_EPS && (b.y0 / 100) * pmm.h >= margin - MM_EPS && ((100 - b.x1) / 100) * pmm.w >= margin - MM_EPS && ((100 - b.y1) / 100) * pmm.h >= margin - MM_EPS;
  if (layout.role === "page") {
    for (const t of layout.texts ?? []) {
      const deg = isQuarterTurn(t.rotate) ? 0 : (t.rotate ?? 0);
      if (!inside(rotatedBoundsPct(t.box, deg, pmm), SAFE_MM)) errors.push({ code: "outside_safe_area", ...(t.bind === "pageText" ? { panel: t.n ?? 0 } : {}) });
    }
    if (layout.caption && !inside({ x0: layout.caption.x, y0: layout.caption.y, x1: layout.caption.x + layout.caption.w, y1: layout.caption.y + layout.caption.h }, SAFE_MM)) {
      errors.push({ code: "outside_safe_area", panel: -1 });
    }
    layout.slots.forEach((s, i) => {
      const framed = !!s.frame && s.frame.kind !== "none";
      if (!framed && !s.rotate) return; // plain slots may bleed (book/bleed.ts)
      if (!inside(rotatedBoundsPct(s, s.rotate ?? 0, pmm), SAFE_MM)) errors.push({ code: "inside_bleed", slot: i });
    });
    for (const d of layout.decorations ?? []) {
      if (!inside(rotatedBoundsPct(d.box, d.rotate ?? 0, pmm), 0)) errors.push({ code: "inside_bleed" });
    }
  }

  // --- texts -----------------------------------------------------------------------------------------
  const panels = new Map((template?.panels ?? []).map((p) => [p.n, p]));
  for (const t of page.texts ?? []) {
    const panel = panels.get(t.panel);
    if (!panel || t.panel < 0) {
      warnings.push({ code: "text_unplaced", panel: t.panel });
      continue;
    }
    if (!textFits(layout, panel, t.text, lang, 1)) errors.push({ code: "text_overflow", panel: t.panel, lang });
    else if (!textFits(layout, panel, t.text, lang, CAPACITY_SLACK)) warnings.push({ code: "text_tight", panel: t.panel, lang });
  }
  for (const p of panels.values()) {
    if (p.n === 0 && template?.family !== "chapter_opening" && !(page.texts ?? []).some((t) => t.panel === 0)) warnings.push({ code: "panel_empty", panel: 0 });
    if (p.n === 1 && !(page.texts ?? []).some((t) => t.panel === 1)) warnings.push({ code: "panel_empty", panel: 1 });
  }
  const cap = panels.get(-1);
  if (cap && page.caption && !rightHalf) {
    if (!textFits(layout, cap, page.caption.text, lang, 1)) errors.push({ code: "text_overflow", panel: -1, lang });
  }

  return { ok: errors.length === 0, errors, warnings };
}
