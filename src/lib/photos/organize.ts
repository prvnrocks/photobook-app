import "server-only";
// Photo organiser (Task 4): quality scores, duplicate groups, moments.
//
//   analyzePhotoQuality(photoId)      score one photo's analysis copy (sharp decode → quality.ts)
//   detectDuplicateGroups(bookId)     exact + near duplicate groups with a preferred photo
//   clusterPhotosIntoMoments(bookId)  the full structured result, stored per book
//
// Every function checks ownership with the caller's session first. None of them changes
// photos.status, deletes a file or calls the model: vision data is read from what Task 3 already
// stored, and a photo without it is simply grouped with less evidence.
// Incremental: quality rows and vision rows are per photo, so a later call only scores the new
// photos; grouping itself is recomputed from all photos (pure, milliseconds) and the user's
// choices (preferred duplicate, moment label, hero) are carried over.

import sharp from "sharp";
import { getMyBook } from "@/lib/db/books";
import { getCurrentUser } from "@/lib/auth/current-user";
import { loadOwnPhoto, type OwnPhoto } from "@/lib/db/photo-analyses";
import {
  listDuplicateGroups,
  listImageHashes,
  listMoments,
  listPhotosForOrganize,
  listQuality,
  listVision,
  replaceDuplicateGroups,
  replaceMoments,
  saveQuality,
  setDuplicatePreference,
  type OrganizePhotoRow,
  type StoredMoment,
  type StoredQuality,
} from "@/lib/db/photo-organize";
import { loadThumbBase64 } from "@/lib/db/photos";
import { PhotoVisionSchema } from "@/lib/storybook/schemas";
import { detectDuplicates, type DetectDuplicatesOptions, type DupPhoto, type DuplicateGroup } from "./duplicates";
import { MOMENTS_VERSION, clusterMoments, rankCandidates, type MomentOptions, type MomentPhoto, type MomentVision } from "./moments";
import { OrganizeResultSchema, type OrganizeResult, type PhotoQuality } from "./organize-schemas";
import { QUALITY_VERSION, lumaOf, scoreImage, sharpnessFromVariance, type QualityScores } from "./quality";

export const ORGANIZE_ERRORS = ["not_found", "not_ready", "no_ai_copy", "undecodable"] as const;
export type OrganizeErrorCode = (typeof ORGANIZE_ERRORS)[number];

/** Code only — never ids, paths or content. */
export class OrganizeError extends Error {
  constructor(public readonly code: OrganizeErrorCode) {
    super(code);
    this.name = "OrganizeError";
  }
}

/** Photos scored per clusterPhotosIntoMoments call (the rest is reported as pending). */
export const QUALITY_MAX_PER_RUN = 150;
export const QUALITY_CONCURRENCY = 6;

export type OrganizeDeps = {
  /** The signed-in owner of the book, or null (not signed in / not the owner / no such book). */
  ownerOf?: (bookId: string) => Promise<string | null>;
  loadPhoto?: (photoId: string) => Promise<OwnPhoto | null>;
  /** Validated analysis copy as base64, or null. */
  loadAiCopy?: (thumbPath: string) => Promise<string | null>;
  listPhotos?: typeof listPhotosForOrganize;
  listQuality?: typeof listQuality;
  saveQuality?: typeof saveQuality;
  listImageHashes?: typeof listImageHashes;
  listVision?: typeof listVision;
  listDuplicateGroups?: typeof listDuplicateGroups;
  replaceDuplicateGroups?: typeof replaceDuplicateGroups;
  listMoments?: typeof listMoments;
  replaceMoments?: typeof replaceMoments;
  duplicateOptions?: DetectDuplicatesOptions;
  momentOptions?: MomentOptions;
  maxQualityPerRun?: number;
};

