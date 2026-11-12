// Replay synthesiser for the Storyteller (D-024): a deterministic AlbumPlan built only from
// request.scenarioMeta (StorytellerScenarioMeta) — used locally, in previews and in tests.
// Registered in ./replay-synths.ts (imported for its side effect by transport-factory.ts).
//
// - moments = Asia/Dubai calendar days in time order (undated photos → one last moment); if there
//   are more days than maxPages, adjacent days are merged into maxPages moments
// - pages: opener single photo when a moment has ≥ 3 photos, then two-vertical (2 portrait),
//   two-horizontal (2 landscape), three-mixed (1 wide + 2 tall), else a single page
//   (landscape → full-page, portrait → one-portrait); avoids repeating the previous layout
// - over maxPages: per-moment page budgets (proportional, ≥ 1); keeps the best-quality photos
//   that fit, in time order
// - cover = coverWorthy photo, portrait/square first, highest quality, earliest
// - place = a place from the moment's own photos, else null (never invented); title = user title
//   or a neutral default
// - design (M10b A11, meta.design; default classic A5 portrait = the rules above, unchanged):
//   other designs fill pages with the design's own layouts (bestPageLayout({design})): opener
//   single, then the 3- or 2-photo layout with the most orientation matches; modern books get at
//   most one spread per moment of ≥ 8 photos, only where it starts on a left page (running page
//   index even); if spreads would exceed maxPages the plan is rebuilt without them
// - backgrounds (v6, modern / geometric / scrapbook only; classic output unchanged): book =
//   the T11 colour vote over the photos' colours (meta.photos[].color) as a catalogue id; each
//   even-numbered moment (m2, m4, …) that opens with a single page gets the vote over its own
//   photos, other moments null; scrapbook moments of ≥ 2 pages instead get "faded-photo" with the
//   first photo of their second page (a kept photo of the same moment, never on the opener)
// scenario "invalid" → the first page gets an extra unknown alias ("p9999"): passes both schemas
// but fails plan validation (wrong slot count + unknown photo), exercising the retry path.

import { dayRange } from "@/lib/autolayout";
import { DEFAULT_TITLES } from "@/lib/book/default-titles";
import { DEFAULT_BOOK_DESIGN, type BookDesign } from "@/lib/book/book-design";
import { layoutsFor } from "@/lib/book/spreads";
import { bestPageLayout, fitScore } from "@/lib/layouts/fit";
import { swatchById } from "@/lib/design/backgrounds";
import { AI_BACKGROUND_CATALOGUE, FADED_PHOTO_ID, suggestBookBackground, suggestsBackgrounds } from "@/lib/design/background-suggest";
import type { Background } from "@/lib/book/types";
import type { AlbumPlanAi } from "../schemas";
import { dubaiDay } from "../story";
import type { ReplaySynth } from "../transport-replay";
import type { StorytellerScenarioMeta } from "./storyteller";

type MetaPhoto = StorytellerScenarioMeta["photos"][number];
type PlanPage = AlbumPlanAi["moments"][number]["pages"][number];

export const INVALID_ALIAS = "p9999";

const notLandscape = (p: MetaPhoto) => p.orientation !== "landscape";
const notPortrait = (p: MetaPhoto) => p.orientation !== "portrait";

function single(p: MetaPhoto, prev: string | null): PlanPage {
  if (p.orientation === "landscape") return { layoutId: "full-page", photoIds: [p.alias] };
  return { layoutId: prev === "one-portrait" ? "full-page" : "one-portrait", photoIds: [p.alias] };
}

