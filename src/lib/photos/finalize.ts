import "server-only";
// Milestone 2 (T9, D-016, D-017): finalize a book after its uploads are ready.
//   1. owner check (getMyBook, RLS)            → null if missing / not owner
//   1b. rate limit: one run per book per FINALIZE_MIN_INTERVAL_S (atomic claim in
//      private.finalize_runs) → { rateLimited, retryAfterSeconds } (route → 429)
//   2. load ready photos (pending ones are ignored)
//   3. duplicate groups → write only changed dup_group values, batched per value
//   4. GPS clusters for photos without a place that were not tried in the last
//      PLACE_RECHECK_MS → reverse geocode ≤ MAX_CLUSTERS_PER_RUN clusters per run and
//      ≤ GEOCODE_DAILY_CAP per book per UTC day (reserved up front), bounded
//      concurrency + overall time budget → write place, and place_checked_at for
//      every attempted cluster whatever the result (so failures aren't retried forever)
//   5. fallback album: only when books.doc is {} (conditional update, see writeDocIfEmpty)
//   6. return counts only
// Writes of server-only photo columns (dup_group, place, place_checked_at) and the
// rate-limit RPCs use the admin client (src/lib/db/photos.ts, finalize-runs.ts) — only
// after step 1 proved ownership, always filtered by book_id.
// Idempotent: a re-run with nothing new makes no geocoder calls and no writes.
// Privacy: never logs or returns coordinates, places, dates or ids — counts and codes only.

