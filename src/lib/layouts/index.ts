// Layout catalogue — pure data (slots as % of an A5 portrait page, 148×210 mm).
// Used by <BookPage>, the rule-based autolayout and the Storyteller's layout catalogue.
// Order is stable: the AI prompt catalogue is built from it (prompt caching).

import type { Layout, LayoutRole } from "@/lib/book/types";
import { cover } from "./cover";
import { fourGrid } from "./four-grid";
import { fullPage } from "./full-page";
import { onePortrait } from "./one-portrait";
import { threeMixed } from "./three-mixed";
import { twoHorizontal } from "./two-horizontal";
import { twoVertical } from "./two-vertical";
import { CLASSIC_LANDSCAPE_LAYOUTS } from "./classic/landscape";
import { MODERN_LANDSCAPE_LAYOUTS } from "./modern/landscape";
import { MODERN_PORTRAIT_LAYOUTS } from "./modern/portrait";
import { GEOMETRIC_LANDSCAPE_LAYOUTS } from "./geometric/landscape";
import { GEOMETRIC_PORTRAIT_LAYOUTS } from "./geometric/portrait";
import { SCRAPBOOK_LANDSCAPE_LAYOUTS } from "./scrapbook/landscape";
import { SCRAPBOOK_PORTRAIT_LAYOUTS } from "./scrapbook/portrait";
import { CLASSIC_PORTRAIT_COVERS } from "./classic/portrait/covers-m29";
import { CLASSIC_LANDSCAPE_COVERS } from "./classic/landscape/covers-m29";
import { MODERN_PORTRAIT_COVERS } from "./modern/portrait/covers-m29";
import { MODERN_LANDSCAPE_COVERS } from "./modern/landscape/covers-m29";
import { GEOMETRIC_PORTRAIT_COVERS } from "./geometric/portrait/covers-m29";
import { GEOMETRIC_LANDSCAPE_COVERS } from "./geometric/landscape/covers-m29";
import { SCRAPBOOK_PORTRAIT_COVERS } from "./scrapbook/portrait/covers-m29";
import { SCRAPBOOK_LANDSCAPE_COVERS } from "./scrapbook/landscape/covers-m29";
import { MAGAZINE_PORTRAIT_COVERS, MAGAZINE_PORTRAIT_LAYOUTS } from "./magazine/portrait";
import { MAGAZINE_LANDSCAPE_COVERS, MAGAZINE_LANDSCAPE_LAYOUTS } from "./magazine/landscape";
import { EDITORIAL_PORTRAIT_COVERS, EDITORIAL_PORTRAIT_LAYOUTS } from "./editorial/portrait";
import { EDITORIAL_LANDSCAPE_COVERS, EDITORIAL_LANDSCAPE_LAYOUTS } from "./editorial/landscape";
import { STORY_LAYOUTS } from "./story";

/** The M1–M10a catalogue: classic A5 portrait. Order and geometry frozen (goldens, AI prompt cache). */
export const CLASSIC_PORTRAIT_LAYOUTS: readonly Layout[] = [
  cover,
  fullPage,
  onePortrait,
  twoVertical,
  twoHorizontal,
  threeMixed,
  fourGrid,
];

/**
 * M29 cover styles (D-080), every format and style, in catalogue order. All `autoPick: false`:
 * chosen only by the user (editor "Cover style" tool), never by bestCoverLayout or the AI.
 */
export const M29_COVERS: readonly Layout[] = [
  ...CLASSIC_PORTRAIT_COVERS,
  ...CLASSIC_LANDSCAPE_COVERS,
  ...MODERN_PORTRAIT_COVERS,
  ...MODERN_LANDSCAPE_COVERS,
  ...GEOMETRIC_PORTRAIT_COVERS,
  ...GEOMETRIC_LANDSCAPE_COVERS,
  ...SCRAPBOOK_PORTRAIT_COVERS,
  ...SCRAPBOOK_LANDSCAPE_COVERS,
];

/**
 * M30 (D-090): the magazine + editorial catalogues, appended after everything above. Each
 * style/format directory exports its layouts (auto cover, pages, spreads) and its user-chosen cover
 * styles (autoPick: false); all layouts of the four directories first, then all cover styles.
 */
