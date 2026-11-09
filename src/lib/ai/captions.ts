// Build captions (D-029/D-030/D-031): batching pages for the Caption Writer and applying its
// results to a BookDoc. Pure, no SDK, no I/O.
//
// Keys (shared contract with src/lib/ai/repair.ts → pageCaptionKeys): the n-th chapter of
// doc.chapters (1-based) is moment m{n} (planToDoc maps moment m{n} → chapter c{n} in order); a
// page's key is captionKey(m{n}, k) where k counts ALL pages of that chapter in doc order
// (captionable or not), so the same key addresses the same page in the plan and in the doc —
// as long as no page was removed in between (call captionBatches on the doc you will apply to).
//
// Only pages whose layout has a caption area are captioned (getLayout(id).caption != null), and a
// caption with source 'user' is never touched.

import type { CaptionLang } from "@/lib/book/options";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc, Caption } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { clipText } from "@/lib/text/clip";
import { buildCaptionContext, checkCaption, type CaptionCheckContext, type CaptionIssue } from "./caption-check";
import { LIMITS, MAX_CAPTION_PAGES_PER_BATCH } from "./limits";
import { AI_TEXT_LIMITS, captionKey, MOMENT_ID_RE, wordCount, type AlbumPlan } from "./schemas";

/** Headings are short chapter titles; longer ones are rejected (the Storyteller title stays). */
export const MAX_HEADING_WORDS = 8;

export interface CaptionBatchPage {
  /** captionKey(momentId, pageIndex), e.g. "m2:1". */
  key: string;
  pageIndex: number;
  /** Index of the page in doc.pages (or in the flattened plan pages). */
  bookPageIndex: number;
  /** 0-based position among all captionable pages of the book (stable replay variation). */
  ordinal: number;
  layout: string;
  /** Photo ids as in the source: real ids for a doc, aliases for a plan. */
  photoIds: string[];
}

export interface CaptionBatchMoment {
  momentId: string;
  /** Storyteller chapter title (draft for the heading). */
  title: string;
  dateLabel: string;
  place: string | null;
  /** False when the moment started in an earlier batch (its heading is taken from there). */
  wantHeading: boolean;
  pages: CaptionBatchPage[];
}

export interface CaptionBatchSpec {
  /** 0-based batch index (step key caption_writer:{index}). */
  index: number;
  lang: CaptionLang;
  moments: CaptionBatchMoment[];
  /** All page keys of the batch, in order. */
  keys: string[];
}

export interface CaptionBatchOptions {
  lang: CaptionLang;
  maxPagesPerBatch?: number;
  /** Default LIMITS.free.maxCaptionBatchesPerBuild (D-034). Pages beyond the cap get no caption. */
  maxBatches?: number;
}

type SourcePage = { layout: string; photoIds: string[]; userCaption: boolean; bookPageIndex: number };
type SourceMoment = { momentId: string; title: string; dateLabel: string; place: string | null; pages: SourcePage[] };

/** Chapter id → moment id "m{n}" by chapter position (1-based), as repair.ts momentIdsByChapter. */
export function momentIdsOfChapters(doc: Pick<BookDoc, "chapters">): Map<string, string> {
  const out = new Map<string, string>();
  doc.chapters.forEach((c, i) => {
    if (!out.has(c.id)) out.set(c.id, `m${i + 1}`);
  });
  return out;
}

function isDoc(x: BookDoc | AlbumPlan): x is BookDoc {
  return (x as BookDoc).version === 1 && Array.isArray((x as BookDoc).pages);
}

