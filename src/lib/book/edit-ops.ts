// Editor operations on the book document (M5). Pure and immutable: every op takes a doc and
// returns a NEW doc (input never mutated; untouched pages/chapters are shared by reference).
// Safe on client and server — no React, no Supabase, no server-only imports.
//
// Conventions
// - Bad input that the UI should never send (index out of range, unknown layout/chapter, cover
//   layout on a page, caption on a layout without a caption area) throws EditOpError with a
//   stable `code` and no user data in the message.
// - A valid op that changes nothing returns the input doc itself (`out === doc`), so the store can
//   skip pushing an undo entry.
// - Chapters are a flat list; pages reference them by `chapterId` (nullable). Page ops keep each
//   chapter's pages contiguous, and structural page ops prune chapters left without pages (D-037 5).
// - Text is made jsonb-safe (lone surrogates stripped) and clipped to the schema limits with
//   clipText / clipCodePoints — never String.slice (lessons 2026-11-08).
// - Ops do NOT set meta.userEdited; use markUserEdited() at save time (the server must mark it
//   anyway — never trust the client).

import { LIMITS } from "@/lib/ai/limits";
import { getLayout } from "@/lib/layouts";
import { clipCodePoints, clipText, stripLoneSurrogates } from "@/lib/text/clip";
import { clampCrop, DEFAULT_CROP } from "./crop";
import { defaultCaptionFont, type CaptionFont } from "./fonts";
import { BOOK_TITLE_MAX_CODE_POINTS } from "./options";
import { BackgroundSchema } from "./schema";
import type { Background, BookDoc, BookPage, Caption, Chapter, Crop, Layout, PageBackground, Slot } from "./types";

export type EditOpErrorCode =
  | "page_out_of_range"
  | "slot_out_of_range"
  | "unknown_layout"
  | "not_a_page_layout"
  | "unknown_chapter"
  | "no_caption_area"
  | "page_limit"
  | "invalid_background";

export class EditOpError extends Error {
  readonly code: EditOpErrorCode;
  constructor(code: EditOpErrorCode) {
    super(`edit op failed: ${code}`);
    this.name = "EditOpError";
    this.code = code;
  }
}

/** Schema text limits (UTF-16 units unless noted). */
export const CAPTION_MAX = 200;
export const SUBTITLE_MAX = 120;
export const CHAPTER_TITLE_MAX = 80;
/** Default layout for a page added with addPage(). Has a caption area. */
export const DEFAULT_NEW_PAGE_LAYOUT = "one-portrait";
/** Hard ceiling = schema max (paid). */
const SCHEMA_MAX_PAGES = LIMITS.paid.maxPages;

export type CaptionAlign = Caption["align"];

// ---- helpers -----------------------------------------------------------------------------------

function pageAt(doc: BookDoc, pageIdx: number): BookPage {
  if (!Number.isInteger(pageIdx) || pageIdx < 0 || pageIdx >= doc.pages.length) {
    throw new EditOpError("page_out_of_range");
  }
  return doc.pages[pageIdx];
}

function pageLayout(layoutId: string): Layout {
  const layout = getLayout(layoutId);
  if (!layout) throw new EditOpError("unknown_layout");
  if (layout.role !== "page") throw new EditOpError("not_a_page_layout");
  return layout;
}

function withPage(doc: BookDoc, pageIdx: number, page: BookPage): BookDoc {
  const pages = doc.pages.slice();
  pages[pageIdx] = page;
  return { ...doc, pages };
}

const emptySlot = (): Slot => ({ photoId: null, crop: { ...DEFAULT_CROP } });
const safeText = (s: string, max: number) => clipText(stripLoneSurrogates(String(s ?? "")), max);
const sameCrop = (a: Crop, b: Crop) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/** New page id ("p<n>") that clashes with no existing page id. */
function newPageId(doc: BookDoc): string {
  const taken = new Set(doc.pages.map((p) => p.id));
  let n = doc.pages.length + 1;
  while (taken.has(`p${n}`)) n++;
  return `p${n}`;
}

