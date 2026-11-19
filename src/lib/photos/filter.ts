// Which photos a storybook sets aside (duplicates, similar shots, clearly blurry ones). Pure:
// no I/O, no model calls, deterministic.
//
//   duplicate  a member of an exact / near-duplicate group (duplicates.ts) that is not the group's
//              keeper (the preferred photo — the user's pick wins — else the best usable member)
//   similar    a burst-like run of the same shot: taken seconds apart (≤ maxGapSeconds between
//              neighbours, ≤ maxSpanSeconds from the first), same scene per the photo analysis, and
//              visually close (dHash distance ≤ maxHamming, or the same average colour AND mostly the
//              same things in the analysis). About one photo in 2–3 is kept (one per started
//              `keepPer` = 2.5 photos: a run of 7 keeps 3): the best ranked first, then the ones that
//              look most different from those already kept (varied framing). Single-pass anchored
//              grouping, not single-linkage: a long session cannot chain into one giant group.
//   blurry     bookBlurryIds (quality.ts): a clear outlier against the book's own sharpness
//
// Nothing here deletes anything. The caller writes `photos.status = 'dropped'` + `drop_reason`
// only for photos the user has not decided about (`user_override = false`), and only for photos
// that are kept now — a set-aside photo is restored with one tap in the editor (Left out by AI),
// which sets user_override so it is never set aside again.
//
// Calibration (2026-11-19, aggregate numbers of one real 60-photo, 13-minute café set; no
// per-photo data kept): neighbours of the same pose are 0–30 s apart with dHash distance 1–20,
// average-colour distance 0–30 and analysis overlap 0.4–0.8; a change of spot shows distance
// ≥ 20 and colour ≥ 30. With the defaults the set gives 8 runs (2–7 photos, none spanning more
// than 60 s) and keeps the change-of-spot photos apart.
//
// v3 calibration (2026-11-19, user feedback: 30 of 50 photos of one 11-minute session left out felt
// too aggressive): similar runs keep about 1 in 2–3 instead of 1 in 4, and the filters set aside at
// most `maxAsideShare` (40 %) of the book — similar shots come back (most different-looking first)
// until the share is met. Near-identical duplicates (exact copies, dHash ≤ 6 within 3 minutes) and
// clearly blurry photos are never given back: they are not worth printing twice; when they alone
// pass 40 % the book keeps one of each and nothing more.

import { hammingHex } from "./dupes";
import { comparePreferred, type DupPhoto, type DuplicateGroup } from "./duplicates";
import { contentTokens, jaccard, type MomentVision } from "./moments";
import { bookBlurryIds, VISION_BLUR_RE } from "./quality";

export const FILTER_REASONS = ["duplicate", "similar", "blurry"] as const;
export type FilterReason = (typeof FILTER_REASONS)[number];

export const SIMILAR_DEFAULTS = {
  maxGapSeconds: 30,
  maxSpanSeconds: 60,
  maxHamming: 10,
  /** Euclidean RGB distance of the photos' average colours (photos.color). */
  maxColour: 14,
  minOverlap: 0.5,
  /** Distance to the run's first photo still accepted when the neighbour matches. */
  anchorHamming: 20,
  /** Keep one photo per started `keepPer` photos of a run (2.5 ≈ one in 2–3). */
  keepPer: 2.5,
  /** Photos set aside: at most this share of the book (only similar shots are given back for it). */
  maxAsideShare: 0.4,
  /** Never leave fewer than this many photos in a book (or all of them when it has fewer). */
  minKept: 4,
} as const;
export type SimilarOptions = Partial<{ [K in keyof typeof SIMILAR_DEFAULTS]: number }>;

export type FilterPhoto = DupPhoto & {
  /** photos.status. */
  status: string;
  /** photos.user_override: the user decided about this photo — never changed here. */
  userOverride: boolean;
  /** photos.color "#rrggbb" or null. */
  color: string | null;
  vision: (MomentVision & { description?: string }) | null;
  /** Laplacian variance of the analysis copy and whether it is texture-free (quality raw / flags). */
  variance: number | null;
  flat: boolean;
};

export type FilterDecision = { photoId: string; reason: FilterReason };
export type SimilarGroup = { photoIds: string[]; keep: string[] };