import { autolayout, type AutoPhoto } from "@/lib/autolayout";
import { limitsFor } from "@/lib/ai/limits";
import { CAPTION_LANGS, OCCASIONS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { bookDesignOf, withBookDesign } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { getMyBook, writeDocIfEmpty, type MyBook } from "@/lib/db/books";
import { claimFinalizeRun, reserveGeocodeCalls, type ClaimResult } from "@/lib/db/finalize-runs";
import {
  listReadyPhotosForFinalize,
  setPhotosDupGroup,
  setPhotosPlace,
  setPhotosPlaceChecked,
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
/** Minimum seconds between two finalize runs of the same book. */
export const FINALIZE_MIN_INTERVAL_S = 10;
/** Max reverse-geocode requests (clusters attempted) per book per UTC day. */
export const GEOCODE_DAILY_CAP = 200;
/** A photo whose geocode attempt failed is retried only after this long. */
export const PLACE_RECHECK_MS = 24 * 60 * 60 * 1000;

export type FinalizeDb = {
  getBook(bookId: string): Promise<MyBook | null>;
  claimRun(bookId: string, minIntervalSeconds: number): Promise<ClaimResult>;
  reserveGeocodeCalls(bookId: string, want: number, dailyCap: number): Promise<number>;
  setPlaceChecked(bookId: string, ids: string[], checkedAt: string): Promise<void>;
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
  /**
   * GPS photos without a place that a re-run would try (not attempted in the last 24 h:
   * skipped by the cluster cap, time budget or daily cap). Failed attempts don't count.
   */
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

/** Another run of this book started less than FINALIZE_MIN_INTERVAL_S ago. */
export type FinalizeRateLimited = { rateLimited: true; retryAfterSeconds: number };

export const defaultFinalizeDb: FinalizeDb = {
  getBook: getMyBook,
  claimRun: claimFinalizeRun,
  reserveGeocodeCalls,
  setPlaceChecked: setPhotosPlaceChecked,
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
    if (page.background?.kind === "photo") ids.add(page.background.photoId);
  }
  // Photo backgrounds (M10a) count too: a missing one makes the doc stale as well.
  if (parsed.doc.style.background.kind === "photo") ids.add(parsed.doc.style.background.photoId);
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
 * Returns null when the id is malformed, the book is missing or not the caller's, and
 * { rateLimited } when the book was finalized less than FINALIZE_MIN_INTERVAL_S ago.
 * Throws BooksQueryError / PhotosQueryError / FinalizeRunsQueryError (code only) on
 * database errors.
 */
export async function finalizeBook(
  bookId: string,
  deps: FinalizeDeps = {},
): Promise<FinalizeResult | FinalizeRateLimited | null> {
  const db = deps.db ?? defaultFinalizeDb;
  const now = deps.now ?? Date.now;

  // 1. Owner check.
  const book = await db.getBook(bookId);
  if (!book) return null;

  // 1b. Rate limit (after the owner check: the claim uses the admin client).
  const claim = await db.claimRun(book.id, FINALIZE_MIN_INTERVAL_S);
  if (!claim.ok) return { rateLimited: true, retryAfterSeconds: claim.retryAfterSeconds };

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

  // 4. Places for GPS photos that don't have one and weren't tried recently.
  const recheckBefore = now() - PLACE_RECHECK_MS;
  const wantsPlace = (p: FinalizePhotoRow) =>
    hasGps(p) &&
    p.place === null &&
    (p.place_checked_at === null || !(Date.parse(p.place_checked_at) >= recheckBefore));
  const needPlace = photos.filter(wantsPlace);
  if (needPlace.length > 0) {
    const allClusters = clusterPoints(
      needPlace.map((p) => ({ id: p.id, lat: p.lat as number, lng: p.lng as number })),
    );
    const want = Math.min(allClusters.length, MAX_CLUSTERS_PER_RUN);
    const granted = await db.reserveGeocodeCalls(book.id, want, GEOCODE_DAILY_CAP);
    const clusters = allClusters.slice(0, Math.max(0, Math.min(granted, want)));

    if (clusters.length > 0) {
      const deadline = now() + (deps.geocodeBudgetMs ?? GEOCODE_BUDGET_MS);
      const budgetSignal = AbortSignal.timeout(Math.max(0, deadline - now()));
      const geocoder: ReverseGeocoder =
        deps.geocoder ?? ((lat, lng) => reverseGeocode(lat, lng, { signal: budgetSignal }));
      const attempted = new Array<boolean>(clusters.length).fill(false);

      // Once the budget is spent, remaining clusters are not started (stay pending).
      const labels = await reverseGeocodeMany(
        clusters.map((c) => c.centroid),
        {
          geocoder,
          concurrency: GEOCODE_CONCURRENCY,
          shouldStart: () => now() < deadline,
          onAttempt: (i) => {
            attempted[i] = true;
          },
        },
      );

      const byId = new Map(photos.map((p) => [p.id, p]));
      const checkedIds: string[] = [];
      for (let i = 0; i < clusters.length; i++) {
        if (!attempted[i]) continue;
        checkedIds.push(...clusters[i].ids);
        const label = labels[i];
        if (!label) continue;
        await db.setPlace(book.id, clusters[i].ids, label);
        for (const id of clusters[i].ids) {
          const p = byId.get(id);
          if (p && p.place === null) p.place = label;
        }
      }
      if (checkedIds.length > 0) {
        const at = new Date(now()).toISOString();
        await db.setPlaceChecked(book.id, checkedIds, at);
        for (const id of checkedIds) {
          const p = byId.get(id);
          if (p) p.place_checked_at = at;
        }
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
    // D-063: format + design style from books.format / books.design_style (M10b A6).
    const design = bookDesignOf(book);
    const doc: BookDoc = withBookDesign(
      autolayout(photos.map(toAutoPhoto), {
        occasion: asOccasion(book.occasion),
        title: book.title,
        captionLang: asCaptionLang(book.caption_lang),
        isPaid,
        design,
      }),
      design,
    );
    const parsed = parseBookDoc(doc);
    const issues = parsed.ok
      ? validateBookDoc(parsed.doc, { photoIds: readyIds, maxPages: limitsFor(isPaid).maxPages })
      : parsed.issues;
    if (issues.length > 0) {
      console.error(`[finalize] fallback album failed validation (${issues.length} issues)`);
    } else {
      wroteDoc = await db.writeDocIfEmpty(
        book.id,
        serializeDoc(doc) as unknown as Json,
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
    placesPending: photos.filter(wantsPlace).length,
    dupGroups: dupGroupIds.size,
    dupPhotos: photos.filter((p) => p.dup_group !== null).length,
    pages,
    wroteDoc,
    docStale,
  };
}
