// The editor's "Replace photo" on a composed storybook page (Task 7, requirement 15). Pure edit op:
// one call = one undo step (ctx.actions.edit). Books that are not composed storybooks (no
// doc.meta.story) — every existing album — keep the plain replacePhoto behaviour exactly.

import { replacePhoto } from "@/lib/book/edit-ops";
import type { BookDoc } from "@/lib/book/types";
import { replacePhotoAndRelayout } from "./relayout";
import type { ComposePhoto } from "./types";

/**
 * Replace the photo in `pageIdx` / `slotIdx`: on a composed storybook page with a photo that is not
 * on another page, replacePhotoAndRelayout (re-selects that page's template when the new photo no
 * longer fits); otherwise — swaps, removals, ordinary albums — edit-ops replacePhoto.
 */
export function replaceSlotPhoto(
  doc: BookDoc,
  pageIdx: number,
  slotIdx: number,
  photoId: string | null,
  photos: ReadonlyMap<string, Pick<ComposePhoto, "width" | "height">>,
  lang: "en" | "ar",
): BookDoc {
  const page = doc.pages[pageIdx];
  const usedElsewhere = photoId !== null && doc.pages.some((p, k) => p.slots.some((s, j) => s.photoId === photoId && !(k === pageIdx && j === slotIdx)));
  if (!doc.meta?.story || !page || photoId === null || usedElsewhere) return replacePhoto(doc, pageIdx, slotIdx, photoId);
  const sizes = new Map<string, ComposePhoto>([...photos].map(([id, p]) => [id, { id, width: p.width, height: p.height }]));
  const next = sizes.get(photoId) ?? { id: photoId, width: null, height: null };
  const r = replacePhotoAndRelayout(doc, page.id, slotIdx, next, { design: { format: doc.format, designStyle: doc.style.designStyle ?? "classic" }, lang, photos: sizes });
  return r.ok ? r.doc : replacePhoto(doc, pageIdx, slotIdx, photoId);
}
