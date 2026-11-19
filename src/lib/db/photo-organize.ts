import "server-only";
// photo_quality / photo_duplicate_groups / photo_moments (migration 2500) and the reads the
// organiser needs. Admin client: the tables are server-written. Callers MUST have proved that
// `userId` owns `bookId` (getMyBook under RLS); every query filters by both. Nothing here logs.

import type { DuplicateGroup } from "@/lib/photos/duplicates";
import type { Moment } from "@/lib/photos/moments";
import type { QualityScores } from "@/lib/photos/quality";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

export class PhotoOrganizeError extends Error {
  constructor(
    what: string,
    public readonly code: string | undefined,
  ) {
    super(`${what} failed${code ? ` (${code})` : ""}`);
    this.name = "PhotoOrganizeError";
  }
}

const missingTable = (code: string | undefined) => code === "42P01" || code === "PGRST205";
const chunks = <T>(items: T[], size = 100): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export type OrganizePhotoRow = {
  id: string;
  fingerprint: string;
  phash: string | null;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  date_source: string | null;
  lat: number | null;
  lng: number | null;
  place: string | null;
  blur_score: number | null;
  ai: Json | null;
  status: string;
  /** Optional in fixtures; read for the storybook's photo filters (never changed when true). */
  user_override?: boolean;
  drop_reason?: string | null;
  color?: string | null;
};

/** Ready photos of the user's book, oldest first. */
export async function listPhotosForOrganize(bookId: string, userId: string): Promise<OrganizePhotoRow[]> {
  if (!isUuid(bookId) || !isUuid(userId)) return [];
  const { data, error } = await createAdminClient()
    .from("photos")
    .select("id, fingerprint, phash, thumb_path, width, height, taken_at, date_source, lat, lng, place, blur_score, ai, status, user_override, drop_reason, color")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .eq("upload_state", "ready")
    .order("id", { ascending: true });
  if (error) throw new PhotoOrganizeError("list photos", error.code);
  return data;
}

export type StoredQuality = QualityScores & { photoId: string };

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

export async function listQuality(bookId: string, userId: string): Promise<StoredQuality[]> {
  const { data, error } = await createAdminClient()
    .from("photo_quality")
    .select("photo_id, version, sharpness, exposure, composition, overall, flags, raw")
    .eq("book_id", bookId)
    .eq("user_id", userId);
  if (error) {
    if (missingTable(error.code)) return [];
    throw new PhotoOrganizeError("list quality", error.code);
  }
  return data.map((r) => ({
    photoId: r.photo_id,
    version: r.version,
    sharpness: num(r.sharpness),
    exposure: num(r.exposure),
    composition: num(r.composition),
    overall: num(r.overall),
    flags: r.flags as QualityScores["flags"],
    raw: r.raw as unknown as QualityScores["raw"],
  }));
}

export async function saveQuality(key: { photoId: string; bookId: string; userId: string }, q: QualityScores): Promise<void> {
  const { error } = await createAdminClient()
    .from("photo_quality")
    .upsert(
      {
        photo_id: key.photoId,
        book_id: key.bookId,
        user_id: key.userId,
        version: q.version,
        sharpness: q.sharpness,
        exposure: q.exposure,
        composition: q.composition,
        overall: q.overall,
        flags: [...q.flags],
        raw: q.raw as unknown as Json,
        scored_at: new Date().toISOString(),
      },
      { onConflict: "photo_id" },
    );
  if (error) throw new PhotoOrganizeError("save quality", error.code);
}

/** saveQuality for several photos in ONE upsert (same rows, same conflict key). Throws on any error. */
export async function saveQualities(rows: readonly { key: { photoId: string; bookId: string; userId: string }; q: QualityScores }[]): Promise<void> {
  if (rows.length === 0) return;
  const scoredAt = new Date().toISOString();
  const { error } = await createAdminClient()
    .from("photo_quality")
    .upsert(
      rows.map(({ key, q }) => ({
        photo_id: key.photoId,
        book_id: key.bookId,
        user_id: key.userId,
        version: q.version,
        sharpness: q.sharpness,
        exposure: q.exposure,
        composition: q.composition,
        overall: q.overall,
        flags: [...q.flags],
        raw: q.raw as unknown as Json,
        scored_at: scoredAt,
      })),
      { onConflict: "photo_id" },
    );
  if (error) throw new PhotoOrganizeError("save qualities", error.code);
}

/** photoId → SHA-256 of its analysis copy, for photos the server verified (photo_ingest). */
export async function listImageHashes(bookId: string, userId: string): Promise<Map<string, string>> {
  const { data, error } = await createAdminClient().from("photo_ingest").select("photo_id, ai_copy_sha256").eq("book_id", bookId).eq("user_id", userId).eq("state", "verified");
  if (error) {
    if (missingTable(error.code)) return new Map();
    throw new PhotoOrganizeError("list image hashes", error.code);
  }
  return new Map(data.filter((r) => r.ai_copy_sha256).map((r) => [r.photo_id, r.ai_copy_sha256!]));
}

/** photoId → the stored vision analysis (photo_analyses, newest ok row per photo). No model call. */
export async function listVision(bookId: string, userId: string): Promise<Map<string, unknown>> {
  const { data, error } = await createAdminClient()
    .from("photo_analyses")
    .select("photo_id, analysis, created_at")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .eq("status", "ok")
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) {
    if (missingTable(error.code)) return new Map();
    throw new PhotoOrganizeError("list vision", error.code);
  }
  return new Map(data.map((r) => [r.photo_id, r.analysis as unknown]));
}

