// Rule-based curation + album: what the user gets when the AI is off, refuses, errors or returns
// something unusable (CLAUDE.md: "the user must always get an album"). Pure, deterministic, no I/O.
//
// ruleCurate() is deliberately CONSERVATIVE — it only drops what is almost certainly unwanted:
//  1. user_override photos are never changed: their current status / drop_reason is returned.
//  2. Screenshot: original_mime image/png AND no camera EXIF AND a phone-screen aspect ratio
//     (long side / short side ≥ SCREENSHOT_MIN_ASPECT, portrait or landscape) → 'screenshot'.
//  3. Extremely blurry: blur_score < EXTREME_BLUR_MAX → 'blurry'. A null score is unknown, never
//     dropped. NOTE: blur_score is the Laplacian variance of the 512 px thumb
//     (src/lib/image/blur.ts); scores are only comparable at that size. Sharp phone photos score
//     in the hundreds–thousands at 512 px; < 10 is a near-uniform, smeared frame.
//  4. Duplicate groups (dup_group): among the group's non-override members that rules 2–3 did not
//     drop, keep the best (rank: highest blur_score (null = 0) → larger pixel area → smaller id)
//     and drop the rest as 'duplicate'. If rules 2–3 dropped every member, the best non-screenshot
//     member is kept anyway (D-019: ≥ 1 kept per group).
//  5. Never 0 kept: if nothing is kept (override-kept photos count), the best non-override photo is
//     kept (non-screenshots first). Batch-level callers may disable this (ensureOneKept: false)
//     and apply ensureAtLeastOneKept() once over the whole book instead.

import { autolayout, type AutolayoutOptions, type AutoPhoto } from "@/lib/autolayout";
import type { BookDoc } from "@/lib/book/types";
import type { Occasion } from "@/lib/book/options";
import { DROP_REASONS } from "./schemas";

export type DropReason = (typeof DROP_REASONS)[number];

/**
 * One photo as the Curator / rule fallback sees it. T5's listPhotosForCuration must supply
 * every field (from the photos row; camelCase).
 */
export interface CurationPhoto {
  id: string;
  /** Storage path of the 512 px JPEG thumb; null → no AI for this photo (rule result). */
  thumbPath: string | null;
  width: number | null;
  height: number | null;
  /** photos.taken_at (ISO). */
  takenAt: string | null;
  dateSource: "exif" | "file" | null;
  place: string | null;
  /** photos.camera (EXIF make/model); null = no camera info. Never sent to the model. */
  camera: string | null;
  originalMime: string | null;
  /** Laplacian variance of the 512 px thumb. */
  blurScore: number | null;
  dupGroup: number | null;
  status: "kept" | "dropped";
  dropReason: DropReason | null;
  userOverride: boolean;
  /** photos.ai jsonb as stored (any shape; checked with needsCuration()). */
  ai: unknown;
}

export interface RuleDecision {
  keep: boolean;
  dropReason: DropReason | null;
  source: "rule";
}

/** Long side / short side at or above which a PNG without camera info looks like a phone screen. */
export const SCREENSHOT_MIN_ASPECT = 1.9;
/** Laplacian variance (512 px thumb) below which a photo is treated as unusably blurry. */
export const EXTREME_BLUR_MAX = 10;

export function aspectRatio(p: Pick<CurationPhoto, "width" | "height">): number | null {
  const { width: w, height: h } = p;
  if (!w || !h || w <= 0 || h <= 0) return null;
  return Math.max(w, h) / Math.min(w, h);
}

export function looksLikeScreenshot(p: CurationPhoto): boolean {
  const mime = (p.originalMime ?? "").trim().toLowerCase();
  const noCamera = (p.camera ?? "").trim() === "";
  const aspect = aspectRatio(p);
  return mime === "image/png" && noCamera && aspect !== null && aspect >= SCREENSHOT_MIN_ASPECT;
}

export function isExtremelyBlurry(p: Pick<CurationPhoto, "blurScore">): boolean {
  return typeof p.blurScore === "number" && Number.isFinite(p.blurScore) && p.blurScore < EXTREME_BLUR_MAX;
}

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rule rank (negative = a is better): sharper → larger → smaller id. Same as autolayout dedupe. */
export function compareRuleRank(a: CurationPhoto, b: CurationPhoto): number {
  const sa = Number.isFinite(a.blurScore) ? (a.blurScore as number) : 0;
  const sb = Number.isFinite(b.blurScore) ? (b.blurScore as number) : 0;
  if (sa !== sb) return sb - sa;
  const area = (p: CurationPhoto) => (p.width ?? 0) * (p.height ?? 0);
  if (area(a) !== area(b)) return area(b) - area(a);
  return cmpId(a.id, b.id);
}

