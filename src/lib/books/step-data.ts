import "server-only";
// Data shared by the photos / build / review screens (M20 T1): the classic pages
// (src/app/books/[id]/{upload,build,review}/page.tsx) and the wizard's steps 5–7
// (src/lib/books/wizard-data.ts → GET /api/books/[id]/wizard) read and derive through the same
// helpers, so both show the same thing. Callers check ownership first (getMyBook under RLS).
// Only ids, counts, signed thumb URLs and caption text leave here — never AI descriptions or
// storage paths.

import type { AiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { docOrigin } from "@/lib/book/replaceable";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { countLiveRebuilds, getActiveRunForBook, type OwnerRun } from "@/lib/db/agent-runs";
import { getBookForRun, type MyBook } from "@/lib/db/books";
import { listReviewPhotos, type UploadStateRow } from "@/lib/db/photos";
import { hasCaptionArea } from "@/lib/layouts";
import {
  aiPicked,
  albumEditedByUser,
  captionsPreviewModel,
  captionsPreviewOf,
  docPhotoIds,
  partialCaptionsNote,
  rebuildsLeft,
  rebuildVariant,
  reviewBanner,
  type CaptionsPreviewDoc,
  type RebuildVariant,
  type ReviewBanner,
  type ReviewTilePhoto,
} from "@/lib/review/ui";
import { draftPreviewItems, draftPreviewPhotoIds, FAN_PHOTOS, fanPhotoUrls } from "@/lib/runs/draft-preview";
import type { ExistingPhoto } from "@/lib/upload/queue";

// --- Photos (step 5) ---------------------------------------------------------------------------

/** books.doc holds an album (anything but null / `{}` / an array). */
export function docHasContent(doc: unknown): boolean {
  return doc !== null && typeof doc === "object" && !Array.isArray(doc) && Object.keys(doc).length > 0;
}

/** The Uploader's resume list (D-013) and its ready / pending counts. */
export function uploadExisting(rows: readonly UploadStateRow[]): {
  existing: ExistingPhoto[];
  readyCount: number;
  pendingCount: number;
} {
  const existing: ExistingPhoto[] = rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint,
    upload_state: r.upload_state === "ready" ? "ready" : "pending",
  }));
  const readyCount = existing.filter((r) => r.upload_state === "ready").length;
  return { existing, readyCount, pendingCount: existing.length - readyCount };
}

// --- Build (step 6) ----------------------------------------------------------------------------

/** The stored album as a draft preview, or null (empty / unparsable doc → checklist only). */
export function draftDoc(raw: unknown): BookDoc | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) return null;
  const parsed = parseBookDoc(raw);
  return parsed.ok && parsed.doc.pages.length > 0 ? parsed.doc : null;
}

/**
 * Photo fan of the wizard build step: the draft's first photos (cover first) as signed 512 px
 * thumbs. A few spares are signed in case some aren't. No draft / a read error → [].
 */
export async function loadFanUrls(bookId: string, doc: BookDoc | null): Promise<string[]> {
  if (!doc) return [];
  const wanted = draftPreviewPhotoIds(doc, draftPreviewItems(doc)).slice(0, FAN_PHOTOS * 2);
  const photos = await listReviewPhotos(bookId, wanted).catch(() => null);
  return photos ? fanPhotoUrls(wanted, photos) : [];
}

// --- Review (step 7) ---------------------------------------------------------------------------

export type ReviewState = {
  /** Only what the grid needs — never AI descriptions (not loaded) or storage paths. */
  tiles: ReviewTilePhoto[];
  activeRun: OwnerRun | null;
  /** books.ai_status picked the photos (done / partial). */
  aiUsed: boolean;
  /** Editor saves / user captions / user backgrounds → only "Continue in the editor" (D-037 #2). */
  userEdited: boolean;
  /** D-028: the album's photo ids (page slots + cover) — ids only, never the rest of the doc. */
  albumPhotoIds: string[];
  /** Chapter titles/dates + caption text/source per page — no photo ids or URLs. */
  captionsPreview: CaptionsPreviewDoc;
  banner: ReviewBanner;
  captionsNote: string | null;
  variant: RebuildVariant;
  /** Live runs only (D-021); null when rebuilds aren't limited. */
  rebuildsLeft: number | null;
};

/**
 * Everything the review screen derives from the DB (photos, ai_status, active run, rebuild count).
 * Throws on a read error (the page's error boundary / the API route's 503). Does NOT touch the
 * warned-draft clock — the caller does that once (touchWarnedDraft) after its ownership check.
 */
export async function loadReviewState(book: Pick<MyBook, "id" | "doc" | "is_paid">, aiMode: AiMode): Promise<ReviewState> {
  const [photos, forRun, activeRun, usedRebuilds] = await Promise.all([
    listReviewPhotos(book.id),
    getBookForRun(book.id),
    getActiveRunForBook(book.id),
    aiMode === "live" ? countLiveRebuilds(book.id) : Promise.resolve(0),
  ]);
  const aiStatus = forRun?.ai_status ?? "idle";
  const aiAvailable = aiMode !== "off";
  const captionsPreview = captionsPreviewOf(book.doc, hasCaptionArea);
  const missingCaptions = captionsPreviewModel(captionsPreview)?.missing ?? 0;
  const { generator } = docOrigin(book.doc);
  // Partial runs: the banner depends on whether the AI album was used and captions are missing.
  const banner = reviewBanner({ activeRun: !!activeRun, aiAvailable, aiStatus, generator, missingCaptions });
  const tiles: ReviewTilePhoto[] = photos.map((p) => ({
    id: p.id,
    status: p.status,
    dropReason: p.dropReason,
    userOverride: p.userOverride,
    dupGroup: p.dupGroup,
    width: p.width,
    height: p.height,
    thumbUrl: p.thumbUrl,
  }));
  return {
    tiles,
    activeRun,
    aiUsed: aiPicked(aiStatus),
    userEdited: albumEditedByUser(book.doc),
    albumPhotoIds: docPhotoIds(book.doc),
    captionsPreview,
    banner,
    captionsNote: banner ? partialCaptionsNote(banner, missingCaptions) : null,
    variant: rebuildVariant({ aiAvailable, aiStatus }),
    rebuildsLeft: aiMode === "live" ? rebuildsLeft(limitsFor(book.is_paid).maxRebuilds, usedRebuilds) : null,
  };
}

/** The album cover's photo id (loose read of books.doc; anything unexpected → null). */
export function coverPhotoIdOf(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const cover = (doc as { cover?: unknown }).cover;
  if (typeof cover !== "object" || cover === null) return null;
  const id = (cover as { photoId?: unknown }).photoId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
