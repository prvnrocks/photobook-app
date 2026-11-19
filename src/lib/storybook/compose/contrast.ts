// Contrasting photo sets (fix: lookalike photos paired on one page). Pure and deterministic.
//
// The storybook plan puts a moment's photos on its pages in capture order, so two near-identical
// shots (two close-ups of the same cup, two takes of one pose at one wall) easily land side by side.
// Before templates are chosen, the composer (compose.ts) re-deals the movable photos of a chapter
// between its pages so each page holds a contrasting set — different framing, subject, scene or
// moment — using the signals ComposePhoto carries (all optional: a photo without them never moves):
//
//   group      duplicate / similar-shot group id — two of one group on a page is a HARD conflict
//   phash      64-bit dHash (hex) — Hamming ≤ 6 near-identical, ≤ 12 same scene other take (dupes.ts)
//   takenAt    capture time — seconds apart = the same burst / pose
//   scene      the Curator's scene (portrait / group / landscape / food / detail …) → framing
//   people     people count — the same person count in a portrait reads as the same pose
//   color      dominant colour (#rrggbb)
//
// photoSimilarity(a, b) folds them into 0..1; ≥ LOOKALIKE reads as "the same picture twice".
// Cost of a page: a hard conflict 100, a lookalike pair 10, a similar pair (≥ SIMILAR) its
// similarity. Back-to-back pages: a lookalike across the fold +1.5, the same framing on two
// consecutive pages +0.5. A photo leaving its own moment (scene) costs MOVE_COST.
//
// Moves (in order, each strictly lowering the cost by ≥ MIN_GAIN, best first, ties in page /
// photo order): swaps of two movable photos between two pages of one chapter (page sizes, families
// and the page budget stay as planned). A hard conflict that no swap can fix moves the photo to
// another page of the chapter with room, else the photo is set aside (left out of the book, like the
// storybook filter's similar shots — never deleted, still in the photo library).
// Pinned photos never move: a chapter opening's or closing's photo, and photos a text is grounded in.

import { hammingHex } from "@/lib/photos/dupes";
import type { ComposePhoto } from "./types";

/** At or above: two photos read as the same picture (never wanted on one page). */
export const LOOKALIKE = 0.7;
/** At or above: similar enough that a contrasting partner is preferred. */
export const SIMILAR = 0.45;
/** A swap must lower the cost by at least this much. */
const MIN_GAIN = 0.2;
/** A photo moved away from its own moment (scene). */
const MOVE_COST = 0.6;
/** Most improving swaps per chapter (bounded work on big books). */
const MAX_SWAPS = 40;

export type Framing = "close" | "mid" | "wide";

/** Framing class of the Curator's scene (null = unknown / not a framing). */
export function framingOf(p: Pick<ComposePhoto, "scene">): Framing | null {
  switch (p.scene) {
    case "food":
    case "detail":
    case "document":
      return "close";
    case "portrait":
      return "mid";
    case "group":
    case "landscape":
      return "wide";
    default:
      return null;
  }
}

const toMs = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

function rgb(hex: string | null | undefined): [number, number, number] | null {
  const m = hex ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) : null;
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null;
}

function orient(p: Pick<ComposePhoto, "width" | "height">): "p" | "l" | "s" | null {
  const w = p.width ?? 0;
  const h = p.height ?? 0;
  if (!(w > 0 && h > 0)) return null;
  return w / h > 1.1 ? "l" : w / h < 1 / 1.1 ? "p" : "s";
}

export const sameGroup = (a: Pick<ComposePhoto, "group">, b: Pick<ComposePhoto, "group">) => !!a.group && a.group === b.group;

