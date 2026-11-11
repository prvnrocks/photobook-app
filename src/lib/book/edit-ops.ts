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
// - Spreads (M10b A7, D-064; storage model in spreads.ts): a spread is two pages (left half at an
//   even index owns slots + caption, right half is an empty placeholder with its own background).
//   Structural ops treat it as ONE unit (pageUnit): delete either half → both go, move → the pair
//   moves and lands on an even index, add after either half → after the right half. After every
//   structural op repairSpreads runs; spreads it had to split are reported as `splitCount` (the UI
//   shows an Undo toast when > 0 — the store's undo stack holds the pre-op doc). An op whose
//   repair would push the book past `maxPages` throws "page_limit" (nothing changes).

import { LIMITS } from "@/lib/ai/limits";
import { getLayout } from "@/lib/layouts";
import { clipCodePoints, clipText, stripLoneSurrogates } from "@/lib/text/clip";
import { clampCrop, DEFAULT_CROP } from "./crop";
import { styleCaptionFont } from "@/lib/design/styles";
import { DEFAULT_ARABIC_CAPTION_FONT, defaultCaptionFont, type CaptionFont } from "./fonts";
import { BOOK_TITLE_MAX_CODE_POINTS } from "./options";
import { BackgroundSchema } from "./schema";
import { isSpreadLayout, layoutsFor, repairSpreads, splitSpreadAt, spreadStartOf } from "./spreads";
import type { Background, BookDoc, BookPage, Caption, Chapter, Crop, Layout, PageBackground, Slot } from "./types";

export type EditOpErrorCode =
  | "page_out_of_range"
  | "slot_out_of_range"
  | "unknown_layout"
  | "not_a_page_layout"
  | "unknown_chapter"
  | "no_caption_area"
  | "page_limit"
  | "invalid_background"
  /** A spread layout was picked for a right-hand page (odd index) that is not part of a spread. */
  | "spread_needs_left_page"
  /** The change would remove a user caption; repeat with `confirmDropCaptions: true` after asking. */
  | "would_drop_caption"
  /** The layout is for another format or design style than the book (D-063: both fixed per book). */
  | "layout_not_for_book";

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
/** Default layout for a page added with addPage() to a classic portrait book. Has a caption area. */
export const DEFAULT_NEW_PAGE_LAYOUT = "one-portrait";

/**
 * Default layout for a new page of this book: DEFAULT_NEW_PAGE_LAYOUT when it matches the book's
 * format + style, else the first page layout of that format + style with a caption area (else the
 * first one at all).
 */
export function defaultNewPageLayout(doc: BookDoc): string {
  const style = doc.style.designStyle ?? "classic";
  const def = getLayout(DEFAULT_NEW_PAGE_LAYOUT);
  if (def && def.format === doc.format && def.style === style) return def.id;
  const pool = layoutsFor(doc.format, style, "page");
  return (pool.find((l) => l.photoCount === 1 && l.caption !== null) ?? pool.find((l) => l.caption !== null) ?? pool[0] ?? def)?.id ?? DEFAULT_NEW_PAGE_LAYOUT;
}
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

/** The caption rect a page can show: its layout's, none on a spread's right half. */
function captionArea(page: BookPage): Layout["caption"] {
  const layout = getLayout(page.layout);
  if (!layout) throw new EditOpError("unknown_layout");
  if (layout.role === "cover") throw new EditOpError("not_a_page_layout");
  if (layout.role === "spread" && page.side !== "left") return null;
  return layout.caption;
}

/** D-063: a page layout must match the book's format and design style (absent style = classic). */
function assertLayoutForBook(doc: BookDoc, layout: Layout): void {
  if (layout.format !== doc.format || layout.style !== (doc.style.designStyle ?? "classic")) {
    throw new EditOpError("layout_not_for_book");
  }
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

/** Page cap: `maxPages` floored, never above the schema ceiling of 100. */
function pageCap(maxPages: number): number {
  return Number.isFinite(maxPages) ? Math.min(Math.floor(maxPages), SCHEMA_MAX_PAGES) : 0;
}

const placedIds = (pages: readonly BookPage[]) =>
  pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((id): id is string => id !== null));

/**
 * Repair spreads after a structural change, refuse when the repair pushes the book past the cap
 * (unless it was not growing), prune chapters left without pages.
 */
