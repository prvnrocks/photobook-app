// selectPageTemplate (Task 7): the best APPROVED template for one page. Pure and deterministic —
// the same intent, photos and text always give the same template, slot order and crops.
//
// Hard rules (a template that breaks one is not chosen):
//   - photo count = the template's slot count;
//   - every text has a panel that takes its role (main text → pageText panel 0; pull quote /
//     caption → panel 1, else the caption area when ≤ 200 units); a pageText panel never stays
//     empty (a chapter opening may have no intro);
//   - every text fits its panel with an 8 % height margin (CAPACITY_SLACK), measured with the
//     renderer's own fitter at the style's fonts (EN / AR alike);
//   - crop: a slot never shows less than 55 % of its photo (CROP_REJECT 0.45 — a 3:2 photo in a
//     2:3 slot loses 56 %, i.e. the subject is usually gone; 4:3 in a square loses 25 %, 16:9 in
//     4:3 loses 25 %, both fine), and with a known focus point the subject never sits outside the
//     visible window or within 4 % of its edge;
//   - print resolution: below MIN_DPI (150) a photo is refused for a full-bleed hero (the next
//     template with smaller slots wins); elsewhere it is a warning, like the editor's badge;
//   - not in `avoid` (previous page / previous chapter opening).
// `relax` turns crop / DPI / subject refusals into warnings (last resort).
//
// Soft score (lower wins; ties keep registry order): orientation misses ×2, crop loss ×4, DPI below
// 200 +1 (below 150 +3), a hero photo not in the largest slot +1, a weak photo (quality < 40) in a
// slot over half the page +1, distance to the planned narrative share ×3, emphasis (photo / text)
// ×2, reuse within the last REPEAT_WINDOW pages +6 / distance, the AI's approved choice −3.

import type { BookDesign } from "@/lib/book/book-design";
import { printSlotSizeMm } from "@/lib/book/bleed";
import { pageMm } from "@/lib/book/format";
import { panelTextMetrics } from "@/lib/book/render";
import { effectiveDpi } from "@/lib/book/resolution";
import { photoRectOf } from "@/lib/book/slot-geometry";
import type { Layout, PageTextRole } from "@/lib/book/types";
import { roleFont, type TextRole } from "@/lib/design/styles";
import { getLayout } from "@/lib/layouts";
import { slotFit } from "@/lib/layouts/fit";
import { MIN_DPI, TARGET_DPI, templatesFor, type PageTemplate, type TemplatePanel } from "@/lib/layouts/templates";
import type { ComposePhoto, ComposeText, PageIntent, SelectResult, SelectWarning, SlotAssignment, TemplateContent, TextAssignment } from "./types";

export const CROP_REJECT = 0.45;
export const CROP_WARN = 0.3;
/** The focus point must stay at least this far (share of the window) inside the visible window. */
export const SUBJECT_EDGE = 0.04;
/** Text must fit within this share of its panel's height when a template is chosen. */
export const CAPACITY_SLACK = 0.92;
/** Pages back a template reuse is penalised (the hard rule is: never the previous page's). */
export const REPEAT_WINDOW = 3;
/** Page captions hold at most this many UTF-16 units (CaptionSchema). */
export const CAPTION_MAX_UNITS = 200;
/** Fixed caption size on the page: CAPTION_FONT_SIZE_CQW 2.6 % of a 148 mm wide page (same mm on landscape). */
export const CAPTION_SIZE_MM = 3.848;

const MAIN: readonly PageTextRole[] = ["intro", "paragraph", "closing"];
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export type PhotoShape = { orient: "portrait" | "landscape" | "square"; ratio: number | null };

export function photoShape(p: Pick<ComposePhoto, "width" | "height">): PhotoShape {
  const w = p.width ?? 0;
  const h = p.height ?? 0;
  if (!(w > 0 && h > 0)) return { orient: "square", ratio: null };
  const ratio = w / h;
  return { orient: ratio > 1.1 ? "landscape" : ratio < 1 / 1.1 ? "portrait" : "square", ratio };
}

/** Visible aspect (w/h, mm) of slot `i`: the shape's inertia rectangle, the photo rect of a frame. */
export function slotAspect(layout: Layout, i: number): number {
  const f = slotFit(layout, i, layout.format);
  if (f) return f.aspect;
  const r = photoRectOf(layout, i, layout.format) ?? layout.slots[i]!;
  const page = pageMm(layout.format);
  return ((r.w / 100) * page.w) / Math.max(1e-9, (r.h / 100) * page.h);
}

