// Two-page spread layouts in the book doc (M10b A2, D-064). Pure: no React/DOM/server imports.
//
// STORAGE MODEL
// The cover stands alone; doc.pages pair up as facing pages [0,1], [2,3], … (same pairing as the
// editor's src/lib/editor/spreads.ts pagesOfSpread and the flipbook viewer). So a left-hand page
// is an EVEN index of doc.pages and its right-hand partner is the next (odd) index.
//
// A spread layout (role "spread") is stored as TWO consecutive pages:
//   pages[2k]   = { side: "left",  layout: <spread id>, slots: <all photoCount slots>,
//                   caption: <the spread's caption or null> }   — owns everything; slot and
//                   caption rects are in 0..200 % x-coordinates across both pages (0..100 = left).
//   pages[2k+1] = { side: "right", layout: <same spread id>, slots: [], caption: null }
//                   — an empty placeholder; it may carry its own `background` and chapterId.
// Both halves count toward the page limits (a spread = 2 pages). Single-page layouts never
// carry `side`. A spread is "aligned" when every left half sits at an even index directly
// followed by its right half, and no right half appears without its left half.
//
// REPAIR (D-064): a single-page insert/delete/move can push a later spread onto a right page.
// repairSpreads then splits it into its twin single-page layouts (layout.twin = [leftId,
// rightId]), distributing slots by which half each slot's centre falls in (centre x < 100 → left).
// Photos, crops and captions are never dropped; when a twin has too few slots, a bigger
// single-page layout of the book's format and design style is used (never another style), and
// only if no layout of that style can hold them all do the leftovers continue on an extra page. An empty right half with
// no left half (only possible from a bug) is removed — no blank filler pages are ever added.

import { getLayout, LAYOUTS } from "@/lib/layouts";
import type { BookDoc, BookFormat, BookPage, DesignStyle, Layout, LayoutRole, Rect, Slot } from "./types";

/** Pages a spread occupies (and counts toward the 20/100 limits). */
export const SPREAD_PAGES = 2;

const CLASSIC: DesignStyle = "classic";

// --- Catalogue queries ---------------------------------------------------------------------------

/**
 * Layouts of `role` for a book of `format` and design `style`, in catalogue order.
 * `style: null` = every style of that format.
 */
export function layoutsFor(format: BookFormat, style: DesignStyle | null, role: LayoutRole): readonly Layout[] {
  return LAYOUTS.filter((l) => l.role === role && l.format === format && (style === null || l.style === style));
}

/** The spread layout `id`, or undefined when unknown / not a spread. */
export function getSpreadLayout(id: string): Layout | undefined {
  const l = getLayout(id);
  return l?.role === "spread" ? l : undefined;
}

export function isSpreadLayout(id: string): boolean {
  return getSpreadLayout(id) !== undefined;
}

/** Which page of the spread a layout rect lies on: by its centre (x < 100 → left). */
export function rectHalf(r: Pick<Rect, "x" | "w">): "left" | "right" {
  return r.x + r.w / 2 < 100 ? "left" : "right";
}

/** A rect of the right half moved into single-page coordinates (x − 100); left rects unchanged. */
export function toPageRect(r: Rect): Rect {
  return rectHalf(r) === "right" ? { ...r, x: Math.max(0, r.x - 100) } : r;
}

// --- Alignment -----------------------------------------------------------------------------------

export type SpreadIssueKind =
  | "misaligned" // left half on an odd index (would show on a right-hand page)
  | "orphan_right" // right half not directly after its left half
  | "missing_right" // left half without a right half (e.g. the last page)
  | "missing_side" // spread layout on a page without side
  | "side_on_single"; // side on a single-page layout

export interface SpreadIssue {
  index: number;
  kind: SpreadIssueKind;
  layout: string;
}

const isLeftHalf = (p: BookPage | undefined, id?: string) =>
  !!p && p.side === "left" && isSpreadLayout(p.layout) && (id === undefined || p.layout === id);
const isRightHalf = (p: BookPage | undefined, id: string) => !!p && p.side === "right" && p.layout === id;

/**
 * Structural spread problems of `doc.pages`, in page order. Unknown layouts are ignored here
 * (validateBookDoc reports them). [] = aligned.
 */
