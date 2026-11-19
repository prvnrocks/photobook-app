// Storybook page-template registry (Task 7, Balanced Storybook). Pure data queries over the layout
// catalogue — no layout maths in components, no I/O, deterministic.
//
// Five template families:
//   chapter_opening  title + date + chapter intro + the chapter's hero photo   (new: ./story open-*)
//   hero             one photo, optionally with a caption / pull quote          (existing 1-photo pages)
//   collage          2–6 photos of one moment, optionally with a caption        (existing 2–6 photo pages)
//   storytelling     1–3 photos + a paragraph, or a text page (+ pull quote)    (new: ./story tell-*)
//   closing          the closing reflection, alone or with one photo            (new: ./story close-*)
//
// Existing layouts are TAGGED, not copied: a single page layout of the style + format with 1–6
// photos that shows no chapter title or chapter description (chapter openings own the title;
// description panels would stay empty in a storybook) is a hero (1 photo) or collage (2–6) template.
// Where a style × format has no such layout for a photo count, ./story generates one
// (STORY_PHOTO_GAPS: hero-full, hero-cap, grid-2 … grid-6).
// Spreads are not templates (the composer never creates a spread).
//
// Every template declares, from its real geometry: photo count, the orientation each slot suits
// (layout.prefers), the pixels a photo needs per slot for 200 dpi at print size (bleed included),
// its text panels with the roles they take and a capacity in words for English and Arabic at the
// style's own fonts (the renderer's fitter, render.ts panelTextMetrics), and `narrativeShare` =
// text area / (text area + photo area) — the measure the 65 / 35 balance is computed from.
//
// APPROVED_TEMPLATE_IDS (per style → format → family) is the ONLY list the AI page-intent call may
// choose from; anything else it returns is ignored (src/lib/ai/story/compose-intent.ts).

import { printSlotSizeMm } from "@/lib/book/bleed";
import { pageMm } from "@/lib/book/format";
import { panelTextMetrics } from "@/lib/book/render";
import { BOOK_FORMATS, DESIGN_STYLES } from "@/lib/book/schema";
import type { BookFormat, DesignStyle, Layout, Orientation, PageTextRole, Rect } from "@/lib/book/types";
import { roleFont, type TextRole } from "@/lib/design/styles";
import { getLayout, LAYOUTS, STORY_LAYOUTS } from "./index";
import { layoutShowsDescription } from "./description";
import { isStoryLayoutId, type StoryTemplateKind } from "./story";

export const TEMPLATE_FAMILIES = ["chapter_opening", "hero", "collage", "storytelling", "closing"] as const;
export type TemplateFamily = (typeof TEMPLATE_FAMILIES)[number];

/** Print resolution the selector aims for; below it a photo gets a warning. */
export const TARGET_DPI = 200;
/** Below this a photo is refused for a full-bleed hero (and only warned elsewhere) — book/resolution LOW_RES_DPI. */
export const MIN_DPI = 150;
/** Most photos a template may hold (STORY_LIMITS.photosPerPage). */
export const TEMPLATE_MAX_PHOTOS = 6;

export interface TemplatePanel {
  /** pageText panel number (`n`), or -1 for the layout's caption area. */
  n: number;
  /** Page text roles this panel takes. */
  roles: readonly PageTextRole[];
  /** % of the page. */
  rect: Rect;
  font: TextRole;
}

export interface PageTemplate {
  id: string;
  family: TemplateFamily;
  style: DesignStyle;
  format: BookFormat;
  photoCount: number;
  /** Per slot: the photo orientation it suits ("any" = both). */
  orientations: readonly Orientation[];
  /** Per slot: pixels a photo needs for TARGET_DPI at print size (bleed included). */
  minPhotoPx: readonly { w: number; h: number }[];
  /** pageText panels (n ≥ 0), then the caption area (n = -1) when the layout has one. */
  panels: readonly TemplatePanel[];
  /** The page shows the chapter title + date (chapter openings). */
  chapterTitle: boolean;
  /** Text area / (text area + photo area), from the layout geometry. */
  narrativeShare: number;
  /** One photo covering ≥ 60 % of the page: refused below MIN_DPI. */
  fullBleed: boolean;
  /** A Task 7 layout (./story) rather than a tagged existing one. */
  isNew: boolean;
  /** The small framed hero: the low-resolution fallback (chosen only when a bigger slot is refused). */
  fallback: boolean;
}

const MAIN_ROLES: readonly PageTextRole[] = ["intro", "paragraph", "closing"];
const QUOTE_ROLES: readonly PageTextRole[] = ["pull_quote", "caption"];

