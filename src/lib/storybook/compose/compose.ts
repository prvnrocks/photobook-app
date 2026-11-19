// composeStoryDoc (Task 7): a Storybook → book-doc pages, chapters and cover. PURE and
// deterministic — the same storybook, photos and AI choices always give a byte-identical doc.
// The server entry point composeStorybookPages (src/lib/ai/story/compose.ts) loads the inputs,
// runs the optional AI page-intent call, merges with the user's edits (./merge.ts) and saves.
//
// Rules, in order:
//  1. Units: one per storybook page (the cover is separate and never counted). Page kind → family:
//     chapter_opener → chapter_opening, mixed / narrative → storytelling, photo → hero (1 photo) or
//     collage (2–6), closing → closing. Photos that are no longer placeable, and photos / pages the
//     user owns in the current doc (`reserved`), are left out; a unit with nothing left is dropped
//     (never an empty page). A storytelling page with more photos than a storytelling template
//     holds (4–6) becomes a collage + a text page (when the page budget allows).
//  2. Page budget: interior pages target MVP_PAGES (12–24), clamped by the book's max_pages
//     (minus pages the user owns). Above 24, neighbouring photo pages of one chapter are merged
//     (≤ 6 photos, ≤ 1 caption); below 12, photo pages with ≥ 2 photos are split while the
//     planned narrative share stays within the balance tolerance. Content always wins: fewer
//     photos → fewer pages; pages are never padded.
//  3. Templates, page by page (selectPageTemplate): the AI's choice when it is approved for the
//     book's style + format + the page's family AND passes the hard rules; never the template of
//     the previous page; a chapter opening never repeats the previous chapter opening; reuse
//     within REPEAT_WINDOW pages is penalised. On overflow: a template with more room, else the
//     paragraph moves to its own text page, else (text page) it is split at a sentence boundary
//     onto a following text page — only while the budget allows; otherwise the page keeps its
//     roomiest template and is flagged (validatePageLayout text_overflow) for
//     rewriteNarrativeBlock("shorter"). Text is never cut.
//  4. Stable ids: page "sp-<storybook page id>" (+ "-t" for a moved paragraph's page, "-b" for a
//     split photo page, "-x" for extra collage photos), chapter "ch-<chapter id>", text
//     "tx-<block id>" (+ "-2" for the second half of a split). Slots are positional:
//     slotElementId(pageId, i) = "<pageId>/s<i>".

import { bestCoverLayout, type FitOrientation } from "@/lib/layouts/fit";
import type { BookDesign } from "@/lib/book/book-design";
import { newCaptionFont } from "@/lib/book/edit-ops";
import type { BookDoc, BookPage, Caption, Chapter, Cover, PageText, PageTextRole } from "@/lib/book/types";
import type { Occasion } from "@/lib/book/options";
import { styleCaptionFont } from "@/lib/design/styles";
import { getLayout } from "@/lib/layouts";
import { isApprovedTemplate, layoutNarrativeShare, type TemplateFamily } from "@/lib/layouts/templates";
import { STORY_BALANCE } from "@/lib/storybook/schemas";
import type { NarrativeBlock, Storybook, StoryPage } from "@/lib/storybook/types";
import { clipCodePoints, clipText } from "@/lib/text/clip";
import { photoShape, selectPageTemplate } from "./select";
import { validatePageLayout } from "./validate";
import type { ComposePhoto, ComposeText, ComposeWarning, PageEmphasis, PageIntentChoice, SelectResult } from "./types";

/** Bumped when the composition rules change (doc.meta.generatorVersion of composed books). */
export const COMPOSE_VERSION = 1;
/** Interior pages of a storybook for the MVP (the cover never counts). */
export const MVP_PAGES = { min: 12, max: 24 } as const;
/** Most photos on one page (STORY_LIMITS.photosPerPage). */
const MAX_PHOTOS = 6;
/** Storytelling templates hold up to this many photos. */
const STORY_MAX_PHOTOS = 3;