export function isDropReason(v: unknown): v is DropReason {
  return typeof v === "string" && (DROP_REASONS as readonly string[]).includes(v);
}

/** The current status of a user_override photo, unchanged. */
export function currentDecision(p: CurationPhoto): RuleDecision {
  const keep = p.status !== "dropped";
  return { keep, dropReason: keep ? null : isDropReason(p.dropReason) ? p.dropReason : null, source: "rule" };
}

export interface RuleCurateOptions {
  /** Default true. Batch callers pass false and run ensureAtLeastOneKept() over the whole book. */
  ensureOneKept?: boolean;
}

export function ruleCurate(photos: CurationPhoto[], opts: RuleCurateOptions = {}): Map<string, RuleDecision> {
  const out = new Map<string, RuleDecision>();
  const unique: CurationPhoto[] = [];
  for (const p of photos) {
    if (out.has(p.id)) continue;
    unique.push(p);
    if (p.userOverride) {
      out.set(p.id, currentDecision(p));
      continue;
    }
    if (looksLikeScreenshot(p)) out.set(p.id, { keep: false, dropReason: "screenshot", source: "rule" });
    else if (isExtremelyBlurry(p)) out.set(p.id, { keep: false, dropReason: "blurry", source: "rule" });
    else out.set(p.id, { keep: true, dropReason: null, source: "rule" });
  }

  // Duplicate groups (non-override members only).
  const groups = new Map<number, CurationPhoto[]>();
  for (const p of unique) {
    if (p.userOverride || p.dupGroup === null || !Number.isFinite(p.dupGroup)) continue;
    const g = groups.get(p.dupGroup);
    if (g) g.push(p);
    else groups.set(p.dupGroup, [p]);
  }
  for (const members of groups.values()) {
    const ranked = [...members].sort(compareRuleRank);
    const alive = ranked.filter((p) => out.get(p.id)!.keep);
    let keeper: CurationPhoto | undefined = alive[0];
    if (!keeper) keeper = ranked.find((p) => !looksLikeScreenshot(p));
    for (const p of ranked) {
      if (p === keeper) out.set(p.id, { keep: true, dropReason: null, source: "rule" });
      else if (out.get(p.id)!.keep) out.set(p.id, { keep: false, dropReason: "duplicate", source: "rule" });
    }
  }

  if (opts.ensureOneKept !== false) return ensureAtLeastOneKept(unique, out);
  return out;
}

/**
 * Book-level guard: if no photo is kept, keep the best non-override photo (non-screenshots first).
 * Override photos are never touched (if every photo is a user-dropped override, 0 kept stays —
 * that is the user's choice). Returns a new map; `decisions` is not mutated.
 */
export function ensureAtLeastOneKept<D extends { keep: boolean; dropReason: DropReason | null }>(
  photos: CurationPhoto[],
  decisions: Map<string, D>,
): Map<string, D> {
  const out = new Map(decisions);
  const anyKept = photos.some((p) => out.get(p.id)?.keep);
  if (anyKept) return out;
  const candidates = photos.filter((p) => !p.userOverride && out.has(p.id));
  if (candidates.length === 0) return out;
  const best = [...candidates].sort((a, b) => {
    const sa = looksLikeScreenshot(a) ? 1 : 0;
    const sb = looksLikeScreenshot(b) ? 1 : 0;
    return sa !== sb ? sa - sb : compareRuleRank(a, b);
  })[0];
  out.set(best.id, { ...out.get(best.id)!, keep: true, dropReason: null });
  return out;
}

export interface RuleAlbumOptions {
  occasion: Occasion;
  title: AutolayoutOptions["title"];
  captionLang: AutolayoutOptions["captionLang"];
  isPaid: boolean;
  dupGroups?: Map<string, number>;
  /** books.format / books.design_style (bookDesignOf). Default classic A5 portrait. */
  design?: AutolayoutOptions["design"];
}

/** Rule-based album for an AI run (doc.meta.runId = runId, generator 'rule'). */
export function ruleAlbum(photos: AutoPhoto[], opts: RuleAlbumOptions, runId: string | null): BookDoc {
  return autolayout(photos, { ...opts, runId });
}
