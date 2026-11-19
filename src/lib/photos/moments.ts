// Moment clustering, grounded labels and candidate ranking. Pure (no I/O, no model calls).
//
// A "moment" is a run of photos that belong together. Evidence, in order of trust:
//   time      capture timestamps — EXIF dates are trusted; file dates (date_source "file":
//             filename / last-modified) are weak evidence and make a grouping uncertain
//   place     GPS distance when both photos have coordinates
//   content   what the vision model saw (scene, objects, activities) — similarity of token sets
// Calendar days are NOT evidence: a party that runs past midnight stays one moment, and a new
// date alone never starts a new one. Only the gap, the distance and the change of content do.
//
// Photos without a timestamp are never dropped: they join the moment they most resemble
// (content or place), else they form their own "undated" moments. Either way the grouping is
// reported as uncertain so the user can check it.
//
// Scenes (v2): one long moment (a single visit, no GPS change, no 20-minute gap) is split into
// scenes at gaps that are long FOR THIS SET — at least `sceneMinGapSeconds` and `sceneGapFactor`
// × the moment's median gap — or at half that gap when what the photos show changes. Segments
// smaller than `sceneMinSize` join the neighbour across the shorter gap, and a moment gets at most
// one scene per `scenePhotosPer` photos. Moments under `sceneMinPhotos` photos stay whole.
//
// Labels (v2) describe the SCENE, never one photo's detail: a setting several photos show
// ("At the café"), else a shared scene-level activity (not a pose like "holding a cup"), else a
// scene category, else the date. A setting seen in a few photos of one visit (same day, close
// together in time and place) labels the visit's other scenes too.

import { haversineKm } from "./geo-cluster";
import type { DuplicateGroup } from "./duplicates";
import type { QualityFlag } from "./quality";

export const MOMENTS_VERSION = 2;

export const MOMENT_DEFAULTS = {
  /** Gaps up to this many minutes never count toward a break. */
  freeGapMinutes: 20,
  /** A gap this long scores 1.0 (a break on its own). */
  fullGapMinutes: 180,
  /** A gap this long is always a break, whatever else matches. */
  hardGapMinutes: 12 * 60,
  nearKm: 0.3,
  farKm: 2,
  veryFarKm: 25,
  /** Break when time + place + content score reaches this. */
  breakAt: 1,
  /** Scores this close to `breakAt` are reported as uncertain boundaries. */
  uncertainBand: 0.2,
  /** Minimum content similarity for an undated photo to join a dated moment. */
  joinSimilarity: 0.34,
  /** Maximum distance for an undated photo with GPS to join a moment by place. */
  joinKm: 0.5,
  /** Up to this many collage candidates per moment. */
  collagePerMoment: 4,
  /** A moment with fewer photos is never split into scenes. */
  sceneMinPhotos: 12,
  /** A scene break needs a gap of at least this many seconds … */
  sceneMinGapSeconds: 45,
  /** … and at least this many times the moment's median gap. */
  sceneGapFactor: 12,
  /** At half that gap, a change of content (overlap below this) is a break too. */
  sceneContentCut: 0.2,
  /** Smallest scene; smaller segments join a neighbour. */
  sceneMinSize: 4,
  /** At most one scene per this many photos. */
  scenePhotosPer: 6,
  /** Moments this close in time (hours) and place (visitKm) form one visit for setting labels. */
  visitHours: 3,
  visitKm: 1,
} as const;
export type MomentConfig = { [K in keyof typeof MOMENT_DEFAULTS]: number };
export type MomentOptions = Partial<MomentConfig>;

export type MomentVision = { scene: string; objects: readonly string[]; activities: readonly string[]; storyRole?: string; peopleCount?: number; /** Used for setting labels only ("a café table"). */ description?: string };

