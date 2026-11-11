// Server-side validation of an editor save (PUT /api/books/[id]/doc, D-036). Pure: the route
// supplies everything that must come from the DB (the book's placeable photos, max_pages, the
// currently saved doc), never from the client.
//
// Results carry stable codes only — never text from the doc.
//
// Backgrounds (M10a A8): the schema already rejects unknown texture ids, a veil outside
// BACKGROUND_VEIL_MIN..MAX, a non-uuid photo id and unknown keys (strict objects) → invalid_doc.
// A photo background (book default or page override) must be one of the book's upload-ready
// photos, kept OR dropped: a background does not "place" a photo, so an AI-dropped photo may be
// used as a faded background without being restored, and the same photo may also sit in a slot.
// Another book's photo → foreign_photo. Background photos are NOT in placedPhotoIds, so saving
// never marks a dropped photo kept just because it is a background.
// A texture tint must be one of the light catalogue swatches (BACKGROUND_SWATCHES with ink
// "dark"), the same list the picker offers: a dark multiply tint turns paper into mud and breaks
// the texture's declared ink → invalid_doc.
//
// Format + design style (M10b A6, D-063, replaces the M10a review-S2 pin to the saved doc):
// books.format / books.design_style are the authority. The route passes them as ctx.design and the
// validator OVERWRITES doc.format / doc.style.designStyle with them before any check, whatever the
// client sent — so a landscape doc sent for a portrait book is stored portrait (and its layouts
// are then checked against portrait). validateBookDoc then rejects layouts of another format or
// another design style than the book's (strict; see book-design.ts) → invalid_doc.
// Page sides are no longer pinned: spread halves (`side` left/right, spreads.ts) are allowed when
// the doc is spread-aligned; misaligned / half spreads and `side` on a single-page layout fail
// validateBookDoc → invalid_doc.

import { BACKGROUND_SWATCHES } from "@/lib/design/backgrounds";
import { clipCodePoints } from "@/lib/text/clip";
import { isBookFont } from "./fonts";
import { BOOK_TITLE_MAX_CODE_POINTS } from "./options";
import { designOfDoc, isSupportedDesign, withBookDesign, type BookDesign } from "./book-design";
import { DocMetaSchema, parseBookDoc, validateBookDoc } from "./schema";
import type { BookDoc, DocMeta } from "./types";

export type EditorDocErrorCode =
  | "invalid_doc"
  | "page_limit"
  | "foreign_photo"
  | "duplicate_photo"
  | "invalid_font"
  | "unsupported_design";

export interface EditorDocContext {
  /** Ids of the book's upload-ready photos (kept AND dropped). */
  photoIds: ReadonlySet<string>;
  /** books.max_pages from the DB. */
  maxPages: number;
  /** books.doc as currently stored (may be `{}` or legacy). */
  savedDoc: unknown;
  /**
   * books.format / books.design_style (bookDesignOf(book row)). The real route MUST pass it.
   * Omitted only by dev fixtures / unit tests: then the saved doc's own design (designOfDoc).
   */
  design?: BookDesign;
}

export type EditorDocResult =
  | {
      ok: true;
      /** The doc to store: client doc with server-forced meta. */
      doc: BookDoc;
      pageCount: number;
      /** Trimmed cover title clipped to 120 code points; null when empty (keep books.title). */
      title: string | null;
      /** Every photo id placed in the doc (cover + slots), deduplicated. Background photos are not placed. */
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

/** Tints a paper texture may use: the light swatches (dark ink), upper-case #RRGGBB. */
export const TEXTURE_TINTS: ReadonlySet<string> = new Set(
  BACKGROUND_SWATCHES.filter((s) => s.ink === "dark").map((s) => s.hex.toUpperCase()),
);

function tintOk(bg: { kind: string; tint?: string } | null | undefined): boolean {
  return bg?.kind !== "texture" || bg.tint === undefined || TEXTURE_TINTS.has(bg.tint.toUpperCase());
}

export function validateEditorDoc(input: unknown, ctx: EditorDocContext): EditorDocResult {
  // Page limit first, so a free book with 21+ pages gets the specific code even when the
  // count is also above the schema's absolute maximum.
  const rawPages = (input as { pages?: unknown } | null)?.pages;
  if (Array.isArray(rawPages) && rawPages.length > ctx.maxPages) return { ok: false, code: "page_limit" };

  // Review S1 (M10b A19): a book whose design style has no layouts yet (geometric / scrapbook rows
  // inserted directly) can never hold a valid doc → a typed refusal instead of invalid_doc.
  const design = ctx.design ?? designOfDoc(ctx.savedDoc);
  if (!isSupportedDesign(design)) return { ok: false, code: "unsupported_design" };

  const parsed = parseBookDoc(input);
  if (!parsed.ok) return { ok: false, code: "invalid_doc" };
  // D-063: format + design style always come from the book row, never from the client.
  const doc = withBookDesign(parsed.doc, design);
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

  // Background photos: any upload-ready photo of this book (kept or dropped); not "placed".
  const bgPhotos = [doc.style.background, ...doc.pages.map((p) => p.background)];
  for (const bg of bgPhotos) {
    if (bg?.kind === "photo" && !ctx.photoIds.has(bg.photoId)) return { ok: false, code: "foreign_photo" };
    if (!tintOk(bg)) return { ok: false, code: "invalid_doc" };
  }

  // Caption fonts: must be a registry face (M5 four + the M10b OFL faces, isBookFont), unless the
  // page keeps its already-saved font. M10b A19 (review B1): the v2 faces are accepted for every
  // book — a modern book's first user caption is Cormorant/Amiri (newCaptionFont), and D-065 offers
  // the pairs to classic books too; any v2 face simply makes the stored doc v2 (usesV2Features),
  // while a classic book with only M5 faces stays v1.
  // Caption `source` is not checked: a client-sent source 'ai' is harmless, because the stored
  // doc always gets meta.userEdited = true (forcedMeta), which alone blocks every AI overwrite
  // (isAiReplaceableDoc) — and an accepted ✨ rewrite is saved as 'user' by the editor (D-037 #1).
  const savedFonts = savedCaptionFonts(ctx.savedDoc);
  for (const page of doc.pages) {
    if (!page.caption || isBookFont(page.caption.font)) continue;
    if (savedFonts.get(page.id) !== page.caption.font) return { ok: false, code: "invalid_font" };
  }
  // Book font (style.font): same rule — a registry face, or the saved doc's unchanged style font.
  if (!isBookFont(doc.style.font) && savedStyleFont(ctx.savedDoc) !== doc.style.font) {
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