/** How alike two photos look, 0..1, from the signals both carry (0 when they share none). */
export function photoSimilarity(a: ComposePhoto, b: ComposePhoto): number {
  if (sameGroup(a, b)) return 1;
  let s = 0;
  let evidence = 0;
  if (a.phash && b.phash) {
    const h = hammingHex(a.phash, b.phash);
    if (Number.isFinite(h)) {
      evidence++;
      s += h <= 6 ? 0.6 : h <= 12 ? 0.4 : h <= 18 ? 0.2 : 0;
    }
  }
  const ta = toMs(a.takenAt);
  const tb = toMs(b.takenAt);
  if (ta !== null && tb !== null) {
    evidence++;
    const dt = Math.abs(ta - tb) / 1000;
    s += dt <= 30 ? 0.25 : dt <= 120 ? 0.15 : dt <= 600 ? 0.05 : 0;
  }
  if (a.scene && b.scene) {
    evidence++;
    s += a.scene === b.scene ? 0.2 : -0.15;
    const people = (a.scene === "portrait" || a.scene === "group") && a.scene === b.scene;
    if (people && typeof a.people === "number" && typeof b.people === "number") s += a.people === b.people ? 0.1 : -0.05;
  }
  const ca = rgb(a.color);
  const cb = rgb(b.color);
  if (ca && cb) {
    evidence++;
    if (Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) < 40) s += 0.1;
  }
  if (evidence === 0) return 0;
  if (orient(a) !== null && orient(a) === orient(b)) s += 0.05;
  return Math.round(Math.min(1, Math.max(0, s)) * 1000) / 1000;
}

/** What the re-dealer needs of a composer unit (compose.ts Unit). */
export type ContrastUnit = {
  id: string;
  chapterId: string | null;
  momentId: string | null;
  family: string;
  photos: ComposePhoto[];
  /** Photo ids that must stay on this unit. */
  pinned: ReadonlySet<string>;
  /** Most photos this unit may hold (moves only). */
  capacity: number;
};

export type ContrastResult = { swaps: number; moved: string[]; setAside: string[] };

/**
 * Re-deals movable photos between the units of each chapter (in place) so pages hold contrasting
 * sets. `units` is the composer's page order. Deterministic; a book without similarity signals is
 * returned untouched (every cost is 0).
 */
