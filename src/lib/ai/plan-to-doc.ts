// AlbumPlan (Storyteller output, aliases) → BookDoc (real photo ids). Pure, deterministic, no I/O.
//
// Code validation step ⑤ of docs/AI-AGENTS.md. The plan is untrusted: every alias must map to a
// known, KEPT photo; layouts must exist with role "page" and the exact photoCount; no photo twice
// in pages (the cover photo may appear once more, on a page); pages ≤ effectiveMaxPages(book).
// Any problem → `{ issues }` (strings with indices, layout ids and aliases only — never user text),
// which the orchestrator feeds back to the Storyteller once (attempt 2), then falls back to the
// rule-based album.
//
// Grounding (CLAUDE.md "never invent places/facts"): chapter `place` is kept only when it equals
// (case/space-insensitive) a place of a photo in that moment, else null; `dateLabel` is recomputed
// from the moment's photo dates (Asia/Dubai days, same format as autolayout), never taken from AI.
// The user's books.title always wins over the AI title (D-018). Captions are null (written in M4).
//
// Book design (M10b A11, D-063/D-064): the plan is checked against the book's format + design
// style. A known page/spread layout of ANOTHER format/style is re-fitted to the best layout of the
// book's design with the same photos (bestPageLayout({design})); only when none exists it becomes
// an issue (retry → rule fallback). A spread entry (role "spread") expands into the page pair
// pages[2k] { side "left", all slots, caption } + pages[2k+1] { side "right", slots [], caption
// null }, counts 2 toward maxPages, and repairSpreads then splits any spread that does not start
// on a left page into its twin single pages (photos never dropped). The cover layout is the
// style's cover for the cover photo's orientation (bestCoverLayout).
//
// Backgrounds (v6, M10c T12, D-068 — modern / geometric / scrapbook; classic untouched, stays v1):
// the plan's background picks are mapped by backgroundPicksOf (catalogue ids of the book's style
// only; a faded-photo alias → a KEPT photo placed in the same moment; a moment that opens with a
// spread gets none) and handed to applyBackgroundSuggestions, which re-validates every pick and
// fills anything missing or invalid with the T11 rules. An invalid pick never fails the plan.
//
// Chapter descriptions (M30 T10, magazine / editorial = writesDescriptions(style)): a "description
// layout" has a text panel for the chapter's paragraph. The Storyteller's own in-design picks are
// kept, with one exception: a SECOND description layout in the same moment is re-fitted to a
// layout without the panel when one has that photo count (the same paragraph must not print
// twice). Re-fits (another design's layout, pages that lost photos in prunePlan) use
// bestPageLayout `description`: "prefer" for a page that showed the description or for the first
// page of a moment that has no description page, "avoid" once the moment has one, "any" else —
// so a moment ends with exactly one page / spread showing its description where the photo counts
// allow. The older styles pass no mode (default "avoid" = no-op, they have no such layouts).

import { withSuggestedColourway } from "@/lib/design/colourway-suggest";
import { withDefaultFilters } from "@/lib/book/default-filters";
import { dayRange, DEFAULT_TITLES } from "@/lib/autolayout";
import { DEFAULT_BOOK_DESIGN, type BookDesign } from "@/lib/book/book-design";
import { BOOK_TITLE_MAX_CODE_POINTS } from "@/lib/book/options";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc, BookPage, Chapter, Crop } from "@/lib/book/types";
import { repairSpreads, SPREAD_PAGES } from "@/lib/book/spreads";
import { getLayout } from "@/lib/layouts";
import { layoutIdShowsDescription, layoutShowsDescription, writesDescriptions } from "@/lib/layouts/description";
import { bestCoverLayout, bestPageLayout, type BestLayoutOptions, type FitOrientation } from "@/lib/layouts/fit";
import { styleCaptionFont } from "@/lib/design/styles";
import {
  AI_BACKGROUND_CATALOGUE,
  applyBackgroundSuggestions,
  backgroundForId,
  FADED_PHOTO_ID,
  suggestsBackgrounds,
  type AiBackgroundPicks,
  type AiBackgroundStyle,
  type SuggestPhoto,
} from "@/lib/design/background-suggest";
import { clipCodePoints, clipText } from "@/lib/text/clip";
import { AI_TEXT_LIMITS, LAYOUT_ID_RE, PHOTO_ALIAS_RE, type AlbumPlan } from "./schemas";
import { dubaiDay, effectiveMaxPages, orientationOf, photoMs, placeKey, type StoryBook, type StoryPhoto } from "./story";

