// Rule-based auto-layout — the fallback album when the AI pipeline fails or hasn't run yet
// (written only when books.doc is replaceable, D-018). Pure, deterministic, no I/O, no AI.
//
// Rules (keep in sync with the HANDOFF in .agentos/runs/m2.md):
// 1. Filter: drop status "dropped" and ids that aren't valid doc ids. Per duplicate group keep one
//    photo: highest blurScore (null = 0) → largest pixel area → smallest id.
//    The group comes from opts.dupGroups.get(id) when given, else photo.dupGroup.
// 2. Sort by takenAt; undated (null / unparsable) go last, sorted by id. Ties → id.
//    Timestamps without a zone ("2026-10-12T18:00:00" / "2026-10-12") are read as Asia/Dubai
//    wall-clock time; all day boundaries use Asia/Dubai (UTC+4, no DST). This makes output
//    identical on any machine/TZ — documented trade-off: a trip abroad is split on Dubai midnight.
// 3. Chapters: new chapter when the Dubai calendar day changes, OR the gap to the previous photo
//    is > 6 h, OR the place changes (a null place never breaks a chapter). All undated photos form
//    one final chapter. Title = first place ?? "12 Oct 2026"; dateLabel "12 Oct 2026" /
//    "12–14 Oct 2026"; place = first non-null place.
// 4. Page cap (limitsFor(isPaid).maxPages): if the unconstrained album is longer than the cap,
//    first merge adjacent chapters (pair with the fewest photos, tie → earliest) until there are
//    ≤ floor(cap / 3) chapters (so each has room for ~3 pages), then each
//    chapter gets a page budget proportional to its unconstrained page count (min 1, unused budget
//    carries over to the next chapter) and keeps the most photos that fit, chosen evenly over
//    time: the chapter is split into k equal buckets and the sharpest photo of each is kept.
// 5. Page filling per chapter, greedy over the chronological queue:
//    - chapter opener (when the chapter has ≥ 3 photos): one photo alone (one-portrait / full-page)
//    - then candidates: two-vertical (2 portrait), two-horizontal (2 landscape), three-mixed
//      (1 landscape + 2 portrait, landscape goes in the wide slot), four-grid (any, only in
//      chapters with ≥ 10 photos). A pair may skip one photo ahead (q0 + q2) to match orientation.
//    - preferred order: short chapters two-* → three-mixed; long chapters three-mixed → four-grid
//      → two-*. If the best candidate repeats the previous page's layout, the next one is used.
//    - no candidate → single page: portrait/square → one-portrait (full-page if the previous page
//      was one-portrait), landscape → full-page (the slot crop centres it).
//    Orientation: w/h ≥ 1.1 landscape, ≤ 1/1.1 portrait, otherwise square (fits either).
// 6. Cover: portrait preferred, then sharpest, largest, smallest id. Title = opts.title ??
//    occasion default; subtitle = most common place · month range ("Abu Dhabi · Oct 2026").
// 7. Captions null everywhere (AI writes them in M3); crops centred, zoom 1; ids c1.., p1...
// 8. meta = { generator: "rule", generatorVersion: AUTOLAYOUT_VERSION, runId: opts.runId ?? null,
//    userEdited: false } on every doc, including the minimal fallback (D-018). Bump
//    AUTOLAYOUT_VERSION when these rules change output.
// 9. Design (M10b A10, D-063): opts.design = books.format / books.design_style (default classic
//    A5 portrait). Classic A5 portrait uses rules 5–6 exactly as above (output byte-identical,
//    frozen by tests/autolayout-classic-golden.test.ts). Every other design uses the same rules
//    1–4 and 6–8 with a catalogue-driven filler over layoutsFor(format, style, …) only:
//    - singles: the one-photo page layouts whose slot fits the photo's orientation (all when none
//      fits), closest slot aspect (mm) first; the previous page's layout is not repeated if
//      another fits. Chapter opener as rule 5.
//    - multi-photo pages: a layout is a candidate when every slot fits a photo (photos are
//      assigned within the page: portrait/landscape slots take matching photos in time order,
//      then squares, "any" slots the rest). Photo counts by chapter size: < 10 → 2, 3, 4 (4 only
//      for layouts whose slots all ask for an orientation — no grids in short chapters);
//      10–19 → 3, 4, 2; ≥ 20 → 4, 5, 3, 6, 2; catalogue order within a count; a pair may skip
//      one photo ahead (ranked last); the previous page's layout is not repeated.
//    - spreads (styles that have them; never on an odd page index — the cover stands alone and
//      doc.pages[2k] is a left page): a photo with aspect ≥ PANORAMA_RATIO at the head of the
//      queue → the panorama spread; a chapter of ≥ SPREAD_MOMENT_MIN photos → one spread per
//      started 20 photos: the first spread layout (fewest photos first) whose slots fit with at
//      most ⌊n/4⌋ orientation misses (all-"any" grids need that many photos left). Never two
//      spreads in a row. A spread counts 2 pages toward maxPages; if the album ends up over the
//      cap anyway it is rebuilt without spreads.
//    - cover: the style's one-photo cover whose slot fits the cover photo (bestCoverLayout);
//      the cover photo prefers the format's orientation (portrait books portrait, landscape
//      books landscape). The minimal album uses the design's full-page layout (fullPageLayout).
// 10. Shape-aware styles (M10c T10: geometric, scrapbook — SHAPE_AWARE_STYLES in layouts/fit) use
//    rule 9 with these changes (classic + modern output byte-identical, frozen by
//    tests/autolayout-classic-golden.test.ts + tests/autolayout-design-golden.test.ts):
//    - fitting is on the VISIBLE photo area (fit.ts slotFit: frame inset removed, shape clip
//      applied): a round slot (circle / hexagon / diamond / petal) misses a photo more than
//      ROUND_STRETCH_MAX away from its visible aspect even when it says "any"; photos are assigned
//      to a page's slots by the fewest misses, then the smallest total aspect distance (exact
//      search, ≤ 6 slots); singles rank by that distance too.
//    - spreads (never on an odd index, never two in a row, one per started 20 chapter photos, in
//      chapters of ≥ SPREAD_MOMENT_MIN photos): the photos may come from the next photoCount + 2
//      of the chapter (contiguous first, skipped ones stay queued in order), at most ⌊n/4⌋
//      misses. Chapters of ≥ LARGE_SPREAD_MOMENT photos try the largest spread first and then
//      alternate (scrapbook: wall, hero, wall …); smaller chapters only the smallest (scrapbook
//      hero, geometric band). No panorama spreads (the styles have none).
//    - cover photo: the orientation the style's cover slot asks for (or shows, for an "any"
//      slot), else the format's (coverPhotoOrientation).
//    - page choice looks ahead (shapedLookahead, M10c polish): the next page is the first page of
//      the best path over the next LOOKAHEAD_PAGES pages, built from the zero-miss multi-photo
//      candidates (skip pairs q0 + q2 always offered) and the head photo alone. Path cost =
//      misses × LOOKAHEAD_MISS + one-photo pages + pages repeating the page before; ties → a path
//      that ends the chapter in fewer pages (7 × 4:3 in a landscape geometric book: one-band +
//      three-diamond × 2, not 1+2+3+1), then fewer repeats (2+2 of the same layout → 3+1), then
//      rule 9 order. A spread the filler would place next ends a path. So consecutive pages only
//      share a layout when every alternative costs a miss or an extra page. The chapter opener
//      and spreads are unchanged. relayout's fitSingles passes the page before as `avoid` to
//      bestPageLayout (shape-aware only).
// The result is checked with parseBookDoc + validateBookDoc; if that ever fails, a minimal
// safe album is returned instead (the user must always get an album).