export function contrastPhotos(units: ContrastUnit[]): ContrastResult {
  const result: ContrastResult = { swaps: 0, moved: [], setAside: [] };
  const homeMoment = new Map<string, string | null>();
  for (const u of units) for (const p of u.photos) homeMoment.set(p.id, u.momentId);

  const memo = new Map<string, number>();
  const sim = (a: ComposePhoto, b: ComposePhoto) => {
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    let v = memo.get(k);
    if (v === undefined) {
      v = photoSimilarity(a, b);
      memo.set(k, v);
    }
    return v;
  };
  const pairCost = (a: ComposePhoto, b: ComposePhoto) => {
    if (sameGroup(a, b)) return 100;
    const s = sim(a, b);
    return s >= LOOKALIKE ? 10 : s >= SIMILAR ? s : 0;
  };
  const pageCost = (u: ContrastUnit) => {
    let c = 0;
    for (let i = 0; i < u.photos.length; i++) for (let j = i + 1; j < u.photos.length; j++) c += pairCost(u.photos[i]!, u.photos[j]!);
    for (const p of u.photos) if (homeMoment.get(p.id) !== u.momentId) c += MOVE_COST;
    return c;
  };
  const framingKey = (u: ContrastUnit) => {
    const f = u.photos.map(framingOf);
    return f.length > 0 && f.every((x) => x !== null) ? [...new Set(f)].sort().join("+") : null;
  };
  const seqCost = (a: ContrastUnit | undefined, b: ContrastUnit | undefined) => {
    if (!a || !b || a.photos.length === 0 || b.photos.length === 0) return 0;
    let c = 0;
    if (a.photos.some((x) => b.photos.some((y) => sameGroup(x, y) || sim(x, y) >= LOOKALIKE))) c += 1.5;
    const fa = framingKey(a);
    if (fa !== null && fa === framingKey(b)) c += 0.5;
    return c;
  };
  const hasConflict = (u: ContrastUnit) => u.photos.some((x, i) => u.photos.some((y, j) => j > i && sameGroup(x, y)));
  /** Cost of units at `idx` (deduped) + the seams around them. */
  const localCost = (idx: readonly number[]) => {
    const set = [...new Set(idx)];
    let c = 0;
    for (const i of set) c += pageCost(units[i]!);
    const seams = new Set<number>();
    for (const i of set) {
      seams.add(i - 1);
      seams.add(i);
    }
    for (const s of seams) c += seqCost(units[s], units[s + 1]);
    return c;
  };

  const chapters: (string | null)[] = [];
  for (const u of units) if (!chapters.includes(u.chapterId)) chapters.push(u.chapterId);
  for (const ch of chapters) {
    const members = units.map((u, i) => (u.chapterId === ch && u.photos.length > 0 ? i : -1)).filter((i) => i >= 0);
    if (members.length === 0) continue;
    const total = () => localCost(members);
    if (total() === 0) continue;

    // 1. swaps
    for (let n = 0; n < MAX_SWAPS; n++) {
      let best: { a: number; x: number; b: number; y: number; gain: number } | null = null;
      for (let ai = 0; ai < members.length; ai++) {
        for (let bi = ai + 1; bi < members.length; bi++) {
          const a = members[ai]!;
          const b = members[bi]!;
          const ua = units[a]!;
          const ub = units[b]!;
          const before = localCost([a, b]);
          if (before === 0) continue;
          for (let x = 0; x < ua.photos.length; x++) {
            if (ua.pinned.has(ua.photos[x]!.id)) continue;
            for (let y = 0; y < ub.photos.length; y++) {
              if (ub.pinned.has(ub.photos[y]!.id)) continue;
              const px = ua.photos[x]!;
              const py = ub.photos[y]!;
              ua.photos[x] = py;
              ub.photos[y] = px;
              const gain = before - localCost([a, b]);
              ua.photos[x] = px;
              ub.photos[y] = py;
              if (gain >= MIN_GAIN - 1e-9 && (!best || gain > best.gain + 1e-9)) best = { a, x, b, y, gain };
            }
          }
        }
      }
      if (!best) break;
      const ua = units[best.a]!;
      const ub = units[best.b]!;
      [ua.photos[best.x], ub.photos[best.y]] = [ub.photos[best.y]!, ua.photos[best.x]!];
      result.swaps++;
    }

    // 2. hard conflicts no swap could fix: move the photo to a page with room, else set it aside
    for (const a of members) {
      const ua = units[a]!;
      while (hasConflict(ua)) {
        // the later, movable member of the first conflicting pair
        let at = -1;
        for (let i = 0; i < ua.photos.length && at < 0; i++) {
          for (let j = ua.photos.length - 1; j > i; j--) {
            if (sameGroup(ua.photos[i]!, ua.photos[j]!) && !ua.pinned.has(ua.photos[j]!.id)) {
              at = j;
              break;
            }
            if (sameGroup(ua.photos[i]!, ua.photos[j]!) && !ua.pinned.has(ua.photos[i]!.id)) {
              at = i;
              break;
            }
          }
        }
        if (at < 0) break; // both pinned: nothing the composer may do
        const photo = ua.photos[at]!;
        let target: { b: number; gain: number } | null = null;
        const before0 = localCost([a]);
        ua.photos.splice(at, 1);
        for (const b of members) {
          const ub = units[b]!;
          if (b === a || ub.photos.length >= ub.capacity || ub.photos.some((y) => sameGroup(y, photo))) continue;
          const before = before0 + localCost([b]);
          ub.photos.push(photo);
          const gain = before - localCost([a, b]);
          ub.photos.pop();
          if (!target || gain > target.gain + 1e-9) target = { b, gain };
        }
        if (target) {
          units[target.b]!.photos.push(photo);
          result.moved.push(photo.id);
        } else result.setAside.push(photo.id);
      }
    }
  }
  return result;
}

/**
 * The similarity signals of a photos row (+ its duplicate / similar group), for ComposePhoto —
 * what the server loader (src/lib/ai/story/compose.ts composePhotosOf) spreads into each photo.
 * A file-dated capture time is left out (WhatsApp forwards carry the forward time).
 */
export function composeSignalsOf(
  row: { phash?: string | null; taken_at?: string | null; date_source?: string | null; color?: string | null; ai?: unknown },
  group?: string | number | null,
): Pick<ComposePhoto, "phash" | "takenAt" | "scene" | "people" | "color" | "group"> {
  const ai = row.ai && typeof row.ai === "object" && !Array.isArray(row.ai) ? (row.ai as Record<string, unknown>) : null;
  const scene = typeof ai?.scene === "string" ? (ai.scene as ComposePhoto["scene"]) : null;
  const people = typeof ai?.peopleCount === "number" && Number.isFinite(ai.peopleCount) ? ai.peopleCount : null;
  return {
    phash: typeof row.phash === "string" && /^[0-9a-f]+$/i.test(row.phash) ? row.phash.toLowerCase() : null,
    takenAt: row.taken_at && row.date_source !== "file" ? row.taken_at : null,
    scene,
    people,
    color: typeof row.color === "string" && /^#[0-9a-f]{6}$/i.test(row.color) ? row.color.toLowerCase() : null,
    group: group === null || group === undefined ? null : String(group),
  };
}