export function spreadIssues(doc: Pick<BookDoc, "pages">): SpreadIssue[] {
  const out: SpreadIssue[] = [];
  const pages = doc.pages;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const layout = getLayout(p.layout);
    if (!layout) continue;
    if (layout.role !== "spread") {
      if (p.side !== undefined) out.push({ index: i, kind: "side_on_single", layout: layout.id });
      continue;
    }
    if (p.side === undefined) {
      out.push({ index: i, kind: "missing_side", layout: layout.id });
      continue;
    }
    if (p.side === "right") {
      // A correctly placed right half is consumed by its left half below.
      out.push({ index: i, kind: "orphan_right", layout: layout.id });
      continue;
    }
    if (i % 2 !== 0) out.push({ index: i, kind: "misaligned", layout: layout.id });
    if (isRightHalf(pages[i + 1], layout.id)) i++;
    else out.push({ index: i, kind: "missing_right", layout: layout.id });
  }
  return out;
}

/** True when every spread starts on a left-hand page (even index) followed by its right half. */
export function isSpreadAligned(doc: Pick<BookDoc, "pages">): boolean {
  return spreadIssues(doc).length === 0;
}

/** Issue text for validateBookDoc (indices + layout ids only, never user data). */
export function spreadIssueText(issue: SpreadIssue, safeId: (id: string) => string = (s) => s): string {
  const at = `pages[${issue.index}]`;
  const id = safeId(issue.layout);
  switch (issue.kind) {
    case "misaligned":
      return `${at}: spread "${id}" starts on a right-hand page`;
    case "orphan_right":
      return `${at}: right half of spread "${id}" without its left half`;
    case "missing_right":
      return `${at}: spread "${id}" has no right half`;
    case "missing_side":
      return `${at}: spread "${id}" page has no side`;
    case "side_on_single":
      return `${at}: layout "${id}" is not a spread but has a side`;
  }
}

/**
 * Index of the left half of the spread containing `doc.pages[idx]`, or null when that page is a
 * single page (or an orphan half). For edit ops (A7) that move/delete a spread as one unit.
 */
export function spreadStartOf(doc: Pick<BookDoc, "pages">, idx: number): number | null {
  const p = doc.pages[idx];
  if (!p || !isSpreadLayout(p.layout)) return null;
  if (p.side === "left") return isRightHalf(doc.pages[idx + 1], p.layout) ? idx : null;
  if (p.side === "right") return isLeftHalf(doc.pages[idx - 1], p.layout) ? idx - 1 : null;
  return null;
}

// --- Repair --------------------------------------------------------------------------------------

export interface PickPageLayoutRequest {
  format: BookFormat;
  style: DesignStyle;
  /** Photos that must fit (≥ 1, or 0 for a caption-only half). */
  photoCount: number;
  /** A caption must be kept → the layout needs a caption area. */
  needsCaption: boolean;
  /** The twin that was too small (or lacked a caption area). */
  twin: Layout;
}

export interface RepairSpreadsOptions {
  /**
   * Single-page layout id for a half whose twin can't hold its photos / caption. Must return a
   * "page" layout of `format` AND `style` with ≥ photoCount slots (and a caption area when
   * needsCaption), or null to use the default: smallest fitting layout of format+style (catalogue
   * order on ties). Never another style: validateBookDoc rejects off-style layouts.
   */
  pickPageLayout?: (req: PickPageLayoutRequest) => string | null;
}

export interface RepairSpreadsResult {
  /** The repaired doc — the SAME object when nothing needed repair. */
  doc: BookDoc;
  /** Spreads split into single pages (misaligned, missing right half, orphan right half with content). */
  splitCount: number;
  /** Empty orphan right halves removed. */
  droppedHalves: number;
  /** Stray `side` keys removed from single-page layouts. */
  clearedSides: number;
}

const DEFAULT_CROP = { x: 0.5, y: 0.5, zoom: 1 } as const;
const emptySlot = (): Slot => ({ photoId: null, crop: { ...DEFAULT_CROP } });
const hasPhoto = (s: Slot) => s.photoId !== null;

/**
 * Make every spread aligned (D-064): misaligned spreads and halves without a partner become
 * single pages (see header). Never drops photos or captions, never adds a page without content.
 * Pure; the input doc is not mutated.
 */