export const slotElementId = (pageId: string, i: number) => `${pageId}/s${i}`;
export const docPageId = (storyPageId: string) => `sp-${storyPageId}`;
export const docChapterId = (storyChapterId: string) => `ch-${storyChapterId}`;
export const textElementId = (blockId: string, part = 1) => (part === 1 ? `tx-${blockId}` : `tx-${blockId}-${part}`);

export type ComposeInput = {
  storybook: Storybook;
  /** The book's placeable photos (ready + kept, preferred duplicate) with sizes / quality / focus. */
  photos: readonly ComposePhoto[];
  design: BookDesign;
  lang: "en" | "ar";
  occasion: Occasion;
  /** books.title — the user's title always wins over the story's (D-018). */
  bookTitle: string | null;
  /** books.max_pages. */
  maxPages: number;
  /** Validated AI page intents by storybook page id (aliases already resolved). */
  intents?: ReadonlyMap<string, PageIntentChoice>;
  /** Pages + photos the user owns in the current doc (./merge.ts): never recomposed or reused. */
  reserved?: { pageIds: ReadonlySet<string>; photoIds: ReadonlySet<string>; pageCount: number };
  /** Book style to keep (the current doc's: user background / colourway); default white + the style's caption face. */
  style?: BookDoc["style"];
  runId?: string | null;
};

export type ComposeBalance = { photoShare: number; narrativeShare: number; drift: number; target: number };
export type ComposeReport = {
  /** Pages of the doc (the cover is not a page and never counts). */
  interiorPages: number;
  /** Measured from template geometry (layoutNarrativeShare of what each page shows), not from the plan. */
  balance: ComposeBalance;
  warnings: ComposeWarning[];
  /** AI page intents: how many were used as given, how many were replaced by the deterministic rules. */
  ai: { used: number; replaced: number };
};
export type ComposeResult = { doc: BookDoc; report: ComposeReport };

type Unit = {
  id: string;
  /** The storybook page this unit comes from (AI intents are keyed by it; split parts share it). */
  storyPageId: string;
  primary: boolean;
  family: TemplateFamily;
  chapterId: string | null;
  photos: ComposePhoto[];
  texts: ComposeText[];
  targetShare: number;
};

const MAIN: readonly PageTextRole[] = ["intro", "paragraph", "closing"];

type BlockInfo = { blockRef: string; source: "ai" | "user"; role: PageTextRole };

function photoFamily(n: number): TemplateFamily {
  return n === 1 ? "hero" : "collage";
}