export interface PlanToDocOptions {
  /** Alias ("p7") → real photo id. */
  aliasToId: ReadonlyMap<string, string>;
  /** All photos of the book (kept and dropped). */
  photos: readonly StoryPhoto[];
  book: StoryBook;
  /** agent_runs.id (uuid). */
  runId: string | null;
  /** Stored in doc.meta.generatorVersion — use STORYTELLER_PROMPT_VERSION. */
  generatorVersion: number;
  /**
   * books.format / books.design_style (bookDesignOf, D-063): doc.format / doc.style.designStyle,
   * and what the plan's layouts are validated against. Omitted → classic A5 portrait.
   */
  design?: BookDesign;
  /**
   * M30: the stored doc this build replaces (books.doc, raw). Only read for a user-chosen accent
   * colourway, which the new doc keeps (colourway-suggest.ts). Omitted → nothing to keep.
   */
  previousDoc?: unknown;
}

export type PlanToDocResult = { doc: BookDoc } | { issues: string[] };

const CENTER: Crop = { x: 0.5, y: 0.5, zoom: 1 };

/** Echo an alias in an issue only when it has the alias shape (no user text leaks). */
function safeAlias(a: unknown): string {
  return typeof a === "string" && PHOTO_ALIAS_RE.test(a) ? a : "?";
}
function safeLayoutId(id: unknown): string {
  return typeof id === "string" && LAYOUT_ID_RE.test(id) ? id : "?";
}

export interface PlanCheckOptions {
  aliasToId: ReadonlyMap<string, string>;
  photos: readonly StoryPhoto[];
  maxPages: number;
  /** The book's format + design style; layouts of another design are issues. Default classic A5 portrait. */
  design?: BookDesign;
}

const inDesign = (l: { format: string; style: string }, d: BookDesign) => l.format === d.format && l.style === d.designStyle;

/** Pages a plan entry occupies: 2 for a spread layout, else 1 (unknown layouts count 1). */
export function planPageSpan(layoutId: string): number {
  return getLayout(layoutId)?.role === "spread" ? SPREAD_PAGES : 1;
}

/** Total book pages of a plan (spreads count 2). */
export function planPageCount(plan: Pick<AlbumPlan, "moments">): number {
  return plan.moments.reduce((n, m) => n + m.pages.reduce((k, pg) => k + planPageSpan(pg.layoutId), 0), 0);
}

/** Plan-level checks against the photo set and the book's design. [] = valid. */
export function validatePlanAgainstPhotos(
  plan: AlbumPlan,
  { aliasToId, photos, maxPages, design = DEFAULT_BOOK_DESIGN }: PlanCheckOptions,
): string[] {
  const issues: string[] = [];
  const byId = new Map(photos.map((p) => [p.id, p]));

  const resolve = (alias: string, at: string): StoryPhoto | null => {
    const id = aliasToId.get(alias);
    const photo = id === undefined ? undefined : byId.get(id);
    if (!photo) {
      issues.push(`${at}: unknown photo "${safeAlias(alias)}" (use only aliases from the photo list)`);
      return null;
    }
    if (!photo.keep) {
      issues.push(`${at}: photo "${safeAlias(alias)}" was dropped and must not be used`);
      return null;
    }
    return photo;
  };

  if (plan.moments.length === 0) issues.push("plan: no moments");

  let pageCount = 0;
  const used = new Set<string>();
  plan.moments.forEach((m, mi) => {
    if (m.pages.length === 0) issues.push(`moments[${mi}]: moment has no pages`);
    m.pages.forEach((pg, pi) => {
      pageCount += planPageSpan(pg.layoutId);
      const at = `moments[${mi}].pages[${pi}]`;
      const layout = getLayout(pg.layoutId);
      if (!layout) {
        issues.push(`${at}: unknown layout "${safeLayoutId(pg.layoutId)}" (use only catalogue page layouts)`);
      } else if (layout.role === "cover") {
        issues.push(`${at}: layout "${layout.id}" is a cover layout, not a page layout`);
      } else if (!inDesign(layout, design)) {
        issues.push(`${at}: layout "${layout.id}" is not in this book's catalogue (use only the catalogue layouts)`);
      } else if (pg.photoIds.length !== layout.photoCount) {
        issues.push(`${at}: layout "${layout.id}" needs exactly ${layout.photoCount} photo${layout.photoCount === 1 ? "" : "s"}, got ${pg.photoIds.length}`);
      }
      pg.photoIds.forEach((alias, si) => {
        const photo = resolve(alias, `${at}.photoIds[${si}]`);
        if (!photo) return;
        if (used.has(photo.id)) issues.push(`${at}.photoIds[${si}]: photo "${safeAlias(alias)}" is used more than once`);
        used.add(photo.id);
      });
    });
  });

  if (pageCount === 0) issues.push("plan: no pages");
  if (pageCount > maxPages) {
    const hasSpread = plan.moments.some((m) => m.pages.some((pg) => planPageSpan(pg.layoutId) === SPREAD_PAGES));
    issues.push(`plan: ${pageCount} pages exceeds the limit of ${maxPages} pages${hasSpread ? " (a spread counts as 2)" : ""}`);
  }

  resolve(plan.coverPhotoId, "coverPhotoId");
  return issues;
}

