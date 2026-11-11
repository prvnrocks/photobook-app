// Removing references to photos that no longer exist from a book doc (M10a review B1 / S3,
// M10b A19 review S2). Pure, no I/O. Safe on client and server.
//
// - stripMissingBackgrounds (strip-backgrounds.ts, re-exported): photo backgrounds whose photo is
//   gone. Book default → white colour (style default when it was an AI pick), page override → removed.
// - stripPhotoFromDoc: everything that points at one deleted photo. The cover photo → null; its
//   backgrounds go as above; and the pages that held it REFLOW per D-028 rule 1 (M10b A19),
//   reusing relayout's removal step (removeSlotPhotos):
//     · a page that loses its photo refits to the best smaller layout of the book's format + style
//       (photo order + crops kept, page id kept; an AI caption goes when the page is re-fitted,
//       D-031 — a user caption is kept, preferring layouts with a caption area);
//     · a spread that loses a photo becomes a smaller spread of the style when every photo fits
//       (one-photo spread only for a panorama), else its twins / the halves that still hold photos;
//     · a page / spread left with no photos and no user caption is removed (a spread as one unit);
//       with a user caption it stays (single page: emptied slots; spread: its caption half's twin);
//     · chapters that lose all their pages are removed; then repairSpreads (D-064) re-aligns any
//       later spread pushed onto a right-hand page (split into twins, photos + captions kept).
//   Safety: if the reflow would lose any user caption, produce an invalid doc, or the design has
//   no layouts (UnsupportedDesignError — none since M10c T10), the doc falls back to the
//   M10a behaviour — slot photoId → null, pages untouched — so a photo delete never fails.
// Both return the input object unchanged (changed:false) when nothing references the photo.

import { pruneAiBackgrounds } from "@/lib/design/background-suggest";
import { removeSlotPhotos, type RelayoutPhoto } from "./relayout";
import { parseBookDoc, validateBookDoc } from "./schema";
import { repairSpreads } from "./spreads";
import { stripMissingBackgrounds, type StripResult } from "./strip-backgrounds";
import type { BookDoc, BookPage } from "./types";

export { FALLBACK_BOOK_BACKGROUND, stripMissingBackgrounds, type StripResult } from "./strip-backgrounds";

/** Pixel size (and date) of a remaining photo, for orientation fitting. Unknown ids fit any slot. */
export interface StripPhotoDims {
  id: string;
  width: number | null;
  height: number | null;
  takenAt?: string | null;
}

export interface StripPhotoResult extends StripResult {
  /** True when pages were re-laid out (false: nothing on pages, or the null-out fallback). */
  reflowed: boolean;
}

/** The M10a behaviour: cover/slot photoId → null (layouts unchanged), backgrounds removed. */
function nullOut(doc: BookDoc, photoId: string): StripResult {
  let changed = false;
  let cover = doc.cover;
  if (cover.photoId === photoId) {
    cover = { ...cover, photoId: null };
    changed = true;
  }
  const pages = doc.pages.map((page) => {
    if (!page.slots.some((s) => s.photoId === photoId)) return page;
    changed = true;
    return { ...page, slots: page.slots.map((s) => (s.photoId === photoId ? { ...s, photoId: null } : s)) };
  });
  const bg = stripMissingBackgrounds({ ...doc, cover, pages }, (id) => id !== photoId);
  if (!changed && !bg.changed) return { doc, changed: false };
  return { doc: bg.doc, changed: true };
}

/** Sequential page ids ("p7") that don't clash with existing ones. */
function pageIdAllocator(pages: readonly BookPage[]): () => string {
  const taken = new Set(pages.map((p) => p.id));
  let n = pages.length + 1;
  return () => {
    while (taken.has(`p${n}`)) n++;
    const id = `p${n}`;
    taken.add(id);
    return id;
  };
}

/** User caption texts with multiplicity (sorted) — the reflow must keep every one. */
function userCaptions(doc: BookDoc): string[] {
  return doc.pages
    .flatMap((p) => (p.caption?.source === "user" ? [p.caption.text] : []))
    .sort();
}

