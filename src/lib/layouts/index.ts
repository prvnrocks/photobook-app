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

export const LAYOUTS: readonly Layout[] = [
  cover,
  fullPage,
  onePortrait,
  twoVertical,
  twoHorizontal,
  threeMixed,
  fourGrid,
];

export const LAYOUT_IDS: readonly string[] = LAYOUTS.map((l) => l.id);

export const COVER_LAYOUT_ID = "cover";

const BY_ID = new Map(LAYOUTS.map((l) => [l.id, l]));

export function getLayout(id: string): Layout | undefined {
  return BY_ID.get(id);
}

export function layoutsByRole(role: LayoutRole): readonly Layout[] {
  return LAYOUTS.filter((l) => l.role === role);
}

/** A5 portrait page size in mm (aspect ratio for slot orientation maths). */
export const PAGE_MM = { w: 148, h: 210 } as const;

/**
 * Print bleed (D-050): the PDF sheet is the trim page plus BLEED_MM on every side. Photo slots
 * that touch a trim edge extend into the bleed; the page background fills the whole sheet.
 */
export const BLEED_MM = 3;

/** Print sheet size in mm = trim page + bleed on every side (154×216). */
export const SHEET_MM = { w: PAGE_MM.w + 2 * BLEED_MM, h: PAGE_MM.h + 2 * BLEED_MM } as const;

/** Safe zone (D-050): every caption / cover-text rect stays at least this far inside the trim. */
export const SAFE_MM = 4;
