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
];

export const LAYOUT_IDS: readonly string[] = LAYOUTS.map((l) => l.id);

export const COVER_LAYOUT_ID = "cover";

const BY_ID = new Map(LAYOUTS.map((l) => [l.id, l]));

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
