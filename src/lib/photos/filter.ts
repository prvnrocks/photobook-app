// Which photos a storybook sets aside (duplicates, similar shots, clearly blurry ones). Pure:
// no I/O, no model calls, deterministic.
//
//   duplicate  a member of an exact / near-duplicate group (duplicates.ts) that is not the group's
//              keeper (the preferred photo — the user's pick wins — else the best usable member)
//   similar    a burst-like run of the same shot: taken seconds apart (≤ maxGapSeconds between
//              neighbours, ≤ maxSpanSeconds from the first), same scene per the photo analysis, and
//              visually close (dHash distance ≤ maxHamming, or the same average colour AND mostly the
//              same things in the analysis). One photo per started `keepPer` photos is kept (a run
//              of 7 keeps 2), the best ranked first. Single-pass anchored grouping, not
//              single-linkage: a long session cannot chain into one giant group.
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
  /** Keep one photo per started `keepPer` photos of a run. */
  keepPer: 4,
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
    .map((r) => {
      const ranked = [...r].sort(comparePreferred);
      return { photoIds: r.map((p) => p.id), keep: ranked.slice(0, Math.ceil(r.length / o.keepPer)).map((p) => p.id) };
    });
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

  // 1. duplicate groups: one keeper among the members still in the book
  for (const g of duplicateGroups) {
    const members = g.photoIds.map((id) => byId.get(id)).filter((p): p is FilterPhoto => !!p && p.status !== "dropped");
    if (members.length < 2) continue;
    const preferred = members.find((p) => p.id === g.preferredPhotoId);
    const keeper = preferred && (g.preferredSource === "user" || !blurry.has(preferred.id)) ? preferred : [...members].sort(rank)[0]!;
    for (const p of members) if (p.id !== keeper.id && eligible(p.id) && !userKept.has(p.id)) reason.set(p.id, "duplicate");
  }

  // 2. similar shots among what is left
  const left = alive.filter((p) => !reason.has(p.id));
  for (const g of groupSimilarShots(left, o)) {
    const members = g.photoIds.map((id) => byId.get(id)!);
    const keepN = Math.ceil(members.length / o.keepPer);
    const pinned = members.filter((p) => p.userOverride || userKept.has(p.id));
    const order = [...new Set([...pinned, ...[...members].sort(rank)])];
    const keep = new Set(order.slice(0, Math.max(keepN, pinned.length)).map((p) => p.id));
    for (const p of members) if (!keep.has(p.id) && eligible(p.id)) reason.set(p.id, "similar");
  }

  // 3. clearly blurry photos that are still in
  for (const p of alive) if (blurry.has(p.id) && !reason.has(p.id) && eligible(p.id) && !userKept.has(p.id)) reason.set(p.id, "blurry");

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
