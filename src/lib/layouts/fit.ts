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
 *
 * `preferCaption`: only consider layouts with a caption area when at least one fits the photo
 * count (used to keep a user's caption on a re-fitted page, D-031); otherwise same as without.
 */
export function bestPageLayout(
  orients: readonly FitOrientation[],
  opts: { preferCaption?: boolean } = {},
): string | null {
  const sized = layoutsByRole("page").filter((l) => l.photoCount === orients.length);
  const withCaption = sized.filter((l) => l.caption !== null);
  const pool = opts.preferCaption && withCaption.length > 0 ? withCaption : sized;
  let best: { id: string; score: number } | null = null;
  for (const l of pool) {
    const score = orients.reduce((n, o, i) => n + (fits(l.prefers[i] ?? "any", o) ? 1 : 0), 0);
    if (!best || score > best.score) best = { id: l.id, score };
  }
  return best?.id ?? null;
}