export function repairSpreads(doc: BookDoc, opts: RepairSpreadsOptions = {}): RepairSpreadsResult {
  if (isSpreadAligned(doc)) return { doc, splitCount: 0, droppedHalves: 0, clearedSides: 0 };

  const ctx = splitContext(doc, opts);

  const out: BookPage[] = [];
  let splitCount = 0;
  let droppedHalves = 0;
  let clearedSides = 0;
  const pages = doc.pages;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const layout = getLayout(p.layout);
    if (!layout) {
      out.push(p); // unknown layout: validation's job
      continue;
    }
    if (layout.role !== "spread") {
      if (p.side !== undefined) {
        const rest = { ...p };
        delete rest.side;
        out.push(rest);
        clearedSides++;
      } else out.push(p);
      continue;
    }
    const isRight = p.side === "right";
    const partner = !isRight && isRightHalf(pages[i + 1], layout.id) ? pages[i + 1] : null;
    if (!isRight && p.side === "left" && partner && out.length % 2 === 0) {
      out.push(p, partner); // aligned pair: unchanged objects
      i++;
      continue;
    }
    if (isRight && !pageHasContent(p)) {
      droppedHalves++;
      continue;
    }
    out.push(...splitSpread(layout, p, isRight ? null : partner, ctx));
    splitCount++;
    if (partner) i++;
  }
  return { doc: { ...doc, pages: out }, splitCount, droppedHalves, clearedSides };
}

function splitContext(doc: BookDoc, opts: RepairSpreadsOptions): SplitContext {
  const ids = new Set(doc.pages.map((p) => p.id));
  const newId = (): string => {
    let n = doc.pages.length + 1;
    while (ids.has(`p${n}`)) n++;
    ids.add(`p${n}`);
    return `p${n}`;
  };
  return { format: doc.format, style: doc.style.designStyle ?? CLASSIC, pick: opts.pickPageLayout, newId };
}

export interface SplitSpreadAtResult {
  doc: BookDoc;
  /** Ids of the pages that replaced the left half (first = the left page's id, + overflow pages). */
  leftPageIds: string[];
  /** Ids of the pages that replaced the right half (first = the right page's id, + overflow pages). */
  rightPageIds: string[];
}

/**
 * Split the aligned spread whose left half is `doc.pages[leftIdx]` into its twin single pages with
 * the repair rules (slots by half, captions/crops/backgrounds kept, too-small twin → bigger layout
 * of the doc's format+style, overflow → extra pages). For "change a spread to a single layout"
 * (edit-ops). Returns null when `leftIdx` is not the left half of a complete spread.
 */
export function splitSpreadAt(doc: BookDoc, leftIdx: number, opts: RepairSpreadsOptions = {}): SplitSpreadAtResult | null {
  if (spreadStartOf(doc, leftIdx) !== leftIdx) return null;
  const left = doc.pages[leftIdx];
  const right = doc.pages[leftIdx + 1];
  const layout = getSpreadLayout(left.layout);
  if (!layout) return null;
  const emitted = splitSpread(layout, left, right, splitContext(doc, opts));
  const at = emitted.findIndex((p) => p.id === right.id);
  const cut = at < 0 ? emitted.length : at;
  const pages = doc.pages.slice();
  pages.splice(leftIdx, 2, ...emitted);
  return {
    doc: { ...doc, pages },
    leftPageIds: emitted.slice(0, cut).map((p) => p.id),
    rightPageIds: emitted.slice(cut).map((p) => p.id),
  };
}

interface SplitContext {
  format: BookFormat;
  style: DesignStyle;
  pick?: (req: PickPageLayoutRequest) => string | null;
  newId: () => string;
}

const pageHasContent = (p: BookPage) => p.caption !== null || p.slots.some(hasPhoto);

interface Half {
  slots: Slot[];
  caption: BookPage["caption"];
}

/**
 * Split one spread (left page `owner` + optional right page `right`) into single pages. `owner`
 * may also be an orphan right half (then `right` is null). Slot j goes to the half of
 * layout.slots[j] (slots beyond the layout → right). The caption goes to the half of the
 * layout's caption rect (left when the layout has none).
 */