export function fillMoment(photos: MetaPhoto[]): PlanPage[] {
  const q = [...photos];
  const pages: PlanPage[] = [];
  let prev: string | null = null;
  const push = (pg: PlanPage) => {
    pages.push(pg);
    prev = pg.layoutId;
  };
  if (q.length >= 3) push(single(q.shift() as MetaPhoto, null));

  while (q.length) {
    const [a, b, c] = q;
    const options: { page: PlanPage; take: number }[] = [];
    if (a && b && notLandscape(a) && notLandscape(b)) options.push({ page: { layoutId: "two-vertical", photoIds: [a.alias, b.alias] }, take: 2 });
    if (a && b && notPortrait(a) && notPortrait(b)) options.push({ page: { layoutId: "two-horizontal", photoIds: [a.alias, b.alias] }, take: 2 });
    if (a && b && c) {
      const three = [a, b, c];
      const wide = three.findIndex((p) => p.orientation === "landscape");
      const w = wide >= 0 ? wide : three.findIndex((p) => p.orientation === "square");
      if (w >= 0 && three.every((p, i) => i === w || notLandscape(p))) {
        const tall = three.filter((_, i) => i !== w);
        options.push({ page: { layoutId: "three-mixed", photoIds: [three[w].alias, ...tall.map((p) => p.alias)] }, take: 3 });
      }
    }
    const pick = options.find((o) => o.page.layoutId !== prev) ?? options[0];
    if (!pick) {
      push(single(q.shift() as MetaPhoto, prev));
      continue;
    }
    q.splice(0, pick.take);
    push(pick.page);
  }
  return pages;
}

const isClassicPortrait = (d: BookDesign) => d.format === "A5_PORTRAIT" && d.designStyle === "classic";

function designSingle(p: MetaPhoto, prev: string | null, design: BookDesign): PlanPage {
  const singles = layoutsFor(design.format, design.designStyle, "page").filter((l) => l.photoCount === 1);
  const ranked = singles.filter((l) => fitScore(l, [p.orientation]) === 1);
  const pool = ranked.length ? ranked : singles;
  const pick = pool.find((l) => l.id !== prev) ?? pool[0];
  return { layoutId: pick.id, photoIds: [p.alias] };
}

/**
 * Pages of one moment in a non-classic-portrait design. `startIndex` = book page index of the
 * moment's first page (spreads only where it is even); `allowSpread` false → page layouts only.
 */
export function fillMomentDesign(photos: MetaPhoto[], design: BookDesign, startIndex = 0, allowSpread = true): PlanPage[] {
  const q = [...photos];
  const pages: PlanPage[] = [];
  let at = startIndex;
  let prev: string | null = null;
  let spreadUsed = !allowSpread || photos.length < 8;
  const spreads = layoutsFor(design.format, design.designStyle, "spread")
    .filter((l) => l.photoCount > 1)
    .sort((a, b) => b.photoCount - a.photoCount);
  const push = (pg: PlanPage, span = 1) => {
    pages.push(pg);
    prev = pg.layoutId;
    at += span;
  };
  if (q.length >= 3) push(designSingle(q.shift() as MetaPhoto, null, design));
  while (q.length) {
    if (!spreadUsed && at % 2 === 0) {
      const sp = spreads.find((l) => l.photoCount <= q.length);
      if (sp) {
        const take = q.splice(0, sp.photoCount);
        push({ layoutId: sp.id, photoIds: take.map((p) => p.alias) }, 2);
        spreadUsed = true;
        continue;
      }
    }
    let best: { id: string; take: number; score: number } | null = null;
    for (const take of [3, 2]) {
      if (q.length < take) continue;
      const orients = q.slice(0, take).map((p) => p.orientation);
      const id = bestPageLayout(orients, { design });
      if (!id || id === prev) continue;
      const layout = layoutsFor(design.format, design.designStyle, "page").find((l) => l.id === id);
      const score = layout ? fitScore(layout, orients) / take : 0;
      if (!best || score > best.score) best = { id, take, score };
    }
    if (!best) {
      push(designSingle(q.shift() as MetaPhoto, prev, design));
      continue;
    }
    push({ layoutId: best.id, photoIds: q.splice(0, best.take).map((p) => p.alias) });
  }
  return pages;
}

const spanOf = (pages: PlanPage[], design: BookDesign) => {
  const spreadIds = new Set(layoutsFor(design.format, design.designStyle, "spread").map((l) => l.id));
  return pages.reduce((n, pg) => n + (spreadIds.has(pg.layoutId) ? 2 : 1), 0);
};

function groupByDay(photos: MetaPhoto[]): MetaPhoto[][] {
  const sorted = [...photos].sort((x, y) => {
    if (x.ms !== null && y.ms !== null && x.ms !== y.ms) return x.ms - y.ms;
    if (x.ms === null && y.ms !== null) return 1;
    if (x.ms !== null && y.ms === null) return -1;
    return 0;
  });
  const groups: MetaPhoto[][] = [];
  const undated: MetaPhoto[] = [];
  let lastDay: number | null = null;
  for (const p of sorted) {
    if (p.ms === null) {
      undated.push(p);
      continue;
    }
    const d = dubaiDay(p.ms);
    if (lastDay === null || d !== lastDay) groups.push([]);
    groups[groups.length - 1].push(p);
    lastDay = d;
  }
  if (undated.length) groups.push(undated);
  return groups;
}