function settleSpreads(before: BookDoc, after: BookDoc, maxPages: number): { doc: BookDoc; splitCount: number } {
  if (after === before) return { doc: before, splitCount: 0 };
  const r = repairSpreads(after);
  const n = r.doc.pages.length;
  if (n > pageCap(maxPages) && n > before.pages.length) throw new EditOpError("page_limit");
  return { doc: pruneEmptyChapters(r.doc), splitCount: r.splitCount };
}

/** Index of the page with `id` in `doc` (fallback when absent). */
const indexOfId = (doc: BookDoc, id: string, fallback: number) => {
  const i = doc.pages.findIndex((p) => p.id === id);
  return i >= 0 ? i : Math.min(Math.max(fallback, 0), Math.max(doc.pages.length - 1, 0));
};

export interface PageUnit {
  /** Index of the unit's first page. */
  start: number;
  /** 2 for a spread (both halves), else 1. */
  count: 1 | 2;
}

/**
 * The pages a structural op on doc.pages[pageIdx] acts on: the whole spread when the page is a
 * half of an aligned spread, else just that page. The UI asks to confirm a delete when count = 2.
 */
export function pageUnit(doc: BookDoc, pageIdx: number): PageUnit {
  pageAt(doc, pageIdx);
  const start = spreadStartOf(doc, pageIdx);
  return start === null ? { start: pageIdx, count: 1 } : { start, count: 2 };
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
  return doc.pages.length < pageCap(maxPages);
}

// ---- layout --------------------------------------------------------------------------------------

export interface ChangeLayoutOptions {
  /** The book's page limit (default and ceiling 100). A spread on the last page needs one more page. */
  maxPages?: number;
  /**
   * Allow removing user captions (source "user") when the new layout can't keep them. Without it
   * such a change throws "would_drop_caption" — use planChangeLayout() to ask the user first.
   * (Single-page → single-page changes keep their M5 behaviour: the caption is dropped and
   * reported in droppedCaption for the Undo toast.)
   */
  confirmDropCaptions?: boolean;
}

export interface ChangeLayoutResult {
  doc: BookDoc;
  /** Photos that no longer fit (in their old slot order) — now unused. */
  removedPhotoIds: string[];
  /** The first caption removed (no caption area / only one caption fits a spread), else null. */
  droppedCaption: Caption | null;
  /** Every caption removed by the change (M10b; [] when none). */
  droppedCaptions: Caption[];
  /** Index of the page that now has the chosen layout (a spread: its left half). */
  pageIdx: number;
  /** Pages the change added (a spread picked on the last page; overflow when splitting a spread). */
  pagesAdded: number;
  /** Later spreads split by the reflow (repairSpreads). > 0 → Undo toast. */
  splitCount: number;
}

const noChange = (doc: BookDoc, pageIdx: number): ChangeLayoutResult => ({
  doc,
  removedPhotoIds: [],
  droppedCaption: null,
  droppedCaptions: [],
  pageIdx,
  pagesAdded: 0,
  splitCount: 0,
});

/**
 * Switch a page to another layout.
 *
 * Single-page layout on a single page (M5): placed photos re-flow in order (empty slots skipped)
 * into the new slots, keeping their crops; photos beyond the new slot count become unused;
 * remaining slots are empty. The caption is dropped when the new layout has no caption area.
 *
 * Single-page layout on a spread half (D-064): the spread is first split into its twin single
 * pages with the repair rules (splitSpreadAt — every photo, crop, caption and background kept,
 * overflow onto extra pages), then the tapped half's page gets the new layout as above.
 *
 * Spread layout (M10b A7): only on a left-hand page (even index) or on a half of an existing
 * spread (then that spread is re-laid out); a single right-hand page throws
 * "spread_needs_left_page". The page and the next one merge: the left page's photos then the next
 * page's photos fill the spread slots in order (crops kept); leftovers become unused. With no
 * next page one is added if the limit allows, else "page_limit". Captions: the spread keeps ONE
 * caption (when it has a caption area) — the first user caption of (left, right), else the first
 * caption; every other caption is removed, and if any removed caption is a user caption the op
 * throws "would_drop_caption" unless `confirmDropCaptions`. Each page keeps its own background,
 * id and chapter (the right page becomes the right half). Later spreads are never moved.
 */