export interface FitPlanOptions {
  aliasToId: ReadonlyMap<string, string>;
  photos: readonly StoryPhoto[];
  design?: BookDesign;
}

function orientResolver(aliasToId: ReadonlyMap<string, string>, photos: readonly StoryPhoto[]) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  return (alias: string): FitOrientation => {
    const id = aliasToId.get(alias);
    const p = id === undefined ? undefined : byId.get(id);
    return p ? orientationOf(p.width, p.height) : "square";
  };
}

type DescriptionMode = NonNullable<BestLayoutOptions["description"]>;

/**
 * bestPageLayout `description` option for a re-fit (see the header). `{}` for styles without AI
 * descriptions, so their calls are exactly the pre-M30 ones.
 */
function descriptionFit(
  describes: boolean,
  page: { first: boolean; showsNow: boolean; shownElsewhere: boolean },
): { description?: DescriptionMode } {
  if (!describes) return {};
  if (page.showsNow) return { description: "prefer" };
  if (page.shownElsewhere) return { description: "avoid" };
  return { description: page.first ? "prefer" : "any" };
}

/**
 * Re-fits plan entries whose layout is a known page/spread layout of ANOTHER format or design
 * style to the book's design: same photos, best layout of the same role (a spread falls back to a
 * page layout), catalogue order on ties. Entries with no layout of that photo count, unknown
 * layouts and cover layouts are left for validatePlanAgainstPhotos to report. Styles with AI
 * descriptions: see the header (one description page per moment). Pure; returns the SAME plan
 * when nothing changed.
 */
export function fitPlanToDesign(plan: AlbumPlan, { aliasToId, photos, design = DEFAULT_BOOK_DESIGN }: FitPlanOptions): AlbumPlan {
  const orientOf = orientResolver(aliasToId, photos);
  const describes = writesDescriptions(design.designStyle);
  let changed = false;
  const moments = plan.moments.map((m) => {
    let mChanged = false;
    const ownDescription = (pg: { layoutId: string }) => {
      const l = getLayout(pg.layoutId);
      return Boolean(l && l.role !== "cover" && inDesign(l, design) && layoutShowsDescription(l));
    };
    // Index of the page that keeps the description: the first in-design description layout.
    const keeper = describes ? m.pages.findIndex(ownDescription) : -1;
    let refitShows = false;
    const pages = m.pages.map((pg, pi) => {
      const layout = getLayout(pg.layoutId);
      if (!layout || layout.role === "cover") return pg;
      const orients = pg.photoIds.map(orientOf);
      if (inDesign(layout, design)) {
        if (!describes || pi === keeper || !layoutShowsDescription(layout)) return pg;
        // A second description layout in this moment: the paragraph would print twice.
        const alt = bestPageLayout(orients, { design, role: layout.role === "spread" ? "spread" : "page", description: "avoid" });
        if (!alt || alt === pg.layoutId || layoutIdShowsDescription(alt)) return pg;
        mChanged = true;
        return { ...pg, layoutId: alt };
      }
      const mode = descriptionFit(describes, { first: pi === 0, showsNow: false, shownElsewhere: keeper >= 0 || refitShows });
      const id =
        (layout.role === "spread" ? bestPageLayout(orients, { design, role: "spread", ...mode }) : null) ??
        bestPageLayout(orients, { design, ...mode });
      if (!id) return pg;
      if (describes && layoutIdShowsDescription(id)) refitShows = true;
      mChanged = true;
      return { ...pg, layoutId: id };
    });
    if (!mChanged) return m;
    changed = true;
    return { ...m, pages };
  });
  return changed ? { ...plan, moments } : plan;
}