/** Drop chapters that no page references. Returns the input when nothing is pruned. */
export function pruneEmptyChapters(doc: BookDoc): BookDoc {
  const used = new Set(doc.pages.map((p) => p.chapterId));
  if (doc.chapters.every((c) => used.has(c.id))) return doc;
  return { ...doc, chapters: doc.chapters.filter((c) => used.has(c.id)) };
}

/** Set meta.userEdited = true (creates a rule meta for docs without one). */
export function markUserEdited(doc: BookDoc): BookDoc {
  if (doc.meta?.userEdited === true) return doc;
  const meta = doc.meta ?? { generator: "rule" as const, generatorVersion: 1, runId: null, userEdited: false };
  return { ...doc, meta: { ...meta, userEdited: true } };
}

// ---- queries -----------------------------------------------------------------------------------

/** Photo ids placed in page slots, plus the cover photo unless `includeCover: false`. */
export function usedPhotoIds(doc: BookDoc, opts: { includeCover?: boolean } = {}): Set<string> {
  const out = new Set<string>();
  if (opts.includeCover !== false && doc.cover.photoId !== null) out.add(doc.cover.photoId);
  for (const p of doc.pages) for (const s of p.slots) if (s.photoId !== null) out.add(s.photoId);
  return out;
}

/** True when one more page fits under `maxPages` (and the schema ceiling of 100). */
export function canAddPage(doc: BookDoc, maxPages: number): boolean {
  const cap = Number.isFinite(maxPages) ? Math.min(Math.floor(maxPages), SCHEMA_MAX_PAGES) : 0;
  return doc.pages.length < cap;
}

// ---- layout --------------------------------------------------------------------------------------

export interface ChangeLayoutResult {
  doc: BookDoc;
  /** Photos that no longer fit (in their old slot order) — now unused. */
  removedPhotoIds: string[];
  /** The caption removed because the new layout has no caption area, else null. */
  droppedCaption: Caption | null;
}

/**
 * Switch a page to another page layout. Placed photos re-flow in order (empty slots skipped)
 * into the new slots, keeping their crops; photos beyond the new slot count become unused;
 * remaining slots are empty. The caption is dropped when the new layout has no caption area.
 */
export function changeLayout(doc: BookDoc, pageIdx: number, layoutId: string): ChangeLayoutResult {
  const page = pageAt(doc, pageIdx);
  const layout = pageLayout(layoutId);
  if (page.layout === layout.id && page.slots.length === layout.photoCount) {
    return { doc, removedPhotoIds: [], droppedCaption: null };
  }
  const placed = page.slots.filter((s) => s.photoId !== null);
  const kept = placed.slice(0, layout.photoCount);
  const removedPhotoIds = placed.slice(layout.photoCount).map((s) => s.photoId as string);
  const slots: Slot[] = Array.from({ length: layout.photoCount }, (_, i) =>
    kept[i] ? { photoId: kept[i].photoId, crop: { ...kept[i].crop } } : emptySlot(),
  );
  const droppedCaption = layout.caption === null ? page.caption : null;
  const caption = layout.caption === null ? null : page.caption;
  return {
    doc: withPage(doc, pageIdx, { ...page, layout: layout.id, slots, caption }),
    removedPhotoIds,
    droppedCaption,
  };
}

// ---- photos --------------------------------------------------------------------------------------

/**
 * Put `photoId` into a page slot (null clears the slot). If the photo already sits in another
 * page slot (same or other page), the two slots swap photos. Every affected slot gets the
 * default crop.
 *
 * The cover is never swapped: validateBookDoc allows the cover photo to appear once more on a
 * page, so placing the cover photo on a page leaves the cover as is (and an empty slot can never
 * blank the cover). Change the cover with setCover().
 */