import { limitsFor } from "@/lib/ai/limits";
import { assertSupportedDesign, DEFAULT_BOOK_DESIGN, type BookDesign } from "@/lib/book/book-design";
import { orientationOf as formatOrientation } from "@/lib/book/format";
import { DEFAULT_TITLES } from "@/lib/book/default-titles";
import { BOOK_TITLE_MAX_CODE_POINTS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { DocMetaSchema, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { layoutsFor } from "@/lib/book/spreads";
import type { BookDoc, BookPage, Chapter, Crop, DocMeta, Layout } from "@/lib/book/types";
import { COVER_LAYOUT_ID } from "@/lib/layouts";
import {
  bestCoverLayout,
  coverPhotoOrientation,
  fitsSlot,
  fullPageLayout,
  isShapeAware,
  shapeCost,
  shapeMiss,
  slotAspectMm,
} from "@/lib/layouts/fit";
import { styleCaptionFont } from "@/lib/design/styles";
import { clipCodePoints, clipText } from "@/lib/text/clip";

export interface AutoPhoto {
  id: string;
  width: number;
  height: number;
  takenAt: string | null;
  dateSource: "exif" | "file" | null;
  place: string | null;
  status: "kept" | "dropped";
  dupGroup: number | null;
  blurScore: number | null;
}

export interface AutolayoutOptions {
  occasion: Occasion;
  title: string | null;
  captionLang: CaptionLang;
  isPaid: boolean;
  /** photoId → duplicate group; overrides AutoPhoto.dupGroup when present. */
  dupGroups?: Map<string, number>;
  /** agent_runs.id when this album is the fallback of an AI run; otherwise null. */
  runId?: string | null;
  /** books.format / books.design_style (bookDesignOf, D-063). Default classic A5 portrait. */
  design?: BookDesign;
}

/** Version of the rules above, stored in doc.meta.generatorVersion. */
export const AUTOLAYOUT_VERSION = 1;

function ruleMeta(opts: AutolayoutOptions): DocMeta {
  return { generator: "rule", generatorVersion: AUTOLAYOUT_VERSION, runId: opts.runId ?? null, userEdited: false };
}

// Cover title for a book without a user title (lives in a light module so client UI can name it).
export { DEFAULT_TITLES } from "@/lib/book/default-titles";

/** Asia/Dubai is UTC+4 all year (no DST). */
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_GAP_MS = 6 * 60 * 60 * 1000;
const LANDSCAPE_RATIO = 1.1;
const LONG_CHAPTER = 10;
const OPENER_MIN = 3;
const PAGES_PER_CHAPTER = 3;
const CENTER: Crop = { x: 0.5, y: 0.5, zoom: 1 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ID_RE = /^[\s\S]{1,64}$/;

type Orient = "portrait" | "landscape" | "square";

interface P {
  id: string;
  ms: number | null;
  day: number | null;
  place: string | null;
  orient: Orient;
  /** w / h (1 when unknown). */
  ratio: number;
  sharp: number;
  area: number;
}

interface Group {
  photos: P[];
}

export function autolayout(photos: AutoPhoto[], opts: AutolayoutOptions): BookDoc {
  const maxPages = limitsFor(opts.isPaid).maxPages;
  const design = opts.design ?? DEFAULT_BOOK_DESIGN;
  // M10b A19 (review S1): a style without layouts (none since M10c T10; unknown styles)
  // throws the typed UnsupportedDesignError here, before any page is built; callers refuse cleanly.
  assertSupportedDesign(design);
  const kept = dedupe(photos, opts.dupGroups).sort(byTime);

  let doc = build(kept, opts, design, maxPages, makeFiller(design, true));
  // A spread counts 2 pages; the budget accounts for that, but a last-resort single-photo chapter
  // could still land a panorama spread over the cap — rebuild without spreads (rule 9).
  if (doc.pages.length > maxPages && hasSpreads(design)) {
    doc = build(kept, opts, design, maxPages, makeFiller(design, false));
  }
  return ensureValid(doc, kept, opts, maxPages, design);
}

function build(kept: P[], opts: AutolayoutOptions, design: BookDesign, maxPages: number, fill: Filler): BookDoc {
  let groups = splitChapters(kept);
  const need = sequentialPages(groups, fill).reduce((a, b) => a + b, 0);
  // Overflowing album: aim for ≥ ~3 pages per chapter so sampling keeps real content.
  if (need > maxPages) groups = mergeToFit(groups, Math.max(1, Math.floor(maxPages / PAGES_PER_CHAPTER)));

  const chosen = fitPages(groups, maxPages, fill);

  const chapters: Chapter[] = [];
  const pages: BookPage[] = [];
  chosen.forEach((g, i) => {
    const chapterId = `c${i + 1}`;
    chapters.push(chapterMeta(chapterId, g.photos, chosen.length > 1));
    for (const pg of fill(g.photos, pages.length)) {
      const slots = pg.photos.map((p) => ({ photoId: p.id, crop: { ...CENTER } }));
      if (!pg.spread) {
        pages.push({ id: `p${pages.length + 1}`, chapterId, layout: pg.layout, slots, caption: null });
        continue;
      }
      pages.push({ id: `p${pages.length + 1}`, chapterId, layout: pg.layout, slots, caption: null, side: "left" });
      pages.push({ id: `p${pages.length + 1}`, chapterId, layout: pg.layout, slots: [], caption: null, side: "right" });
    }
  });

  const classic = isClassicPortrait(design);
  const coverPhoto = pickCover(
    kept,
    classic ? "portrait" : (coverPhotoOrientation(design) ?? formatOrientation(design.format)),
  );
  return {
    version: 2,
    format: design.format,
    occasion: opts.occasion,
    cover: {
      layout: classic ? COVER_LAYOUT_ID : bestCoverLayout(design, coverPhoto?.orient ?? null),
      photoId: coverPhoto?.id ?? null,
      title: coverTitle(opts.title?.trim() || DEFAULT_TITLES[opts.occasion]),
      subtitle: clip(subtitleFor(kept), 120),
    },
    chapters,
    pages,
    style: {
      background: { kind: "color", hex: "#FFFFFF" },
      designStyle: design.designStyle,
      font: styleCaptionFont(design.designStyle, opts.captionLang),
    },
    meta: ruleMeta(opts),
  };
}

/** Pages each chapter takes when laid out one after another (spreads depend on the start index). */
function sequentialPages(groups: Group[], fill: Filler): number[] {
  let start = 0;
  return groups.map((g) => {
    const n = pageCount(fill(g.photos, start));
    start += n;
    return n;
  });
}

// ---------- 1. filter + dedupe ----------

function dedupe(photos: AutoPhoto[], dupGroups?: Map<string, number>): P[] {
  const seen = new Set<string>();
  const singles: P[] = [];
  const best = new Map<number, P>();
  for (const ph of photos) {
    if (ph.status !== "kept" || typeof ph.id !== "string" || !ID_RE.test(ph.id)) continue;
    if (seen.has(ph.id)) continue;
    seen.add(ph.id);
    const p = toP(ph);
    const group = dupGroups?.get(ph.id) ?? ph.dupGroup;
    if (group === null || group === undefined) {
      singles.push(p);
      continue;
    }
    const cur = best.get(group);
    if (!cur || bySharpness(p, cur) < 0) best.set(group, p);
  }
  return [...singles, ...best.values()];
}

function toP(ph: AutoPhoto): P {
  const ms = parseTime(ph.takenAt);
  const w = Number.isFinite(ph.width) && ph.width > 0 ? ph.width : 0;
  const h = Number.isFinite(ph.height) && ph.height > 0 ? ph.height : 0;
  const ratio = w > 0 && h > 0 ? w / h : 1;
  const orient: Orient =
    ratio >= LANDSCAPE_RATIO ? "landscape" : ratio <= 1 / LANDSCAPE_RATIO ? "portrait" : "square";
  const place = ph.place?.trim() ? ph.place.trim() : null;
  return {
    id: ph.id,
    ms,
    day: ms === null ? null : Math.floor((ms + DUBAI_OFFSET_MS) / DAY_MS),
    place,
    orient,
    ratio,
    sharp: Number.isFinite(ph.blurScore) ? (ph.blurScore as number) : 0,
    area: w * h,
  };
}

const NAIVE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/** ISO string → epoch ms. Strings without a zone are Asia/Dubai wall-clock time. */
export function parseTime(s: string | null): number | null {
  if (!s) return null;
  let str = s.trim();
  if (NAIVE_RE.test(str)) {
    str = (str.length === 10 ? `${str}T00:00:00` : str.replace(" ", "T")) + "+04:00";
  }
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : null;
}

/** Sharper first, then larger, then smaller id. Negative = a is better. */
function bySharpness(a: P, b: P): number {
  if (a.sharp !== b.sharp) return b.sharp - a.sharp;
  if (a.area !== b.area) return b.area - a.area;
  return cmpId(a.id, b.id);
}

function byTime(a: P, b: P): number {
  if (a.ms !== null && b.ms !== null && a.ms !== b.ms) return a.ms - b.ms;
  if (a.ms === null && b.ms !== null) return 1;
  if (a.ms !== null && b.ms === null) return -1;
  return cmpId(a.id, b.id);
}

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- 2-3. chapters ----------

function splitChapters(sorted: P[]): Group[] {
  const groups: Group[] = [];
  const undated = sorted.filter((p) => p.ms === null);
  let cur: P[] = [];
  let curPlace: string | null = null;
  for (const p of sorted) {
    if (p.ms === null) continue;
    const prev = cur[cur.length - 1];
    const brk =
      prev !== undefined &&
      (p.day !== prev.day ||
        (p.ms as number) - (prev.ms as number) > MAX_GAP_MS ||
        (p.place !== null && curPlace !== null && p.place !== curPlace));
    if (brk) {
      groups.push({ photos: cur });
      cur = [];
      curPlace = null;
    }
    cur.push(p);
    if (p.place !== null) curPlace = p.place;
  }
  if (cur.length) groups.push({ photos: cur });
  if (undated.length) groups.push({ photos: undated });
  return groups;
}

/** Merge adjacent chapters (smallest combined size first, tie → earliest) until ≤ max. */
function mergeToFit(groups: Group[], max: number): Group[] {
  const gs = groups.map((g) => ({ photos: [...g.photos] }));
  while (gs.length > max && gs.length > 1) {
    let bestI = 0;
    let bestSize = Infinity;
    for (let i = 0; i < gs.length - 1; i++) {
      const size = gs[i].photos.length + gs[i + 1].photos.length;
      if (size < bestSize) {
        bestSize = size;
        bestI = i;
      }
    }
    gs.splice(bestI, 2, { photos: [...gs[bestI].photos, ...gs[bestI + 1].photos] });
  }
  return gs;
}

/** `hasOthers`: the book has other chapters (undated chapter is then "More moments"). */
function chapterMeta(id: string, photos: P[], hasOthers: boolean): Chapter {
  const places: string[] = [];
  for (const p of photos) if (p.place !== null && !places.includes(p.place)) places.push(p.place);
  const days = photos.filter((p) => p.day !== null).map((p) => p.day as number);
  const dateLabel = days.length ? dayRange(Math.min(...days), Math.max(...days)) : "";
  const placeTitle = places.length > 1 ? `${places[0]} & ${places[1]}` : (places[0] ?? null);
  const fallback = days.length ? dayLabel(Math.min(...days)) : hasOthers ? "More moments" : "Our moments";
  return {
    id,
    title: clip(placeTitle ?? fallback, 80),
    dateLabel: clip(dateLabel, 40),
    place: places[0] ? clip(places[0], 80) : null,
  };
}

function dayParts(day: number): { d: number; m: number; y: number } {
  const dt = new Date(day * DAY_MS);
  return { d: dt.getUTCDate(), m: dt.getUTCMonth(), y: dt.getUTCFullYear() };
}

function dayLabel(day: number): string {
  const { d, m, y } = dayParts(day);
  return `${d} ${MONTHS[m]} ${y}`;
}

/** "12 Oct 2026", "12–14 Oct 2026", "30 Oct – 2 Nov 2026", "30 Dec 2026 – 2 Jan 2027". */
export function dayRange(from: number, to: number): string {
  if (from === to) return dayLabel(from);
  const a = dayParts(from);
  const b = dayParts(to);
  if (a.y !== b.y) return `${dayLabel(from)} – ${dayLabel(to)}`;
  if (a.m !== b.m) return `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
  return `${a.d}–${b.d} ${MONTHS[a.m]} ${a.y}`;
}

function subtitleFor(photos: P[]): string {
  const counts = new Map<string, number>();
  for (const p of photos) if (p.place !== null) counts.set(p.place, (counts.get(p.place) ?? 0) + 1);
  let place: string | null = null;
  let n = 0;
  for (const p of photos) {
    // first-seen order in chronological list → deterministic tie-break (earliest place wins)
    const c = p.place !== null ? (counts.get(p.place) ?? 0) : 0;
    if (c > n) {
      n = c;
      place = p.place;
    }
  }
  const days = photos.filter((p) => p.day !== null).map((p) => p.day as number);
  let when = "";
  if (days.length) {
    const a = dayParts(Math.min(...days));
    const b = dayParts(Math.max(...days));
    if (a.y !== b.y) when = `${MONTHS[a.m]} ${a.y} – ${MONTHS[b.m]} ${b.y}`;
    else if (a.m !== b.m) when = `${MONTHS[a.m]} – ${MONTHS[b.m]} ${a.y}`;
    else when = `${MONTHS[a.m]} ${a.y}`;
  }
  return [place, when].filter(Boolean).join(" · ");
}

/** Cover photo: `prefer` orientation first (portrait for portrait books), then sharpest, largest, smallest id. */
function pickCover(photos: P[], prefer: "portrait" | "landscape"): P | null {
  let best: P | null = null;
  for (const p of photos) {
    if (!best) {
      best = p;
      continue;
    }
    const pp = p.orient === prefer ? 0 : 1;
    const bp = best.orient === prefer ? 0 : 1;
    if (pp < bp || (pp === bp && bySharpness(p, best) < 0)) best = p;
  }
  return best;
}

// ---------- 4. page cap ----------

function fitPages(groups: Group[], maxPages: number, fill: Filler): Group[] {
  const need = sequentialPages(groups, fill);
  const total = need.reduce((a, b) => a + b, 0);
  if (total <= maxPages) return groups;

  // Budget: 1 per chapter, the rest by largest remainder on (need - 1). Never exceeds need.
  const extra = maxPages - groups.length;
  const weights = need.map((n) => n - 1);
  const wSum = weights.reduce((a, b) => a + b, 0);
  const budget = need.map(() => 1);
  if (extra > 0 && wSum > 0) {
    const raw = weights.map((w) => (extra * w) / wSum);
    const floors = raw.map(Math.floor);
    floors.forEach((f, i) => (budget[i] += f));
    let left = extra - floors.reduce((a, b) => a + b, 0);
    const order = raw
      .map((r, i) => ({ i, frac: r - Math.floor(r) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (const { i } of order) {
      if (left <= 0) break;
      budget[i] += 1;
      left -= 1;
    }
  }

  // Chapters are laid out in order: `start` = page index of the chapter's first page, so the
  // counts here are exactly what the final fill produces (spreads only on even indices).
  let carry = 0;
  let start = 0;
  return groups.map((g, i) => {
    const b = budget[i] + carry;
    const full = pageCount(fill(g.photos, start));
    if (full <= b) {
      carry = b - full;
      start += full;
      return g;
    }
    const n = g.photos.length;
    for (let k = Math.min(n, fill.maxPerPage * b); k >= 1; k--) {
      const sample = sampleEvenly(g.photos, k);
      const used = pageCount(fill(sample, start));
      if (used <= b) {
        carry = b - used;
        start += used;
        return { photos: sample };
      }
    }
    const one = sampleEvenly(g.photos, 1);
    carry = b - 1;
    start += pageCount(fill(one, start));
    return { photos: one };
  });
}

/** Split into k equal chronological buckets, keep the sharpest of each (order preserved). */
function sampleEvenly(photos: P[], k: number): P[] {
  const n = photos.length;
  if (k >= n) return photos;
  const out: P[] = [];
  for (let i = 0; i < k; i++) {
    const from = Math.floor((i * n) / k);
    const to = Math.floor(((i + 1) * n) / k);
    let best = photos[from];
    for (let j = from + 1; j < to; j++) if (bySharpness(photos[j], best) < 0) best = photos[j];
    out.push(best);
  }
  return out;
}

// ---------- 5. page filling ----------

interface PagePlan {
  layout: string;
  photos: P[];
  /** A two-page spread (left page owns the photos; counts 2 pages). */
  spread?: boolean;
}

/** Fills one chapter whose first page lands on doc.pages[start]. */
interface Filler {
  (photos: P[], start: number, opener?: boolean, prevLayout?: string | null): PagePlan[];
  /** Most photos one page can hold (bounds the page-cap sampling). */
  maxPerPage: number;
}

const pageCount = (plans: readonly PagePlan[]) => plans.reduce((n, p) => n + (p.spread ? 2 : 1), 0);

function isClassicPortrait(d: BookDesign): boolean {
  return d.format === "A5_PORTRAIT" && d.designStyle === "classic";
}

function hasSpreads(d: BookDesign): boolean {
  return layoutsFor(d.format, d.designStyle, "spread").length > 0;
}

/** Rule 5 filler for classic A5 portrait, the catalogue-driven filler (rule 9) otherwise. */
function makeFiller(design: BookDesign, allowSpreads: boolean): Filler {
  if (isClassicPortrait(design)) {
    const classic = (photos: P[], _start: number, opener = true, prev: string | null = null) =>
      fillChapter(photos, opener, prev);
    return Object.assign(classic, { maxPerPage: 4 });
  }
  const cat = catalogueOf(design);
  const generic = (photos: P[], start: number, opener = true, prev: string | null = null) =>
    genericFill(cat, allowSpreads, photos, start, opener, prev);
  const spreadMax = allowSpreads ? Math.max(0, ...cat.spreads.map((l) => Math.ceil(l.photoCount / 2))) : 0;
  return Object.assign(generic, { maxPerPage: Math.max(1, cat.maxPerPage, spreadMax) });
}

const isP = (p: P) => p.orient !== "landscape";
const isL = (p: P) => p.orient !== "portrait";

function single(p: P, prev: string | null): PagePlan {
  if (p.orient === "landscape") return { layout: "full-page", photos: [p] };
  return { layout: prev === "one-portrait" ? "full-page" : "one-portrait", photos: [p] };
}

/** Candidate pages from the head of the queue; `take` = queue indices consumed. */
function candidates(q: P[], long: boolean): { layout: string; take: number[]; order: number[] }[] {
  const out: { layout: string; take: number[]; order: number[] }[] = [];
  const [a, b, c, d] = q;

  if (a && b && c) {
    // three-mixed: one landscape-ish photo in the wide slot (prefer a true landscape)
    const idx = [0, 1, 2];
    const wide =
      idx.find((i) => q[i].orient === "landscape" && idx.every((j) => j === i || isP(q[j]))) ??
      idx.find((i) => isL(q[i]) && idx.every((j) => j === i || isP(q[j])));
    if (wide !== undefined) {
      out.push({ layout: "three-mixed", take: idx, order: [wide, ...idx.filter((j) => j !== wide)] });
    }
  }
  if (long && a && b && c && d) out.push({ layout: "four-grid", take: [0, 1, 2, 3], order: [0, 1, 2, 3] });

  const pairWith = (pred: (p: P) => boolean): number | undefined => {
    if (!pred(a)) return undefined;
    if (b && pred(b)) return 1;
    if (c && pred(c)) return 2;
    return undefined;
  };
  // A portrait/square head pairs vertically; a landscape/square head horizontally.
  const v = a && a.orient !== "landscape" ? pairWith(isP) : undefined;
  if (v !== undefined) out.push({ layout: "two-vertical", take: [0, v], order: [0, v] });
  const h = a && a.orient !== "portrait" ? pairWith(isL) : undefined;
  if (h !== undefined) out.push({ layout: "two-horizontal", take: [0, h], order: [0, h] });

  const rank = long
    ? ["three-mixed", "four-grid", "two-vertical", "two-horizontal"]
    : ["two-vertical", "two-horizontal", "three-mixed"];
  // A pair that skips a photo (q0 + q2) ranks after every contiguous candidate.
  const key = (c2: { layout: string; take: number[] }) =>
    rank.indexOf(c2.layout) + (c2.take.includes(2) && c2.take.length === 2 ? rank.length : 0);
  return out.sort((x, y) => key(x) - key(y));
}

/**
 * Greedy, orientation-aware page filler (rule 5) for photos that are appended to an existing
 * chapter (relayoutDoc, D-028): photos are sorted by time (undated last, ties by id), no chapter
 * opener unless asked, and `prevLayout` (the chapter's last page) is not repeated first.
 * Same rules and output as the autolayout filler of `opts.design` (default classic A5 portrait),
 * single pages only. Pure, deterministic.
 */
export function fillPages(
  photos: readonly Pick<AutoPhoto, "id" | "width" | "height" | "takenAt" | "place" | "blurScore">[],
  opts: { opener?: boolean; prevLayout?: string | null; design?: BookDesign } = {},
): { layout: string; photoIds: string[] }[] {
  const ps = photos
    .map((ph) => toP({ ...ph, dateSource: null, status: "kept", dupGroup: null }))
    .sort(byTime);
  // Single pages only (no spreads): the caller inserts these between existing pages, where the
  // page index parity is not known — repairSpreads handles later spreads.
  const design = opts.design ?? DEFAULT_BOOK_DESIGN;
  assertSupportedDesign(design);
  const fill = makeFiller(design, false);
  return fill(ps, 0, opts.opener ?? false, opts.prevLayout ?? null).map((pg) => ({
    layout: pg.layout,
    photoIds: pg.photos.map((p) => p.id),
  }));
}

function fillChapter(photos: P[], opener = true, prevLayout: string | null = null): PagePlan[] {
  const pages: PagePlan[] = [];
  const q = [...photos];
  const long = photos.length >= LONG_CHAPTER;
  let prev: string | null = prevLayout;

  if (opener && q.length >= OPENER_MIN) {
    const opener = single(q.shift() as P, null);
    pages.push(opener);
    prev = opener.layout;
  }

  while (q.length) {
    const cands = candidates(q, long);
    let pick = cands[0];
    if (pick && pick.layout === prev && cands[1]) pick = cands[1];
    if (!pick) {
      const s = single(q.shift() as P, prev);
      pages.push(s);
      prev = s.layout;
      continue;
    }
    const chosen = pick.order.map((i) => q[i]);
    const taken = new Set(pick.take);
    for (let i = q.length - 1; i >= 0; i--) if (taken.has(i)) q.splice(i, 1);
    pages.push({ layout: pick.layout, photos: chosen });
    prev = pick.layout;
  }
  return pages;
}

// ---------- 9. catalogue-driven filler (every design except classic A5 portrait) ----------

/** Aspect (w/h) at or above which a photo is a panorama (rule 9: panorama spread). */
export const PANORAMA_RATIO = 2.0;
/** Chapter size from which a chapter gets a grid / mosaic spread (rule 9). */
export const SPREAD_MOMENT_MIN = 7;
/** One grid/mosaic spread per started block of this many chapter photos. */
const PHOTOS_PER_SPREAD = 20;
/** Shape-aware styles (rule 10): chapter size from which the largest spread is tried first. */
export const LARGE_SPREAD_MOMENT = 12;
/** Shape-aware styles (rule 10): how far past a spread's photo count its photos may be picked. */
const SPREAD_LOOKAHEAD = 2;
/** Weight of one orientation miss against aspect distance in the shape-aware slot assignment. */
const MISS_WEIGHT = 1000;

interface Catalogue {
  design: BookDesign;
  /** Rule 10: fit on the visible photo area (geometric / scrapbook). */
  shaped: boolean;
  singles: readonly Layout[];
  /** Page layouts with ≥ 2 photos by photo count, catalogue order. */
  multis: ReadonlyMap<number, readonly Layout[]>;
  /** Panorama spreads (one wide photo). */
  panoramas: readonly Layout[];
  /** Grid / mosaic spreads, fewest photos first (catalogue order on ties). */
  bigSpreads: readonly Layout[];
  /** Spread layouts at all (bigSpreads + panoramas). */
  spreads: readonly Layout[];
  maxPerPage: number;
}

function catalogueOf(design: BookDesign): Catalogue {
  const pages = layoutsFor(design.format, design.designStyle, "page");
  const spreads = layoutsFor(design.format, design.designStyle, "spread");
  const multis = new Map<number, Layout[]>();
  for (const l of pages) {
    if (l.photoCount < 2) continue;
    const list = multis.get(l.photoCount) ?? [];
    list.push(l);
    multis.set(l.photoCount, list);
  }
  return {
    design,
    shaped: isShapeAware(design),
    singles: pages.filter((l) => l.photoCount === 1),
    multis,
    panoramas: spreads.filter((l) => l.photoCount === 1),
    bigSpreads: spreads
      .filter((l) => l.photoCount >= 2)
      .map((l, i) => ({ l, i }))
      .sort((a, b) => a.l.photoCount - b.l.photoCount || a.i - b.i)
      .map((x) => x.l),
    spreads,
    maxPerPage: Math.max(1, ...pages.map((l) => l.photoCount)),
  };
}

/**
 * Photos → slots of `layout`: portrait/landscape slots take matching photos (time order), then
 * squares; the remaining slots ("any" + unmatched) take the rest in time order. `misses` = slots
 * whose preference the assigned photo doesn't fit.
 */
function assignSlots(cat: Catalogue, layout: Layout, photos: P[]): { order: P[]; misses: number } {
  if (cat.shaped) return assignShaped(layout, photos, cat.design);
  const prefs = layout.prefers;
  const used = photos.map(() => false);
  const order: (P | undefined)[] = prefs.map(() => undefined);
  const take = (s: number, pred: (p: P) => boolean) => {
    const j = photos.findIndex((p, i) => !used[i] && pred(p));
    if (j >= 0) {
      used[j] = true;
      order[s] = photos[j];
    }
  };
  prefs.forEach((pref, s) => {
    if (pref !== "any") take(s, (p) => p.orient === pref);
  });
  prefs.forEach((pref, s) => {
    if (pref !== "any" && !order[s]) take(s, (p) => p.orient === "square");
  });
  prefs.forEach((_, s) => {
    if (!order[s]) take(s, () => true);
  });
  const filled = order.filter((p): p is P => p !== undefined);
  const misses = prefs.reduce((n, pref, s) => n + (order[s] && fitsSlot(pref, order[s].orient) ? 0 : 1), 0);
  return { order: filled, misses };
}

/**
 * Rule 10: photos → slots with the fewest shape-aware misses, then the smallest total aspect
 * distance (exact: dynamic programming over photo subsets — 2^photos states: ≤ 6 photos per page →
 * ≤ 64, spreads up to 12 photos → ≤ 4096; ties keep the earlier photo in the earlier slot).
 * `photos.length` may exceed the slot count only in tests; extra photos stay unassigned.
 */
function assignShaped(layout: Layout, photos: P[], design: BookDesign): { order: P[]; misses: number } {
  const k = Math.min(layout.prefers.length, photos.length);
  const n = photos.length;
  const miss: boolean[][] = [];
  const cost: number[][] = [];
  for (let s = 0; s < k; s++) {
    miss.push(photos.map((p) => shapeMiss(layout, s, p, design.format)));
    cost.push(photos.map((p) => shapeCost(layout, s, p, design.format)));
  }
  const size = 1 << n;
  const best = new Float64Array(size).fill(Infinity);
  const from = new Int32Array(size).fill(-1);
  best[0] = 0;
  const bits = (m: number) => {
    let c = 0;
    for (let x = m; x; x &= x - 1) c++;
    return c;
  };
  let end = -1;
  for (let mask = 0; mask < size; mask++) {
    if (best[mask] === Infinity) continue;
    const s = bits(mask);
    if (s === k) {
      if (end < 0 || best[mask] < best[end] - 1e-9) end = mask;
      continue;
    }
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      const next = mask | (1 << j);
      const v = best[mask] + (miss[s][j] ? MISS_WEIGHT : 0) + cost[s][j];
      if (v < best[next] - 1e-9) {
        best[next] = v;
        from[next] = j;
      }
    }
  }
  const order: P[] = new Array(k);
  let misses = 0;
  for (let mask = end, s = k - 1; s >= 0; s--) {
    const j = from[mask];
    order[s] = photos[j];
    if (miss[s][j]) misses++;
    mask &= ~(1 << j);
  }
  return { order, misses };
}

function genericSingle(cat: Catalogue, p: P, prev: string | null): PagePlan {
  const misses = (l: Layout) =>
    cat.shaped ? shapeMiss(l, 0, p, cat.design.format) : !fitsSlot(l.prefers[0] ?? "any", p.orient);
  const fitting = cat.singles.filter((l) => !misses(l));
  const pool = fitting.length > 0 ? fitting : cat.singles;
  const dist = (l: Layout) =>
    cat.shaped ? shapeCost(l, 0, p, cat.design.format) : Math.abs(Math.log(slotAspectMm(cat.design, l.slots[0]) / p.ratio));
  const ranked = pool
    .map((l, i) => ({ l, i, d: dist(l) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.l);
  const pick = ranked[0].id === prev && ranked[1] ? ranked[1] : ranked[0];
  return { layout: pick.id, photos: [p] };
}

function countsFor(chapterSize: number): number[] {
  if (chapterSize >= 2 * LONG_CHAPTER) return [4, 5, 3, 6, 2];
  if (chapterSize >= LONG_CHAPTER) return [3, 4, 2];
  return [2, 3, 4];
}

/** Multi-photo page candidates from the head of the queue, best first (rule 9). */
function genericCandidates(cat: Catalogue, q: P[], chapterSize: number): { layout: string; take: number[]; order: P[] }[] {
  const out: { layout: string; take: number[]; order: P[] }[] = [];
  const skips: { layout: string; take: number[]; order: P[] }[] = [];
  for (const k of countsFor(chapterSize)) {
    if (q.length < k) continue;
    for (const l of cat.multis.get(k) ?? []) {
      // Short chapters: 4-photo pages only when every slot asks for an orientation (no grids).
      if (k > 3 && chapterSize < LONG_CHAPTER && l.prefers.every((p) => p === "any")) continue;
      const take = Array.from({ length: k }, (_, i) => i);
      const a = assignSlots(cat, l, take.map((i) => q[i]));
      if (a.misses === 0) out.push({ layout: l.id, take, order: a.order });
      // Shape-aware styles also keep the skip pair when the head pair fits, so the look-ahead
      // (rule 10) can pair q0 + q2 and leave q1 for a different next page.
      if ((a.misses !== 0 || cat.shaped) && k === 2 && q.length >= 3) {
        const b = assignSlots(cat, l, [q[0], q[2]]);
        if (b.misses === 0) skips.push({ layout: l.id, take: [0, 2], order: b.order });
      }
    }
  }
  return [...out, ...skips];
}

const firstK = (k: number) => Array.from({ length: k }, (_, i) => i);

/**
 * A spread for the head of the queue, or null (caller checks the even page index). `take` = queue
 * indices consumed; `used` = big spreads already placed in this chapter.
 */
function spreadFor(
  cat: Catalogue,
  q: P[],
  chapterSize: number,
  bigLeft: number,
  used: number,
): { plan: PagePlan; take: number[]; big: boolean } | null {
  if (cat.shaped) return shapedSpreadFor(cat, q, chapterSize, bigLeft, used);
  const head = q[0];
  if (head && head.ratio >= PANORAMA_RATIO && cat.panoramas[0]) {
    return { plan: { layout: cat.panoramas[0].id, photos: [head], spread: true }, take: [0], big: false };
  }
  if (bigLeft <= 0 || chapterSize < SPREAD_MOMENT_MIN) return null;
  for (const l of cat.bigSpreads) {
    if (q.length < l.photoCount) continue;
    const a = assignSlots(cat, l, q.slice(0, l.photoCount));
    if (a.misses <= Math.floor(l.photoCount / 4)) {
      return { plan: { layout: l.id, photos: a.order, spread: true }, take: firstK(l.photoCount), big: true };
    }
  }
  return null;
}

/** k-subsets of 0..n-1 in lexicographic order (the contiguous head [0..k-1] first). */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const walk = (from: number) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = from; i <= n - (k - cur.length); i++) {
      cur.push(i);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return out;
}

/** Rule 10 spread choice (geometric / scrapbook). */
function shapedSpreadFor(
  cat: Catalogue,
  q: P[],
  chapterSize: number,
  bigLeft: number,
  used: number,
): { plan: PagePlan; take: number[]; big: true } | null {
  if (bigLeft <= 0 || chapterSize < SPREAD_MOMENT_MIN || cat.bigSpreads.length === 0) return null;
  const large = chapterSize >= LARGE_SPREAD_MOMENT;
  const smallest = cat.bigSpreads[0].photoCount;
  const pool = large ? cat.bigSpreads : cat.bigSpreads.filter((l) => l.photoCount === smallest);
  const ordered = large && used % 2 === 0 ? [...pool].reverse() : pool;
  for (const l of ordered) {
    const k = l.photoCount;
    if (q.length < k) continue;
    const allowed = Math.floor(k / 4);
    let pick: { take: number[]; order: P[]; misses: number } | null = null;
    for (const take of combinations(Math.min(q.length, k + SPREAD_LOOKAHEAD), k)) {
      const a = assignSlots(
        cat,
        l,
        take.map((i) => q[i]),
      );
      if (!pick || a.misses < pick.misses) pick = { take, order: a.order, misses: a.misses };
      if (a.misses === 0) break;
    }
    if (pick && pick.misses <= allowed) {
      return { plan: { layout: l.id, photos: pick.order, spread: true }, take: pick.take, big: true };
    }
  }
  return null;
}

function genericFill(
  cat: Catalogue,
  allowSpreads: boolean,
  photos: P[],
  start: number,
  opener: boolean,
  prevLayout: string | null,
): PagePlan[] {
  const pages: PagePlan[] = [];
  const q = [...photos];
  const n = photos.length;
  let pos = start;
  let prev = prevLayout;
  let lastSpread = false;
  const bigTotal = allowSpreads ? Math.ceil(n / PHOTOS_PER_SPREAD) : 0;
  let bigLeft = bigTotal;
  const memo: LookaheadMemo = { cands: new Map(), spreads: new Map() };
  const push = (pl: PagePlan) => {
    pages.push(pl);
    pos += pl.spread ? 2 : 1;
    prev = pl.layout;
    lastSpread = pl.spread === true;
  };
  const trySpread = (): boolean => {
    if (!allowSpreads || pos % 2 !== 0 || lastSpread || cat.spreads.length === 0) return false;
    const s = spreadFor(cat, q, n, bigLeft, bigTotal - bigLeft);
    if (!s) return false;
    const taken = new Set(s.take);
    for (let i = q.length - 1; i >= 0; i--) if (taken.has(i)) q.splice(i, 1);
    if (s.big) bigLeft--;
    push(s.plan);
    return true;
  };

  if (opener && q.length >= OPENER_MIN && !trySpread()) push(genericSingle(cat, q.shift() as P, null));

  while (q.length) {
    if (trySpread()) continue;
    if (cat.shaped) {
      const move = shapedLookahead(cat, allowSpreads, { q, pos, prev, lastSpread, bigLeft }, n, bigTotal, memo);
      const taken = new Set(move.take);
      for (let i = q.length - 1; i >= 0; i--) if (taken.has(i)) q.splice(i, 1);
      push({ layout: move.layout, photos: move.order });
      continue;
    }
    const cands = genericCandidates(cat, q, n);
    const pick = cands.find((c) => c.layout !== prev) ?? cands[0];
    if (!pick) {
      push(genericSingle(cat, q.shift() as P, prev));
      continue;
    }
    const taken = new Set(pick.take);
    for (let i = q.length - 1; i >= 0; i--) if (taken.has(i)) q.splice(i, 1);
    push({ layout: pick.layout, photos: pick.order });
  }
  return pages;
}

/** Rule 10: pages the shape-aware filler looks ahead when it chooses the next page. */
const LOOKAHEAD_PAGES = 3;
/** Rule 10 look-ahead cost of one orientation miss (a single page that misses its slot). */
const LOOKAHEAD_MISS = 100;

interface FillState {
  q: P[];
  pos: number;
  prev: string | null;
  lastSpread: boolean;
  bigLeft: number;
}

interface Move {
  layout: string;
  take: number[];
  order: P[];
  /** Look-ahead cost of this page: miss, one-photo page, repeat of the previous layout. */
  misses: number;
  single: boolean;
}

interface PathScore {
  cost: number;
  /** The path used up the chapter's queue. */
  done: boolean;
  pages: number;
  repeats: number;
  ranks: number[];
}

/** Per-chapter caches: candidates and spread checks depend only on the queue head (+ spread state). */
interface LookaheadMemo {
  cands: Map<string, Move[]>;
  spreads: Map<string, boolean>;
}

const headKey = (q: readonly P[], len: number) =>
  q
    .slice(0, len)
    .map((p) => p.id)
    .join("\u0000");

/** Moves for the next page: zero-miss multi-photo pages (rule 9 order), then the head photo alone. */
function movesFor(cat: Catalogue, q: P[], chapterSize: number, prev: string | null, memo: LookaheadMemo): Move[] {
  const key = `${headKey(q, cat.maxPerPage + 1)}\u0001${prev ?? ""}`;
  const hit = memo.cands.get(key);
  if (hit) return hit;
  const moves: Move[] = genericCandidates(cat, q, chapterSize).map((c) => ({ ...c, misses: 0, single: false }));
  const s = genericSingle(cat, q[0], prev);
  const miss = shapeMiss(getLayoutOf(cat, s.layout), 0, q[0], cat.design.format);
  moves.push({ layout: s.layout, take: [0], order: s.photos, misses: miss ? 1 : 0, single: true });
  memo.cands.set(key, moves);
  return moves;
}

function getLayoutOf(cat: Catalogue, id: string): Layout {
  return cat.singles.find((l) => l.id === id) as Layout;
}

function spreadNext(
  cat: Catalogue,
  allowSpreads: boolean,
  st: FillState,
  chapterSize: number,
  bigTotal: number,
  memo: LookaheadMemo,
): boolean {
  if (!allowSpreads || st.pos % 2 !== 0 || st.lastSpread || cat.spreads.length === 0 || st.bigLeft <= 0) return false;
  const maxK = Math.max(0, ...cat.bigSpreads.map((l) => l.photoCount)) + SPREAD_LOOKAHEAD;
  const key = `${headKey(st.q, maxK)}\u0001${st.bigLeft}`;
  let hit = memo.spreads.get(key);
  if (hit === undefined) {
    hit = spreadFor(cat, st.q, chapterSize, st.bigLeft, bigTotal - st.bigLeft) !== null;
    memo.spreads.set(key, hit);
  }
  return hit;
}

/** Lower is better: cost, a path that finishes the chapter, its page count, repeats, catalogue rank. */
function betterPath(a: PathScore, b: PathScore): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  if (a.done !== b.done) return a.done;
  if (a.done && a.pages !== b.pages) return a.pages < b.pages;
  if (a.repeats !== b.repeats) return a.repeats < b.repeats;
  for (let i = 0; i < Math.min(a.ranks.length, b.ranks.length); i++) {
    if (a.ranks[i] !== b.ranks[i]) return a.ranks[i] < b.ranks[i];
  }
  return a.ranks.length < b.ranks.length;
}

/**
 * Rule 10 page choice: the first page of the best path over the next LOOKAHEAD_PAGES pages
 * (exhaustive over zero-miss multi-photo pages + the head photo alone). Path cost = misses ×
 * LOOKAHEAD_MISS + one-photo pages + pages repeating the previous page's layout; ties → a path
 * that finishes the chapter in fewer pages → fewer repeats → rule 9 catalogue order. A spread
 * the filler would place next ends the path (it breaks any repeat).
 */
function shapedLookahead(
  cat: Catalogue,
  allowSpreads: boolean,
  start: FillState,
  chapterSize: number,
  bigTotal: number,
  memo: LookaheadMemo,
): Move {
  let best: { score: PathScore; first: Move } | null = null;
  const walk = (st: FillState, depth: number, acc: PathScore, first: Move | null) => {
    const leaf =
      depth === LOOKAHEAD_PAGES || st.q.length === 0 || (depth > 0 && spreadNext(cat, allowSpreads, st, chapterSize, bigTotal, memo));
    if (leaf && first) {
      const score = { ...acc, done: st.q.length === 0 };
      if (!best || betterPath(score, best.score)) best = { score, first };
      return;
    }
    if (best && acc.cost > best.score.cost) return; // costs only grow
    const moves = movesFor(cat, st.q, chapterSize, st.prev, memo);
    moves.forEach((m, rank) => {
      const repeat = m.layout === st.prev ? 1 : 0;
      const taken = new Set(m.take);
      walk(
        {
          q: st.q.filter((_, i) => !taken.has(i)),
          pos: st.pos + 1,
          prev: m.layout,
          lastSpread: false,
          bigLeft: st.bigLeft,
        },
        depth + 1,
        {
          cost: acc.cost + m.misses * LOOKAHEAD_MISS + (m.single ? 1 : 0) + repeat,
          done: false,
          pages: acc.pages + 1,
          repeats: acc.repeats + repeat,
          ranks: [...acc.ranks, rank],
        },
        first ?? m,
      );
    });
  };
  walk(start, 0, { cost: 0, done: false, pages: 0, repeats: 0, ranks: [] }, null);
  return (best as { score: PathScore; first: Move } | null)?.first ?? movesFor(cat, start.q, chapterSize, start.prev, memo)[0];
}

// ---------- 7. safety net ----------

function ensureValid(doc: BookDoc, kept: P[], opts: AutolayoutOptions, maxPages: number, design: BookDesign): BookDoc {
  const photoIds = new Set(kept.map((p) => p.id));
  const parsed = parseBookDoc(doc);
  if (parsed.ok && validateBookDoc(parsed.doc, { photoIds, maxPages }).length === 0) return parsed.doc;

  // Should never happen (tests cover it) — a minimal album the renderer can always show, in the
  // book's own format + style (validateBookDoc rejects other layouts).
  const classic = isClassicPortrait(design);
  const fullPage = classic ? "full-page" : fullPageLayout(design);
  const minimal: BookDoc = {
    ...doc,
    cover: {
      ...doc.cover,
      layout: classic ? COVER_LAYOUT_ID : bestCoverLayout(design, kept[0]?.orient ?? null),
      photoId: kept[0]?.id ?? null,
      title: coverTitle(DEFAULT_TITLES[opts.occasion]),
      subtitle: "",
    },
    chapters: [],
    pages: sampleEvenly(kept, Math.min(kept.length, maxPages)).map((p, i) => ({
      id: `p${i + 1}`,
      chapterId: null,
      layout: fullPage,
      slots: [{ photoId: p.id, crop: { ...CENTER } }],
      caption: null,
    })),
    // A bad runId must not cost the user their album: drop it rather than fail.
    meta: { ...ruleMeta(opts), runId: validRunId(opts.runId) },
  };
  return minimal;
}

function validRunId(id: string | null | undefined): string | null {
  return id != null && DocMetaSchema.shape.runId.safeParse(id).success ? id : null;
}

/** Unicode-safe clip to `max` UTF-16 units (never leaves a lone surrogate — jsonb rejects it). */
function clip(s: string, max: number): string {
  return clipText(s, max);
}

/**
 * Cover title = the user's title, kept whole: titles are capped at BOOK_TITLE_MAX_CODE_POINTS
 * code points on input, which always fits CoverSchema. Only a longer (legacy/bad) title is clipped,
 * by code points then UTF-16 units, matching the schema's two checks.
 */
function coverTitle(s: string): string {
  return clipText(clipCodePoints(s, BOOK_TITLE_MAX_CODE_POINTS), BOOK_TITLE_MAX_CODE_POINTS * 2);
}