/** Share of the photo hidden by a cover-fit crop at `zoom` (0 = nothing cut). */
export function cropLoss(photoRatio: number, slotRatio: number, zoom = 1): number {
  const visible = Math.min(photoRatio, slotRatio) / Math.max(photoRatio, slotRatio);
  return r4(1 - visible / (zoom * zoom));
}

/**
 * True when a known focus point ends up outside the visible window, or within SUBJECT_EDGE of an
 * edge the crop cut (the photo's own edges don't count), for a cover-fit crop centred on `center`
 * (the stored crop focal point) at `zoom`. A crop centred on the focus never cuts it at zoom 1 —
 * this catches user crops and zooms (validatePageLayout).
 */
export function cutsSubject(photoRatio: number, slotRatio: number, focus: { x: number; y: number }, center: { x: number; y: number } = focus, zoom = 1): boolean {
  const ww = (photoRatio > slotRatio ? slotRatio / photoRatio : 1) / zoom;
  const wh = (photoRatio > slotRatio ? 1 : photoRatio / slotRatio) / zoom;
  const x0 = Math.min(Math.max(center.x - ww / 2, 0), 1 - ww);
  const y0 = Math.min(Math.max(center.y - wh / 2, 0), 1 - wh);
  const u = (focus.x - x0) / ww;
  const v = (focus.y - y0) / wh;
  // Near an edge the crop made (not the photo's own edge): the subject is cut there.
  const e = 1e-9;
  return (u < SUBJECT_EDGE && x0 > e) || (u > 1 - SUBJECT_EDGE && x0 + ww < 1 - e) || (v < SUBJECT_EDGE && y0 > e) || (v > 1 - SUBJECT_EDGE && y0 + wh < 1 - e) || u < 0 || u > 1 || v < 0 || v > 1;
}