export type MomentPhoto = {
  id: string;
  takenAt: string | null;
  dateSource: "exif" | "file" | null;
  lat: number | null;
  lng: number | null;
  /** Place name from reverse geocoding or the user (metadata) — never from the vision model. */
  place: string | null;
  vision: MomentVision | null;
  /** Overall quality 0–100, null when not scored. */
  quality: number | null;
  qualityFlags: readonly QualityFlag[];
  /** False when the photo is dropped (Curator or user). Dropped photos are still grouped. */
  keep: boolean;
  coverWorthy?: boolean;
};

export const UNCERTAIN_REASONS = [
  "weak_boundary", // the break before this moment was a close call
  "weak_join", // two photos stayed together on a close call
  "file_dates", // timestamps come from file dates, not EXIF
  "no_timestamp", // photo(s) without any timestamp
  "joined_by_content", // undated photo attached by visual similarity
  "joined_by_place", // undated photo attached by GPS proximity
  "no_evidence", // no timestamp, no place and no visual description
] as const;
export type UncertainReason = (typeof UNCERTAIN_REASONS)[number];

export type LabelEvidence = {
  kind: "place" | "activity" | "object" | "scene" | "date";
  /** Where the fact comes from. */
  source: "metadata" | "vision" | "timestamp";
  value: string;
  /** Photos of the moment that support it / photos that could have. */
  support: number;
  of: number;
};

export type Moment = {
  /** Stable while the moment keeps its first photo: `m:<first photo id>`. */
  key: string;
  position: number;
  photoIds: string[];
  label: string;
  /** Null when the moment has no timestamps. */
  dateLabel: string | null;
  labelEvidence: LabelEvidence[];
  startsAt: string | null;
  endsAt: string | null;
  place: string | null;
  heroPhotoId: string | null;
  /** 0–1: how well supported the grouping is. */
  confidence: number;
  uncertain: boolean;
  uncertainReasons: UncertainReason[];
};

export type UncertainGrouping = {
  kind: "boundary" | "membership" | "moment";
  reason: UncertainReason;
  momentKey: string;
  /** For a boundary: the neighbouring moment. */
  otherMomentKey?: string;
  /** Photos concerned (the two around a boundary, or the attached photos). */
  photoIds: string[];
  /** Break score for boundaries / similarity for joins (0–1.x), for debugging and UI ordering. */
  score?: number;
};

export const CANDIDATE_ROLES = ["hero", "collage", "supporting", "alternate"] as const;
export type CandidateRole = (typeof CANDIDATE_ROLES)[number];

export type Candidate = {
  photoId: string;
  momentKey: string;
  role: CandidateRole;
  /** Ranking score 0–100 within the book. */
  score: number;
  /** Why a photo is only an alternate. */
  reason?: "duplicate" | "blurry" | "dropped";
};

// ---------------------------------------------------------------------------- helpers

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const hasGps = (p: MomentPhoto): p is MomentPhoto & { lat: number; lng: number } =>
  typeof p.lat === "number" && typeof p.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng);

const STOP = new Set(["a", "an", "the", "of", "on", "in", "at", "with", "and", "to", "by", "for", "from", "up", "out", "is", "are"]);