/** Cover title kept whole up to the schema limits (code points, then UTF-16 units). */
function coverTitle(s: string): string {
  return clipText(clipCodePoints(s, BOOK_TITLE_MAX_CODE_POINTS), BOOK_TITLE_MAX_CODE_POINTS * 2);
}

function groundedPlace(aiPlace: string | null, momentPhotos: StoryPhoto[]): string | null {
  const key = placeKey(aiPlace);
  if (key === null) return null;
  const match = momentPhotos.find((p) => placeKey(p.place) === key);
  return match?.place ? clipText(match.place.replace(/\s+/g, " ").trim(), AI_TEXT_LIMITS.place) : null;
}

function dateLabelFor(momentPhotos: StoryPhoto[]): string {
  const days: number[] = [];
  for (const p of momentPhotos) {
    const ms = photoMs(p);
    if (ms !== null) days.push(dubaiDay(ms));
  }
  return days.length ? clipText(dayRange(Math.min(...days), Math.max(...days)), AI_TEXT_LIMITS.dateLabel) : "";
}

/** StoryPhoto → the background rules' photo view (status from the final keep decision). */
export function suggestPhotosOf(photos: readonly StoryPhoto[]): SuggestPhoto[] {
  return photos.map((p) => ({
    id: p.id,
    status: p.keep ? "kept" : "dropped",
    color: p.color ?? null,
    width: p.width,
    height: p.height,
    blurScore: p.blurScore ?? null,
  }));
}

export interface BackgroundPickOptions {
  aliasToId: ReadonlyMap<string, string>;
  photos: readonly StoryPhoto[];
  design: BookDesign;
  /** The doc built from `plan` (chapter c{n} = moment n-1), after repairSpreads. */
  doc: Pick<BookDoc, "pages">;
}

/**
 * The plan's background picks as AiBackgroundPicks (real photo ids, chapter ids). Only for styles
 * with AI backgrounds ({} otherwise). Dropped from the picks (→ the rules decide): unknown /
 * other-style ids, faded-photo outside the style catalogue or without a usable photo — the alias
 * must map to a KEPT photo of the book placed on a page of the same moment (an alias of a dropped,
 * unknown or other-moment photo is rejected, D-062). `null` (the AI chose none) is kept. A moment
 * whose first page is a spread half gets null (a background on one half would stop at the fold).
 * applyBackgroundSuggestions re-checks everything (opener page, coverage, kept).
 */
export function backgroundPicksOf(plan: AlbumPlan, { aliasToId, photos, design, doc }: BackgroundPickOptions): AiBackgroundPicks {
  const style = design.designStyle;
  if (!suggestsBackgrounds(style)) return {};
  const byId = new Map(photos.map((p) => [p.id, p]));
  const picks: { book?: string | null; chapters: Map<string, { id: string; photoId?: string | null } | null> } = { chapters: new Map() };
  const book = plan.bookBackgroundId;
  if (typeof book === "string" && backgroundForId(style, book)) picks.book = book;

  plan.moments.forEach((m, mi) => {
    const chapterId = `c${mi + 1}`;
    const pick = m.backgroundId;
    if (pick === undefined) return;
    const opener = doc.pages.find((p) => p.chapterId === chapterId);
    if (pick === null || opener?.side !== undefined) {
      picks.chapters.set(chapterId, null);
      return;
    }
    if (pick === FADED_PHOTO_ID) {
      const alias = m.backgroundPhotoId;
      const id = typeof alias === "string" ? aliasToId.get(alias) : undefined;
      const photo = id === undefined ? undefined : byId.get(id);
      const inMoment = typeof alias === "string" && m.pages.some((pg) => pg.photoIds.includes(alias));
      if (photo?.keep && inMoment && (AI_BACKGROUND_CATALOGUE[style as AiBackgroundStyle] as readonly string[]).includes(FADED_PHOTO_ID)) picks.chapters.set(chapterId, { id: FADED_PHOTO_ID, photoId: photo.id });
      return; // invalid faded pick → rules
    }
    if (backgroundForId(style, pick)) picks.chapters.set(chapterId, { id: pick });
  });
  return picks;
}