export async function listDuplicateGroups(bookId: string, userId: string): Promise<DuplicateGroup[]> {
  const { data, error } = await createAdminClient()
    .from("photo_duplicate_groups")
    .select("group_key, kind, photo_ids, preferred_photo_id, preferred_source, updated_at")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .order("updated_at", { ascending: true });
  if (error) {
    if (missingTable(error.code)) return [];
    throw new PhotoOrganizeError("list duplicate groups", error.code);
  }
  return data.map((r) => ({
    key: r.group_key,
    kind: r.kind === "exact" ? "exact" : "near",
    photoIds: r.photo_ids,
    preferredPhotoId: r.preferred_photo_id,
    preferredSource: r.preferred_source === "user" ? "user" : "auto",
  }));
}

/** Makes the stored groups of the book equal to `groups` (upsert by key, then remove the rest). */
export async function replaceDuplicateGroups(bookId: string, userId: string, groups: readonly DuplicateGroup[]): Promise<void> {
  const admin = createAdminClient();
  for (const batch of chunks([...groups])) {
    const { error } = await admin.from("photo_duplicate_groups").upsert(
      batch.map((g) => ({
        book_id: bookId,
        user_id: userId,
        group_key: g.key,
        kind: g.kind,
        photo_ids: g.photoIds,
        preferred_photo_id: g.preferredPhotoId,
        preferred_source: g.preferredSource,
      })),
      { onConflict: "book_id,group_key" },
    );
    if (error) throw new PhotoOrganizeError("save duplicate groups", error.code);
  }
  const keep = groups.map((g) => g.key);
  let del = admin.from("photo_duplicate_groups").delete().eq("book_id", bookId).eq("user_id", userId);
  if (keep.length) del = del.not("group_key", "in", `(${keep.join(",")})`);
  const { error } = await del;
  if (error) throw new PhotoOrganizeError("prune duplicate groups", error.code);
}

/** Records the user's "keep this one" for the group containing `photoId`. False when there is no such group. */
export async function setDuplicatePreference(bookId: string, userId: string, photoId: string): Promise<boolean> {
  if (!isUuid(photoId)) return false;
  const { data, error } = await createAdminClient()
    .from("photo_duplicate_groups")
    .update({ preferred_photo_id: photoId, preferred_source: "user" })
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .contains("photo_ids", [photoId])
    .select("id");
  if (error) throw new PhotoOrganizeError("set duplicate preference", error.code);
  return data.length > 0;
}

export type StoredMoment = Moment & { labelSource: "auto" | "user"; heroSource: "auto" | "user" };

export async function listMoments(bookId: string, userId: string): Promise<StoredMoment[]> {
  const { data, error } = await createAdminClient()
    .from("photo_moments")
    .select("moment_key, position, photo_ids, label, label_source, date_label, label_evidence, hero_photo_id, hero_source, starts_at, ends_at, place, confidence, uncertain, uncertain_reasons")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (error) {
    if (missingTable(error.code)) return [];
    throw new PhotoOrganizeError("list moments", error.code);
  }
  return data.map((r) => ({
    key: r.moment_key,
    position: r.position,
    photoIds: r.photo_ids,
    label: r.label,
    labelSource: r.label_source === "user" ? "user" : "auto",
    dateLabel: r.date_label,
    labelEvidence: r.label_evidence as unknown as Moment["labelEvidence"],
    heroPhotoId: r.hero_photo_id,
    heroSource: r.hero_source === "user" ? "user" : "auto",
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    place: r.place,
    confidence: num(r.confidence),
    uncertain: r.uncertain,
    uncertainReasons: r.uncertain_reasons as Moment["uncertainReasons"],
  }));
}

/** Makes the stored moments of the book equal to `moments` (upsert by key, then remove the rest). */
export async function replaceMoments(bookId: string, userId: string, moments: readonly StoredMoment[], version: number): Promise<void> {
  const admin = createAdminClient();
  for (const batch of chunks([...moments], 50)) {
    const { error } = await admin.from("photo_moments").upsert(
      batch.map((m) => ({
        book_id: bookId,
        user_id: userId,
        moment_key: m.key,
        position: m.position,
        photo_ids: m.photoIds,
        label: m.label.slice(0, 160),
        label_source: m.labelSource,
        date_label: m.dateLabel,
        label_evidence: m.labelEvidence as unknown as Json,
        hero_photo_id: m.heroPhotoId,
        hero_source: m.heroSource,
        starts_at: m.startsAt,
        ends_at: m.endsAt,
        place: m.place ? m.place.slice(0, 200) : null,
        confidence: m.confidence,
        uncertain: m.uncertain,
        uncertain_reasons: [...m.uncertainReasons],
        version,
      })),
      { onConflict: "book_id,moment_key" },
    );
    if (error) throw new PhotoOrganizeError("save moments", error.code);
  }
  const keep = moments.map((m) => `"${m.key}"`);
  let del = admin.from("photo_moments").delete().eq("book_id", bookId).eq("user_id", userId);
  if (keep.length) del = del.not("moment_key", "in", `(${keep.join(",")})`);
  const { error } = await del;
  if (error) throw new PhotoOrganizeError("prune moments", error.code);
}
