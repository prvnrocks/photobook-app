import "server-only";
// One signed cover thumb for a single book (M21 share preview): doc.cover.photoId, else the
// first photo slot on any page (the dashboard card only looks at page 1's first slot). RLS client throughout
// (photos_select_own + storage owner policies) — the photo must exist, be ready, belong to this
// book and have a thumb. Best effort: any problem → null, never a throw (the page must render
// without a picture rather than fail). No logging (nothing here is worth a line, and ids / paths
// must not reach logs anyway).

import { COVER_THUMB_TTL_SECONDS } from "@/lib/db/books";
import { PHOTOS_BUCKET } from "@/lib/db/photos";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

function photoIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { photoId?: unknown }).photoId;
  return typeof id === "string" && isUuid(id) ? id : null;
}

/**
 * The photo the preview shows: doc.cover.photoId, else the first slot (page order, slot order)
 * holding a photo. Reads the raw doc loosely — a malformed doc just yields null.
 */
export function coverPhotoIdOfDoc(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return null;
  const cover = photoIdOf((doc as { cover?: unknown }).cover);
  if (cover) return cover;
  const pages = (doc as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return null;
  for (const page of pages) {
    const slots = page && typeof page === "object" ? (page as { slots?: unknown }).slots : null;
    if (!Array.isArray(slots)) continue;
    for (const slot of slots) {
      const id = photoIdOf(slot);
      if (id) return id;
    }
  }
  return null;
}

/** The cover photo as the renderer takes it: signed 512px thumb + ORIGINAL pixel size (crop math). */
export type CoverPhoto = { photoId: string; url: string; width: number | null; height: number | null };

/**
 * The book's cover photo (see coverPhotoIdOfDoc) with a signed URL (COVER_THUMB_TTL_SECONDS) of
 * its 512px thumb, or null when there is none / the photo is gone, not ready, not this book's,
 * has no thumb / signing failed. One photos lookup + ONE createSignedUrl call, user client.
 */
export async function getCoverPhoto(bookId: string, doc: unknown): Promise<CoverPhoto | null> {
  if (!isUuid(bookId)) return null;
  const photoId = coverPhotoIdOfDoc(doc);
  if (!photoId) return null;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("photos")
      .select("id, book_id, thumb_path, width, height")
      .eq("id", photoId)
      .eq("upload_state", "ready")
      .maybeSingle();
    if (error || !data || data.book_id !== bookId || !data.thumb_path) return null;
    const { data: signed, error: signError } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .createSignedUrl(data.thumb_path, COVER_THUMB_TTL_SECONDS);
    if (signError || !signed?.signedUrl) return null;
    return { photoId, url: signed.signedUrl, width: data.width ?? null, height: data.height ?? null };
  } catch {
    return null;
  }
}

/** Signed thumb URL of the cover photo only (getCoverPhoto().url), or null. */
export async function getCoverThumbUrl(bookId: string, doc: unknown): Promise<string | null> {
  return (await getCoverPhoto(bookId, doc))?.url ?? null;
}