function splitSpread(layout: Layout, owner: BookPage, right: BookPage | null, ctx: SplitContext): BookPage[] {
  const halves: [Half, Half] = [
    { slots: [], caption: null },
    { slots: [], caption: null },
  ];
  owner.slots.forEach((s, j) => {
    const rect = layout.slots[j];
    halves[rect && rectHalf(rect) === "left" ? 0 : 1].slots.push(s);
  });
  for (const s of right?.slots ?? []) halves[1].slots.push(s); // malformed right half: keep its photos
  const captions = [owner.caption, right?.caption ?? null].filter((c) => c !== null);
  if (captions.length > 0) {
    const h = layout.caption && rectHalf(layout.caption) === "right" ? 1 : 0;
    halves[h].caption = captions[0];
    if (captions[1]) halves[1 - h].caption = captions[1];
  }

  const twins = (layout.twin ?? []).map((id) => getLayout(id));
  const content = halves.map((h) => h.caption !== null || h.slots.some(hasPhoto));
  // Both halves when the right page existed (page count unchanged); otherwise only halves with
  // content — the left one also when nothing has content, so the owner page never vanishes.
  const wanted = ([0, 1] as const).filter((h) =>
    h === 0 ? content[0] || right !== null || !content[1] : content[1] || right !== null,
  );
  const out: BookPage[] = [];
  for (const h of wanted) {
    // The first emitted page keeps the owner's id; a second one the right page's id if it existed.
    const base = out.length === 0 ? owner : right;
    const twin = twins[h] ?? twins[0];
    out.push(...fillHalf(halves[h], twin, base, owner, ctx));
  }
  return out;
}

/** Pages for one half: its twin when it fits, else a bigger single layout; overflow → extra pages. */
function fillHalf(half: Half, twin: Layout | undefined, base: BookPage | null, owner: BookPage, ctx: SplitContext): BookPage[] {
  const photos = half.slots.filter(hasPhoto);
  const pages: BookPage[] = [];
  let rest = photos;
  let caption = half.caption;
  let first = true;
  do {
    const need = rest.length;
    const layout = chooseLayout(twin, need, caption !== null, ctx);
    let slots: Slot[];
    if (first && layout.id === twin?.id && half.slots.length === layout.photoCount) {
      slots = half.slots; // exact fit: keep slot order incl. empty slots
      rest = [];
    } else {
      slots = rest.slice(0, layout.photoCount);
      rest = rest.slice(layout.photoCount);
      while (slots.length < layout.photoCount) slots.push(emptySlot());
    }
    const src = first ? base : null;
    const page: BookPage = {
      id: src?.id ?? ctx.newId(),
      chapterId: (base ?? owner).chapterId,
      layout: layout.id,
      slots: slots.map((s) => ({ photoId: s.photoId, crop: { ...s.crop } })),
      // A caption is never dropped: if no layout of the format has a caption area it stays on
      // the page anyway (validateBookDoc then reports it) instead of looping for a place.
      caption: caption !== null && (layout.caption !== null || first) ? { ...caption } : null,
    };
    const bg = (base ?? owner).background;
    if (bg) page.background = { ...bg };
    if (page.caption !== null) caption = null;
    pages.push(page);
    first = false;
  } while (rest.length > 0 || caption !== null);
  return pages;
}

/**
 * Twin if it fits, else the picker's / default choice, else the largest layout available — always
 * a page layout of the doc's format AND design style (validateBookDoc rejects a page whose layout
 * style differs from doc.style.designStyle), so a too-big half overflows onto extra pages of the
 * same style instead of switching style.
 */
function chooseLayout(twin: Layout | undefined, photoCount: number, needsCaption: boolean, ctx: SplitContext): Layout {
  const inStyle = (l: Layout) => l.role === "page" && l.format === ctx.format && l.style === ctx.style;
  const fits = (l: Layout) => inStyle(l) && l.photoCount >= photoCount && (!needsCaption || l.caption !== null);
  if (twin && fits(twin)) return twin;
  if (twin && ctx.pick) {
    const picked = getLayout(ctx.pick({ format: ctx.format, style: ctx.style, photoCount, needsCaption, twin }) ?? "");
    if (picked && fits(picked)) return picked;
  }
  const pool = layoutsFor(ctx.format, ctx.style, "page");
  const best = smallestFitting(pool, fits);
  if (best) return best;
  // Nothing holds them all: the largest layout of the style (with a caption area when one is
  // needed) takes what it can; fillHalf continues on another page.
  const capable = needsCaption ? pool.filter((l) => l.caption !== null) : pool;
  const from = capable.length > 0 ? capable : pool;
  const largest = from.reduce<Layout | undefined>((a, l) => (!a || l.photoCount > a.photoCount ? l : a), undefined);
  const fallback = largest ?? twin;
  if (!fallback) throw new Error(`repairSpreads: no page layout for ${ctx.format}/${ctx.style}`);
  return fallback;
}

function smallestFitting(pool: readonly Layout[], fits: (l: Layout) => boolean): Layout | undefined {
  let best: Layout | undefined;
  for (const l of pool) if (fits(l) && (!best || l.photoCount < best.photoCount)) best = l;
  return best;
}
