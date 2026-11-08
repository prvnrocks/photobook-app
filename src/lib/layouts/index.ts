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