/** Merge adjacent groups into at most `max` groups (even chunks, order kept). */
function mergeTo(groups: MetaPhoto[][], max: number): MetaPhoto[][] {
  if (groups.length <= max) return groups;
  const out: MetaPhoto[][] = [];
  for (let i = 0; i < max; i++) {
    const from = Math.floor((i * groups.length) / max);
    const to = Math.floor(((i + 1) * groups.length) / max);
    out.push(groups.slice(from, to).flat());
  }
  return out;
}

/** Best `k` by quality (ties → earlier), returned in time order. */
function bestK(photos: MetaPhoto[], k: number): MetaPhoto[] {
  const ranked = photos.map((p, i) => ({ p, i })).sort((x, y) => y.p.quality - x.p.quality || x.i - y.i);
  const keep = new Set(ranked.slice(0, k).map((r) => r.i));
  return photos.filter((_, i) => keep.has(i));
}

function budgets(need: number[], maxPages: number): number[] {
  const total = need.reduce((a, b) => a + b, 0);
  const b = need.map((n) => Math.max(1, Math.min(n, Math.floor((maxPages * n) / total))));
  let sum = b.reduce((x, y) => x + y, 0);
  while (sum > maxPages) {
    let i = 0;
    for (let j = 1; j < b.length; j++) if (b[j] > b[i]) i = j;
    if (b[i] <= 1) break;
    b[i]--;
    sum--;
  }
  return b;
}

function pickCover(photos: MetaPhoto[], against: "landscape" | "portrait" = "landscape"): MetaPhoto | undefined {
  const pool = photos.some((p) => p.cover) ? photos.filter((p) => p.cover) : photos;
  let best: MetaPhoto | undefined;
  for (const p of pool) {
    if (!best) {
      best = p;
      continue;
    }
    const pp = p.orientation === against ? 1 : 0;
    const bp = best.orientation === against ? 1 : 0;
    if (pp < bp || (pp === bp && p.quality > best.quality)) best = p;
  }
  return best;
}

function readMeta(meta: Record<string, unknown>): StorytellerScenarioMeta {
  const m = meta as Partial<StorytellerScenarioMeta>;
  return {
    photos: Array.isArray(m.photos) ? m.photos : [],
    maxPages: typeof m.maxPages === "number" && m.maxPages >= 1 ? Math.floor(m.maxPages) : 20,
    userTitle: typeof m.userTitle === "string" ? m.userTitle : null,
    captionLang: m.captionLang === "ar" ? "ar" : "en",
    occasion: m.occasion ?? "other",
    design:
      m.design && typeof m.design === "object" && typeof m.design.format === "string" && typeof m.design.designStyle === "string"
        ? m.design
        : undefined,
  };
}

/** Swatch ids the AI may pick in any style (catalogue order, de-duplicated; textures excluded). */
const AI_SWATCH_IDS: readonly string[] = [
  ...new Set(Object.values(AI_BACKGROUND_CATALOGUE).flatMap((ids) => (ids as readonly string[]).filter((id) => swatchById(id)))),
];

/** Catalogue id of a rule Background (swatch by hex, texture by id). */
function idOfBackground(bg: Background): string | null {
  if (bg.kind === "texture") return bg.textureId;
  if (bg.kind !== "color") return null;
  const hex = bg.hex.toUpperCase();
  return AI_SWATCH_IDS.find((id) => swatchById(id)?.hex.toUpperCase() === hex) ?? null;
}

