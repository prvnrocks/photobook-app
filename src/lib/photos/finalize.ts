import "server-only";
// Milestone 2 (T9, D-016, D-017): finalize a book after its uploads are ready.
//   1. owner check (getMyBook, RLS)            → null if missing / not owner
//   2. load ready photos (pending ones are ignored)
//   3. duplicate groups → write only changed dup_group values, batched per value
//   4. GPS clusters for photos without a place → reverse geocode ≤ MAX_CLUSTERS_PER_RUN
//      clusters per run (bounded concurrency + overall time budget) → write place
//   5. fallback album: only when books.doc is {} (conditional update, see writeDocIfEmpty)
//   6. return counts only
// Idempotent: a re-run with nothing new makes no geocoder calls and no writes.
// Privacy: never logs or returns coordinates, places, dates or ids — counts and codes only.

import { autolayout, type AutoPhoto } from "@/lib/autolayout";
import { limitsFor } from "@/lib/ai/limits";
import { CAPTION_LANGS, OCCASIONS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { getMyBook, writeDocIfEmpty, type MyBook } from "@/lib/db/books";
import {
  listReadyPhotosForFinalize,
  setPhotosDupGroup,
  setPhotosPlace,
  type FinalizePhotoRow,
} from "@/lib/db/photos";
import {
  reverseGeocode,
  reverseGeocodeMany,
  type ReverseGeocoder,
} from "@/lib/geo/reverse-geocode";
import { groupDuplicates } from "@/lib/photos/dupes";
import { clusterPoints } from "@/lib/photos/geo-cluster";
import type { Json } from "@/lib/supabase/database.types";

/** Max reverse-geocode requests (one per ~1 km cluster) per finalize run. */
export const MAX_CLUSTERS_PER_RUN = 50;
/** Overall time budget for geocoding in one run (route maxDuration is 60 s). */
export const GEOCODE_BUDGET_MS = 35_000;
const GEOCODE_CONCURRENCY = 4;

export type FinalizeDb = {
  getBook(bookId: string): Promise<MyBook | null>;
  listReadyPhotos(bookId: string): Promise<FinalizePhotoRow[]>;
  setDupGroup(bookId: string, ids: string[], dupGroup: number | null): Promise<void>;
  setPlace(bookId: string, ids: string[], place: string): Promise<void>;
  writeDocIfEmpty(
    bookId: string,
    doc: Json,
    pageCount: number,
    expectedUpdatedAt: string,
  ): Promise<boolean>;
};

export type FinalizeDeps = {
  geocoder?: ReverseGeocoder;
  db?: FinalizeDb;
  /** Geocoding time budget in ms (default GEOCODE_BUDGET_MS). */
  geocodeBudgetMs?: number;
  now?: () => number;
};

export type FinalizeResult = {
  /** Ready photos considered (pending uploads are ignored). */
  photos: number;
  /** Photos whose date came from EXIF. */
  withDate: number;
  withGps: number;
  /** Photos with a place after this run. */
  withPlace: number;
  /** GPS photos still without a place (cluster cap, time budget or geocode failure) — re-run to fill. */
  placesPending: number;
  dupGroups: number;
  dupPhotos: number;
  /** Page count of the doc written now, else the stored page_count. */
  pages: number;
  /** True only when this run wrote the fallback album. */
  wroteDoc: boolean;
  /** Existing doc references photos that are no longer ready/present (pruning is M5's job). */
  docStale: boolean;
};

export const defaultFinalizeDb: FinalizeDb = {
  getBook: getMyBook,
  listReadyPhotos: listReadyPhotosForFinalize,
  setDupGroup: setPhotosDupGroup,
  setPlace: setPhotosPlace,
  writeDocIfEmpty,
};

export function isEmptyDoc(doc: unknown): boolean {
  return (
    typeof doc === "object" &&
    doc !== null &&
    !Array.isArray(doc) &&
    Object.keys(doc as object).length === 0
  );
}

/** Photo ids referenced by a doc; null if the doc doesn't parse. */
function referencedPhotoIds(doc: unknown): Set<string> | null {
  const parsed = parseBookDoc(doc);
  if (!parsed.ok) return null;
  const ids = new Set<string>();
  if (parsed.doc.cover.photoId) ids.add(parsed.doc.cover.photoId);
  for (const page of parsed.doc.pages) {
    for (const slot of page.slots) if (slot.photoId) ids.add(slot.photoId);
  }
  return ids;
}

const asOccasion = (v: string | null): Occasion =>
  (OCCASIONS as readonly string[]).includes(v ?? "") ? (v as Occasion) : "other";
const asCaptionLang = (v: string): CaptionLang =>
  (CAPTION_LANGS as readonly string[]).includes(v) ? (v as CaptionLang) : "en";
const asDateSource = (v: string | null): AutoPhoto["dateSource"] =>
  v === "exif" || v === "file" ? v : null;
const positive = (v: number | null): number => (v !== null && Number.isFinite(v) && v > 0 ? v : 1);

function toAutoPhoto(p: FinalizePhotoRow): AutoPhoto {
  return {
    id: p.id,
    // Unknown dimensions → 1×1 (treated as square, fits any slot).
    width: positive(p.width),
    height: positive(p.height),
    takenAt: p.taken_at,
    dateSource: asDateSource(p.date_source),
    place: p.place,
    status: p.status === "dropped" ? "dropped" : "kept",
    dupGroup: p.dup_group,
    blurScore: p.blur_score,
  };
}

const hasGps = (p: FinalizePhotoRow) => p.lat !== null && p.lng !== null;

/**
 * Runs the finalize steps for one of the current user's books.
 * Returns null when the id is malformed, the book is missing or not the caller's.
 * Throws BooksQueryError / PhotosQueryError (code only) on database errors.
 */
export async function finalizeBook(
  bookId: string,
  deps: FinalizeDeps = {},
): Promise<FinalizeResult | null> {
  const db = deps.db ?? defaultFinalizeDb;
  const now = deps.now ?? Date.now;

  // 1. Owner check.
  const book = await db.getBook(bookId);
  if (!book) return null;

  // 2. Ready photos only (copies, so later steps can update them in memory).
  const photos = (await db.listReadyPhotos(book.id)).map((p) => ({ ...p }));

  // 3. Duplicate groups — write only changed values, one batch per new value.
  const groups = groupDuplicates(
    photos.map((p) => ({
      id: p.id,
      phash: p.phash,
      takenAt: p.taken_at,
      dateSource: asDateSource(p.date_source),
    })),
  );
  const changes = new Map<number | null, string[]>();
  for (const p of photos) {
    const next = groups.get(p.id) ?? null;
    if (next === p.dup_group) continue;
    const list = changes.get(next);
    if (list) list.push(p.id);
    else changes.set(next, [p.id]);
    p.dup_group = next;
  }
  for (const [value, ids] of changes) await db.setDupGroup(book.id, ids, value);

  // 4. Places for GPS photos that don't have one yet.
  const needPlace = photos.filter((p) => hasGps(p) && p.place === null);
  if (needPlace.length > 0) {
    const clusters = clusterPoints(
      needPlace.map((p) => ({ id: p.id, lat: p.lat as number, lng: p.lng as number })),
    ).slice(0, MAX_CLUSTERS_PER_RUN);

    const deadline = now() + (deps.geocodeBudgetMs ?? GEOCODE_BUDGET_MS);
    const budgetSignal = AbortSignal.timeout(Math.max(0, deadline - now()));
    const base: ReverseGeocoder =
      deps.geocoder ?? ((lat, lng) => reverseGeocode(lat, lng, { signal: budgetSignal }));
    // Once the budget is spent, remaining clusters are skipped (stay pending for a re-run).
    const geocoder: ReverseGeocoder = (lat, lng) =>
      now() >= deadline ? Promise.resolve(null) : base(lat, lng);

    const labels = await reverseGeocodeMany(
      clusters.map((c) => c.centroid),
      { geocoder, concurrency: GEOCODE_CONCURRENCY },
    );

    const byId = new Map(photos.map((p) => [p.id, p]));
    for (let i = 0; i < clusters.length; i++) {
      const label = labels[i];
      if (!label) continue;
      await db.setPlace(book.id, clusters[i].ids, label);
      for (const id of clusters[i].ids) {
        const p = byId.get(id);
        if (p && p.place === null) p.place = label;
      }
    }
  }

  // 5. Fallback album only when the doc is still {} (D-016).
  let wroteDoc = false;
  let docStale = false;
  let pages = book.page_count;
  const readyIds = new Set(photos.map((p) => p.id));

  if (isEmptyDoc(book.doc)) {
    const isPaid = book.is_paid;
    const doc: BookDoc = autolayout(photos.map(toAutoPhoto), {
      occasion: asOccasion(book.occasion),
      title: book.title,
      captionLang: asCaptionLang(book.caption_lang),
      isPaid,
    });
    const parsed = parseBookDoc(doc);
    const issues = parsed.ok
      ? validateBookDoc(parsed.doc, { photoIds: readyIds, maxPages: limitsFor(isPaid).maxPages })
      : parsed.issues;
    if (issues.length > 0) {
      console.error(`[finalize] fallback album failed validation (${issues.length} issues)`);
    } else {
      wroteDoc = await db.writeDocIfEmpty(
        book.id,
        doc as unknown as Json,
        doc.pages.length,
        book.updated_at,
      );
      if (wroteDoc) pages = doc.pages.length;
    }
  } else {
    const refs = referencedPhotoIds(book.doc);
    // An unparsable doc can't be trusted either — report it as stale.
    docStale = refs === null || [...refs].some((id) => !readyIds.has(id));
  }

  // 6. Counts only.
  const dupGroupIds = new Set<number>();
  for (const p of photos) if (p.dup_group !== null) dupGroupIds.add(p.dup_group);
  return {
    photos: photos.length,
    withDate: photos.filter((p) => p.date_source === "exif").length,
    withGps: photos.filter(hasGps).length,
    withPlace: photos.filter((p) => p.place !== null).length,
    placesPending: photos.filter((p) => hasGps(p) && p.place === null).length,
    dupGroups: dupGroupIds.size,
    dupPhotos: photos.filter((p) => p.dup_group !== null).length,
    pages,
    wroteDoc,
    docStale,
  };
}
