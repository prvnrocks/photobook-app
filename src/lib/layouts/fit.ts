// Best page layout for a fixed, ordered set of photos. Pure data maths, shared by prunePlan
// (photos removed from an AI plan mid-run) and relayoutDoc (D-028 "Update album").

import { layoutsByRole } from "./index";

export type FitOrientation = "portrait" | "landscape" | "square";

/** A square photo fits any slot; "any" slots fit any photo. */
const fits = (pref: string, o: FitOrientation) => pref === "any" || o === "square" || pref === o;

/**
 * Page layout id with exactly `orients.length` slots and the most orientation matches
 * (slot i ↔ photo i, photos are not reordered); catalogue order on ties. null = no page layout
 * has that many slots.
 */
export function bestPageLayout(orients: readonly FitOrientation[]): string | null {
  let best: { id: string; score: number } | null = null;
  for (const l of layoutsByRole("page")) {
    if (l.photoCount !== orients.length) continue;
    const score = orients.reduce((n, o, i) => n + (fits(l.prefers[i] ?? "any", o) ? 1 : 0), 0);
    if (!best || score > best.score) best = { id: l.id, score };
  }
  return best?.id ?? null;
}