async function defaultOwnerOf(bookId: string): Promise<string | null> {
  const [user, book] = await Promise.all([getCurrentUser(), getMyBook(bookId)]);
  return user && book ? user.id : null;
}
const defaultLoadAiCopy = async (path: string) => (await loadThumbBase64([path])).get(path) ?? null;

/** Decodes the (already validated ≤ 512 px JPEG) analysis copy and scores it. */
export async function scoreAiCopy(base64: string): Promise<QualityScores> {
  try {
    const { data, info } = await sharp(Buffer.from(base64, "base64"), { limitInputPixels: 1024 * 1024, failOn: "error" })
      .rotate() // no-op: the copy carries no EXIF; kept so a future rotated copy is still measured upright
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels === 1 ? 1 : info.channels === 3 ? 3 : 4;
    return scoreImage(lumaOf(data, info.width, info.height, channels), info.width, info.height);
  } catch {
    throw new OrganizeError("undecodable");
  }
}

/**
 * Quality scores of one photo of the signed-in user. Stored scores of the current
 * QUALITY_VERSION are returned without touching the image again.
 */
export async function analyzePhotoQuality(photoId: string, deps: OrganizeDeps = {}): Promise<PhotoQuality> {
  const photo = await (deps.loadPhoto ?? loadOwnPhoto)(photoId);
  if (!photo) throw new OrganizeError("not_found");
  if (photo.upload_state !== "ready" || !photo.thumb_path) throw new OrganizeError("not_ready");
  const stored = (await (deps.listQuality ?? listQuality)(photo.book_id, photo.user_id)).find((q) => q.photoId === photo.id && q.version === QUALITY_VERSION);
  if (stored) return toQuality(stored);
  const scores = await scoreOne({ id: photo.id, thumb_path: photo.thumb_path }, photo.book_id, photo.user_id, deps);
  return toQuality({ ...scores, photoId: photo.id });
}

async function scoreOne(photo: { id: string; thumb_path: string | null }, bookId: string, userId: string, deps: OrganizeDeps): Promise<QualityScores> {
  if (!photo.thumb_path) throw new OrganizeError("no_ai_copy");
  const base64 = await (deps.loadAiCopy ?? defaultLoadAiCopy)(photo.thumb_path);
  if (!base64) throw new OrganizeError("no_ai_copy");
  const scores = await scoreAiCopy(base64);
  await (deps.saveQuality ?? saveQuality)({ photoId: photo.id, bookId, userId }, scores);
  return scores;
}

const toQuality = (q: StoredQuality): PhotoQuality => ({
  photoId: q.photoId,
  version: q.version,
  sharpness: q.sharpness,
  exposure: q.exposure,
  composition: q.composition,
  overall: q.overall,
  flags: [...q.flags],
  basis: "pixels",
});

/** Sharpness-only stand-in for a photo that has not been scored yet (upload-time blur score). */
function provisionalQuality(p: OrganizePhotoRow): PhotoQuality | null {
  if (p.blur_score === null || p.blur_score < 0) return null;
  const sharpness = sharpnessFromVariance(p.blur_score);
  return { photoId: p.id, version: QUALITY_VERSION, sharpness, exposure: 50, composition: 50, overall: Math.round((0.5 * sharpness + 25) * 10) / 10, flags: p.blur_score < 10 ? ["blurry"] : [], basis: "blur_score" };
}

const dateSource = (v: string | null) => (v === "exif" || v === "file" ? v : null);

function buildDuplicates(photos: OrganizePhotoRow[], quality: Map<string, PhotoQuality>, hashes: Map<string, string>, previous: DuplicateGroup[], options: DetectDuplicatesOptions = {}): DuplicateGroup[] {
  const items: DupPhoto[] = photos.map((p) => ({
    id: p.id,
    fingerprint: p.fingerprint || null,
    imageSha256: hashes.get(p.id) ?? null,
    phash: p.phash,
    takenAt: p.taken_at,
    dateSource: dateSource(p.date_source),
    width: p.width,
    height: p.height,
    quality: quality.get(p.id)?.overall ?? null,
    blurScore: p.blur_score,
  }));
  const ids = new Set(photos.map((p) => p.id));
  const userPreferred = previous.filter((g) => g.preferredSource === "user" && ids.has(g.preferredPhotoId)).map((g) => g.preferredPhotoId);
  return detectDuplicates(items, { ...options, userPreferred });
}