/** Content tokens of a photo: scene + words of objects and activities (lowercase, no stop words). */
export function contentTokens(v: MomentVision | null): Set<string> {
  const out = new Set<string>();
  if (!v) return out;
  out.add(`scene:${v.scene}`);
  for (const phrase of [...v.objects, ...v.activities]) {
    for (const w of phrase.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length > 2 && !STOP.has(w)) out.add(w.replace(/(ing|s)$/u, ""));
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

type Draft = { photos: MomentPhoto[]; tokens: Map<string, number>; reasons: Set<UncertainReason>; breakScore: number | null; undated: boolean };

const profile = (d: Draft): Set<string> => {
  // tokens seen in at least a quarter of the moment's described photos
  const described = d.photos.filter((p) => p.vision).length;
  const min = Math.max(1, Math.ceil(described / 4));
  const out = new Set<string>();
  for (const [t, n] of d.tokens) if (n >= min) out.add(t);
  return out;
};
const addPhoto = (d: Draft, p: MomentPhoto) => {
  d.photos.push(p);
  for (const t of contentTokens(p.vision)) d.tokens.set(t, (d.tokens.get(t) ?? 0) + 1);
};
const newDraft = (undated = false): Draft => ({ photos: [], tokens: new Map(), reasons: new Set(), breakScore: null, undated });

function centroid(d: Draft): { lat: number; lng: number } | null {
  const pts = d.photos.filter(hasGps);
  if (pts.length === 0) return null;
  return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
}

/** Break score between the running moment and the next photo (≥ breakAt = new moment). */
export function breakScore(current: { last: MomentPhoto; profile: ReadonlySet<string> }, next: MomentPhoto, o: MomentConfig): { score: number; hard: boolean } {
  const gapMin = (ms(next.takenAt)! - ms(current.last.takenAt)!) / 60_000;
  if (gapMin >= o.hardGapMinutes) return { score: 2, hard: true };
  const time = gapMin <= o.freeGapMinutes ? 0 : Math.min(1.2, (gapMin - o.freeGapMinutes) / (o.fullGapMinutes - o.freeGapMinutes));
  let place = 0;
  if (hasGps(current.last) && hasGps(next)) {
    const km = haversineKm(current.last, next);
    place = km <= o.nearKm ? -0.3 : km >= o.veryFarKm ? 1 : km >= o.farKm ? 0.6 : ((km - o.nearKm) / (o.farKm - o.nearKm)) * 0.6;
  }
  let content = 0;
  const tokens = contentTokens(next.vision);
  if (tokens.size > 0 && current.profile.size > 0) content = (0.5 - Math.min(1, jaccard(tokens, current.profile) * 2)) * 0.6;
  return { score: Math.round((time + place + content) * 1000) / 1000, hard: false };
}

// ---------------------------------------------------------------------------- labels

const DATE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dubai" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "Asia/Dubai" });
const YM = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "Asia/Dubai" });

/** "12 Oct 2026", "12–14 Oct 2026", "30 Oct – 2 Nov 2026" (app convention: Asia/Dubai days). */
export function dateRangeLabel(startMs: number, endMs: number): string {
  const a = DATE_FMT.format(startMs);
  const b = DATE_FMT.format(endMs);
  if (a === b) return a;
  if (YM.format(startMs) === YM.format(endMs)) return `${DAY.format(startMs)}–${b}`;
  if (new Date(startMs).getUTCFullYear() === new Date(endMs).getUTCFullYear()) return `${DAY_MONTH.format(startMs)} – ${b}`;
  return `${a} – ${b}`;
}

const SCENE_LABEL: Record<string, string | undefined> = { portrait: "Portraits", group: "People together", landscape: "Scenery", food: "Food", detail: "Details" };
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Settings a photo description / object list can show → the scene label. Generic nouns only, never a named place. */
/** A whole-word, case-insensitive matcher that also works next to accented letters ("café"). */
const word = (src: string) => new RegExp(`(?<![\\p{L}])(?:${src})(?![\\p{L}])`, "iu");