export function changeLayout(
  doc: BookDoc,
  pageIdx: number,
  layoutId: string,
  opts: ChangeLayoutOptions = {},
): ChangeLayoutResult {
  pageAt(doc, pageIdx);
  const layout = getLayout(layoutId);
  if (!layout) throw new EditOpError("unknown_layout");
  if (layout.role === "cover") throw new EditOpError("not_a_page_layout");
  assertLayoutForBook(doc, layout);
  const maxPages = opts.maxPages ?? SCHEMA_MAX_PAGES;
  if (layout.role === "spread") return changeToSpread(doc, pageIdx, layout, maxPages, opts.confirmDropCaptions === true);

  const start = spreadStartOf(doc, pageIdx);
  if (start === null) {
    const r = changeSingle(doc, pageIdx, layout);
    const settled = settleSpreads(doc, r.doc, maxPages);
    const id = doc.pages[pageIdx].id;
    return { ...r, doc: settled.doc, splitCount: settled.splitCount, pageIdx: indexOfId(settled.doc, id, pageIdx) };
  }
  // A spread half → split the spread into its twins, then change the tapped half.
  const split = splitSpreadAt(doc, start);
  if (!split) throw new EditOpError("page_out_of_range"); // unreachable: spreadStartOf found it
  const targetId = pageIdx === start ? split.leftPageIds[0] : split.rightPageIds[0];
  const idx = indexOfId(split.doc, targetId, pageIdx);
  const r = changeSingle(split.doc, idx, layout);
  const settled = settleSpreads(doc, r.doc, maxPages);
  return {
    ...r,
    doc: settled.doc,
    splitCount: settled.splitCount,
    pageIdx: indexOfId(settled.doc, targetId, idx),
    pagesAdded: Math.max(0, settled.doc.pages.length - doc.pages.length),
  };
}

/** M5 single-page change (no spread logic). */
function changeSingle(doc: BookDoc, pageIdx: number, layout: Layout): ChangeLayoutResult {
  const page = doc.pages[pageIdx];
  if (page.layout === layout.id && page.slots.length === layout.photoCount && page.side === undefined) {
    return noChange(doc, pageIdx);
  }
  const placed = page.slots.filter((s) => s.photoId !== null);
  const kept = placed.slice(0, layout.photoCount);
  const removedPhotoIds = placed.slice(layout.photoCount).map((s) => s.photoId as string);
  const slots: Slot[] = Array.from({ length: layout.photoCount }, (_, i) =>
    kept[i] ? { photoId: kept[i].photoId, crop: { ...kept[i].crop } } : emptySlot(),
  );
  const droppedCaption = layout.caption === null ? page.caption : null;
  const caption = layout.caption === null ? null : page.caption;
  const next: BookPage = { ...page, layout: layout.id, slots, caption };
  delete next.side;
  return {
    ...noChange(withPage(doc, pageIdx, next), pageIdx),
    removedPhotoIds,
    droppedCaption,
    droppedCaptions: droppedCaption ? [droppedCaption] : [],
  };
}

function changeToSpread(
  doc: BookDoc,
  pageIdx: number,
  layout: Layout,
  maxPages: number,
  confirmDropCaptions: boolean,
): ChangeLayoutResult {
  const existing = spreadStartOf(doc, pageIdx);
  const start = existing ?? pageIdx;
  if (start % 2 !== 0) throw new EditOpError("spread_needs_left_page");
  const left = doc.pages[start];
  if (existing !== null && left.layout === layout.id) return noChange(doc, start);
  let right: BookPage | undefined = doc.pages[start + 1];
  // Only reachable on a malformed doc: the next page is itself a spread half that isn't ours.
  if (existing === null && right && isSpreadLayout(right.layout)) throw new EditOpError("spread_needs_left_page");

  let pagesAdded = 0;
  if (!right) {
    if (!canAddPage(doc, maxPages)) throw new EditOpError("page_limit");
    right = { id: newPageId(doc), chapterId: left.chapterId, layout: layout.id, slots: [], caption: null };
    pagesAdded = 1;
  }

  const placed = [...left.slots, ...right.slots].filter((s) => s.photoId !== null);
  const kept = placed.slice(0, layout.photoCount);
  const removedPhotoIds = placed.slice(layout.photoCount).map((s) => s.photoId as string);
  const slots: Slot[] = Array.from({ length: layout.photoCount }, (_, i) =>
    kept[i] ? { photoId: kept[i].photoId, crop: { ...kept[i].crop } } : emptySlot(),
  );

  const captions = [left.caption, right.caption].filter((c): c is Caption => c !== null);
  const keep =
    layout.caption === null ? null : (captions.find((c) => c.source === "user") ?? captions[0] ?? null);
  const droppedCaptions = captions.filter((c) => c !== keep);
  if (!confirmDropCaptions && droppedCaptions.some((c) => c.source === "user")) {
    throw new EditOpError("would_drop_caption");
  }

  const newLeft: BookPage = { ...left, layout: layout.id, side: "left", slots, caption: keep ? { ...keep } : null };
  const newRight: BookPage = { ...right, layout: layout.id, side: "right", slots: [], caption: null };
  const pages = doc.pages.slice();
  pages.splice(start, pagesAdded === 1 ? 1 : 2, newLeft, newRight);
  const settled = settleSpreads(doc, { ...doc, pages }, maxPages);
  return {
    doc: settled.doc,
    removedPhotoIds,
    droppedCaption: droppedCaptions[0] ?? null,
    droppedCaptions,
    pageIdx: indexOfId(settled.doc, left.id, start),
    pagesAdded,
    splitCount: settled.splitCount,
  };
}