/**
 * Duplicate groups of the signed-in user's book, stored and returned. Members are never dropped
 * or deleted; `preferredPhotoId` is a suggestion unless `preferredSource` is "user".
 */
export async function detectDuplicateGroups(bookId: string, deps: OrganizeDeps = {}): Promise<DuplicateGroup[]> {
  const userId = await (deps.ownerOf ?? defaultOwnerOf)(bookId);
  if (!userId) throw new OrganizeError("not_found");
  const [photos, stored, hashes, previous] = await Promise.all([
    (deps.listPhotos ?? listPhotosForOrganize)(bookId, userId),
    (deps.listQuality ?? listQuality)(bookId, userId),
    (deps.listImageHashes ?? listImageHashes)(bookId, userId),
    (deps.listDuplicateGroups ?? listDuplicateGroups)(bookId, userId),
  ]);
  const quality = new Map(stored.filter((q) => q.version === QUALITY_VERSION).map((q) => [q.photoId, toQuality(q)]));
  const groups = buildDuplicates(photos, quality, hashes, previous, deps.duplicateOptions);
  await (deps.replaceDuplicateGroups ?? replaceDuplicateGroups)(bookId, userId, groups);
  return groups;
}

/** The user's "keep this one" for a duplicate group. False when the photo is in no group of the book. */
export async function preferDuplicate(bookId: string, photoId: string, deps: Pick<OrganizeDeps, "ownerOf"> = {}): Promise<boolean> {
  const userId = await (deps.ownerOf ?? defaultOwnerOf)(bookId);
  if (!userId) throw new OrganizeError("not_found");
  return setDuplicatePreference(bookId, userId, photoId);
}

function visionOf(raw: unknown): MomentVision | null {
  const v = PhotoVisionSchema.safeParse(raw);
  return v.success ? { scene: v.data.scene, objects: v.data.objects, activities: v.data.activities, storyRole: v.data.storyRole, peopleCount: v.data.peopleCount } : null;
}

const overlap = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(a);
  const inter = b.filter((id) => set.has(id)).length;
  return inter / (a.length + b.length - inter || 1);
};

/**
 * Scores what is not scored yet (bounded), groups duplicates, clusters ALL ready photos of the
 * book into moments, ranks candidates, stores the groups and returns the structured result.
 * Safe to call again after more uploads: only new photos are scored, moments are regrouped, and
 * the user's labels / hero / duplicate choices are kept.
 */