export const SETTINGS: readonly { id: string; re: RegExp; label: string }[] = [
  { id: "cafe", re: word(String.raw`(?:caf[eé]s?|coffee ?shops?|coffeehouses?)`), label: "At the café" },
  { id: "restaurant", re: word(String.raw`(?:restaurants?|diners?|dining rooms?)`), label: "At the restaurant" },
  { id: "beach", re: word(String.raw`(?:beach(?:es)?|shorelines?|seashores?)`), label: "At the beach" },
  { id: "pool", re: word(String.raw`(?:swimming pools?|poolside|pools?)`), label: "By the pool" },
  { id: "park", re: word(String.raw`(?:parks|park|playgrounds?)`), label: "In the park" },
  { id: "garden", re: word(String.raw`gardens?`), label: "In the garden" },
  { id: "desert", re: word(String.raw`(?:deserts?|sand dunes?|dunes)`), label: "In the desert" },
  { id: "market", re: word(String.raw`(?:markets?|souks?|bazaars?)`), label: "At the market" },
  { id: "mall", re: word(String.raw`(?:malls?|shopping cent(?:re|er)s?)`), label: "At the mall" },
  { id: "museum", re: word(String.raw`(?:museums?|galler(?:y|ies)|exhibitions?)`), label: "At the museum" },
  { id: "kitchen", re: word(String.raw`kitchens?`), label: "In the kitchen" },
  { id: "street", re: word(String.raw`(?:streets?|sidewalks?|alleys?|alleyways?)`), label: "Out on the street" },
  { id: "mountains", re: word(String.raw`(?:mountains?|hiking trails?)`), label: "In the mountains" },
  { id: "airport", re: word(String.raw`(?:airports?|terminal building)`), label: "At the airport" },
  { id: "water", re: word(String.raw`(?:boats?|yachts?|dhows?|ferr(?:y|ies))`), label: "On the water" },
];
/** Activities that describe a pose or a single gesture, not what a scene is about. */
const POSE_ACTIVITY = /^(?:holding|posing|smiling|looking|standing|sitting|leaning|resting|wearing|covering|raising|giving|showing|facing|touching|pointing|gesturing|taking a (?:photo|picture|selfie))\b/i;

function top<T extends string>(values: T[]): { value: T; count: number } | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { value: T; count: number } | null = null;
  for (const [value, count] of counts) if (!best || count > best.count || (count === best.count && value < best.value)) best = { value, count };
  return best;
}

/** Setting ids one photo shows (description + objects). */
function settingsOf(p: MomentPhoto): string[] {
  if (!p.vision) return [];
  const text = [p.vision.description ?? "", ...p.vision.objects].join(" . ");
  return SETTINGS.filter((s) => s.re.test(text)).map((s) => s.id);
}