export type ChangeLayoutPlan =
  | {
      ok: true;
      /** The result of applying the change with confirmDropCaptions: true. */
      result: ChangeLayoutResult;
      /** True when user captions would be removed: ask first, then call changeLayout with confirmDropCaptions. */
      needsConfirm: boolean;
      /** The user captions that would be removed (show their text in the confirm dialog). */
      droppedUserCaptions: Caption[];
    }
  | { ok: false; code: EditOpErrorCode };

/**
 * Dry run of changeLayout for the UI: what the change would do, and whether it needs a confirm
 * (user captions removed). Never throws for EditOpErrors.
 */
export function planChangeLayout(
  doc: BookDoc,
  pageIdx: number,
  layoutId: string,
  opts: Omit<ChangeLayoutOptions, "confirmDropCaptions"> = {},
): ChangeLayoutPlan {
  try {
    const result = changeLayout(doc, pageIdx, layoutId, { ...opts, confirmDropCaptions: true });
    const droppedUserCaptions = result.droppedCaptions.filter((c) => c.source === "user");
    // Single → single keeps the M5 behaviour (toast + Undo, no confirm).
    const target = getLayout(layoutId);
    const needsConfirm = droppedUserCaptions.length > 0 && target?.role === "spread";
    return { ok: true, result, needsConfirm, droppedUserCaptions };
  } catch (err) {
    if (err instanceof EditOpError) return { ok: false, code: err.code };
    throw err;
  }
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
 * An existing caption keeps its font/align; a new one gets "center" and the book style's caption
 * face (newCaptionFont): classic = defaultCaptionFont (Playfair / Cairo, unchanged), modern =
 * styleCaptionFont (Cormorant / Amiri) — caption.font overrides the style face in the renderer.
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
  if (captionArea(page) === null) throw new EditOpError("no_caption_area");
  const prev = page.caption;
  if (prev && prev.text === clean && prev.source === "user") return doc;
  const caption: Caption = {
    text: clean,
    font: prev?.font ?? newCaptionFont(doc, clean, opts.captionLang),
    align: prev?.align ?? "center",
    source: "user",
  };
  return withPage(doc, pageIdx, { ...page, caption });
}

/**
 * Font for a new user caption: Arabic vs Latin is decided from the text as before
 * (defaultCaptionFont); classic books keep exactly that font, other styles use their caption face.
 */
