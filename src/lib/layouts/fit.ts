// Best layout for a fixed, ordered set of photos, per book format + design style (M10b A10).
// Pure data maths, shared by the rule-based autolayout, prunePlan (photos removed from an AI plan
// mid-run) and relayoutDoc (D-028 "Update album"). Every query stays inside the book's design:
// layoutsFor(format, style, role) — validateBookDoc rejects any other format or style.
// Default design = classic A5 portrait (the M1–M10a catalogue, in the same order → identical picks).

import { assertSupportedDesign, type BookDesign } from "@/lib/book/book-design";
import { DEFAULT_FORMAT, pageMm } from "@/lib/book/format";
import { layoutsFor } from "@/lib/book/spreads";
import type { Layout } from "@/lib/book/types";

export type FitOrientation = "portrait" | "landscape" | "square";

const DEFAULT_DESIGN: BookDesign = { format: DEFAULT_FORMAT, designStyle: "classic" };

/** A square photo fits any slot; "any" slots fit any photo. */
export const fitsSlot = (pref: string, o: FitOrientation): boolean => pref === "any" || o === "square" || pref === o;

/** Number of slots i whose preference fits photo i. */
export function fitScore(layout: Pick<Layout, "prefers">, orients: readonly FitOrientation[]): number {
  return orients.reduce((n, o, i) => n + (fitsSlot(layout.prefers[i] ?? "any", o) ? 1 : 0), 0);
}

export interface BestLayoutOptions {
  /**
   * Only consider layouts with a caption area when at least one fits the photo count (used to
   * keep a user's caption on a re-fitted page, D-031); otherwise same as without.
   */
  preferCaption?: boolean;
  /** The book's format + design style (books.format / books.design_style). Default classic A5 portrait. */
  design?: BookDesign;
  /** "page" (default) or "spread" (two-page layouts; modern only). */
  role?: "page" | "spread";
}

/**
 * Layout id of the book's design with exactly `orients.length` slots and the most orientation
 * matches (slot i ↔ photo i, photos are not reordered); catalogue order on ties. null = no layout
 * of that role has that many slots.
 */
export function bestPageLayout(orients: readonly FitOrientation[], opts: BestLayoutOptions = {}): string | null {
  const design = opts.design ?? DEFAULT_DESIGN;
  assertSupportedDesign(design); // typed UnsupportedDesignError (geometric / scrapbook: no layouts yet)
  const sized = layoutsFor(design.format, design.designStyle, opts.role ?? "page").filter(
    (l) => l.photoCount === orients.length,
  );
  const withCaption = sized.filter((l) => l.caption !== null);
  const pool = opts.preferCaption && withCaption.length > 0 ? withCaption : sized;
  let best: { id: string; score: number } | null = null;
  for (const l of pool) {
    const score = fitScore(l, orients);
    if (!best || score > best.score) best = { id: l.id, score };
  }
  return best?.id ?? null;
}

/**
 * Cover layout of the book's design for a cover photo of orientation `orient` (null = no photo):
 * among the style's one-photo covers (all covers when none has one photo), the first whose slot
 * prefers that orientation, else the first. Classic A5 portrait → "cover".
 */
export function bestCoverLayout(design: BookDesign = DEFAULT_DESIGN, orient: FitOrientation | null = null): string {
  assertSupportedDesign(design);
  const covers = layoutsFor(design.format, design.designStyle, "cover");
  const ones = covers.filter((l) => l.photoCount === 1);
  const pool = ones.length > 0 ? ones : covers;
  const hit = orient === null ? undefined : pool.find((l) => fitsSlot(l.prefers[0] ?? "any", orient));
  const pick = hit ?? pool[0];
  if (!pick) throw new Error(`no cover layout for ${design.format}/${design.designStyle}`);
  return pick.id;
}

/**
 * The design's full-page layout: the one-photo page layout without a caption area and the
 * largest slot (catalogue order on ties) — "full-page" for classic A5 portrait.
 */
export function fullPageLayout(design: BookDesign = DEFAULT_DESIGN): string {
  assertSupportedDesign(design);
  const singles = layoutsFor(design.format, design.designStyle, "page").filter((l) => l.photoCount === 1);
  const pool = singles.some((l) => l.caption === null) ? singles.filter((l) => l.caption === null) : singles;
  let best: Layout | undefined;
  for (const l of pool) {
    const area = (l.slots[0]?.w ?? 0) * (l.slots[0]?.h ?? 0);
    const bestArea = best ? (best.slots[0]?.w ?? 0) * (best.slots[0]?.h ?? 0) : -1;
    if (area > bestArea) best = l;
  }
  if (!best) throw new Error(`no full-page layout for ${design.format}/${design.designStyle}`);
  return best.id;
}

/** Slot aspect (w/h) in mm on a page of `design.format` (spread slots: x in 0..200 → same maths). */
export function slotAspectMm(design: BookDesign, slot: { w: number; h: number }): number {
  const page = pageMm(design.format);
  return (slot.w * page.w) / Math.max(1e-9, slot.h * page.h);
}