const positive = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1);

/**
 * Removes every reference to `photoId` and reflows the pages that held it (see the file header).
 * `photos` = the book's remaining photos with their pixel sizes (orientation fitting); a photo
 * missing from it counts as square (fits any slot).
 */
export function stripPhotoFromDoc(doc: BookDoc, photoId: string, photos: readonly StripPhotoDims[] = []): StripPhotoResult {
  const onPages = doc.pages.some((p) => p.slots.some((s) => s.photoId === photoId));
  if (!onPages) return { ...nullOut(doc, photoId), reflowed: false };
  try {
    const reflowed = reflow(doc, photoId, photos);
    if (reflowed) return { doc: reflowed, changed: true, reflowed: true };
  } catch {
    // UnsupportedDesignError (no layouts for the style) or any unexpected layout gap → fallback.
  }
  return { ...nullOut(doc, photoId), reflowed: false };
}

function reflow(doc: BookDoc, photoId: string, photos: readonly StripPhotoDims[]): BookDoc | null {
  const dims = new Map(photos.map((p) => [p.id, p]));
  const photo = (id: string): RelayoutPhoto => {
    const d = dims.get(id);
    return {
      id,
      width: positive(d?.width),
      height: positive(d?.height),
      takenAt: d?.takenAt ?? null,
      status: "kept",
      place: null,
      dupGroup: null,
      blurScore: null,
    };
  };
  const design = { format: doc.format, designStyle: doc.style.designStyle ?? "classic" };
  const removal = removeSlotPhotos(doc, {
    keep: (id) => id !== photoId,
    photo,
    design,
    nextPageId: pageIdAllocator(doc.pages),
    keepUserCaptionPages: true,
  });

  // Chapters that lost all their pages go (as Update album, D-028 rule 4).
  const hadPages = new Set(doc.pages.map((p) => p.chapterId));
  const hasPages = new Set(removal.pages.map((p) => p.chapterId));
  const chapters = doc.chapters.filter((c) => !hadPages.has(c.id) || hasPages.has(c.id));
  // A user-edited album never loses a chapter (its title may be user-typed; chapters carry no
  // source) — fall back to the M10a null-out, which keeps the page with an empty slot.
  if (doc.meta?.userEdited === true && chapters.length < doc.chapters.length) return null;
  const cover = doc.cover.photoId === photoId ? { ...doc.cover, photoId: null } : doc.cover;

  const bg = stripMissingBackgrounds({ ...doc, cover, chapters, pages: removal.pages }, (id) => id !== photoId);
  // AI photo backgrounds stay only on their chapter's first page (M10c T11): a removed or split
  // opener must not leave one on a later page.
  const out = pruneAiBackgrounds(repairSpreads(bg.doc).doc, (id) => id !== photoId).doc;

  // Never lose a user caption; never write a doc that fails validation.
  const before = userCaptions(doc);
  const after = userCaptions(out);
  if (before.length !== after.length || before.some((t, i) => t !== after[i])) return null;
  const parsed = parseBookDoc(out);
  if (!parsed.ok) return null;
  const slotIds = new Set<string>();
  for (const p of doc.pages) for (const s of p.slots) if (s.photoId !== null && s.photoId !== photoId) slotIds.add(s.photoId);
  if (doc.cover.photoId !== null && doc.cover.photoId !== photoId) slotIds.add(doc.cover.photoId);
  const bgIds = new Set<string>(slotIds);
  for (const b of [doc.style.background, ...doc.pages.map((p) => p.background)]) {
    if (b?.kind === "photo" && b.photoId !== photoId) bgIds.add(b.photoId);
  }
  const issues = validateBookDoc(parsed.doc, {
    photoIds: slotIds,
    backgroundPhotoIds: bgIds,
    maxPages: Math.max(1, doc.pages.length),
  });
  if (issues.length > 0) return null;
  return out; // validated; untouched pages stay the same objects
}