function momentsOf(src: BookDoc | AlbumPlan): SourceMoment[] {
  if (!isDoc(src)) {
    let n = 0;
    return src.moments
      .filter((m) => MOMENT_ID_RE.test(m.id))
      .map((m) => ({
        momentId: m.id,
        title: m.title,
        dateLabel: m.dateLabel,
        place: m.place,
        pages: m.pages.map((pg) => ({ layout: pg.layoutId, photoIds: [...pg.photoIds], userCaption: false, bookPageIndex: n++ })),
      }));
  }
  const momentOf = momentIdsOfChapters(src);
  const byMoment = new Map<string, SourceMoment>();
  const out: SourceMoment[] = [];
  src.chapters.forEach((ch, i) => {
    const id = `m${i + 1}`;
    if (momentOf.get(ch.id) !== id) return; // duplicate chapter id: first wins
    const m: SourceMoment = { momentId: id, title: ch.title, dateLabel: ch.dateLabel, place: ch.place, pages: [] };
    byMoment.set(id, m);
    out.push(m);
  });
  src.pages.forEach((p, i) => {
    const m = byMoment.get((p.chapterId && momentOf.get(p.chapterId)) || "");
    if (!m) return;
    m.pages.push({
      layout: p.layout,
      photoIds: p.slots.map((s) => s.photoId).filter((id): id is string => typeof id === "string"),
      userCaption: p.caption?.source === "user",
      bookPageIndex: i,
    });
  });
  return out;
}

const hasCaptionArea = (layoutId: string) => {
  const l = getLayout(layoutId);
  return Boolean(l && l.role === "page" && l.caption);
};

/** Pages the Caption Writer may caption: layout with a caption area, not a user caption. */
export function countCaptionablePages(src: BookDoc | AlbumPlan): number {
  return momentsOf(src).reduce((n, m) => n + m.pages.filter((p) => !p.userCaption && hasCaptionArea(p.layout)).length, 0);
}

/**
 * Split the book into Caption Writer calls: consecutive moments, ≤ maxPagesPerBatch captionable
 * pages per call (a long moment continues in the next batch; only its first part asks for the
 * heading), ≤ maxBatches calls. Moments without captionable pages still get their heading in the
 * current batch. Pages past the batch cap are left uncaptioned (null).
 */
export function captionBatches(src: BookDoc | AlbumPlan, opts: CaptionBatchOptions): CaptionBatchSpec[] {
  const perBatch = Math.max(1, Math.floor(opts.maxPagesPerBatch ?? MAX_CAPTION_PAGES_PER_BATCH));
  const maxBatches = Math.max(0, Math.floor(opts.maxBatches ?? LIMITS.free.maxCaptionBatchesPerBuild));
  const batches: CaptionBatchSpec[] = [];
  let current: CaptionBatchSpec | null = null;
  let pagesInCurrent = 0;
  let ordinal = 0;

  const open = (): CaptionBatchSpec | null => {
    if (batches.length >= maxBatches) return null;
    const b: CaptionBatchSpec = { index: batches.length, lang: opts.lang, moments: [], keys: [] };
    batches.push(b);
    pagesInCurrent = 0;
    return b;
  };
  const momentIn = (b: CaptionBatchSpec, m: SourceMoment, wantHeading: boolean): CaptionBatchMoment => {
    const last = b.moments[b.moments.length - 1];
    if (last?.momentId === m.momentId) return last;
    const bm: CaptionBatchMoment = { momentId: m.momentId, title: m.title, dateLabel: m.dateLabel, place: m.place, wantHeading, pages: [] };
    b.moments.push(bm);
    return bm;
  };

  for (const m of momentsOf(src)) {
    const pages = m.pages
      .map((p, pageIndex) => ({ p, pageIndex }))
      .filter(({ p }) => !p.userCaption && hasCaptionArea(p.layout));
    if (pages.length === 0) {
      current = current ?? open();
      if (!current) break;
      momentIn(current, m, true);
      continue;
    }
    let headingAsked = false;
    for (const { p, pageIndex } of pages) {
      if (!current || pagesInCurrent >= perBatch) current = open();
      if (!current) break;
      const bm = momentIn(current, m, !headingAsked);
      headingAsked = true;
      const key = captionKey(m.momentId, pageIndex);
      bm.pages.push({ key, pageIndex, bookPageIndex: p.bookPageIndex, ordinal: ordinal++, layout: p.layout, photoIds: [...p.photoIds] });
      current.keys.push(key);
      pagesInCurrent++;
    }
    if (!current) break;
  }
  // A batch is only opened when something is added; a headings-only batch can only happen when the
  // whole book has no captionable page (one cheap call for the chapter headings).
  return batches;
}