/** v6 background picks added to a synthesised plan (styles with AI backgrounds only). */
function withBackgrounds(plan: AlbumPlanAi, meta: StorytellerScenarioMeta, design: BookDesign): AlbumPlanAi {
  const style = design.designStyle;
  if (!suggestsBackgrounds(style)) return plan;
  const colourOf = new Map(meta.photos.map((p) => [p.alias, p.color ?? null]));
  const spreadIds = new Set(layoutsFor(design.format, style, "spread").map((l) => l.id));
  const scrapbook = style === "scrapbook";
  const moments = plan.moments.map((m, i) => {
    const opensWithSpread = spreadIds.has(m.pages[0]?.layoutId ?? "");
    let backgroundId: string | null = null;
    let backgroundPhotoId: string | null = null;
    if (!opensWithSpread) {
      if (scrapbook && m.pages.length >= 2 && m.pages[1].photoIds[0]) {
        backgroundId = FADED_PHOTO_ID;
        backgroundPhotoId = m.pages[1].photoIds[0];
      } else if (i % 2 === 1) {
        const own = m.pages.flatMap((pg) => pg.photoIds.map((a) => colourOf.get(a) ?? null));
        backgroundId = idOfBackground(suggestBookBackground(style, own));
      }
    }
    return scrapbook ? { ...m, backgroundId, backgroundPhotoId } : { ...m, backgroundId };
  });
  const book = idOfBackground(suggestBookBackground(style, meta.photos.map((p) => p.color ?? null)));
  return { ...plan, bookBackgroundId: book, moments };
}

export function synthAlbumPlan(meta: StorytellerScenarioMeta): AlbumPlanAi {
  return withBackgrounds(synthLayoutPlan(meta), meta, meta.design ?? DEFAULT_BOOK_DESIGN);
}

function synthLayoutPlan(meta: StorytellerScenarioMeta): AlbumPlanAi {
  const design = meta.design ?? DEFAULT_BOOK_DESIGN;
  const classic = isClassicPortrait(design);
  // Page-only fill used for the budget (spreads never need more pages than the pages they replace).
  const fillPagesOnly = (g: MetaPhoto[]) => (classic ? fillMoment(g) : fillMomentDesign(g, design, 0, false));
  const ar = meta.captionLang === "ar";
  let groups = mergeTo(groupByDay(meta.photos), meta.maxPages);
  const need = groups.map((g) => fillPagesOnly(g).length);
  if (need.reduce((a, b) => a + b, 0) > meta.maxPages) {
    const b = budgets(need, meta.maxPages);
    groups = groups.map((g, i) => {
      for (let k = g.length; k >= 1; k--) {
        const sample = bestK(g, k);
        if (fillPagesOnly(sample).length <= b[i]) return sample;
      }
      return bestK(g, 1);
    });
  }

  const nonEmpty = groups.filter((g) => g.length > 0);
  const fillAll = (allowSpread: boolean): PlanPage[][] => {
    if (classic) return nonEmpty.map((g) => fillMoment(g));
    let at = 0;
    return nonEmpty.map((g) => {
      const pages = fillMomentDesign(g, design, at, allowSpread);
      at += spanOf(pages, design);
      return pages;
    });
  };
  let filled = fillAll(true);
  if (!classic && filled.reduce((n, p) => n + spanOf(p, design), 0) > meta.maxPages) filled = fillAll(false);

  const moments = nonEmpty
    .map((g, i) => {
      const days = g.filter((p) => p.ms !== null).map((p) => dubaiDay(p.ms as number));
      const place = g.find((p) => p.place)?.place ?? null;
      const title = days.length ? (ar ? `اليوم ${i + 1}` : `Day ${i + 1}`) : ar ? "لحظات أخرى" : "More moments";
      return {
        id: `m${i + 1}`,
        title,
        dateLabel: days.length ? dayRange(Math.min(...days), Math.max(...days)) : "",
        place,
        pages: filled[i],
      };
    });

  return {
    // M13 polish: an English replay album keeps the draft's occasion cover title (one book name).
    title: meta.userTitle ?? (ar ? "حكايتنا" : (DEFAULT_TITLES[meta.occasion] ?? DEFAULT_TITLES.other)),
    subtitle: "",
    coverPhotoId: pickCover(meta.photos, design.format === "A5_LANDSCAPE" ? "portrait" : "landscape")?.alias ?? "p1",
    moments,
  };
}

export const storytellerReplaySynth: ReplaySynth = (raw, ctx) => {
  const plan = synthAlbumPlan(readMeta(raw));
  if (ctx.scenario === "invalid" && plan.moments[0]?.pages[0]) {
    plan.moments[0].pages[0].photoIds.push(INVALID_ALIAS);
  }
  return plan;
};