const round4 = (n: number) => Math.round(n * 10000) / 10000;
/** A rect clipped to the page (spread / bleed-free), its area in %². */
const clippedArea = (r: Rect) => Math.max(0, Math.min(100, r.x + r.w) - Math.max(0, r.x)) * Math.max(0, Math.min(100, r.y + r.h) - Math.max(0, r.y));

function storyKindOf(id: string): StoryTemplateKind | null {
  const m = /^st-[a-z]+-[pl]-(.+)$/.exec(id);
  return m ? (m[1] as StoryTemplateKind) : null;
}

/** The family of a layout as a storybook template, or null when it is not one. */
export function templateFamilyOf(layout: Layout): TemplateFamily | null {
  if (layout.role !== "page") return null;
  if (isStoryLayoutId(layout.id)) {
    const kind = storyKindOf(layout.id);
    if (!kind) return null;
    if (kind === "hero-small") return "hero";
    if (kind.startsWith("open")) return "chapter_opening";
    if (kind.startsWith("tell")) return "storytelling";
    if (kind.startsWith("close")) return "closing";
    return kind.startsWith("hero") ? "hero" : "collage";
  }
  if (layout.photoCount < 1 || layout.photoCount > TEMPLATE_MAX_PHOTOS) return null;
  if (layoutShowsDescription(layout)) return null;
  // A chapter title belongs on the chapter opening only (a date strip is part of a style's look).
  if (layout.texts?.some((t) => t.bind === "chapterTitle")) return null;
  return layout.photoCount === 1 ? "hero" : "collage";
}

/** Text panels a story page uses, in panel order: pageText panels, then the caption area. */
function panelsOf(layout: Layout): TemplatePanel[] {
  const out: TemplatePanel[] = [];
  for (const t of layout.texts ?? []) {
    if (t.bind !== "pageText") continue;
    const n = t.n ?? 0;
    out.push({ n, roles: n === 0 ? MAIN_ROLES : QUOTE_ROLES, rect: t.box, font: t.font });
  }
  out.sort((a, b) => a.n - b.n);
  if (layout.caption) {
    const panel = layout.texts?.find((t) => t.bind === "pageCaption");
    out.push({ n: -1, roles: QUOTE_ROLES, rect: layout.caption, font: panel?.font ?? "caption" });
  }
  return out;
}

/** Geometric narrative share of a layout: text boxes (pageText, caption, chapter title, date) vs photo slots. */
export function layoutNarrativeShare(layout: Layout, shown?: (bind: string, n: number) => boolean): number {
  let text = 0;
  for (const t of layout.texts ?? []) {
    if (t.bind === "pageCaption" || t.bind === "chapterDescription") continue;
    if (t.bind !== "pageText" && t.bind !== "chapterTitle" && t.bind !== "dateLabel") continue;
    if (shown && !shown(t.bind, t.n ?? 0)) continue;
    text += clippedArea(t.box);
  }
  if (layout.caption && (!shown || shown("pageCaption", 0))) text += clippedArea(layout.caption);
  const photos = layout.slots.reduce((s, r) => s + clippedArea(r), 0);
  return text + photos > 0 ? round4(text / (text + photos)) : 0;
}

function buildTemplate(layout: Layout, family: TemplateFamily): PageTemplate {
  const minPhotoPx = layout.slots.map((_, i) => {
    const mm = printSlotSizeMm(layout, i, layout.format) ?? { w: 0, h: 0 };
    return { w: Math.ceil((mm.w / 25.4) * TARGET_DPI), h: Math.ceil((mm.h / 25.4) * TARGET_DPI) };
  });
  // A hero whose one photo covers ≥ 60 % of the page prints large: refused below MIN_DPI.
  const fullBleed = layout.photoCount === 1 && !!layout.slots[0] && clippedArea(layout.slots[0]) >= 6000;
  return {
    id: layout.id,
    family,
    style: layout.style,
    format: layout.format,
    photoCount: layout.photoCount,
    orientations: layout.slots.map((_, i) => layout.prefers[i] ?? "any"),
    minPhotoPx,
    panels: panelsOf(layout),
    chapterTitle: !!layout.texts?.some((t) => t.bind === "chapterTitle"),
    narrativeShare: layoutNarrativeShare(layout),
    fullBleed,
    isNew: isStoryLayoutId(layout.id),
    fallback: storyKindOf(layout.id) === "hero-small",
  };
}

