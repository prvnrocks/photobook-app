// Duplicate groups with a preferred photo. Pure (no I/O).
//
//   exact  the same file content: equal upload fingerprint or equal SHA-256 of the analysis copy
//   near   perceptual-hash neighbours (dHash Hamming distance + capture-time window, dupes.ts);
//          thresholds are configurable
// A group is "exact" only when ALL its members share one content hash; otherwise it is "near".
//
// The preferred photo is a SUGGESTION: the best-scoring member, unless the user picked one
// (userPreferred) — a user choice always wins and survives regrouping. Nothing here drops,
// hides or deletes a photo; the other members stay available as alternates.

import { DUPE_DEFAULTS, groupDuplicates, type GroupDuplicatesOptions } from "./dupes";
import { sharpnessFromVariance } from "./quality";

export type DupPhoto = {
  id: string;
  /** photos.fingerprint (sampled SHA-256 of the original file). */
  fingerprint: string | null;
  /** SHA-256 of the metadata-free analysis copy (photo_ingest.ai_copy_sha256). */
  imageSha256: string | null;
  phash: string | null;
  takenAt: string | null;
  dateSource: "exif" | "file" | null;
  width: number | null;
  height: number | null;
  /** Overall quality 0–100 when scored. */
  quality: number | null;
  /** photos.blur_score (Laplacian variance) — used when `quality` is missing. */
  blurScore: number | null;
};

export type DuplicateGroup = {
  /** Stable while the membership is stable: the smallest photo id of the group. */
  key: string;
  kind: "exact" | "near";
  photoIds: string[];
  preferredPhotoId: string;
  preferredSource: "auto" | "user";
};

export type DetectDuplicatesOptions = GroupDuplicatesOptions & {
  /** Photo ids the user chose as "keep this one" (most recent choice last). */
  userPreferred?: readonly string[];
};

export const DUPLICATE_DEFAULTS = DUPE_DEFAULTS;

/** Rank for "which copy is best": quality (or sharpness from the blur score), then pixels, then id. */
export function duplicateRank(p: DupPhoto): number {
  if (p.quality !== null && Number.isFinite(p.quality)) return p.quality;
  return p.blurScore !== null ? sharpnessFromVariance(p.blurScore) * 0.5 : 0;
}

export function comparePreferred(a: DupPhoto, b: DupPhoto): number {
  const q = duplicateRank(b) - duplicateRank(a);
  if (Math.abs(q) > 1e-9) return q;
  const area = (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0);
  if (area !== 0) return area;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function detectDuplicates(photos: readonly DupPhoto[], opts: DetectDuplicatesOptions = {}): DuplicateGroup[] {
  const index = new Map(photos.map((p, i) => [p.id, i]));
  const parent = photos.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // exact: same fingerprint or same analysis-copy hash
  const firstByHash = new Map<string, number>();
  photos.forEach((p, i) => {
    for (const h of [p.fingerprint ? `f:${p.fingerprint}` : null, p.imageSha256 ? `i:${p.imageSha256}` : null]) {
      if (!h) continue;
      const seen = firstByHash.get(h);
      if (seen === undefined) firstByHash.set(h, i);
      else union(seen, i);
    }
  });

  // near: perceptual hash (+ time window when both are EXIF-dated)
  const near = groupDuplicates(
    photos.map((p) => ({ id: p.id, phash: p.phash, takenAt: p.takenAt, dateSource: p.dateSource })),
    opts,
  );
  const firstByGroup = new Map<number, number>();
  for (const [id, g] of near) {
    const i = index.get(id)!;
    const seen = firstByGroup.get(g);
    if (seen === undefined) firstByGroup.set(g, i);
    else union(seen, i);
  }

  const members = new Map<number, DupPhoto[]>();
  photos.forEach((p, i) => {
    const r = find(i);
    const list = members.get(r);
    if (list) list.push(p);
    else members.set(r, [p]);
  });

  const userOrder = new Map((opts.userPreferred ?? []).map((id, i) => [id, i]));
  const groups: DuplicateGroup[] = [];
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const ids = list.map((p) => p.id).sort();
    const sameFingerprint = list.every((p) => p.fingerprint !== null && p.fingerprint === list[0]!.fingerprint);
    const sameImage = list.every((p) => p.imageSha256 !== null && p.imageSha256 === list[0]!.imageSha256);
    const chosen = list.filter((p) => userOrder.has(p.id)).sort((a, b) => userOrder.get(b.id)! - userOrder.get(a.id)!)[0];
    const best = [...list].sort(comparePreferred)[0]!;
    groups.push({
      key: ids[0]!,
      kind: sameFingerprint || sameImage ? "exact" : "near",
      photoIds: ids,
      preferredPhotoId: (chosen ?? best).id,
      preferredSource: chosen ? "user" : "auto",
    });
  }
  return groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** photoId → the group it belongs to. */
export function duplicateIndex(groups: readonly DuplicateGroup[]): Map<string, DuplicateGroup> {
  const out = new Map<string, DuplicateGroup>();
  for (const g of groups) for (const id of g.photoIds) out.set(id, g);
  return out;
}