export function planToDoc(rawPlan: AlbumPlan, opts: PlanToDocOptions): PlanToDocResult {
  const { aliasToId, photos, book, runId, generatorVersion, design = DEFAULT_BOOK_DESIGN } = opts;
  const maxPages = effectiveMaxPages(book);

  const plan = fitPlanToDesign(rawPlan, { aliasToId, photos, design });
  const planIssues = validatePlanAgainstPhotos(plan, { aliasToId, photos, maxPages, design });
  if (planIssues.length) return { issues: planIssues };

  const byId = new Map(photos.map((p) => [p.id, p]));
  const idOf = (alias: string) => aliasToId.get(alias) as string; // validated above

  const chapters: Chapter[] = [];
  const pages: BookPage[] = [];
  plan.moments.forEach((m, mi) => {
    const chapterId = `c${mi + 1}`;
    const momentPhotos = m.pages.flatMap((pg) => pg.photoIds.map((a) => byId.get(idOf(a)) as StoryPhoto));
    const dateLabel = dateLabelFor(momentPhotos);
    const title = clipText(m.title.trim(), AI_TEXT_LIMITS.chapterTitle) || dateLabel || "Our moments";
    chapters.push({ id: chapterId, title, dateLabel, place: groundedPlace(m.place, momentPhotos) });
    for (const pg of m.pages) {
      const slots = pg.photoIds.map((a) => ({ photoId: idOf(a), crop: { ...CENTER } }));
      if (planPageSpan(pg.layoutId) === SPREAD_PAGES) {
        // Spread (D-064 storage model): the left page owns every slot and the caption; the right
        // page is an empty placeholder of the same layout. Never captioned.
        pages.push({ id: `p${pages.length + 1}`, chapterId, layout: pg.layoutId, slots, caption: null, side: "left" });
        pages.push({ id: `p${pages.length + 1}`, chapterId, layout: pg.layoutId, slots: [], caption: null, side: "right" });
      } else {
        pages.push({ id: `p${pages.length + 1}`, chapterId, layout: pg.layoutId, slots, caption: null });
      }
    }
  });

  const coverPhoto = byId.get(idOf(plan.coverPhotoId)) as StoryPhoto;
  const userTitle = book.title?.trim() ?? "";
  const built: BookDoc = {
    version: 2,
    format: design.format,
    occasion: book.occasion,
    cover: {
      layout: bestCoverLayout(design, orientationOf(coverPhoto.width, coverPhoto.height)),
      photoId: coverPhoto.id,
      title: coverTitle(userTitle || plan.title.trim() || DEFAULT_TITLES[book.occasion]),
      subtitle: clipText(plan.subtitle.trim(), AI_TEXT_LIMITS.subtitle),
    },
    chapters,
    pages,
    style: {
      background: { kind: "color", hex: "#FFFFFF" },
      designStyle: design.designStyle,
      font: styleCaptionFont(design.designStyle, book.captionLang),
    },
    meta: { generator: "ai", generatorVersion, runId, userEdited: false },
  };
  // A spread the model put on a right-hand page splits into its twin single pages (same photos,
  // same chapter); the page count can only grow when a twin is too small (validated below).
  const repaired = repairSpreads(built).doc;
  // v6 backgrounds (modern / geometric / scrapbook): AI picks, validated, gaps → T11 rules.
  // Classic → the doc unchanged (still v1-serialisable).
  const doc = applyBackgroundSuggestions(
    repaired,
    suggestPhotosOf(photos),
    backgroundPicksOf(plan, { aliasToId, photos, design, doc: repaired }),
  );
  // M30: accent colourway from the photos' colours (magazine / editorial only; rule, not a model
  // pick). A user-chosen colourway of the doc being replaced is kept.
  const coloured = withSuggestedColourway(doc, suggestPhotosOf(photos), opts.previousDoc);

  const parsed = parseBookDoc(coloured);
  if (!parsed.ok) return { issues: parsed.issues.map((i) => `doc: ${i}`) };
  const kept = new Set(photos.filter((p) => p.keep).map((p) => p.id));
  const docIssues = validateBookDoc(parsed.doc, { photoIds: kept, maxPages });
  if (docIssues.length) return { issues: docIssues.map((i) => `doc: ${i}`) };
  // Default looks on some photos (D-089) — the user changes them in the editor's Filter tool.
  return { doc: withDefaultFilters(parsed.doc) };
}

// ---------------------------------------------------------------------------------------------
// Pruning a validated plan when photos changed during the run (review toggles while building)

export interface PrunePlanOptions {
  aliasToId: ReadonlyMap<string, string>;
  /** Current photos of the book (kept and dropped). */
  photos: readonly StoryPhoto[];
  /** The book's format + design style (bookDesignOf): re-fitted pages use only its layouts. Default classic A5 portrait. */
  design?: BookDesign;
}