export function replacePhoto(doc: BookDoc, pageIdx: number, slotIdx: number, photoId: string | null): BookDoc {
  const page = pageAt(doc, pageIdx);
  if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= page.slots.length) {
    throw new EditOpError("slot_out_of_range");
  }
  const current = page.slots[slotIdx].photoId;
  if (current === photoId) return doc;

  let other: { p: number; s: number } | null = null;
  if (photoId !== null) {
    doc.pages.forEach((pg, p) =>
      pg.slots.forEach((sl, s) => {
        if (!other && sl.photoId === photoId && !(p === pageIdx && s === slotIdx)) other = { p, s };
      }),
    );
  }

  const pages = doc.pages.slice();
  const setSlot = (p: number, s: number, id: string | null) => {
    const slots = pages[p].slots.slice();
    slots[s] = { photoId: id, crop: { ...DEFAULT_CROP } };
    pages[p] = { ...pages[p], slots };
  };
  setSlot(pageIdx, slotIdx, photoId);
  if (other) {
    const o = other as { p: number; s: number };
    setSlot(o.p, o.s, current);
  }
  return { ...doc, pages };
}

/** Set a slot's crop, clamped to schema bounds (x, y 0..1; zoom 1..4; non-finite → default). */
export function setCrop(doc: BookDoc, pageIdx: number, slotIdx: number, crop: Partial<Crop>): BookDoc {
  const page = pageAt(doc, pageIdx);
  if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= page.slots.length) {
    throw new EditOpError("slot_out_of_range");
  }
  const old = page.slots[slotIdx];
  const next = clampCrop({ ...old.crop, ...crop });
  if (sameCrop(old.crop, next)) return doc;
  const slots = page.slots.slice();
  slots[slotIdx] = { ...old, crop: next };
  return withPage(doc, pageIdx, { ...page, slots });
}

// ---- captions ------------------------------------------------------------------------------------

/**
 * Set a page caption typed by the user (source "user"). Whitespace-only text removes the
 * caption (null). Text is kept as typed (not trimmed), made jsonb-safe and clipped to 200 units.
 * An existing caption keeps its font/align; a new one gets defaultCaptionFont(text, captionLang)
 * and "center".
 */
export function setCaption(
  doc: BookDoc,
  pageIdx: number,
  text: string,
  opts: { captionLang?: string } = {},
): BookDoc {
  const page = pageAt(doc, pageIdx);
  const clean = safeText(text, CAPTION_MAX);
  if (clean.trim() === "") {
    return page.caption === null ? doc : withPage(doc, pageIdx, { ...page, caption: null });
  }
  if (pageLayout(page.layout).caption === null) throw new EditOpError("no_caption_area");
  const prev = page.caption;
  if (prev && prev.text === clean && prev.source === "user") return doc;
  const caption: Caption = {
    text: clean,
    font: prev?.font ?? defaultCaptionFont(clean, opts.captionLang),
    align: prev?.align ?? "center",
    source: "user",
  };
  return withPage(doc, pageIdx, { ...page, caption });
}

/**
 * Change the caption font. No caption → no-op. Styling is a user edit, so source becomes "user"
 * (the AI must not overwrite a caption the user has styled).
 */
export function setCaptionFont(doc: BookDoc, pageIdx: number, font: CaptionFont): BookDoc {
  const page = pageAt(doc, pageIdx);
  if (!page.caption || page.caption.font === font) return doc;
  return withPage(doc, pageIdx, { ...page, caption: { ...page.caption, font, source: "user" } });
}

/** Change the caption alignment. No caption → no-op. Source becomes "user" (see setCaptionFont). */
export function setCaptionAlign(doc: BookDoc, pageIdx: number, align: CaptionAlign): BookDoc {
  const page = pageAt(doc, pageIdx);
  if (!page.caption || page.caption.align === align) return doc;
  return withPage(doc, pageIdx, { ...page, caption: { ...page.caption, align, source: "user" } });
}

// ---- pages ---------------------------------------------------------------------------------------

/**
 * Insert an empty page (all slots empty, no caption) after `afterIdx` (-1 = at the start),
 * in the chapter of the page at `afterIdx` (at the start: the chapter of the current first page).
 * The new page is at index afterIdx + 1. Throws "page_limit" past `maxPages` (default and
 * ceiling: the schema max of 100) — check canAddPage() first in the UI.
 */