export function newCaptionFont(doc: Pick<BookDoc, "style">, text: string, captionLang?: string) {
  const classic = defaultCaptionFont(text, captionLang);
  const style = doc.style.designStyle ?? "classic";
  if (style === "classic") return classic;
  return styleCaptionFont(style, classic === DEFAULT_ARABIC_CAPTION_FONT ? "ar" : "en");
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

export interface PageOpResult {
  doc: BookDoc;
  /**
   * Index of the affected page in the new doc: the added page, the moved unit's first page, or
   * (delete) the page now at the deleted spot (clamped; -1 when the book has no pages left).
   */
  pageIdx: number;
  pagesAdded: number;
  /** 2 when a spread was deleted (the UI confirms first via pageUnit), 1 for a page, 0 otherwise. */
  pagesRemoved: number;
  /** Photos that left the book's pages (deleted pages) — now unused. */
  removedPhotoIds: string[];
  /** Spreads split by the reflow (repairSpreads, D-064). > 0 → Undo toast. */
  splitCount: number;
}

const unchanged = (doc: BookDoc, pageIdx: number): PageOpResult => ({
  doc,
  pageIdx,
  pagesAdded: 0,
  pagesRemoved: 0,
  removedPhotoIds: [],
  splitCount: 0,
});

/** True when inserting at `at` in `pages` would sit between the halves of a spread. */
function insideSpread(pages: BookPage[], at: number): boolean {
  const before = pages[at - 1];
  const after = pages[at];
  return !!before && !!after && before.side === "left" && after.side === "right" && before.layout === after.layout;
}

/**
 * Insert an empty single page (all slots empty, no caption; default layout: defaultNewPageLayout)
 * after `afterIdx` (-1 = at the start),
 * in the chapter of the page at `afterIdx` (at the start: the chapter of the current first page).
 * After a spread half the page goes after the whole spread. Later spreads pushed onto a right
 * page are split (splitCount). Throws "page_limit" past `maxPages` (default and ceiling: the
 * schema max of 100) — check canAddPage() first in the UI.
 */
export function addPageResult(
  doc: BookDoc,
  afterIdx: number,
  layoutId: string = defaultNewPageLayout(doc),
  maxPages: number = SCHEMA_MAX_PAGES,
): PageOpResult {
  if (!Number.isInteger(afterIdx) || afterIdx < -1 || afterIdx >= doc.pages.length) {
    throw new EditOpError("page_out_of_range");
  }
  const layout = pageLayout(layoutId);
  assertLayoutForBook(doc, layout);
  if (!canAddPage(doc, maxPages)) throw new EditOpError("page_limit");
  let after = afterIdx;
  if (after >= 0) {
    const unit = pageUnit(doc, after);
    after = unit.start + unit.count - 1;
  }
  const neighbour = after >= 0 ? doc.pages[after] : doc.pages[0];
  const page: BookPage = {
    id: newPageId(doc),
    chapterId: neighbour?.chapterId ?? doc.chapters[0]?.id ?? null,
    layout: layout.id,
    slots: Array.from({ length: layout.photoCount }, emptySlot),
    caption: null,
  };
  const pages = doc.pages.slice();
  pages.splice(after + 1, 0, page);
  const settled = settleSpreads(doc, { ...doc, pages }, maxPages);
  return {
    ...unchanged(settled.doc, indexOfId(settled.doc, page.id, after + 1)),
    pagesAdded: settled.doc.pages.length - doc.pages.length,
    splitCount: settled.splitCount,
  };
}

/** addPageResult, returning only the doc (M5 signature). */
export function addPage(
  doc: BookDoc,
  afterIdx: number,
  layoutId: string = defaultNewPageLayout(doc),
  maxPages: number = SCHEMA_MAX_PAGES,
): BookDoc {
  return addPageResult(doc, afterIdx, layoutId, maxPages).doc;
}

/**
 * Remove a page — or the whole spread when it is a spread half (pagesRemoved 2; confirm first
 * with pageUnit). Its photos become unused. Later spreads pushed onto a right page are split.
 * Chapters left without pages are pruned.
 */
export function deletePageResult(doc: BookDoc, pageIdx: number, maxPages: number = SCHEMA_MAX_PAGES): PageOpResult {
  const unit = pageUnit(doc, pageIdx);
  const removed = doc.pages.slice(unit.start, unit.start + unit.count);
  const pages = doc.pages.filter((_, i) => i < unit.start || i >= unit.start + unit.count);
  const settled = settleSpreads(doc, { ...doc, pages }, maxPages);
  const n = settled.doc.pages.length;
  return {
    doc: settled.doc,
    pageIdx: n === 0 ? -1 : Math.min(unit.start, n - 1),
    pagesAdded: 0,
    pagesRemoved: unit.count,
    removedPhotoIds: placedIds(removed),
    splitCount: settled.splitCount,
  };
}

/** deletePageResult, returning only the doc (M5 signature). */
export function deletePage(doc: BookDoc, pageIdx: number, maxPages: number = SCHEMA_MAX_PAGES): BookDoc {
  return deletePageResult(doc, pageIdx, maxPages).doc;
}

/** Give every page of `unit` the chapter `chapterId` (same objects when already there). */
const withChapter = (unit: BookPage[], chapterId: string | null) =>
  unit.map((p) => (p.chapterId === chapterId ? p : { ...p, chapterId }));

/**
 * Move a page so it ends up at index `to` (index in the resulting page list). A spread half moves
 * the whole spread, which lands on an even index (`to` rounded toward the move's direction), so
 * moving a spread never splits anything. A single page never lands between a spread's halves
 * (it goes past the spread in the move's direction); spreads it shifts by one are split
 * (splitCount). The moved unit takes the chapter of the page before it at its new spot; at
 * position 0 the chapter of the page that is now after it (= the book's first chapter). Empty
 * chapters are pruned.
 */
export function movePageResult(doc: BookDoc, from: number, to: number, maxPages: number = SCHEMA_MAX_PAGES): PageOpResult {
  const unit = pageUnit(doc, from);
  if (!Number.isInteger(to) || to < 0 || to >= doc.pages.length) throw new EditOpError("page_out_of_range");
  if (from === to) return unchanged(doc, unit.start);
  const moving = doc.pages.slice(unit.start, unit.start + unit.count);
  const rest = doc.pages.filter((_, i) => i < unit.start || i >= unit.start + unit.count);
  const forward = to > from;
  let at = Math.min(to, rest.length);
  if (unit.count === 2) {
    if (at % 2 !== 0) at = forward && at + 1 <= rest.length ? at + 1 : at - 1;
  } else if (insideSpread(rest, at)) {
    at = forward ? at + 1 : at - 1;
  }
  if (at === unit.start) return unchanged(doc, unit.start);
  const neighbour = at > 0 ? rest[at - 1] : rest[0];
  const chapterId = neighbour ? neighbour.chapterId : moving[0].chapterId;
  rest.splice(at, 0, ...withChapter(moving, chapterId));
  const settled = settleSpreads(doc, { ...doc, pages: rest }, maxPages);
  return {
    ...unchanged(settled.doc, indexOfId(settled.doc, moving[0].id, at)),
    pagesAdded: Math.max(0, settled.doc.pages.length - doc.pages.length),
    splitCount: settled.splitCount,
  };
}

/** movePageResult, returning only the doc (M5 signature). */
export function movePage(doc: BookDoc, from: number, to: number, maxPages: number = SCHEMA_MAX_PAGES): BookDoc {
  return movePageResult(doc, from, to, maxPages).doc;
}

/**
 * Move a page (a spread half: the whole spread) to the end of `chapterId` (D-037 5: "Move to
 * chapter" appends; never between a spread's halves). A spread that would land on an odd index
 * goes before the chapter's last page instead, so it stays intact. A chapter that has no pages
 * gets the unit at the end of the book (a spread there may be split if the book's length is odd).
 * Empty chapters are pruned.
 */
export function movePageToChapterResult(
  doc: BookDoc,
  pageIdx: number,
  chapterId: string,
  maxPages: number = SCHEMA_MAX_PAGES,
): PageOpResult {
  const unit = pageUnit(doc, pageIdx);
  if (!doc.chapters.some((c) => c.id === chapterId)) throw new EditOpError("unknown_chapter");
  const moving = doc.pages.slice(unit.start, unit.start + unit.count);
  const rest = doc.pages.filter((_, i) => i < unit.start || i >= unit.start + unit.count);
  let last = -1;
  rest.forEach((p, i) => {
    if (p.chapterId === chapterId) last = i;
  });
  let at = last >= 0 ? last + 1 : rest.length;
  if (insideSpread(rest, at)) at++;
  if (unit.count === 2 && at % 2 !== 0 && last >= 0) at--;
  rest.splice(at, 0, ...withChapter(moving, chapterId));
  if (rest.every((p, i) => p === doc.pages[i])) return unchanged(doc, unit.start);
  const settled = settleSpreads(doc, { ...doc, pages: rest }, maxPages);
  return {
    ...unchanged(settled.doc, indexOfId(settled.doc, moving[0].id, at)),
    pagesAdded: Math.max(0, settled.doc.pages.length - doc.pages.length),
    splitCount: settled.splitCount,
  };
}

/** movePageToChapterResult, returning only the doc (M5 signature). */
export function movePageToChapter(
  doc: BookDoc,
  pageIdx: number,
  chapterId: string,
  maxPages: number = SCHEMA_MAX_PAGES,
): BookDoc {
  return movePageToChapterResult(doc, pageIdx, chapterId, maxPages).doc;
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