export interface PrunedPlan {
  plan: AlbumPlan;
  /** Slots removed (photos no longer kept / gone). */
  removed: number;
  /** False = the input plan is returned unchanged. */
  changed: boolean;
}

type PlanPage = AlbumPlan["moments"][number]["pages"][number];

/**
 * Plan pages for the photos left on an affected entry, all inside `design`: a spread keeps a
 * spread of that count when one exists, else one page layout of that count; when the design has
 * no layout for that many photos (only possible for a spread that lost photos), the photos are
 * chunked over several pages of the largest page layouts so none is lost. [] = no layout at all.
 */
function refitPages(
  pg: PlanPage,
  left: string[],
  orientOf: (a: string) => FitOrientation,
  design: BookDesign,
  mode: { description?: DescriptionMode } = {},
): PlanPage[] {
  const wasSpread = getLayout(pg.layoutId)?.role === "spread";
  const fit = (aliases: string[]) =>
    (wasSpread ? bestPageLayout(aliases.map(orientOf), { design, role: "spread", ...mode }) : null) ??
    bestPageLayout(aliases.map(orientOf), { design, ...mode });
  const whole = fit(left);
  if (whole) return [{ ...pg, layoutId: whole, photoIds: left }];
  const out: PlanPage[] = [];
  let rest = left;
  while (rest.length > 0) {
    let n = rest.length;
    let id: string | null = null;
    // Only the first chunk may take the description panel (later chunks: default "avoid").
    const chunkMode = out.length === 0 ? mode : {};
    while (n > 0 && !(id = bestPageLayout(rest.slice(0, n).map(orientOf), { design, ...chunkMode }))) n--;
    if (!id) return [];
    out.push({ layoutId: id, photoIds: rest.slice(0, n) });
    rest = rest.slice(n);
  }
  return out;
}

/**
 * Removes photos that are no longer kept (e.g. the user removed them on the review screen while
 * the run was going) from an AI plan instead of discarding the whole plan: their slots go, an
 * affected page gets the best-fitting layout of the book's design for the photos left on it (a
 * spread stays a spread when one of that count exists, else becomes page(s)), or is dropped when
 * empty; empty moments are dropped and a removed cover is replaced by the first photo left.
 * Pure. The result still has to pass planToDoc (+ validateBookDoc); if it does not, the caller
 * falls back to the rule-based album.
 */
export function prunePlan(plan: AlbumPlan, { aliasToId, photos, design = DEFAULT_BOOK_DESIGN }: PrunePlanOptions): PrunedPlan {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const photoOf = (alias: string) => {
    const id = aliasToId.get(alias);
    return id === undefined ? undefined : byId.get(id);
  };
  const usable = (alias: string) => photoOf(alias)?.keep === true;
  const orientOf = orientResolver(aliasToId, photos);

  const describes = writesDescriptions(design.designStyle);
  let removed = 0;
  const moments: AlbumPlan["moments"] = [];
  for (const m of plan.moments) {
    const pages: PlanPage[] = [];
    // Description pages of this moment that stay untouched (all their photos are still kept).
    let shown = describes && m.pages.some((pg) => layoutIdShowsDescription(pg.layoutId) && pg.photoIds.every(usable));
    for (const pg of m.pages) {
      const left = pg.photoIds.filter(usable);
      removed += pg.photoIds.length - left.length;
      if (left.length === 0) continue;
      if (left.length === pg.photoIds.length) {
        pages.push(pg);
        continue;
      }
      const showsNow = describes && layoutIdShowsDescription(pg.layoutId);
      const mode = descriptionFit(describes, { first: pages.length === 0, showsNow: showsNow && !shown, shownElsewhere: shown });
      const refit = refitPages(pg, left, orientOf, design, mode);
      if (describes && refit.some((r) => layoutIdShowsDescription(r.layoutId))) shown = true;
      if (refit.length) pages.push(...refit);
      else removed += left.length; // no layout for this count: drop the page
    }
    if (pages.length) moments.push({ ...m, pages });
  }
  if (removed === 0 && usable(plan.coverPhotoId)) return { plan, removed: 0, changed: false };

  const firstLeft = moments[0]?.pages[0]?.photoIds[0];
  const coverPhotoId = usable(plan.coverPhotoId) ? plan.coverPhotoId : (firstLeft ?? plan.coverPhotoId);
  return { plan: { ...plan, coverPhotoId, moments }, removed, changed: true };
}
