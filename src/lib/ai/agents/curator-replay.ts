// Replay synthesiser for the Curator (D-024): deterministic, plausible answers built only from
// request.scenarioMeta — never from image content. Used locally, in previews and in tests.
//
// scenarioMeta = { aliases: string[], hints: Record<alias, CuratorReplayHint> }
//  - screenshot (png + no camera + aspect ≥ SCREENSHOT_MIN_ASPECT) → dropped 'screenshot'
//  - quality from blur score (log scale); quality ≤ 2 → dropped 'blurry'
//  - per dup group the highest blur score is kept, the rest dropped 'duplicate'
//  - the best two kept photos with quality ≥ 6 are coverWorthy
// scenario "invalid" → an object of the wrong shape (fails the lean AI schema → parse_failed).

import type { ReplaySynth } from "../transport-replay";
import { SCREENSHOT_MIN_ASPECT, type DropReason } from "../fallback";

export interface CuratorReplayHint {
  isPng: boolean;
  noCamera: boolean;
  aspect: number | null;
  blur: number | null;
  dupGroup: number | null;
}

const MOODS = ["joyful", "calm", "romantic", "nostalgic"] as const;

export function replayQuality(blur: number | null): number {
  if (blur === null || !Number.isFinite(blur)) return 6;
  return Math.max(1, Math.min(10, Math.round(Math.log10(Math.max(0, blur) + 1) * 3)));
}

export const curatorReplaySynth: ReplaySynth = (meta, ctx) => {
  const aliases = Array.isArray(meta.aliases) ? meta.aliases.filter((a): a is string => typeof a === "string") : [];
  const hints = (meta.hints && typeof meta.hints === "object" ? meta.hints : {}) as Record<string, CuratorReplayHint>;
  if (ctx.scenario === "invalid") return { items: aliases.map((a) => ({ id: a, ok: true })) };

  const hint = (a: string): CuratorReplayHint =>
    hints[a] ?? { isPng: false, noCamera: false, aspect: null, blur: null, dupGroup: null };

  const rows = aliases.map((alias, i) => {
    const h = hint(alias);
    const quality = replayQuality(h.blur);
    const screenshot = h.isPng && h.noCamera && (h.aspect ?? 0) >= SCREENSHOT_MIN_ASPECT;
    const dropReason: DropReason | null = screenshot ? "screenshot" : quality <= 2 ? "blurry" : null;
    return { alias, i, h, quality, screenshot, dropReason: dropReason as DropReason | null };
  });

  // Dup groups: keep the sharpest non-dropped member (tie → earlier alias), drop the rest.
  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    if (r.h.dupGroup === null) continue;
    groups.set(r.h.dupGroup, [...(groups.get(r.h.dupGroup) ?? []), r]);
  }
  for (const members of groups.values()) {
    const ranked = [...members].sort((a, b) => (b.h.blur ?? 0) - (a.h.blur ?? 0) || a.i - b.i);
    const keeper = ranked.find((r) => r.dropReason === null) ?? ranked.find((r) => !r.screenshot);
    for (const r of ranked) {
      if (r === keeper) r.dropReason = null;
      else if (r.dropReason === null) r.dropReason = "duplicate";
    }
  }

  const cover = new Set(
    rows
      .filter((r) => r.dropReason === null && r.quality >= 6)
      .sort((a, b) => b.quality - a.quality || a.i - b.i)
      .slice(0, 2)
      .map((r) => r.alias),
  );

  return {
    photos: rows.map((r) => {
      const landscape = (r.h.aspect ?? 1) > 1.1;
      const people = r.screenshot ? 0 : (r.i * 7 + 3) % 5;
      return {
        photoId: r.alias,
        description: r.screenshot
          ? "A phone screenshot (synthetic replay note)."
          : `A ${landscape ? "wide" : "tall"} photo with ${people} people (synthetic replay note).`,
        scene: r.screenshot ? "screenshot" : people >= 3 ? "group" : people >= 1 ? "portrait" : landscape ? "landscape" : "detail",
        peopleCount: people,
        mood: MOODS[r.i % MOODS.length],
        quality: r.quality,
        coverWorthy: cover.has(r.alias),
        keep: r.dropReason === null,
        dropReason: r.dropReason,
      };
    }),
  };
};