/** Effective print dpi of `photo` in slot `i` of `layout` (bleed included); null when unknown. */
export function slotDpi(layout: Layout, i: number, photo: Pick<ComposePhoto, "width" | "height">, zoom = 1): number | null {
  const mm = printSlotSizeMm(layout, i, layout.format);
  if (!mm) return null;
  return effectiveDpi(photo.width, photo.height, mm.w, mm.h, zoom);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The crop the composer stores for a photo: its focus point (else the centre), zoom 1. */
export function cropFor(p: Pick<ComposePhoto, "focus">): SlotAssignment["crop"] {
  return p.focus ? { x: r4(clamp01(p.focus.x)), y: r4(clamp01(p.focus.y)), zoom: 1 } : { x: 0.5, y: 0.5, zoom: 1 };
}

type SlotEval = { cost: number; reject: "crop" | "low_dpi" | null; warnings: SelectWarning[] };

function evalSlot(t: PageTemplate, layout: Layout, i: number, p: ComposePhoto, relax: boolean): SlotEval {
  const shape = photoShape(p);
  const warnings: SelectWarning[] = [];
  let cost = 0;
  let reject: SlotEval["reject"] = null;
  const pref = t.orientations[i] ?? "any";
  if (pref !== "any" && shape.orient !== "square" && pref !== shape.orient) {
    cost += 2;
    warnings.push("orientation_miss");
  }
  if (shape.ratio !== null) {
    const s = slotAspect(layout, i);
    const loss = cropLoss(shape.ratio, s);
    cost += 4 * loss;
    if (loss > CROP_REJECT) {
      if (relax) warnings.push("crop_heavy");
      else reject = "crop";
    } else if (loss > CROP_WARN) warnings.push("crop_heavy");
    if (p.focus && cutsSubject(shape.ratio, s, p.focus)) {
      cost += 2;
      if (relax) warnings.push("crop_subject");
      else reject ??= "crop";
    }
    const dpi = slotDpi(layout, i, p);
    if (dpi !== null && dpi < MIN_DPI) {
      cost += t.fullBleed ? 6 : 3;
      if (t.fullBleed && !relax) reject ??= "low_dpi";
      else warnings.push("low_dpi");
    } else if (dpi !== null && dpi < TARGET_DPI) {
      cost += 1;
      warnings.push("dpi_below_target");
    }
  }
  const slot = layout.slots[i]!;
  const areaShare = (slot.w * slot.h) / 10000;
  if (p.role === "hero" && t.photoCount > 1 && layout.slots.some((s) => s.w * s.h > slot.w * slot.h + 1e-6)) cost += 1;
  if (typeof p.quality === "number" && p.quality < 40 && areaShare > 0.5) cost += 1;
  return { cost, reject, warnings };
}

function* permutations(n: number): Generator<number[]> {
  const a = Array.from({ length: n }, (_, i) => i);
  yield a.slice();
  // Heap's algorithm, iterative — deterministic order, identity first.
  const c = new Array<number>(n).fill(0);
  let i = 1;
  while (i < n) {
    if (c[i]! < i) {
      const j = i % 2 === 0 ? 0 : c[i]!;
      [a[j], a[i]] = [a[i]!, a[j]!];
      yield a.slice();
      c[i]! += 1;
      i = 1;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

type Assignment = { order: number[]; cost: number; reject: SlotEval["reject"]; warnings: SelectWarning[] };

/** Best photo → slot assignment (slot i gets photos[order[i]]). Photos keep their order on ties. */
function assignPhotos(t: PageTemplate, layout: Layout, photos: readonly ComposePhoto[], relax: boolean): Assignment {
  const n = photos.length;
  const evals = Array.from({ length: n }, (_, i) => photos.map((p) => evalSlot(t, layout, i, p, relax)));
  let best: Assignment | null = null;
  for (const order of permutations(n)) {
    let cost = 0;
    let reject: SlotEval["reject"] = null;
    for (let i = 0; i < n; i++) {
      const e = evals[i]![order[i]!]!;
      cost += e.cost;
      reject ??= e.reject;
    }
    const better = !best || (best.reject !== null && reject === null) || ((best.reject === null) === (reject === null) && cost < best.cost - 1e-9);
    if (better) best = { order, cost, reject, warnings: [] };
  }
  if (!best) return { order: [], cost: 0, reject: null, warnings: [] };
  const warnings = new Set<SelectWarning>();
  best.order.forEach((pi, si) => evals[si]![pi]!.warnings.forEach((w) => warnings.add(w)));
  return { ...best, warnings: [...warnings] };
}

/** Does `text` fit `panel` of `t` (caption areas at the fixed caption size)? */
export function textFits(t: Pick<PageTemplate, "style" | "format">, panel: Pick<TemplatePanel, "n" | "rect" | "font" | "size">, text: string, lang: "en" | "ar", slack = CAPACITY_SLACK): boolean {
  const page = pageMm(t.format);
  const wMm = (panel.rect.w / 100) * page.w;
  const hMm = (panel.rect.h / 100) * page.h;
  const font: TextRole = panel.font;
  const f = roleFont(t.style, font, text, { captionLang: lang });
  return panelTextMetrics(text, font, wMm, hMm, f, t.style, slack, panel.n === -1 ? CAPTION_SIZE_MM : undefined, panel.size).fits;
}

type TextPlan = { ok: true; texts: TextAssignment[] } | { ok: false; reason: "text_unplaced" | "text_overflow"; detail: string };

/** Panels for every text of `content` on template `t` (see the header rules). */
export function placeTexts(t: PageTemplate, content: TemplateContent, lang: "en" | "ar", slack = CAPACITY_SLACK): TextPlan {
  const mains = content.texts.filter((x) => MAIN.includes(x.role));
  const quotes = content.texts.filter((x) => !MAIN.includes(x.role));
  const main = t.panels.find((p) => p.n === 0);
  const quote = t.panels.find((p) => p.n === 1);
  const caption = t.panels.find((p) => p.n === -1);
  if (mains.length > 1 || quotes.length > 1) return { ok: false, reason: "text_unplaced", detail: "too_many_texts" };
  const out: TextAssignment[] = [];
  const placed: [ComposeText, TemplatePanel][] = [];
  if (mains[0]) {
    if (!main || !main.roles.includes(mains[0].role)) return { ok: false, reason: "text_unplaced", detail: mains[0].role };
    placed.push([mains[0], main]);
  } else if (main && t.family !== "chapter_opening") return { ok: false, reason: "text_unplaced", detail: "empty_main_panel" };
  if (quotes[0]) {
    const q = quotes[0];
    const target = quote && quote.roles.includes(q.role) ? quote : caption && caption.roles.includes(q.role) && q.text.length <= CAPTION_MAX_UNITS ? caption : undefined;
    if (!target) return { ok: false, reason: "text_unplaced", detail: q.role };
    placed.push([q, target]);
  } else if (quote) return { ok: false, reason: "text_unplaced", detail: "empty_quote_panel" };
  for (const [x, panel] of placed) {
    if (!textFits(t, panel, x.text, lang, slack)) return { ok: false, reason: "text_overflow", detail: `panel_${panel.n < 0 ? "caption" : panel.n}` };
    out.push({ key: x.key, panel: panel.n });
  }
  return { ok: true, texts: out };
}

/** Candidate templates of an intent (style + format + family, the right photo count). */
export function candidatesFor(design: BookDesign, family: PageIntent["family"], photoCount: number): readonly PageTemplate[] {
  return templatesFor(design.designStyle, design.format, family).filter((t) => t.photoCount === photoCount);
}

/**
 * The best approved template for a page, a photo → slot assignment (with crops at the photos'
 * focus points) and a panel for every text — or a reasoned "no fit" (the most telling reason over
 * all candidates: photo_count > text_unplaced > text_overflow > low_dpi > crop > repeat).
 */
export function selectPageTemplate(intent: PageIntent, photos: readonly ComposePhoto[], content: TemplateContent): SelectResult {
  const all = templatesFor(intent.design.designStyle, intent.design.format, intent.family);
  if (all.length === 0) return { ok: false, reason: "no_template", detail: intent.family, tried: 0 };
  const sized = all.filter((t) => t.photoCount === photos.length);
  if (sized.length === 0) return { ok: false, reason: "photo_count", detail: String(photos.length), tried: all.length };

  const avoid = new Set(intent.avoid ?? []);
  const recent = intent.recent ?? [];
  const rank = { repeat: 1, crop: 2, low_dpi: 3, text_overflow: 4, text_unplaced: 5 } as const;
  let worst: { reason: keyof typeof rank; detail: string } | null = null;
  const fail = (reason: keyof typeof rank, detail: string) => {
    if (!worst || rank[reason] > rank[worst.reason]) worst = { reason, detail };
  };

  let best: { t: PageTemplate; score: number; a: Assignment; texts: TextAssignment[] } | null = null;
  for (const t of sized) {
    const layout = getLayout(t.id);
    if (!layout) continue;
    const text = placeTexts(t, content, intent.lang, intent.fitSlack ?? CAPACITY_SLACK);
    if (!text.ok) {
      fail(text.reason, text.detail);
      continue;
    }
    const a = assignPhotos(t, layout, photos, !!intent.relax);
    if (a.reject) {
      fail(a.reject, t.id);
      continue;
    }
    if (avoid.has(t.id)) {
      fail("repeat", t.id);
      continue;
    }
    // the small framed hero only wins when the bigger heroes are refused (low resolution)
    let score = a.cost + (t.fallback ? 2.5 : 0);
    if (intent.targetShare !== undefined) score += 3 * Math.abs(t.narrativeShare - intent.targetShare);
    if (intent.emphasis === "photo") score += 2 * t.narrativeShare;
    if (intent.emphasis === "text" && t.panels.length > 0) score += 2 * (1 - t.narrativeShare);
    for (let k = 1; k <= REPEAT_WINDOW; k++) if (recent[recent.length - k] === t.id) score += 6 / k;
    if (intent.preferredTemplateId === t.id) score -= 3;
    if (!best || score < best.score - 1e-9) best = { t, score, a, texts: text.texts };
  }
  if (!best) {
    const w = worst as { reason: keyof typeof rank; detail: string } | null;
    return { ok: false, reason: w?.reason ?? "no_template", detail: w?.detail ?? "", tried: sized.length };
  }
  const warnings = new Set<SelectWarning>(best.a.warnings);
  for (let k = 1; k <= REPEAT_WINDOW; k++) if (recent[recent.length - k] === best.t.id) warnings.add("repeat_recent");
  if (intent.preferredTemplateId && intent.preferredTemplateId !== best.t.id) warnings.add("preferred_ignored");
  const slots = best.a.order.map((pi) => ({ photoId: photos[pi]!.id, crop: cropFor(photos[pi]!) }));
  return { ok: true, templateId: best.t.id, slots, texts: best.texts, score: r4(best.score), warnings: [...warnings] };
}
