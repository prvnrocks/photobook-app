// Server-side validation of an editor save (PUT /api/books/[id]/doc, D-036). Pure: the route
// supplies everything that must come from the DB (the book's placeable photos, max_pages, the
// currently saved doc), never from the client.
//
// Results carry stable codes only — never text from the doc.

import { clipCodePoints } from "@/lib/text/clip";
import { isCaptionFont } from "./fonts";
import { BOOK_TITLE_MAX_CODE_POINTS } from "./options";
import { DocMetaSchema, parseBookDoc, validateBookDoc } from "./schema";
import type { BookDoc, DocMeta } from "./types";

export type EditorDocErrorCode =
  | "invalid_doc"
  | "page_limit"
  | "foreign_photo"
  | "duplicate_photo"
  | "invalid_font";

export interface EditorDocContext {
  /** Ids of the book's upload-ready photos (kept AND dropped). */
  photoIds: ReadonlySet<string>;
  /** books.max_pages from the DB. */
  maxPages: number;
  /** books.doc as currently stored (may be `{}` or legacy). */
  savedDoc: unknown;
}

export type EditorDocResult =
  | {
      ok: true;
      /** The doc to store: client doc with server-forced meta. */
      doc: BookDoc;
      pageCount: number;
      /** Trimmed cover title clipped to 120 code points; null when empty (keep books.title). */
      title: string | null;
      /** Every photo id placed in the doc (cover + slots), deduplicated. */
      placedPhotoIds: string[];
    }
  | { ok: false; code: EditorDocErrorCode };

const DEFAULT_META: Omit<DocMeta, "userEdited"> = { generator: "rule", generatorVersion: 1, runId: null };

/** meta to store: origin fields from the SAVED doc (never the client's), userEdited forced true. */
export function forcedMeta(savedDoc: unknown): DocMeta {
  const raw =
    savedDoc && typeof savedDoc === "object" && !Array.isArray(savedDoc)
      ? (savedDoc as { meta?: unknown }).meta
      : undefined;
  const parsed = raw === undefined ? null : DocMetaSchema.safeParse(raw);
  const base = parsed?.success
    ? { generator: parsed.data.generator, generatorVersion: parsed.data.generatorVersion, runId: parsed.data.runId }
    : DEFAULT_META;
  return { ...base, userEdited: true };
}

/** page id → caption font of the saved doc (only well-formed pages). */
function savedCaptionFonts(savedDoc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const pages = (savedDoc as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages)) return out;
  for (const p of pages) {
    if (!p || typeof p !== "object") continue;
    const { id, caption } = p as { id?: unknown; caption?: unknown };
    const font = (caption as { font?: unknown } | null | undefined)?.font;
    if (typeof id === "string" && typeof font === "string") out.set(id, font);
  }
  return out;
}

/** style.font of the saved doc, or null. */
function savedStyleFont(savedDoc: unknown): string | null {
  const style = (savedDoc as { style?: unknown } | null)?.style;
  const font = (style as { font?: unknown } | null | undefined)?.font;
  return typeof font === "string" ? font : null;
}

export function validateEditorDoc(input: unknown, ctx: EditorDocContext): EditorDocResult {
  // Page limit first, so a free book with 21+ pages gets the specific code even when the
  // count is also above the schema's absolute maximum.
  const rawPages = (input as { pages?: unknown } | null)?.pages;
  if (Array.isArray(rawPages) && rawPages.length > ctx.maxPages) return { ok: false, code: "page_limit" };

  const parsed = parseBookDoc(input);
  if (!parsed.ok) return { ok: false, code: "invalid_doc" };
  const doc = parsed.doc;
  if (doc.pages.length > ctx.maxPages) return { ok: false, code: "page_limit" };

  // Photo ownership + single use (the cover photo may repeat once on a page).
  const placed = new Set<string>();
  if (doc.cover.photoId !== null) {
    if (!ctx.photoIds.has(doc.cover.photoId)) return { ok: false, code: "foreign_photo" };
    placed.add(doc.cover.photoId);
  }
  const onPages = new Set<string>();
  for (const page of doc.pages) {
    for (const slot of page.slots) {
      if (slot.photoId === null) continue;
      if (!ctx.photoIds.has(slot.photoId)) return { ok: false, code: "foreign_photo" };
      if (onPages.has(slot.photoId)) return { ok: false, code: "duplicate_photo" };
      onPages.add(slot.photoId);
      placed.add(slot.photoId);
    }
  }

  // Caption fonts: must be an editor font, unless the page keeps its already-saved font.
  // Caption `source` is not checked: a client-sent source 'ai' is harmless, because the stored
  // doc always gets meta.userEdited = true (forcedMeta), which alone blocks every AI overwrite
  // (isAiReplaceableDoc) — and an accepted ✨ rewrite is saved as 'user' by the editor (D-037 #1).
  const savedFonts = savedCaptionFonts(ctx.savedDoc);
  for (const page of doc.pages) {
    if (!page.caption || isCaptionFont(page.caption.font)) continue;
    if (savedFonts.get(page.id) !== page.caption.font) return { ok: false, code: "invalid_font" };
  }
  // Book font (style.font): same rule — an editor font, or the saved doc's unchanged style font.
  if (!isCaptionFont(doc.style.font) && savedStyleFont(ctx.savedDoc) !== doc.style.font) {
    return { ok: false, code: "invalid_font" };
  }

  // Remaining structure (layouts, slot counts, chapters, unique ids).
  const issues = validateBookDoc(doc, { photoIds: new Set(ctx.photoIds), maxPages: ctx.maxPages });
  if (issues.length > 0) return { ok: false, code: "invalid_doc" };

  const title = clipCodePoints(doc.cover.title.trim(), BOOK_TITLE_MAX_CODE_POINTS).trim();
  return {
    ok: true,
    doc: { ...doc, meta: forcedMeta(ctx.savedDoc) },
    pageCount: doc.pages.length,
    title: title === "" ? null : title,
    placedPhotoIds: [...placed],
  };
}
