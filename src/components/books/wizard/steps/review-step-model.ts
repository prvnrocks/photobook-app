// Pure helpers for wizard step 7 "Review your book" (M20 T8, D-072). No React, no server imports:
// what the hero summary shows (chapters, caption picks, cover), whether "Generate album" must first
// re-lay out the album (updateAlbumAction) and how its answer is treated. Text only — never photo
// content or AI descriptions (those aren't in the step data).

import {
  captionTextAttrs,
  captionsPreviewModel,
  countKept,
  unsyncedPhotoIds,
  type CaptionsPreviewDoc,
  type PreviewCaptionSource,
  type ReviewTilePhoto,
  type UpdateAlbumResult,
} from "@/lib/review/ui";

export type ReviewChapter = { title: string; dateLabel: string; pages: number };

/** Chapters with a title or a date, in album order, with their page counts. */
export function reviewChapters(preview: CaptionsPreviewDoc | null | undefined): ReviewChapter[] {
  if (!preview) return [];
  const pages = new Array<number>(preview.chapters.length).fill(0);
  for (const p of preview.pages) if (p.chapter !== null && p.chapter >= 0 && p.chapter < pages.length) pages[p.chapter] += 1;
  return preview.chapters
    .map((c, i) => ({ title: c.title, dateLabel: c.dateLabel, pages: pages[i] }))
    .filter((c) => c.title || c.dateLabel);
}

export type ReviewCaptionPick = {
  text: string;
  source: PreviewCaptionSource;
  chapter: string | null;
  lang: "ar" | undefined;
  arabicFont: boolean;
};

/** The first `n` captions of the album (page order), with their chapter title and font attrs. */
export function reviewCaptionPicks(
  preview: CaptionsPreviewDoc | null | undefined,
  captionLang: string,
  n = 3,
): ReviewCaptionPick[] {
  const model = captionsPreviewModel(preview);
  if (!model) return [];
  const out: ReviewCaptionPick[] = [];
  for (const g of model.groups) {
    for (const item of g.items) {
      if (out.length >= n) return out;
      out.push({ text: item.text, source: item.source, chapter: g.title, ...captionTextAttrs(item.text, captionLang) });
    }
  }
  return out;
}

/** The cover photo's thumb: the album cover, else none (never a guess — the cover is the album's). */
export function coverThumb(photos: readonly ReviewTilePhoto[], coverPhotoId: string | null): string | null {
  if (!coverPhotoId) return null;
  return photos.find((p) => p.id === coverPhotoId)?.thumbUrl ?? null;
}

/**
 * Must "Generate album" re-lay out the album first? Yes when a keep / leave-out choice isn't in the
 * album yet (unsyncedPhotoIds, the classic review rule), or when there is no album yet but photos
 * are kept (Update album writes a fresh rule album). Never for a user-edited album or while building.
 */
export function needsAlbumUpdate(
  photos: readonly ReviewTilePhoto[],
  albumPhotoIds: readonly string[],
  opts: { userEdited: boolean; building: boolean },
): boolean {
  if (opts.userEdited || opts.building) return false;
  const ids = new Set(albumPhotoIds);
  if (ids.size === 0) return countKept(photos) > 0;
  return unsyncedPhotoIds(photos, ids, { hasAlbum: true, userEdited: false, building: false }).length > 0;
}

/** A key for the current choices: an update for this key already succeeded → skip it on a retry. */
export function choicesKey(photos: readonly Pick<ReviewTilePhoto, "id" | "status">[]): string {
  return photos.map((p) => `${p.id}:${p.status === "dropped" ? 0 : 1}`).join(",");
}

/**
 * What Generate does with updateAlbumAction's answer: go on to the editor, or stop with a message.
 * user_edited / busy go on (the album can't or needn't change now — the editor shows the book as
 * it is); signed_out goes on too (confirmAlbumAction sends the user to sign in).
 */
export function updateStepOutcome(result: UpdateAlbumResult | null): { go: true } | { go: false; message: string } {
  if (result?.ok) return { go: true };
  const error = result ? result.error : "failed";
  if (error === "user_edited" || error === "busy" || error === "signed_out") return { go: true };
  if (error === "not_found") return { go: false, message: "We couldn't find this book. Please reload the page." };
  if (error === "unsupported_design") return { go: false, message: "This book's design style isn't available yet." };
  return { go: false, message: "We couldn't apply your photo changes. Check your connection and try again." };
}

export const OPEN_FAILED_MESSAGE = "We couldn't open your book just now. Your photos are safe — please try again.";

/** "AI kept 42 of 50 photos" / "42 of 50 photos in your book" (matches the classic headerCopy). */
export function heroCountCopy(aiUsed: boolean, kept: number, total: number): string {
  return aiUsed ? `AI kept ${kept} of ${total} photos` : `${kept} of ${total} photos in your book`;
}

/** The line under the counter — honest about how the album was made (classic review wording). */
export function heroSubline(aiUsed: boolean): string {
  return aiUsed
    ? "AI picked the best shots, grouped them into moments and wrote the captions. You decide what stays."
    : "We sorted these by date and place and left out duplicates and very blurry shots. You decide what stays.";
}

export function pagesCopy(n: number): string {
  return n === 1 ? "1 page" : `${n} pages`;
}
