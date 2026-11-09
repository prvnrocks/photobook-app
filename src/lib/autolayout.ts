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
// The result is checked with parseBookDoc + validateBookDoc; if that ever fails, a minimal
// safe album is returned instead (the user must always get an album).

import { limitsFor } from "@/lib/ai/limits";
import { BOOK_TITLE_MAX_CODE_POINTS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { DocMetaSchema, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc, BookPage, Chapter, Crop, DocMeta } from "@/lib/book/types";
import { COVER_LAYOUT_ID } from "@/lib/layouts";
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
}

/** Version of the rules above, stored in doc.meta.generatorVersion. */
export const AUTOLAYOUT_VERSION = 1;

function ruleMeta(opts: AutolayoutOptions): DocMeta {
  return { generator: "rule", generatorVersion: AUTOLAYOUT_VERSION, runId: opts.runId ?? null, userEdited: false };
}

export const DEFAULT_TITLES: Record<Occasion, string> = {
  wedding: "Our Wedding",
  travel: "Our Travels",
  baby: "Our Little One",
  graduation: "Graduation Day",
  family: "Family Moments",
  other: "Our Photobook",
};

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
  sharp: number;
  area: number;
}

interface Group {
  photos: P[];
}

export function autolayout(photos: AutoPhoto[], opts: AutolayoutOptions): BookDoc {
  const maxPages = limitsFor(opts.isPaid).maxPages;
  const kept = dedupe(photos, opts.dupGroups).sort(byTime);

  let groups = splitChapters(kept);
  const need = groups.reduce((a, g) => a + fillChapter(g.photos).length, 0);
  // Overflowing album: aim for ≥ ~3 pages per chapter so sampling keeps real content.
  if (need > maxPages) groups = mergeToFit(groups, Math.max(1, Math.floor(maxPages / PAGES_PER_CHAPTER)));

  const chosen = fitPages(groups, maxPages);

  const chapters: Chapter[] = [];
  const pages: BookPage[] = [];
  chosen.forEach((g, i) => {
    const chapterId = `c${i + 1}`;
    chapters.push(chapterMeta(chapterId, g.photos, chosen.length > 1));
    for (const pg of fillChapter(g.photos)) {
      pages.push({
        id: `p${pages.length + 1}`,
        chapterId,
        layout: pg.layout,
        slots: pg.photos.map((p) => ({ photoId: p.id, crop: { ...CENTER } })),
        caption: null,
      });
    }
  });

  const coverPhoto = pickCover(kept);
  const doc: BookDoc = {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: opts.occasion,
    cover: {
      layout: COVER_LAYOUT_ID,
      photoId: coverPhoto?.id ?? null,
      title: coverTitle(opts.title?.trim() || DEFAULT_TITLES[opts.occasion]),
      subtitle: clip(subtitleFor(kept), 120),
    },
    chapters,
    pages,
    style: { background: "#FFFFFF", font: opts.captionLang === "ar" ? "Cairo" : "Playfair" },
    meta: ruleMeta(opts),
  };

  return ensureValid(doc, kept, opts, maxPages);
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

function pickCover(photos: P[]): P | null {
  let best: P | null = null;
  for (const p of photos) {
    if (!best) {
      best = p;
      continue;
    }
    const pp = p.orient === "portrait" ? 0 : 1;
    const bp = best.orient === "portrait" ? 0 : 1;
    if (pp < bp || (pp === bp && bySharpness(p, best) < 0)) best = p;
  }
  return best;
}

// ---------- 4. page cap ----------

function fitPages(groups: Group[], maxPages: number): Group[] {
  const need = groups.map((g) => fillChapter(g.photos).length);
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

  let carry = 0;
  return groups.map((g, i) => {
    const b = budget[i] + carry;
    if (need[i] <= b) {
      carry = b - need[i];
      return g;
    }
    const n = g.photos.length;
    for (let k = Math.min(n, 4 * b); k >= 1; k--) {
      const sample = sampleEvenly(g.photos, k);
      const used = fillChapter(sample).length;
      if (used <= b) {
        carry = b - used;
        return { photos: sample };
      }
    }
    carry = b - 1;
    return { photos: sampleEvenly(g.photos, 1) };
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
 * Same rules and output as the autolayout filler. Pure, deterministic.
 */
export function fillPages(
  photos: readonly Pick<AutoPhoto, "id" | "width" | "height" | "takenAt" | "place" | "blurScore">[],
  opts: { opener?: boolean; prevLayout?: string | null } = {},
): { layout: string; photoIds: string[] }[] {
  const ps = photos
    .map((ph) => toP({ ...ph, dateSource: null, status: "kept", dupGroup: null }))
    .sort(byTime);
  return fillChapter(ps, opts.opener ?? false, opts.prevLayout ?? null).map((pg) => ({
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

// ---------- 7. safety net ----------

function ensureValid(doc: BookDoc, kept: P[], opts: AutolayoutOptions, maxPages: number): BookDoc {
  const photoIds = new Set(kept.map((p) => p.id));
  const parsed = parseBookDoc(doc);
  if (parsed.ok && validateBookDoc(parsed.doc, { photoIds, maxPages }).length === 0) return parsed.doc;

  // Should never happen (tests cover it) — a minimal album the renderer can always show.
  const minimal: BookDoc = {
    ...doc,
    cover: { ...doc.cover, photoId: kept[0]?.id ?? null, title: coverTitle(DEFAULT_TITLES[opts.occasion]), subtitle: "" },
    chapters: [],
    pages: sampleEvenly(kept, Math.min(kept.length, maxPages)).map((p, i) => ({
      id: `p${i + 1}`,
      chapterId: null,
      layout: "full-page",
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