/** The setting most photos show, when it clearly leads: ≥ `min` photos and ≥ 2× the runner-up. */
export function dominantSetting(photos: readonly MomentPhoto[], min: number): { id: string; label: string; support: number } | null {
  const counts = new Map<string, number>();
  for (const p of photos) for (const id of new Set(settingsOf(p))) counts.set(id, (counts.get(id) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [first, second] = ranked;
  if (!first || first[1] < min || (second && first[1] < 2 * second[1])) return null;
  return { id: first[0], label: SETTINGS.find((s) => s.id === first[0])!.label, support: first[1] };
}

/**
 * Label from evidence only. Every part is listed in `evidence` with its source and how many
 * photos support it; a part is used only when enough photos agree, and it always describes the
 * scene (setting / activity / category) — never a single object. `visitSetting` = a setting the
 * surrounding visit shows (photos of the same visit), used when the moment's own photos do not
 * show one. No evidence → the date; no date either → "Undated photos".
 */
export function labelMoment(
  photos: readonly MomentPhoto[],
  visitSetting: { id: string; label: string; support: number; of: number } | null = null,
): { label: string; dateLabel: string | null; place: string | null; evidence: LabelEvidence[] } {
  const evidence: LabelEvidence[] = [];
  const n = photos.length;

  const placed = photos.filter((p) => p.place?.trim());
  const topPlace = top(placed.map((p) => p.place!.trim()));
  let place: string | null = null;
  if (topPlace && topPlace.count / n >= 0.5) {
    place = topPlace.value;
    evidence.push({ kind: "place", source: "metadata", value: place, support: topPlace.count, of: n });
  }

  let subject: string | null = null;
  const described = photos.filter((p) => p.vision);
  if (described.length > 0) {
    const own = dominantSetting(described, Math.max(2, Math.ceil(described.length * 0.3)));
    const activity = top(described.flatMap((p) => [...new Set(p.vision!.activities.map((a) => a.toLowerCase().trim()).filter((a) => a && !POSE_ACTIVITY.test(a)))]));
    const scene = top(described.map((p) => p.vision!.scene));
    if (own) {
      subject = own.label;
      evidence.push({ kind: "scene", source: "vision", value: own.id, support: own.support, of: described.length });
    } else if (visitSetting) {
      subject = visitSetting.label;
      evidence.push({ kind: "scene", source: "vision", value: visitSetting.id, support: visitSetting.support, of: visitSetting.of });
    } else if (activity && activity.count / described.length >= 0.5 && activity.count >= Math.min(2, described.length)) {
      subject = cap(activity.value);
      evidence.push({ kind: "activity", source: "vision", value: activity.value, support: activity.count, of: described.length });
    } else if (scene && SCENE_LABEL[scene.value] && scene.count / described.length >= 0.6) {
      subject = SCENE_LABEL[scene.value]!;
      evidence.push({ kind: "scene", source: "vision", value: scene.value, support: scene.count, of: described.length });
    }
  }

  const times = photos.map((p) => ms(p.takenAt)).filter((t): t is number => t !== null);
  let dateLabel: string | null = null;
  if (times.length > 0) {
    dateLabel = dateRangeLabel(Math.min(...times), Math.max(...times));
    evidence.push({ kind: "date", source: "timestamp", value: dateLabel, support: times.length, of: n });
  }

  const parts = [subject, place].filter((x): x is string => !!x);
  const label = parts.length ? parts.join(" · ") : (dateLabel ?? "Undated photos");
  return { label, dateLabel, place, evidence };
}

// ---------------------------------------------------------------------------- clustering

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Splits one dated moment into scenes (see the header). Returns the photo index ranges
 * [start, end) in time order; one range = the moment stays whole. Deterministic.
 */
export function sceneRanges(photos: readonly MomentPhoto[], o: MomentConfig): [number, number][] {
  const n = photos.length;
  if (n < o.sceneMinPhotos) return [[0, n]];
  const t = photos.map((p) => ms(p.takenAt)!);
  const gaps = t.slice(1).map((x, i) => (x - t[i]!) / 1000);
  const threshold = Math.max(o.sceneMinGapSeconds, o.sceneGapFactor * median(gaps));
  const tokens = photos.map((p) => contentTokens(p.vision));
  const window = (from: number, to: number) => {
    const out = new Set<string>();
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) for (const x of tokens[i]!) out.add(x);
    return out;
  };
  // cut i = between photo i and i + 1
  const cuts: number[] = [];
  gaps.forEach((g, i) => {
    if (g >= threshold) cuts.push(i);
    else if (g >= threshold / 2) {
      const before = window(i - 2, i + 1);
      const after = window(i + 1, i + 4);
      if (before.size > 0 && after.size > 0 && jaccard(before, after) < o.sceneContentCut) cuts.push(i);
    }
  });
  let ranges: [number, number][] = [];
  let start = 0;
  for (const c of cuts) {
    ranges.push([start, c + 1]);
    start = c + 1;
  }
  ranges.push([start, n]);
  const gapBefore = (r: [number, number]) => (r[0] > 0 ? gaps[r[0] - 1]! : Infinity);
  const mergeAt = (i: number) => {
    // merge ranges[i] and ranges[i + 1]
    ranges = [...ranges.slice(0, i), [ranges[i]![0], ranges[i + 1]![1]], ...ranges.slice(i + 2)];
  };
  // segments that are too small join the neighbour across the shorter gap
  for (;;) {
    const i = ranges.findIndex((r) => r[1] - r[0] < o.sceneMinSize);
    if (i < 0 || ranges.length === 1) break;
    if (i === 0) mergeAt(0);
    else if (i === ranges.length - 1) mergeAt(i - 1);
    else mergeAt(gapBefore(ranges[i]!) <= gapBefore(ranges[i + 1]!) ? i - 1 : i);
  }
  // at most one scene per scenePhotosPer photos: merge across the shortest gaps
  const maxScenes = Math.max(1, Math.floor(n / o.scenePhotosPer));
  while (ranges.length > maxScenes) {
    let best = 0;
    for (let i = 1; i + 1 < ranges.length; i++) if (gapBefore(ranges[i + 1]!) < gapBefore(ranges[best + 1]!)) best = i;
    mergeAt(best);
  }
  return ranges;
}

export type ClusterResult = { moments: Moment[]; uncertain: UncertainGrouping[] };

/**
 * Groups ALL given photos into moments (every photo ends up in exactly one). Deterministic:
 * the same photos give the same moments, in story order (dated moments by time, undated last).
 */
export function clusterMoments(photos: readonly MomentPhoto[], options: MomentOptions = {}): ClusterResult {
  const o: MomentConfig = { ...MOMENT_DEFAULTS, ...options };
  const byTime = (a: MomentPhoto, b: MomentPhoto) => ms(a.takenAt)! - ms(b.takenAt)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const dated = photos.filter((p) => ms(p.takenAt) !== null).sort(byTime);
  const undated = photos.filter((p) => ms(p.takenAt) === null).sort((a, b) => (a.id < b.id ? -1 : 1));

  const drafts: Draft[] = [];
  const pending: { kind: "boundary" | "membership"; reason: UncertainReason; draft: Draft; other?: Draft; photoIds: string[]; score?: number }[] = [];

  let current: Draft | null = null;
  for (const p of dated) {
    if (!current) {
      current = newDraft();
      addPhoto(current, p);
      drafts.push(current);
      continue;
    }
    const last = current.photos[current.photos.length - 1]!;
    const { score, hard } = breakScore({ last, profile: profile(current) }, p, o);
    const close = !hard && Math.abs(score - o.breakAt) <= o.uncertainBand;
    if (score >= o.breakAt) {
      const next = newDraft();
      next.breakScore = score;
      addPhoto(next, p);
      drafts.push(next);
      if (close) {
        next.reasons.add("weak_boundary");
        pending.push({ kind: "boundary", reason: "weak_boundary", draft: next, other: current, photoIds: [last.id, p.id], score });
      }
      current = next;
    } else {
      if (close) {
        current.reasons.add("weak_join");
        pending.push({ kind: "membership", reason: "weak_join", draft: current, photoIds: [last.id, p.id], score });
      }
      addPhoto(current, p);
    }
  }
  // scenes: split long single-visit moments (pending entries follow their photos)
  for (let k = drafts.length - 1; k >= 0; k--) {
    const d = drafts[k]!;
    const ranges = sceneRanges(d.photos, o);
    if (ranges.length < 2) continue;
    const parts = ranges.map(([a, b], j) => {
      const part = newDraft();
      for (const p of d.photos.slice(a, b)) addPhoto(part, p);
      part.breakScore = j === 0 ? d.breakScore : null;
      return part;
    });
    const partOf = (id: string) => parts.find((x) => x.photos.some((p) => p.id === id)) ?? parts[0]!;
    for (const u of pending) {
      if (u.draft === d) {
        u.draft = partOf(u.photoIds[u.photoIds.length - 1]!);
        u.draft.reasons.add(u.reason);
      }
      if (u.other === d) u.other = partOf(u.photoIds[0]!);
    }
    drafts.splice(k, 1, ...parts);
  }
  for (const d of drafts) {
    const file = d.photos.filter((p) => p.dateSource !== "exif");
    // File dates say when a file was saved, not when the photo was taken.
    if (file.length > 0 && file.length >= d.photos.length / 2) {
      d.reasons.add("file_dates");
      pending.push({ kind: "membership", reason: "file_dates", draft: d, photoIds: file.map((p) => p.id) });
    }
  }

  // Undated photos: join the most similar dated moment (content, then place), else group together.
  const leftovers: MomentPhoto[] = [];
  for (const p of undated) {
    const tokens = contentTokens(p.vision);
    let best: { draft: Draft; score: number; reason: UncertainReason } | null = null;
    for (const d of drafts) {
      if (tokens.size > 0) {
        const s = jaccard(tokens, profile(d));
        if (s >= o.joinSimilarity && (!best || s > best.score)) best = { draft: d, score: s, reason: "joined_by_content" };
      }
    }
    if (!best && hasGps(p)) {
      for (const d of drafts) {
        const c = centroid(d);
        if (!c) continue;
        const km = haversineKm(c, p);
        const s = 1 - km / o.joinKm;
        if (km <= o.joinKm && (!best || s > best.score)) best = { draft: d, score: s, reason: "joined_by_place" };
      }
    }
    if (best) {
      addPhoto(best.draft, p);
      best.draft.reasons.add(best.reason);
      pending.push({ kind: "membership", reason: best.reason, draft: best.draft, photoIds: [p.id], score: Math.round(best.score * 1000) / 1000 });
    } else leftovers.push(p);
  }

  // Leftover undated photos: greedy groups by content similarity; undescribed ones share one group.
  const undatedDrafts: Draft[] = [];
  let blind: Draft | null = null;
  for (const p of leftovers) {
    const tokens = contentTokens(p.vision);
    if (tokens.size === 0) {
      blind ??= newDraft(true);
      addPhoto(blind, p);
      continue;
    }
    let best: { draft: Draft; score: number } | null = null;
    for (const d of undatedDrafts) {
      const s = jaccard(tokens, profile(d));
      if (s >= o.joinSimilarity && (!best || s > best.score)) best = { draft: d, score: s };
    }
    if (best) addPhoto(best.draft, p);
    else {
      const d = newDraft(true);
      addPhoto(d, p);
      undatedDrafts.push(d);
    }
  }
  for (const d of undatedDrafts) d.reasons.add("no_timestamp");
  if (blind) {
    blind.reasons.add(blind.photos.some((p) => hasGps(p) || p.place) ? "no_timestamp" : "no_evidence");
    undatedDrafts.push(blind);
  }

  const all = [...drafts, ...undatedDrafts];
  // visits: neighbouring dated moments close in time and place share what their photos show
  const visitSetting = new Map<Draft, { id: string; label: string; support: number; of: number }>();
  for (let i = 0; i < drafts.length; ) {
    let j = i + 1;
    while (j < drafts.length) {
      const prev = drafts[j - 1]!;
      const next = drafts[j]!;
      const gapH = (ms(next.photos[0]!.takenAt)! - ms(prev.photos[prev.photos.length - 1]!.takenAt)!) / 3_600_000;
      const a = centroid(prev);
      const b = centroid(next);
      if (gapH > o.visitHours || (a && b && haversineKm(a, b) > o.visitKm)) break;
      j++;
    }
    const visit = drafts.slice(i, j);
    const photosOfVisit = visit.flatMap((d) => d.photos);
    const described = photosOfVisit.filter((p) => p.vision).length;
    const setting = visit.length > 1 ? dominantSetting(photosOfVisit, 2) : null;
    if (setting) for (const d of visit) visitSetting.set(d, { ...setting, of: described });
    i = j;
  }
  const keyOf = new Map<Draft, string>();
  const moments: Moment[] = all.map((d, position) => {
    const ids = d.photos.map((p) => p.id);
    const firstId = d.undated ? [...ids].sort()[0]! : ids[0]!;
    const key = `m:${firstId}`;
    keyOf.set(d, key);
    const { label, dateLabel, place, evidence } = labelMoment(d.photos, visitSetting.get(d) ?? null);
    const times = d.photos.map((p) => ms(p.takenAt)).filter((t): t is number => t !== null);
    const reasons = [...d.reasons].sort();
    let confidence = d.undated ? 0.4 : 0.9;
    if (d.reasons.has("weak_boundary") || d.reasons.has("weak_join")) confidence -= 0.2;
    if (d.reasons.has("file_dates")) confidence -= 0.25;
    if (d.reasons.has("joined_by_content") || d.reasons.has("joined_by_place")) confidence -= 0.1;
    if (d.reasons.has("no_evidence")) confidence = 0.1;
    return {
      key,
      position,
      photoIds: ids,
      label,
      dateLabel,
      labelEvidence: evidence,
      startsAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      endsAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      place,
      heroPhotoId: null,
      confidence: Math.round(Math.max(0.05, Math.min(1, confidence)) * 100) / 100,
      uncertain: reasons.length > 0,
      uncertainReasons: reasons,
    };
  });

  const uncertain: UncertainGrouping[] = pending.map((u) => ({
    kind: u.kind,
    reason: u.reason,
    momentKey: keyOf.get(u.draft)!,
    ...(u.other ? { otherMomentKey: keyOf.get(u.other)! } : {}),
    photoIds: u.photoIds,
    ...(u.score !== undefined ? { score: u.score } : {}),
  }));
  for (const d of undatedDrafts) {
    const reason: UncertainReason = d.reasons.has("no_evidence") ? "no_evidence" : "no_timestamp";
    uncertain.push({ kind: "moment", reason, momentKey: keyOf.get(d)!, photoIds: d.photos.map((p) => p.id) });
  }
  return { moments, uncertain };
}

// ---------------------------------------------------------------------------- candidates

const ROLE_BONUS: Record<string, number> = { establishing: 8, portrait: 6, emotion: 6, action: 4, closing: 3, detail: 0 };

/** Ranking score of one photo (0–100): quality first, then what the picture can do in a story. */
export function candidateScore(p: MomentPhoto): number {
  const base = p.quality ?? 50;
  const role = p.vision?.storyRole ? (ROLE_BONUS[p.vision.storyRole] ?? 0) : 0;
  const people = (p.vision?.peopleCount ?? 0) > 0 ? 3 : 0;
  const cover = p.coverWorthy ? 5 : 0;
  return Math.round(Math.max(0, Math.min(100, base * 0.84 + role + people + cover)) * 10) / 10;
}

/**
 * Roles per moment: one hero (the best usable photo), up to `collagePerMoment` collage
 * candidates, the rest supporting. Photos that are not the preferred copy of a duplicate group,
 * are unusably blurry or were dropped become "alternate" — still listed, still selectable, never
 * removed. Sets `heroPhotoId` on the returned moments.
 */
export function rankCandidates(
  moments: readonly Moment[],
  photos: readonly MomentPhoto[],
  duplicates: readonly DuplicateGroup[] = [],
  options: MomentOptions = {},
): { moments: Moment[]; candidates: Candidate[] } {
  const o: MomentConfig = { ...MOMENT_DEFAULTS, ...options };
  const byId = new Map(photos.map((p) => [p.id, p]));
  const notPreferred = new Set<string>();
  for (const g of duplicates) for (const id of g.photoIds) if (id !== g.preferredPhotoId) notPreferred.add(id);

  const candidates: Candidate[] = [];
  const out = moments.map((m) => {
    const scored = m.photoIds
      .map((id) => byId.get(id))
      .filter((p): p is MomentPhoto => !!p)
      .map((p) => {
        const reason: Candidate["reason"] = !p.keep ? "dropped" : notPreferred.has(p.id) ? "duplicate" : p.qualityFlags.includes("blurry") ? "blurry" : undefined;
        return { p, score: candidateScore(p), reason };
      })
      .sort((a, b) => b.score - a.score || (a.p.id < b.p.id ? -1 : 1));
    const usable = scored.filter((s) => !s.reason);
    const hero = usable[0]?.p.id ?? null;
    let collage = 0;
    for (const s of scored) {
      let role: CandidateRole;
      if (s.reason) role = "alternate";
      else if (s.p.id === hero) role = "hero";
      else if (collage < o.collagePerMoment && !s.p.qualityFlags.includes("soft") && s.score >= 45) {
        role = "collage";
        collage++;
      } else role = "supporting";
      candidates.push({ photoId: s.p.id, momentKey: m.key, role, score: s.score, ...(s.reason ? { reason: s.reason } : {}) });
    }
    return { ...m, heroPhotoId: hero };
  });
  return { moments: out, candidates };
}