/**
 * momentId → index of the FIRST batch containing it (for repair.ts planRepair `batchIndexOf`);
 * undefined for moments that got no batch (past the cap).
 */
export function batchIndexOfMoment(batches: readonly CaptionBatchSpec[]): (momentId: string) => number | undefined {
  const map = new Map<string, number>();
  for (const b of batches) for (const m of b.moments) if (!map.has(m.momentId)) map.set(m.momentId, b.index);
  return (momentId) => map.get(momentId);
}

/** captionKey → index of the batch holding that page (a split moment spans two batches). */
export function batchIndexOfKey(batches: readonly CaptionBatchSpec[]): (key: string) => number | undefined {
  const map = new Map<string, number>();
  for (const b of batches) for (const k of b.keys) map.set(k, b.index);
  return (key) => map.get(key);
}

export interface ApplyCaptionsOptions {
  lang: CaptionLang;
  /** Pre-check context for headings; default: built from the doc (title, chapters, date labels). */
  ctx?: CaptionCheckContext;
}

/** Default heading context from the doc alone (title, chapter titles/places, date-label numbers). */
export function docCaptionContext(doc: BookDoc, lang: CaptionLang): CaptionCheckContext {
  const ctx = buildCaptionContext({ lang, bookTitle: doc.cover.title, chapters: doc.chapters });
  const digits = new Set(ctx.allowDigits);
  for (const c of doc.chapters) for (const run of c.dateLabel.match(/[0-9]+/g) ?? []) digits.add(String(Number(run)));
  return { ...ctx, allowDigits: digits };
}

const cleanCaptionText = (s: string, max: number) => clipText(s.replace(/\s+/g, " ").trim(), max);

/** Heading issues: the caption pre-check plus a word cap (codes only). [] = usable. */
export function checkHeading(text: string, ctx: CaptionCheckContext): CaptionIssue[] {
  const t = cleanCaptionText(text, AI_TEXT_LIMITS.heading);
  const issues = checkCaption(t, ctx);
  if (t && wordCount(t) > MAX_HEADING_WORDS && !issues.some((i) => i.code === "too_long")) issues.push({ code: "too_long" });
  return issues;
}

/**
 * Write AI captions/headings into a doc (new object; input untouched). Captions: only pages with a
 * caption area and no user caption; font Cairo for ar else Playfair, centred, source 'ai'.
 * Headings replace chapter titles only when they pass checkHeading. If the result would not parse
 * as a BookDoc, the input doc is returned unchanged.
 */
export function applyCaptions(
  doc: BookDoc,
  results: ReadonlyMap<string, string>,
  headings: ReadonlyMap<string, string>,
  opts: ApplyCaptionsOptions,
): BookDoc {
  const font = opts.lang === "ar" ? "Cairo" : "Playfair";
  const ctx = opts.ctx ?? docCaptionContext(doc, opts.lang);
  const perChapter = new Map<string, number>();
  const momentOf = momentIdsOfChapters(doc);

  const pages = doc.pages.map((page) => {
    const momentId = page.chapterId ? momentOf.get(page.chapterId) : undefined;
    if (!momentId) return page;
    const pageIndex = perChapter.get(momentId) ?? 0;
    perChapter.set(momentId, pageIndex + 1);
    if (page.caption?.source === "user" || !hasCaptionArea(page.layout)) return page;
    const raw = results.get(captionKey(momentId, pageIndex));
    if (typeof raw !== "string") return page;
    const text = cleanCaptionText(raw, AI_TEXT_LIMITS.caption);
    if (!text) return page;
    const caption: Caption = { text, font, align: "center", source: "ai" };
    return { ...page, caption };
  });

  const chapters = doc.chapters.map((ch) => {
    const momentId = momentOf.get(ch.id);
    const raw = momentId ? headings.get(momentId) : undefined;
    if (typeof raw !== "string") return ch;
    const title = cleanCaptionText(raw, AI_TEXT_LIMITS.heading);
    if (!title || checkHeading(title, ctx).length) return ch;
    return { ...ch, title };
  });

  const next: BookDoc = { ...doc, chapters, pages };
  const parsed = parseBookDoc(next);
  return parsed.ok ? parsed.doc : doc;
}