export function addPage(
  doc: BookDoc,
  afterIdx: number,
  layoutId: string = DEFAULT_NEW_PAGE_LAYOUT,
  maxPages: number = SCHEMA_MAX_PAGES,
): BookDoc {
  if (!Number.isInteger(afterIdx) || afterIdx < -1 || afterIdx >= doc.pages.length) {
    throw new EditOpError("page_out_of_range");
  }
  const layout = pageLayout(layoutId);
  if (!canAddPage(doc, maxPages)) throw new EditOpError("page_limit");
  const neighbour = afterIdx >= 0 ? doc.pages[afterIdx] : doc.pages[0];
  const page: BookPage = {
    id: newPageId(doc),
    chapterId: neighbour?.chapterId ?? doc.chapters[0]?.id ?? null,
    layout: layout.id,
    slots: Array.from({ length: layout.photoCount }, emptySlot),
    caption: null,
  };
  const pages = doc.pages.slice();
  pages.splice(afterIdx + 1, 0, page);
  return { ...doc, pages };
}

/** Remove a page; its photos become unused. Chapters left without pages are pruned. */
export function deletePage(doc: BookDoc, pageIdx: number): BookDoc {
  pageAt(doc, pageIdx);
  const pages = doc.pages.filter((_, i) => i !== pageIdx);
  return pruneEmptyChapters({ ...doc, pages });
}

/**
 * Move a page so it ends up at index `to` (index in the resulting page list). The moved page
 * takes the chapter of the page before it at its new spot; at position 0 it takes the chapter of
 * the page that is now second (= the book's first chapter). Empty chapters are pruned.
 */
export function movePage(doc: BookDoc, from: number, to: number): BookDoc {
  const page = pageAt(doc, from);
  if (!Number.isInteger(to) || to < 0 || to >= doc.pages.length) throw new EditOpError("page_out_of_range");
  if (from === to) return doc;
  const rest = doc.pages.filter((_, i) => i !== from);
  const neighbour = to > 0 ? rest[to - 1] : rest[0];
  const chapterId = neighbour ? neighbour.chapterId : page.chapterId;
  const moved = chapterId === page.chapterId ? page : { ...page, chapterId };
  rest.splice(to, 0, moved);
  return pruneEmptyChapters({ ...doc, pages: rest });
}

/**
 * Move a page to the end of `chapterId` (D-037 5: "Move to chapter" appends). A chapter that
 * has no pages gets the page at the end of the book. Empty chapters are pruned.
 */
export function movePageToChapter(doc: BookDoc, pageIdx: number, chapterId: string): BookDoc {
  const page = pageAt(doc, pageIdx);
  if (!doc.chapters.some((c) => c.id === chapterId)) throw new EditOpError("unknown_chapter");
  const rest = doc.pages.filter((_, i) => i !== pageIdx);
  let last = -1;
  rest.forEach((p, i) => {
    if (p.chapterId === chapterId) last = i;
  });
  const at = last >= 0 ? last + 1 : rest.length;
  rest.splice(at, 0, page.chapterId === chapterId ? page : { ...page, chapterId });
  const same = rest.every((p, i) => p === doc.pages[i]);
  if (same) return doc;
  return pruneEmptyChapters({ ...doc, pages: rest });
}

// ---- cover & chapters ------------------------------------------------------------------------------

export interface CoverPatch {
  /** ≤ 120 code points (clipped). Mirror to books.title on save (D-037 7). */
  title?: string;
  /** ≤ 120 UTF-16 units (clipped). */
  subtitle?: string;
  /** Cover photo; null = no photo. May also be on one page (allowed by validateBookDoc). */
  photoId?: string | null;
}

/** Patch the cover. Only given fields change. */
export function setCover(doc: BookDoc, patch: CoverPatch): BookDoc {
  const cover = { ...doc.cover };
  if (patch.title !== undefined) {
    cover.title = clipCodePoints(stripLoneSurrogates(String(patch.title)), BOOK_TITLE_MAX_CODE_POINTS);
  }
  if (patch.subtitle !== undefined) cover.subtitle = safeText(patch.subtitle, SUBTITLE_MAX);
  if (patch.photoId !== undefined) cover.photoId = patch.photoId;
  const c = doc.cover;
  if (cover.title === c.title && cover.subtitle === c.subtitle && cover.photoId === c.photoId) return doc;
  return { ...doc, cover };
}