export async function clusterPhotosIntoMoments(bookId: string, deps: OrganizeDeps = {}): Promise<OrganizeResult> {
  const userId = await (deps.ownerOf ?? defaultOwnerOf)(bookId);
  if (!userId) throw new OrganizeError("not_found");

  const [photos, storedQuality, hashes, visionRows, previousGroups, previousMoments] = await Promise.all([
    (deps.listPhotos ?? listPhotosForOrganize)(bookId, userId),
    (deps.listQuality ?? listQuality)(bookId, userId),
    (deps.listImageHashes ?? listImageHashes)(bookId, userId),
    (deps.listVision ?? listVision)(bookId, userId),
    (deps.listDuplicateGroups ?? listDuplicateGroups)(bookId, userId),
    (deps.listMoments ?? listMoments)(bookId, userId),
  ]);

  // 1. quality: stored rows of the current version, then score the missing ones (bounded)
  const quality = new Map<string, PhotoQuality>(storedQuality.filter((q) => q.version === QUALITY_VERSION).map((q) => [q.photoId, toQuality(q)]));
  const missing = photos.filter((p) => !quality.has(p.id) && p.thumb_path);
  const batch = missing.slice(0, Math.max(0, deps.maxQualityPerRun ?? QUALITY_MAX_PER_RUN));
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const p = batch[next++]!;
      try {
        const scores = await scoreOne(p, bookId, userId, deps);
        quality.set(p.id, toQuality({ ...scores, photoId: p.id }));
      } catch {
        // unscored: the provisional value below is used; a later call tries again
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(QUALITY_CONCURRENCY, batch.length) }, worker));
  let pendingQuality = 0;
  for (const p of photos) {
    if (quality.has(p.id)) continue;
    pendingQuality++;
    const provisional = provisionalQuality(p);
    if (provisional) quality.set(p.id, provisional);
  }

  // 2. duplicates
  const duplicateGroups = buildDuplicates(photos, quality, hashes, previousGroups, deps.duplicateOptions);

  // 3. moments + candidates
  let pendingVision = 0;
  const momentPhotos: MomentPhoto[] = photos.map((p) => {
    const vision = visionOf(visionRows.get(p.id));
    if (!vision) pendingVision++;
    const q = quality.get(p.id);
    const ai = p.ai && typeof p.ai === "object" && !Array.isArray(p.ai) ? (p.ai as Record<string, unknown>) : null;
    return {
      id: p.id,
      takenAt: p.taken_at,
      dateSource: dateSource(p.date_source),
      lat: p.lat,
      lng: p.lng,
      place: p.place,
      vision,
      quality: q?.overall ?? null,
      qualityFlags: q?.flags ?? [],
      keep: p.status !== "dropped",
      coverWorthy: ai?.coverWorthy === true,
    };
  });
  const clustered = clusterMoments(momentPhotos, deps.momentOptions);
  const ranked = rankCandidates(clustered.moments, momentPhotos, duplicateGroups, deps.momentOptions);

  // 4. carry over the user's label / hero from the stored moment each new moment continues
  const moments: StoredMoment[] = ranked.moments.map((m) => {
    const prev = previousMoments.find((s) => s.key === m.key) ?? previousMoments.filter((s) => overlap(s.photoIds, m.photoIds) >= 0.5).sort((a, b) => overlap(b.photoIds, m.photoIds) - overlap(a.photoIds, m.photoIds))[0];
    const keepLabel = prev?.labelSource === "user";
    const keepHero = prev?.heroSource === "user" && prev.heroPhotoId !== null && m.photoIds.includes(prev.heroPhotoId);
    return {
      ...m,
      label: keepLabel ? prev!.label : m.label,
      labelSource: keepLabel ? "user" : "auto",
      heroPhotoId: keepHero ? prev!.heroPhotoId : m.heroPhotoId,
      heroSource: keepHero ? "user" : "auto",
    };
  });
  const userHero = new Map(moments.filter((m) => m.heroSource === "user").map((m) => [m.key, m.heroPhotoId!]));
  const candidates = ranked.candidates.map((c) => {
    const chosen = userHero.get(c.momentKey);
    if (!chosen) return c;
    if (c.photoId === chosen) return { photoId: c.photoId, momentKey: c.momentKey, role: "hero" as const, score: c.score };
    return c.role === "hero" ? { ...c, role: "collage" as const } : c;
  });

  await (deps.replaceDuplicateGroups ?? replaceDuplicateGroups)(bookId, userId, duplicateGroups);
  await (deps.replaceMoments ?? replaceMoments)(bookId, userId, moments, MOMENTS_VERSION);

  const result: OrganizeResult = {
    bookId,
    photos: photos.length,
    quality: photos.map((p) => quality.get(p.id)).filter((q): q is PhotoQuality => !!q),
    duplicateGroups,
    candidates,
    moments,
    uncertain: clustered.uncertain,
    pending: { quality: pendingQuality, vision: pendingVision },
  };
  return OrganizeResultSchema.parse(result);
}
