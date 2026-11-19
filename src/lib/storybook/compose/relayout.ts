// replacePhotoAndRelayout (Task 7, requirement 15): swap one photo of a storybook page and, when the
// new photo no longer suits the page's template (orientation, crop, print resolution), choose
// another approved template of the SAME family for that page only — same page id, same chapter,
// same text elements (ids, roles, texts), every other page untouched. Pure; one edit op = one undo
// step in the editor (ctx.actions.edit).
//
// A page whose layout is not a storybook template (a user layout) just gets the photo, like the
// editor's plain Replace. The new photo must not already sit on another page (that page would change
// too): `photo_in_use` — use the plain swap (edit-ops replacePhoto) for that.

import type { BookDesign } from "@/lib/book/book-design";
import { newCaptionFont } from "@/lib/book/edit-ops";
import { getLayout } from "@/lib/layouts";
import { clipText } from "@/lib/text/clip";
import { getPageTemplate, MIN_DPI } from "@/lib/layouts/templates";
import type { BookDoc, BookPage, Caption, PageText } from "@/lib/book/types";
import { cropFor, cropLoss, CROP_REJECT, cutsSubject, photoShape, selectPageTemplate, slotAspect, slotDpi } from "./select";
import type { ComposePhoto, ComposeText } from "./types";

export type ReplacePhotoResult =
  | { ok: true; doc: BookDoc; relaid: boolean; templateId: string }
  | { ok: false; reason: "page_not_found" | "slot_not_found" | "photo_in_use" | "no_fit"; doc: BookDoc };

export type ReplacePhotoContext = {
  design: BookDesign;
  lang: "en" | "ar";
  /** Sizes (+ focus) of the photos on the page and of the new photo; unknown → no fit checks. */
  photos: ReadonlyMap<string, ComposePhoto>;
};

/** `slotId` = the slot index, or its element id "<pageId>/s<index>" (compose.ts slotElementId). */
function slotIndexOf(pageId: string, slotId: number | string): number {
  if (typeof slotId === "number") return slotId;
  const m = new RegExp(`^${pageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/s(\\d+)$`).exec(slotId);
  return m ? Number(m[1]) : -1;
}

/** Does `photo` still suit slot `i` of the page's layout (the selector's hard rules)? */
function stillFits(page: BookPage, i: number, photo: ComposePhoto): boolean {
  const layout = getLayout(page.layout);
  const template = getPageTemplate(page.layout);
  if (!layout || !template) return true;
  const shape = photoShape(photo);
  if (shape.ratio === null) return true;
  const pref = layout.prefers[i] ?? "any";
  if (pref !== "any" && shape.orient !== "square" && pref !== shape.orient) return false;
  const aspect = slotAspect(layout, i);
  if (cropLoss(shape.ratio, aspect) > CROP_REJECT) return false;
  if (photo.focus && cutsSubject(shape.ratio, aspect, photo.focus)) return false;
  const dpi = slotDpi(layout, i, photo);
  return !(template.fullBleed && dpi !== null && dpi < MIN_DPI);
}

export function replacePhotoAndRelayout(doc: BookDoc, pageId: string, slotId: number | string, newPhoto: ComposePhoto, ctx: ReplacePhotoContext): ReplacePhotoResult {
  const pageIdx = doc.pages.findIndex((p) => p.id === pageId);
  const page = doc.pages[pageIdx];
  if (!page) return { ok: false, reason: "page_not_found", doc };
  const i = slotIndexOf(pageId, slotId);
  if (!Number.isInteger(i) || i < 0 || i >= page.slots.length) return { ok: false, reason: "slot_not_found", doc };
  if (page.slots[i]!.photoId === newPhoto.id) return { ok: true, doc, relaid: false, templateId: page.layout };
  const elsewhere = doc.pages.some((p, k) => p.slots.some((s, j) => s.photoId === newPhoto.id && !(k === pageIdx && j === i)));
  if (elsewhere) return { ok: false, reason: "photo_in_use", doc };

  const swapped: BookPage = { ...page, slots: page.slots.map((s, j) => (j === i ? { photoId: newPhoto.id, crop: cropFor(newPhoto) } : s)) };
  const template = getPageTemplate(page.layout);
  const withPage = (p: BookPage): BookDoc => ({ ...doc, pages: doc.pages.map((x, k) => (k === pageIdx ? p : x)) });
  if (!template || stillFits(swapped, i, newPhoto)) return { ok: true, doc: withPage(swapped), relaid: false, templateId: page.layout };

  // Re-select within the family: the page's photos (the new one in place of the old) and its texts.
  const photos: ComposePhoto[] = swapped.slots
    .map((s) => (s.photoId === newPhoto.id ? newPhoto : s.photoId ? (ctx.photos.get(s.photoId) ?? { id: s.photoId, width: null, height: null }) : null))
    .filter((x): x is ComposePhoto => !!x);
  const texts: ComposeText[] = (page.texts ?? []).map((t) => ({ key: t.id, role: t.role, text: t.text }));
  const CAPTION_KEY = "\u0000caption";
  if (page.caption) texts.push({ key: CAPTION_KEY, role: "caption", text: page.caption.text });
  const neighbours = [doc.pages[pageIdx - 1]?.layout, doc.pages[pageIdx + 1]?.layout].filter((x): x is string => !!x);
  const r = selectPageTemplate({ family: template.family, design: ctx.design, lang: ctx.lang, targetShare: template.narrativeShare, recent: [], avoid: neighbours }, photos, { texts });
  if (!r.ok) return { ok: true, doc: withPage(swapped), relaid: false, templateId: page.layout };

  // Keep each photo's crop (the user's), the new photo gets its focus crop; texts keep their ids.
  const cropOf = new Map(swapped.slots.filter((s) => s.photoId).map((s) => [s.photoId!, s.crop]));
  const slots = r.slots.map((s) => ({ photoId: s.photoId, crop: { ...(cropOf.get(s.photoId) ?? s.crop) } }));
  const panelOf = new Map(r.texts.map((t) => [t.key, t.panel]));
  // never lose or re-type text: a caption that would leave the caption area keeps the old template
  if (page.caption && panelOf.get(CAPTION_KEY) !== -1) return { ok: true, doc: withPage(swapped), relaid: false, templateId: page.layout };
  let caption: Caption | null = null;
  const nextTexts: PageText[] = [];
  for (const t of page.texts ?? []) {
    const panel = panelOf.get(t.id);
    if (panel === undefined) continue;
    if (panel === -1) caption = { text: clipText(t.text, 200), font: page.caption?.font ?? newCaptionFont(doc, t.text, ctx.lang), align: "center", source: t.source };
    else nextTexts.push({ ...t, panel });
  }
  if (page.caption) caption = page.caption;
  const relaid: BookPage = { id: page.id, chapterId: page.chapterId, layout: r.templateId, slots, caption };
  if (page.background) relaid.background = page.background;
  if (nextTexts.length) relaid.texts = nextTexts.sort((a, b) => a.panel - b.panel);
  return { ok: true, doc: withPage(relaid), relaid: true, templateId: r.templateId };
}