const ms = (iso: string | null) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function rgb(hex: string | null): [number, number, number] | null {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
function colourDistance(a: string | null, b: string | null): number {
  const x = rgb(a);
  const y = rgb(b);
  return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : Infinity;
}

type Prepared = FilterPhoto & { t: number; tokens: Set<string> };

function alike(a: Prepared, b: Prepared, o: typeof SIMILAR_DEFAULTS): boolean {
  if (a.vision && b.vision && a.vision.scene !== b.vision.scene) return false;
  const h = a.phash && b.phash ? hammingHex(a.phash.toLowerCase(), b.phash.toLowerCase()) : Infinity;
  if (h <= o.maxHamming) return true;
  if (colourDistance(a.color, b.color) > o.maxColour) return false;
  if (a.tokens.size > 0 && b.tokens.size > 0) return jaccard(a.tokens, b.tokens) >= o.minOverlap;
  return false;
}

/**
 * Burst-like runs of the same shot among `photos` (EXIF-dated only: file dates of forwarded
 * photos are not capture times). Every run has ≥ 2 photos; `keep` = its best ranked photos.
 */
export function groupSimilarShots(photos: readonly FilterPhoto[], options: SimilarOptions = {}): SimilarGroup[] {
  const o = { ...SIMILAR_DEFAULTS, ...options } as typeof SIMILAR_DEFAULTS;
  const list: Prepared[] = photos
    .filter((p) => p.dateSource === "exif" && ms(p.takenAt) !== null)
    .map((p) => ({ ...p, t: ms(p.takenAt)!, tokens: contentTokens(p.vision) }))
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const runs: Prepared[][] = [];
  let run: Prepared[] | null = null;
  for (const p of list) {
    if (run) {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const near = (p.t - last.t) / 1000 <= o.maxGapSeconds && (p.t - first.t) / 1000 <= o.maxSpanSeconds;
      const anchorOk = () => alike(first, p, o) || (first.phash && p.phash ? hammingHex(first.phash.toLowerCase(), p.phash.toLowerCase()) <= o.anchorHamming : false);
      if (near && alike(last, p, o) && anchorOk()) {
        run.push(p);
        continue;
      }
    }
    run = [p];
    runs.push(run);
  }
  return runs
    .filter((r) => r.length >= 2)
    .map((r) => ({ photoIds: r.map((p) => p.id), keep: variedKeep([...r].sort(comparePreferred), Math.ceil(r.length / o.keepPer)).map((p) => p.id) }));
}

const dist = (a: FilterPhoto, b: FilterPhoto) => (a.phash && b.phash ? hammingHex(a.phash.toLowerCase(), b.phash.toLowerCase()) : 0);

/**
 * `n` photos of a ranked run: the best one first, then each time the photo that looks most
 * different from those already kept (largest smallest dHash distance; ties → better ranked).
 */
export function variedKeep<T extends FilterPhoto>(ranked: readonly T[], n: number): T[] {
  const kept: T[] = [];
  const left = [...ranked];
  while (kept.length < n && left.length > 0) {
    let at = 0;
    if (kept.length > 0) {
      let best = -1;
      left.forEach((p, i) => {
        const d = Math.min(...kept.map((k) => dist(p, k)));
        if (d > best) {
          best = d;
          at = i;
        }
      });
    }
    kept.push(left.splice(at, 1)[0]!);
  }
  return kept;
}

/**
 * The photos to set aside, with one reason each. Only photos that are kept now and that the user
 * has not decided about are ever returned; a group's keeper is chosen among the photos still in
 * the book (kept or restored by the user), preferring sharp ones, so no group loses every member.
 */
export function decidePhotoFilters(photos: readonly FilterPhoto[], duplicateGroups: readonly DuplicateGroup[], options: SimilarOptions = {}): FilterDecision[] {
  const o = { ...SIMILAR_DEFAULTS, ...options } as typeof SIMILAR_DEFAULTS;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const alive = photos.filter((p) => p.status !== "dropped");
  const eligible = (id: string) => {
    const p = byId.get(id);
    return !!p && p.status === "kept" && !p.userOverride;
  };
  const blurry = bookBlurryIds(alive.map((p) => ({ id: p.id, variance: p.variance, flat: p.flat, visionBlurry: !!p.vision?.description && VISION_BLUR_RE.test(p.vision.description) })));
  const rank = (a: FilterPhoto, b: FilterPhoto) => Number(blurry.has(a.id)) - Number(blurry.has(b.id)) || comparePreferred(a, b);
  const reason = new Map<string, FilterReason>();
  const userKept = new Set(duplicateGroups.filter((g) => g.preferredSource === "user").map((g) => g.preferredPhotoId));

  /** Similar shots the 40 % cap may give back, with the photos of their run that stay. */
  const cappable = new Map<string, { reason: FilterReason; keepers: FilterPhoto[] }>();

  // 1. duplicate groups: one keeper among the members still in the book
  for (const g of duplicateGroups) {
    const members = g.photoIds.map((id) => byId.get(id)).filter((p): p is FilterPhoto => !!p && p.status !== "dropped");
    if (members.length < 2) continue;
    const preferred = members.find((p) => p.id === g.preferredPhotoId);
    const keeper = preferred && (g.preferredSource === "user" || !blurry.has(preferred.id)) ? preferred : [...members].sort(rank)[0]!;
    for (const p of members) {
      if (p.id === keeper.id || !eligible(p.id) || userKept.has(p.id)) continue;
      reason.set(p.id, "duplicate");
    }
  }

  // 2. similar shots among what is left
  const left = alive.filter((p) => !reason.has(p.id));
  for (const g of groupSimilarShots(left, o)) {
    const members = g.photoIds.map((id) => byId.get(id)!);
    const keepN = Math.ceil(members.length / o.keepPer);
    const pinned = members.filter((p) => p.userOverride || userKept.has(p.id));
    const order = [...new Set([...pinned, ...[...members].sort(rank)])];
    const keepList = [...pinned, ...variedKeep(order.filter((p) => !pinned.includes(p)), Math.max(0, keepN - pinned.length))];
    const keep = new Set(keepList.map((p) => p.id));
    for (const p of members) {
      if (keep.has(p.id) || !eligible(p.id)) continue;
      reason.set(p.id, "similar");
      cappable.set(p.id, { reason: "similar", keepers: keepList });
    }
  }

  // 3. clearly blurry photos that are still in
  for (const p of alive) if (blurry.has(p.id) && !reason.has(p.id) && eligible(p.id) && !userKept.has(p.id)) reason.set(p.id, "blurry");

  // v3: the filters never take more than maxAsideShare of the book through similar shots — the
  // ones that look most different from what stays come back first. Near-identical duplicates and
  // clearly blurry photos are not given back (they still count toward the share).
  const maxAside = Math.floor(alive.length * o.maxAsideShare);
  const asideCappable = [...cappable.keys()].filter((id) => reason.has(id));
  const over = reason.size - maxAside;
  if (over > 0 && asideCappable.length > 0) {
    const order = asideCappable
      .map((id) => {
        const c = cappable.get(id)!;
        const p = byId.get(id)!;
        return { id, p, similar: c.reason === "similar" ? 1 : 0, spread: c.keepers.length ? Math.min(...c.keepers.map((k) => dist(p, k))) : 0 };
      })
      .sort((a, b) => b.similar - a.similar || b.spread - a.spread || rank(a.p, b.p));
    for (const x of order.slice(0, over)) reason.delete(x.id);
  }

  // never empty a book: give back the best ranked set-aside photos until minKept remain
  const keptAfter = alive.length - reason.size;
  const floor = Math.min(o.minKept, alive.length);
  if (keptAfter < floor) {
    const back = [...reason.keys()].map((id) => byId.get(id)!).sort(rank).slice(0, floor - keptAfter);
    for (const p of back) reason.delete(p.id);
  }
  return [...reason.entries()].map(([photoId, r]) => ({ photoId, reason: r })).sort((a, b) => (a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0));
}

export type FilterCounts = Record<FilterReason, number>;

/** Photos currently set aside by the AI per reason (not by the user), from photos rows. */
export function filterCounts(rows: readonly { status: string; drop_reason?: string | null; user_override?: boolean }[]): FilterCounts {
  const out: FilterCounts = { duplicate: 0, similar: 0, blurry: 0 };
  for (const r of rows) {
    if (r.status !== "dropped" || r.user_override) continue;
    if (r.drop_reason === "duplicate" || r.drop_reason === "similar" || r.drop_reason === "blurry") out[r.drop_reason]++;
  }
  return out;
}