/** Rename a chapter (≤ 80 units, clipped). */
export function setChapterTitle(doc: BookDoc, chapterId: string, title: string): BookDoc {
  const idx = doc.chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) throw new EditOpError("unknown_chapter");
  const clean = safeText(title, CHAPTER_TITLE_MAX);
  if (doc.chapters[idx].title === clean) return doc;
  const chapters: Chapter[] = doc.chapters.slice();
  chapters[idx] = { ...chapters[idx], title: clean };
  return { ...doc, chapters };
}

// ---- backgrounds (M10a A8) -----------------------------------------------------------------------
//
// A page shows page.background when set, else the book default style.background (the cover always
// shows the book default). Every background the editor writes is a user choice: page overrides get
// source "user" so AI suggestions (M10c, source "ai") never replace them. Photo backgrounds don't
// "place" a photo: they may use any photo of the book, also one that is on a page or AI-dropped
// (the server checks ownership; validate-editor-doc.ts).

/** A schema-valid copy of `bg` with known keys only; throws "invalid_background" otherwise. */
function cleanBackground(bg: Background): Background {
  const r = BackgroundSchema.safeParse(bg);
  if (!r.success) throw new EditOpError("invalid_background");
  return r.data;
}

/** Same background (ignores `source`). */
export function sameBackground(a: Background | PageBackground | null | undefined, b: Background | PageBackground | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  switch (a.kind) {
    case "color":
      return b.kind === "color" && a.hex.toUpperCase() === b.hex.toUpperCase();
    case "texture":
      return b.kind === "texture" && a.textureId === b.textureId && (a.tint ?? null)?.toUpperCase() === (b.tint ?? null)?.toUpperCase();
    case "photo":
      return b.kind === "photo" && a.photoId === b.photoId && a.veil === b.veil && a.veilColor.toUpperCase() === b.veilColor.toUpperCase();
  }
}

/**
 * Give one page its own background, chosen by the user (source "user"). Setting the same
 * background again on a page that already has it as a user choice is a no-op; on an AI-suggested
 * one it turns the suggestion into the user's choice (source "user").
 */
export function setPageBackground(doc: BookDoc, pageIdx: number, bg: Background): BookDoc {
  const page = pageAt(doc, pageIdx);
  const clean = cleanBackground(bg);
  if (page.background && page.background.source === "user" && sameBackground(page.background, clean)) return doc;
  const background = { ...clean, source: "user" } as PageBackground;
  return withPage(doc, pageIdx, { ...page, background });
}

/**
 * Remove a page's own background, so it shows the book default again. No override (absent or
 * null) → no-op.
 * The key is removed (not set to null), so a book without other v2 features is stored as v1 again.
 */
export function resetPageBackground(doc: BookDoc, pageIdx: number): BookDoc {
  const page = pageAt(doc, pageIdx);
  if (page.background === undefined || page.background === null) return doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop the key
  const { background: _drop, ...rest } = page;
  return withPage(doc, pageIdx, rest);
}

export interface SetBookBackgroundOptions {
  /**
   * Keep pages' own backgrounds (default false). "Whole book" in the editor means every page, so
   * by default every page override (user or AI) is removed — one undo step brings them back.
   */
  keepPageOverrides?: boolean;
}

/** Set the book default background (cover + every page without an override). */
export function setBookBackground(doc: BookDoc, bg: Background, opts: SetBookBackgroundOptions = {}): BookDoc {
  const clean = cleanBackground(bg);
  const sameDefault = sameBackground(doc.style.background, clean);
  const clearPages = opts.keepPageOverrides !== true && doc.pages.some((p) => p.background != null);
  if (sameDefault && !clearPages) return doc;
  const style = sameDefault ? doc.style : { ...doc.style, background: clean };
  if (!clearPages) return { ...doc, style };
  const pages = doc.pages.map((p) => {
    if (p.background == null) return p;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop the key
    const { background: _drop, ...rest } = p;
    return rest;
  });
  return { ...doc, style, pages };
}

/** Number of pages with their own background (shown by "Whole book" before it replaces them). */
export function pageBackgroundOverrideCount(doc: BookDoc): number {
  return doc.pages.filter((p) => p.background !== undefined && p.background !== null).length;
}