let registry: { all: PageTemplate[]; byId: Map<string, PageTemplate> } | null = null;

function build() {
  if (registry) return registry;
  const all: PageTemplate[] = [];
  for (const layout of [...LAYOUTS, ...STORY_LAYOUTS]) {
    const family = templateFamilyOf(layout);
    if (family) all.push(buildTemplate(layout, family));
  }
  registry = { all, byId: new Map(all.map((t) => [t.id, t])) };
  return registry;
}

/** Every storybook template, catalogue order (existing layouts first, then the story layouts). */
export function pageTemplates(): readonly PageTemplate[] {
  return build().all;
}

export function getPageTemplate(id: string): PageTemplate | undefined {
  return build().byId.get(id);
}

/** Templates of one style + format (+ family), catalogue order. */
export function templatesFor(style: DesignStyle, format: BookFormat, family?: TemplateFamily): readonly PageTemplate[] {
  return build().all.filter((t) => t.style === style && t.format === format && (family === undefined || t.family === family));
}

export type ApprovedTemplateIds = Readonly<Record<DesignStyle, Readonly<Record<BookFormat, Readonly<Record<TemplateFamily, readonly string[]>>>>>>;

let approved: ApprovedTemplateIds | null = null;

/**
 * The approved template ids per design style → format → family: the only ids the AI page-intent
 * call may pick. Built from the registry (catalogue order), frozen.
 */
export function approvedTemplateIds(): ApprovedTemplateIds {
  if (approved) return approved;
  const out = {} as Record<DesignStyle, Record<BookFormat, Record<TemplateFamily, string[]>>>;
  for (const style of DESIGN_STYLES) {
    out[style] = {} as Record<BookFormat, Record<TemplateFamily, string[]>>;
    for (const format of BOOK_FORMATS) {
      out[style][format] = Object.fromEntries(TEMPLATE_FAMILIES.map((f) => [f, templatesFor(style, format, f).map((t) => t.id)])) as Record<TemplateFamily, string[]>;
    }
  }
  approved = deepFreeze(out);
  return approved;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** True when `id` is an approved template of that style, format (and family). */
export function isApprovedTemplate(id: string, style: DesignStyle, format: BookFormat, family?: TemplateFamily): boolean {
  const t = getPageTemplate(id);
  return !!t && t.style === style && t.format === format && (family === undefined || t.family === family);
}

// --- text capacity ---------------------------------------------------------------------------------

/** Synthetic words used to state a capacity in words (average word lengths: EN 5, AR 4 letters). */
const SAMPLE_WORD = { en: "words", ar: "كلمة" } as const;
const capacityCache = new Map<string, number>();

/**
 * How many words of average length fit `panel` of `template` in `lang` at the style's font
 * (render.ts panelTextMetrics, the renderer's own fitter) with `slack` of the box height
 * (default 1 = exactly fits; the selector uses CAPACITY_SLACK). Memoised.
 */
export function panelCapacityWords(template: Pick<PageTemplate, "id" | "style" | "format">, panel: Pick<TemplatePanel, "n" | "rect" | "font">, lang: "en" | "ar", slack = 1): number {
  const key = `${template.id}:${panel.n}:${lang}:${slack}`;
  const hit = capacityCache.get(key);
  if (hit !== undefined) return hit;
  const page = pageMm(template.format);
  const wMm = (panel.rect.w / 100) * page.w;
  const hMm = (panel.rect.h / 100) * page.h;
  const sample = (n: number) => Array.from({ length: n }, () => SAMPLE_WORD[lang]).join(" ");
  const fits = (n: number) => {
    const text = sample(n);
    const f = roleFont(template.style, panel.font, text, { captionLang: lang });
    return panelTextMetrics(text, panel.font, wMm, hMm, f, template.style, slack).fits;
  };
  let lo = 0;
  let hi = 600;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  capacityCache.set(key, lo);
  return lo;
}

/** Capacity in words (EN / AR) of every text panel of a template. */
export function templateCapacity(id: string, slack = 1): { n: number; roles: readonly PageTextRole[]; en: number; ar: number }[] {
  const t = getPageTemplate(id);
  if (!t) return [];
  return t.panels.map((p) => ({ n: p.n, roles: p.roles, en: panelCapacityWords(t, p, "en", slack), ar: panelCapacityWords(t, p, "ar", slack) }));
}

/** The layout of a template (always defined for a registry id). */
export function templateLayout(id: string): Layout | undefined {
  return getPageTemplate(id) ? getLayout(id) : undefined;
}
