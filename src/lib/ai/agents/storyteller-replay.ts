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
// scenario "invalid" → the first page gets an extra unknown alias ("p9999"): passes both schemas
// but fails plan validation (wrong slot count + unknown photo), exercising the retry path.

import { dayRange } from "@/lib/autolayout";
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

function pickCover(photos: MetaPhoto[]): MetaPhoto | undefined {
  const pool = photos.some((p) => p.cover) ? photos.filter((p) => p.cover) : photos;
  let best: MetaPhoto | undefined;
  for (const p of pool) {
    if (!best) {
      best = p;
      continue;
    }
    const pp = p.orientation === "landscape" ? 1 : 0;
    const bp = best.orientation === "landscape" ? 1 : 0;
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
  };
}

export function synthAlbumPlan(meta: StorytellerScenarioMeta): AlbumPlanAi {
  const ar = meta.captionLang === "ar";
  let groups = mergeTo(groupByDay(meta.photos), meta.maxPages);
  const need = groups.map((g) => fillMoment(g).length);
  if (need.reduce((a, b) => a + b, 0) > meta.maxPages) {
    const b = budgets(need, meta.maxPages);
    groups = groups.map((g, i) => {
      for (let k = g.length; k >= 1; k--) {
        const sample = bestK(g, k);
        if (fillMoment(sample).length <= b[i]) return sample;
      }
      return bestK(g, 1);
    });
  }

  const moments = groups
    .filter((g) => g.length > 0)
    .map((g, i) => {
      const days = g.filter((p) => p.ms !== null).map((p) => dubaiDay(p.ms as number));
      const place = g.find((p) => p.place)?.place ?? null;
      const title = days.length ? (ar ? `اليوم ${i + 1}` : `Day ${i + 1}`) : ar ? "لحظات أخرى" : "More moments";
      return {
        id: `m${i + 1}`,
        title,
        dateLabel: days.length ? dayRange(Math.min(...days), Math.max(...days)) : "",
        place,
        pages: fillMoment(g),
      };
    });

  return {
    title: meta.userTitle ?? (ar ? "حكايتنا" : "Our Story"),
    subtitle: "",
    coverPhotoId: pickCover(meta.photos)?.alias ?? "p1",
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