/** The user-chosen M30 cover styles (autoPick: false), like M29_COVERS. */
export const M30_COVERS: readonly Layout[] = [
  ...MAGAZINE_PORTRAIT_COVERS,
  ...MAGAZINE_LANDSCAPE_COVERS,
  ...EDITORIAL_PORTRAIT_COVERS,
  ...EDITORIAL_LANDSCAPE_COVERS,
];

export const M30_LAYOUTS: readonly Layout[] = [
  ...MAGAZINE_PORTRAIT_LAYOUTS,
  ...MAGAZINE_LANDSCAPE_LAYOUTS,
  ...EDITORIAL_PORTRAIT_LAYOUTS,
  ...EDITORIAL_LANDSCAPE_LAYOUTS,
  ...M30_COVERS,
];

/** Every layout of every format and style (M10b). Format/style-aware code uses layoutsFor() in lib/book/spreads. */
export const LAYOUTS: readonly Layout[] = [
  ...CLASSIC_PORTRAIT_LAYOUTS,
  ...CLASSIC_LANDSCAPE_LAYOUTS,
  ...MODERN_PORTRAIT_LAYOUTS,
  ...MODERN_LANDSCAPE_LAYOUTS,
  // M10c (appended; empty until T5/T6 land).
  ...GEOMETRIC_PORTRAIT_LAYOUTS,
  ...GEOMETRIC_LANDSCAPE_LAYOUTS,
  ...SCRAPBOOK_PORTRAIT_LAYOUTS,
  ...SCRAPBOOK_LANDSCAPE_LAYOUTS,
  // M29 cover styles (D-080): appended after everything above, autoPick:false (editor-only).
  ...M29_COVERS,
  // M30 magazine + editorial (D-090): appended last (empty until the layout tasks land).
  ...M30_LAYOUTS,
];

export const LAYOUT_IDS: readonly string[] = LAYOUTS.map((l) => l.id);

export const COVER_LAYOUT_ID = "cover";

/**
 * Task 7: storybook page templates (chapter openings with an intro, storytelling, closing
 * reflections — ./story). Known to getLayout (render, validation, edit ops) but deliberately NOT
 * part of LAYOUTS, so layoutsFor / autolayout / the album Storyteller catalogue / the layout picker
 * are unchanged. Only the storybook page composer places them.
 */
export { STORY_LAYOUTS, isStoryLayoutId } from "./story";

const BY_ID = new Map([...LAYOUTS, ...STORY_LAYOUTS].map((l) => [l.id, l]));

export function getLayout(id: string): Layout | undefined {
  return BY_ID.get(id);
}

/**
 * Legacy: classic A5 portrait layouts of `role` only (M1–M10a callers: fit, layout picker, Storyteller
 * catalogue). New code must use layoutsFor(format, style, role) from lib/book/spreads.
 */
export function layoutsByRole(role: LayoutRole): readonly Layout[] {
  return CLASSIC_PORTRAIT_LAYOUTS.filter((l) => l.role === role);
}

/**
 * A5 PORTRAIT page size in mm — compat alias for M1–M9 callers. Format-aware code uses
 * pageMm(doc.format) / sheetMm(doc.format) (re-exported below from lib/book/format).
 */
export const PAGE_MM = { w: 148, h: 210 } as const;

export {
  aspect,
  DEFAULT_FORMAT,
  FORMAT_GEOMETRY,
  formatGeometry,
  orientationOf,
  pageMm,
  sheetMm,
  sheetPt,
  trimPt,
  type FormatGeometry,
  type FormatOrientation,
  type SizeMm,
} from "@/lib/book/format";

/**
 * Print bleed (D-050): the PDF sheet is the trim page plus BLEED_MM on every side. Photo slots
 * that touch a trim edge extend into the bleed; the page background fills the whole sheet.
 */
export const BLEED_MM = 3;

/** PORTRAIT print sheet in mm = trim page + bleed on every side (154×216). Compat alias — use sheetMm(format). */
export const SHEET_MM = { w: PAGE_MM.w + 2 * BLEED_MM, h: PAGE_MM.h + 2 * BLEED_MM } as const;

/** Safe zone (D-050): every caption / cover-text rect stays at least this far inside the trim. */
export const SAFE_MM = 4;

/** A single page with a caption area, or the LEFT half of a spread whose layout has one. */
export function hasCaptionArea(layoutId: string, side?: "left" | "right"): boolean {
  const l = getLayout(layoutId);
  if (!l || !l.caption) return false;
  if (l.role === "page") return true;
  return l.role === "spread" && side === "left";
}