/** Families a unit may use (an AI family outside this set is ignored). */
function compatible(u: Pick<Unit, "family" | "photos" | "texts">): readonly TemplateFamily[] {
  const n = u.photos.length;
  if (u.family === "chapter_opening") return ["chapter_opening"];
  if (u.family === "closing") return ["closing"];
  if (u.family === "storytelling") return n === 0 ? ["storytelling"] : n <= STORY_MAX_PHOTOS ? ["storytelling"] : [];
  // photo pages: a hero / collage by count; a single-photo page with a main text may tell a story
  return n === 1 ? ["hero"] : ["collage"];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Splits a text at the sentence boundary nearest its middle (null when it has one sentence). */
export function splitAtSentence(text: string): [string, string] | null {
  const marks = [...text.matchAll(/[.!?؟。](?:["'”’»)]*)\s+/gu)].map((m) => (m.index ?? 0) + m[0].length);
  if (marks.length === 0) return null;
  const mid = text.length / 2;
  const at = marks.reduce((b, m) => (Math.abs(m - mid) < Math.abs(b - mid) ? m : b), marks[0]!);
  const a = text.slice(0, at).trim();
  const b = text.slice(at).trim();
  return a && b ? [a, b] : null;
}

function buildUnits(sb: Storybook, input: ComposeInput, warn: (pageId: string, code: ComposeWarning["code"]) => void, blocks: Map<string, BlockInfo>): Unit[] {
  const photoById = new Map(input.photos.map((p) => [p.id, p]));
  const reservedPhotos = input.reserved?.photoIds ?? new Set<string>();
  const reservedPages = input.reserved?.pageIds ?? new Set<string>();
  const heroIds = new Set(sb.moments.map((m) => m.heroPhotoId).filter((x): x is string => !!x));
  const units: Unit[] = [];
  const textsOf = (p: StoryPage): ComposeText[] =>
    p.blocks.map((b: NarrativeBlock) => {
      const key = textElementId(b.id);
      blocks.set(key, { blockRef: b.id, source: b.provenance.source === "user" ? "user" : "ai", role: b.kind });
      return { key, role: b.kind, text: b.text };
    });

  for (const p of sb.pages) {
    if (p.kind === "cover") continue;
    const id = docPageId(p.id);
    if (reservedPages.has(id)) continue;
    const photos = p.photoIds
      .filter((pid) => !reservedPhotos.has(pid))
      .map((pid) => photoById.get(pid))
      .filter((x): x is ComposePhoto => !!x)
      .map((ph) => ({ ...ph, role: ph.role ?? (heroIds.has(ph.id) ? ("hero" as const) : p.photoIds.length > 1 ? ("collage" as const) : ("supporting" as const)) }));
    const texts = textsOf(p);
    const chapterId = p.chapterId ? docChapterId(p.chapterId) : null;
    const base = { storyPageId: p.id, chapterId, targetShare: p.narrativeShare };
    const mains = texts.filter((t) => MAIN.includes(t.role));
    const quotes = texts.filter((t) => !MAIN.includes(t.role));
    if (photos.length === 0 && texts.length === 0) {
      warn(id, "page_dropped");
      continue;
    }
    switch (p.kind) {
      case "chapter_opener": {
        if (photos.length === 0) {
          warn(id, "opener_without_photo");
          units.push({ ...base, id, primary: true, family: "storytelling", photos: [], texts: mains.slice(0, 1) });
          break;
        }
        units.push({ ...base, id, primary: true, family: "chapter_opening", photos: photos.slice(0, 1), texts: mains.slice(0, 1) });
        for (const [k, extra] of chunk(photos.slice(1), MAX_PHOTOS).entries()) units.push({ ...base, id: `${id}-x${k > 0 ? k + 1 : ""}`, primary: false, family: photoFamily(extra.length), photos: extra, texts: [], targetShare: 0 });
        break;
      }
      case "closing": {
        const extra = photos.slice(1);
        for (const [k, group] of chunk(extra, MAX_PHOTOS).entries()) units.push({ ...base, id: `${id}-x${k > 0 ? k + 1 : ""}`, primary: false, family: photoFamily(group.length), photos: group, texts: [], targetShare: 0 });
        if (mains.length === 0) {
          if (photos[0]) units.push({ ...base, id, primary: true, family: "hero", photos: photos.slice(0, 1), texts: quotes.slice(0, 1) });
          break;
        }
        units.push({ ...base, id, primary: true, family: "closing", photos: photos.slice(0, 1), texts: mains.slice(0, 1) });
        break;
      }
      case "mixed":
      case "narrative": {
        if (mains.length === 0) {
          // the paragraph was dropped: a photo page (with its caption, if any)
          if (photos.length > 0) units.push({ ...base, id, primary: true, family: photoFamily(Math.min(photos.length, MAX_PHOTOS)), photos: photos.slice(0, MAX_PHOTOS), texts: quotes.slice(0, 1) });
          else units.push({ ...base, id, primary: true, family: "storytelling", photos: [], texts: quotes.slice(0, 1) });
          break;
        }
        // 4–6 photos + a paragraph are resolved in composeStoryDoc (split / spill, budget permitting)
        units.push({ ...base, id, primary: true, family: "storytelling", photos: photos.slice(0, MAX_PHOTOS), texts: [...mains.slice(0, 1), ...quotes.slice(0, 1)] });
        break;
      }
      case "photo": {
        const groups = chunk(photos, MAX_PHOTOS);
        groups.forEach((g, k) => units.push({ ...base, id: k === 0 ? id : `${id}-x${k > 1 ? k : ""}`, primary: k === 0, family: photoFamily(g.length), photos: g, texts: k === 0 ? [...quotes.slice(0, 1), ...mains.slice(0, 1)].slice(0, 1) : [] }));
        break;
      }
    }
  }
  return units;
}

const isPhotoUnit = (u: Unit) => u.family === "hero" || u.family === "collage";

/** Rule 2: merge photo pages above the target, split them below it (balance permitting). */
function fitBudget(units: Unit[], budget: number, target: number): void {
  const max = Math.min(budget, Math.max(MVP_PAGES.max, 0));
  while (units.length > max) {
    let best = -1;
    let bestSize = Infinity;
    for (let i = 0; i + 1 < units.length; i++) {
      const a = units[i]!;
      const b = units[i + 1]!;
      if (!isPhotoUnit(a) || !isPhotoUnit(b) || a.chapterId !== b.chapterId) continue;
      const size = a.photos.length + b.photos.length;
      if (size <= MAX_PHOTOS && a.texts.length + b.texts.length <= 1 && size < bestSize) {
        best = i;
        bestSize = size;
      }
    }
    if (best < 0) break;
    const a = units[best]!;
    const b = units[best + 1]!;
    units.splice(best, 2, { ...a, family: photoFamily(a.photos.length + b.photos.length), photos: [...a.photos, ...b.photos], texts: [...a.texts, ...b.texts] });
  }
  // Content always wins over the 12-page floor, and so does the 65 / 35 balance.
  const floor = Math.min(MVP_PAGES.min, budget);
  const mean = () => units.reduce((s, u) => s + u.targetShare, 0) / Math.max(1, units.length);
  while (units.length < floor) {
    let pick = -1;
    for (let i = 0; i < units.length; i++) {
      const u = units[i]!;
      if (isPhotoUnit(u) && u.photos.length >= 2 && (pick < 0 || u.photos.length > units[pick]!.photos.length)) pick = i;
    }
    if (pick < 0) break;
    const projected = (mean() * units.length) / (units.length + 1);
    if (projected < target - STORY_BALANCE.tolerance) break;
    const u = units[pick]!;
    const k = Math.ceil(u.photos.length / 2);
    const first: Unit = { ...u, family: photoFamily(k), photos: u.photos.slice(0, k) };
    const second: Unit = { ...u, id: `${u.id}-b`, primary: false, family: photoFamily(u.photos.length - k), photos: u.photos.slice(k), texts: [], targetShare: 0 };
    units.splice(pick, 1, first, second);
  }
}

function chapterOf(sb: Storybook, storyChapterId: string, lang: "en" | "ar"): Chapter {
  const c = sb.chapters.find((x) => x.id === storyChapterId);
  const moments = (c?.momentIds ?? []).map((id) => sb.moments.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
  const date = moments.find((m) => m.dateLabel)?.dateLabel ?? "";
  const place = moments.find((m) => m.place)?.place ?? null;
  return {
    id: docChapterId(storyChapterId),
    title: clipText(c?.title.text ?? (lang === "ar" ? "فصل" : "Chapter"), 80),
    dateLabel: clipText(date, 40),
    place: place ? clipText(place, 80) : null,
  };
}

/** Narrative share each page SHOWS (what has text), from its layout geometry; mean over the pages. */
export function measureBalance(doc: Pick<BookDoc, "pages" | "chapters">, targetShare: number = STORY_BALANCE.narrativeShare): ComposeBalance {
  const shares: number[] = [];
  for (const p of doc.pages) {
    if (p.side === "right") continue;
    const layout = getLayout(p.layout);
    if (!layout) continue;
    const chapter = p.chapterId ? doc.chapters.find((c) => c.id === p.chapterId) : undefined;
    shares.push(
      layoutNarrativeShare(layout, (bind, n) => {
        if (bind === "pageText") return !!p.texts?.some((t) => t.panel === n);
        if (bind === "pageCaption") return p.caption !== null;
        if (bind === "chapterTitle") return !!chapter?.title.trim();
        if (bind === "dateLabel") return !!chapter?.dateLabel.trim();
        return false;
      }),
    );
  }
  const narrative = shares.length ? Math.round((shares.reduce((a, b) => a + b, 0) / shares.length) * 10000) / 10000 : 0;
  return { photoShare: shares.length ? Math.round((1 - narrative) * 10000) / 10000 : 0, narrativeShare: narrative, drift: Math.round((narrative - targetShare) * 10000) / 10000, target: targetShare };
}

export function composeStoryDoc(input: ComposeInput): ComposeResult {
  const sb = input.storybook;
  const { design, lang } = input;
  const warnings: ComposeWarning[] = [];
  const warn = (pageId: string, code: ComposeWarning["code"]) => warnings.push({ pageId, code });
  const blocks = new Map<string, BlockInfo>();
  const budget = Math.max(0, Math.floor(input.maxPages) - (input.reserved?.pageCount ?? 0));

  const units = buildUnits(sb, input, warn, blocks);
  fitBudget(units, budget, sb.target.narrativeShare);

  const style: BookDoc["style"] = input.style
    ? { ...input.style, designStyle: design.designStyle }
    : { background: { kind: "color", hex: "#FFFFFF" }, designStyle: design.designStyle, font: styleCaptionFont(design.designStyle, lang) };
  const docForFonts = { style };

  const pages: BookPage[] = [];
  /** The unit each page was built from (parallel to `pages`). */
  const placedUnits: Unit[] = [];
  const recent: string[] = [];
  let lastOpener: string | null = null;
  const ai = { used: 0, replaced: 0 };

  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (pages.length >= budget) {
      warn(u.id, "page_dropped");
      continue;
    }
    /** Pages that may still be added on top of the units already planned. */
    const room = () => budget - pages.length - (units.length - i);
    /** Index of the nearest photo-only unit of this chapter that can take `n` more photos (later first, then earlier). */
    const spillTarget = (at: number, n: number): number | null => {
      const fits = (x: Unit | undefined) => !!x && isPhotoUnit(x) && x.chapterId === units[at]!.chapterId && x.photos.length + n <= MAX_PHOTOS && x.texts.length === 0;
      for (let k = at + 1; k < units.length && units[k]!.chapterId === units[at]!.chapterId; k++) if (fits(units[k])) return k;
      for (let k = at - 1; k >= 0 && units[k]!.chapterId === units[at]!.chapterId; k--) if (fits(units[k]) && placedUnits.includes(units[k]!)) return k;
      return null;
    };
    if (u.family === "storytelling" && u.photos.length > STORY_MAX_PHOTOS) {
      const main = u.texts.find((t) => MAIN.includes(t.role));
      const quotes = u.texts.filter((t) => !MAIN.includes(t.role));
      const extra = u.photos.slice(STORY_MAX_PHOTOS);
      if (main && room() > 0) {
        // photos on a collage, the paragraph on its own text page right after
        warn(u.id, "paragraph_moved");
        units.splice(i + 1, 0, { ...u, id: `${u.id}-t`, primary: false, family: "storytelling", photos: [], texts: [main], targetShare: 1 });
        u.family = "collage";
        u.texts = quotes;
        u.targetShare = 0;
      } else if (main && spillTarget(i, extra.length) !== null) {
        // no room for another page: the extra photos join the nearest photo page of the chapter
        warn(u.id, "photos_moved");
        const at = spillTarget(i, extra.length)!;
        const target = units[at]!;
        target.photos = at > i ? [...extra, ...target.photos] : [...target.photos, ...extra];
        target.family = photoFamily(target.photos.length);
        u.photos = u.photos.slice(0, STORY_MAX_PHOTOS);
        if (at < i) {
          // an earlier page grows: compose it again (same neighbours rule), then this one
          const pageAt = placedUnits.indexOf(target);
          if (pageAt >= 0) {
            const before = pages[pageAt - 1]?.layout;
            const after = pages[pageAt + 1]?.layout;
            const again = selectPageTemplate({ family: target.family, design, lang, targetShare: 0, recent: [], avoid: [before, after].filter((x): x is string => !!x), relax: true }, target.photos, { texts: target.texts });
            if (again.ok) {
              pages[pageAt] = { ...pages[pageAt]!, layout: again.templateId, slots: again.slots.map((x) => ({ photoId: x.photoId, crop: x.crop })) };
              recent[pageAt] = again.templateId;
            }
          }
        }
      } else {
        warn(u.id, "text_unplaced");
        u.family = "collage";
        u.texts = quotes;
        u.targetShare = 0;
      }
    }
    const choice = u.primary ? input.intents?.get(u.storyPageId) : undefined;
    const families = compatible(u);
    let family = u.family;
    let preferred: string | null = null;
    let emphasis: PageEmphasis | undefined;
    if (choice) {
      const famOk = families.includes(choice.family);
      if (famOk) family = choice.family;
      emphasis = choice.emphasis;
      if (famOk && isApprovedTemplate(choice.templateId, design.designStyle, design.format, family)) preferred = choice.templateId;
    }
    const prev = recent[recent.length - 1];
    const intentBase = {
      family,
      design,
      lang,
      emphasis,
      targetShare: u.targetShare,
      preferredTemplateId: preferred,
      recent,
      avoid: [prev, family === "chapter_opening" ? lastOpener : null].filter((x): x is string => !!x),
    };
    const content = { texts: u.texts };
    let r: SelectResult = selectPageTemplate(intentBase, u.photos, content);

    if (!r.ok && r.reason === "text_overflow") {
      const main = u.texts.find((t) => MAIN.includes(t.role));
      const roomLeft = room() > 0;
      if (main && u.photos.length > 0 && roomLeft) {
        // the paragraph moves to its own text page right after this one
        warn(u.id, "paragraph_moved");
        const textFamily: TemplateFamily = u.family === "closing" ? "closing" : "storytelling";
        u.texts = u.texts.filter((t) => t !== main);
        if (u.family !== "chapter_opening") u.family = photoFamily(u.photos.length);
        units.splice(i + 1, 0, { ...u, id: `${u.id}-t`, primary: false, family: textFamily, photos: [], texts: [main], targetShare: 1 });
        i--;
        continue;
      }
      if (main && u.photos.length === 0 && roomLeft) {
        const halves = splitAtSentence(main.text);
        if (halves) {
          warn(u.id, "text_split");
          const second: ComposeText = { key: `${main.key}-2`, role: main.role, text: halves[1] };
          const info = blocks.get(main.key);
          if (info) blocks.set(second.key, info);
          main.text = halves[0];
          units.splice(i + 1, 0, { ...u, id: `${u.id}-t`, primary: false, texts: [second], targetShare: 1 });
          i--;
          continue;
        }
      }
      // last resort: the roomiest template, flagged by validatePageLayout (never cut)
      r = selectPageTemplate({ ...intentBase, relax: true, fitSlack: 1000 }, u.photos, content);
    }
    if (!r.ok && (r.reason === "crop" || r.reason === "low_dpi") && isPhotoUnit(u) && u.photos.length >= 2 && u.texts.length === 0 && room() > 0) {
      // photos that cannot share a page without a bad crop get a page each (budget permitting)
      const k = Math.ceil(u.photos.length / 2);
      units.splice(i + 1, 0, { ...u, id: `${u.id}-b`, primary: false, family: photoFamily(u.photos.length - k), photos: u.photos.slice(k), texts: [], targetShare: 0 });
      u.photos = u.photos.slice(0, k);
      u.family = photoFamily(k);
      i--;
      continue;
    }
    if (!r.ok && (r.reason === "crop" || r.reason === "low_dpi") && intentBase.avoid.length > 0) {
      // print quality beats variety: a template the neighbour already uses, before a bad crop / low dpi
      // (a chapter opening still never repeats the previous chapter opening — there are three)
      const again = selectPageTemplate({ ...intentBase, avoid: family === "chapter_opening" && lastOpener ? [lastOpener] : [] }, u.photos, content);
      if (again.ok) {
        warn(u.id, "repeat_forced");
        r = again;
      }
    }
    if (!r.ok && (r.reason === "crop" || r.reason === "low_dpi")) {
      warn(u.id, "relaxed");
      r = selectPageTemplate({ ...intentBase, relax: true }, u.photos, content);
    }
    if (!r.ok && r.reason === "repeat") {
      warn(u.id, "repeat_forced");
      r = selectPageTemplate({ ...intentBase, avoid: family === "chapter_opening" && lastOpener ? [lastOpener] : [], relax: true }, u.photos, content);
    }
    if (!r.ok && r.reason === "text_unplaced" && u.texts.length > 0) {
      const keep = u.texts.filter((t) => MAIN.includes(t.role) && (family === "storytelling" || family === "closing" || family === "chapter_opening"));
      warn(u.id, "text_unplaced");
      u.texts = keep;
      r = selectPageTemplate({ ...intentBase, relax: true }, u.photos, { texts: keep });
    }
    if (!r.ok) {
      warn(u.id, "page_dropped");
      continue;
    }
    if (choice) {
      if (preferred === r.templateId) ai.used++;
      else {
        ai.replaced++;
        warn(u.id, "ai_choice_replaced");
      }
    }
    for (const w of r.warnings) if (w !== "preferred_ignored") warn(u.id, w);

    const textByKey = new Map(u.texts.map((t) => [t.key, t]));
    let caption: Caption | null = null;
    const texts: PageText[] = [];
    for (const a of r.texts) {
      const t = textByKey.get(a.key);
      if (!t) continue;
      const info = blocks.get(a.key);
      const source = info?.source ?? "ai";
      if (a.panel === -1) caption = { text: clipText(t.text, 200), font: newCaptionFont(docForFonts, t.text, lang), align: "center", source };
      else texts.push({ id: a.key, panel: a.panel, role: t.role, text: t.text, source, ...(info ? { blockRef: info.blockRef } : {}) });
    }
    texts.sort((a, b) => a.panel - b.panel);
    const page: BookPage = { id: u.id, chapterId: u.chapterId, layout: r.templateId, slots: r.slots.map((s) => ({ photoId: s.photoId, crop: s.crop })), caption };
    if (texts.length) page.texts = texts;
    pages.push(page);
    placedUnits.push(u);
    recent.push(r.templateId);
    if (family === "chapter_opening") lastOpener = r.templateId;
  }

  // chapters: every chapter a page refers to, in storybook order
  const used = new Set(pages.map((p) => p.chapterId).filter((x): x is string => !!x));
  const chapters: Chapter[] = sb.chapters.filter((c) => used.has(docChapterId(c.id))).map((c) => chapterOf(sb, c.id, lang));

  const photoById = new Map(input.photos.map((p) => [p.id, p]));
  const coverPhoto = (sb.coverPhotoId && photoById.get(sb.coverPhotoId)) || photoById.get(pages.find((p) => p.slots[0]?.photoId)?.slots[0]?.photoId ?? "") || null;
  const orient: FitOrientation | null = coverPhoto ? photoShape(coverPhoto).orient : null;
  const title = (input.bookTitle ?? "").replace(/\s+/g, " ").trim() || sb.title.text;
  const cover: Cover = {
    layout: bestCoverLayout(design, orient),
    photoId: coverPhoto?.id ?? null,
    title: clipCodePoints(title, 120),
    subtitle: clipText(sb.subtitle?.text ?? "", 120),
  };

  const doc: BookDoc = {
    version: 2,
    format: design.format,
    occasion: input.occasion,
    cover,
    chapters,
    pages,
    style,
    meta: { generator: "ai", generatorVersion: COMPOSE_VERSION, runId: input.runId ?? null, userEdited: false },
  };

  const photoMap = new Map(input.photos.map((p) => [p.id, p]));
  for (const p of pages) {
    const v = validatePageLayout(p, { design, photos: photoMap, lang });
    for (const e of v.errors) warn(p.id, e.code);
    for (const w of v.warnings) if (w.code !== "orientation_miss" && w.code !== "crop_heavy" && w.code !== "low_dpi" && w.code !== "dpi_below_target" && w.code !== "crop_subject") warn(p.id, w.code);
  }

  return { doc, report: { interiorPages: pages.length, balance: measureBalance(doc, sb.target.narrativeShare), warnings: dedupe(warnings), ai } };
}

function dedupe(ws: ComposeWarning[]): ComposeWarning[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const k = `${w.pageId}|${w.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
