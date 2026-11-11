// Targeted repair planner (D-030). Pure, deterministic, no I/O, no SDK.
//
// Input: the Critic's critique (or null when the Critic failed / refused), the caption pre-check
// result (checkBookCaptions: captionKey → issues) and the current book doc. Output: which captions
// the Caption Writer must rewrite (grouped by caption batch), an optional cover swap (decided in
// code, never by the model) and the issues that are only logged. The caller runs ONE repair round.
//
// Page references (the one mapping between the Critic and the Caption Writer):
//   Critique.issues[].pageIndex = index into doc.pages (0-based, book order, cover excluded).
//   captionKey = "m{n}:{k}" where n = 1-based position of the page's chapter in doc.chapters
//   (planToDoc maps moment m{n} → chapter c{n} in order) and k = 0-based index of the page among
//   the pages of that chapter (= MomentCaptions.pageCaptions[].pageIndex). Headings: "m{n}:heading".
//   pageCaptionKeys(doc)[pageIndex] gives the key; pageIndexOfKey(doc, key) the reverse.
//
// Rules: pre-check failures are always targets; Critic issues only when score < CRITIC_REPAIR_BELOW:
// caption_mismatch | caption_invented_fact | caption_not_original | too_repetitive → rewrite that
// page's caption;
// weak_cover → cover swap (best kept cover-worthy portrait/group photo, highest quality, not the
// current cover); everything else is logged only. Captions with source "user" are never targeted.
// Reasons and logged entries carry codes/indices only — never caption text or critique detail.

import type { BookDoc } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import type { CaptionIssue } from "./caption-check";
import { momentIdsOfChapters } from "./captions";
import { captionKey, MOMENT_ID_RE, type Critique } from "./schemas";
import { byStoryTime, type StoryPhoto } from "./story";

/** Critic issues trigger repair only below this score (AI-AGENTS.md: "issues & score < 7"). */
export const CRITIC_REPAIR_BELOW = 7;

export const CAPTION_REPAIR_TYPES = [
  "caption_mismatch",
  "caption_invented_fact",
  "caption_not_original",
  "too_repetitive",
] as const;
const COVER_SCENES = new Set(["portrait", "group"]);

/** Moment id ("m3") of each chapter id, by chapter order — the shared helper (first position wins). */
export const momentIdsByChapter = momentIdsOfChapters;

/** captionKey of every page (index = doc.pages index); null when the page has no / an unknown chapter. */
export function pageCaptionKeys(doc: Pick<BookDoc, "chapters" | "pages">): Array<string | null> {
  const momentOf = momentIdsByChapter(doc);
  const seen = new Map<string, number>();
  return doc.pages.map((p) => {
    const m = p.chapterId ? momentOf.get(p.chapterId) : undefined;
    if (!m) return null;
    const k = seen.get(m) ?? 0;
    seen.set(m, k + 1);
    return captionKey(m, k);
  });
}

/** doc.pages index of a page caption key ("m2:1"); null for headings / unknown keys. */
export function pageIndexOfKey(doc: Pick<BookDoc, "chapters" | "pages">, key: string): number | null {
  const i = pageCaptionKeys(doc).indexOf(key);
  return i >= 0 ? i : null;
}

/** "m3:0" → "m3", "m3:heading" → "m3"; null when malformed. */
export function momentIdOfKey(key: string): string | null {
  const m = key.split(":")[0] ?? "";
  return MOMENT_ID_RE.test(m) ? m : null;
}

/** True when the page's layout has a caption area (a spread: its left half only, never the right). */
export function isCaptionable(page: Pick<BookDoc["pages"][number], "layout" | "side">): boolean {
  const l = getLayout(page.layout);
  return Boolean(l && l.caption !== null && !(l.role === "spread" && page.side !== "left"));
}

export type CoverCandidate = Pick<StoryPhoto, "id" | "keep" | "takenAt"> & {
  analysis: Pick<NonNullable<StoryPhoto["analysis"]>, "scene" | "quality" | "coverWorthy"> | null;
};

/** Best replacement cover in code: kept, coverWorthy, portrait|group, highest quality, earliest; never the current cover. */
export function pickCoverSwap(photos: readonly CoverCandidate[], currentCoverId: string | null): string | null {
  const candidates = photos.filter(
    (p) => p.keep && p.id !== currentCoverId && p.analysis?.coverWorthy === true && COVER_SCENES.has(p.analysis.scene),
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.analysis?.quality ?? 0) - (a.analysis?.quality ?? 0) || byStoryTime(a, b));
  return candidates[0].id;
}

export interface RepairTarget {
  /** captionKey ("m2:1" or "m2:heading"). */
  key: string;
  /** Codes only, e.g. "pre-check: too_long, unknown_name; critic: caption_mismatch". */
  reason: string;
}

export interface RepairPlan {
  /** Caption batch index → captions to rewrite in that batch (doc order). */
  rewrite: Map<number, RepairTarget[]>;
  /** Photo id of the new cover, or null. */
  coverSwap: string | null;
  /** Not repaired, for agent_steps / admin trace: "type@pageIndex[:why]" (codes only). */
  loggedOnly: string[];
}

export interface PlanRepairOptions {
  /** All photos of the book with their analysis (for the cover swap). */
  photos: readonly CoverCandidate[];
  /** Caption batch index of a moment id (the Caption Writer's batching); null = not captioned. */
  batchIndexOf: (momentId: string) => number | null | undefined;
  /** The cover must stay (e.g. chosen by the user) → weak_cover is logged only. */
  keepCoverOverride?: boolean;
}

export function planRepair(
  critique: Critique | null,
  precheck: ReadonlyMap<string, readonly CaptionIssue[]>,
  doc: Pick<BookDoc, "chapters" | "pages" | "cover">,
  opts: PlanRepairOptions,
): RepairPlan {
  const keys = pageCaptionKeys(doc);
  const pageOfKey = new Map<string, number>();
  keys.forEach((k, i) => {
    if (k) pageOfKey.set(k, i);
  });
  const loggedOnly: string[] = [];
  // key → { batch, reasons }; insertion order = pre-check order then critic order.
  const targets = new Map<string, { batch: number; pre: string[]; critic: string[] }>();

  const isUserCaption = (pageIndex: number) => doc.pages[pageIndex]?.caption?.source === "user";

  const addTarget = (key: string, kind: "pre" | "critic", codes: string[], logAs: string): void => {
    const moment = momentIdOfKey(key);
    const batch = moment ? opts.batchIndexOf(moment) : null;
    if (batch === null || batch === undefined || !Number.isInteger(batch) || batch < 0) {
      loggedOnly.push(`${logAs}:no_batch`);
      return;
    }
    const t = targets.get(key) ?? { batch, pre: [], critic: [] };
    for (const c of codes) if (!t[kind].includes(c)) t[kind].push(c);
    targets.set(key, t);
  };

  // 1. Pre-check failures: always repaired (unless the caption is the user's).
  for (const [key, issues] of precheck) {
    const codes = issues.map((i) => i.code);
    if (!codes.length) continue;
    const pageIndex = pageOfKey.get(key);
    const isHeading = key.endsWith(":heading");
    if (!isHeading && pageIndex === undefined) {
      loggedOnly.push(`precheck@${key}:unknown_page`);
      continue;
    }
    if (pageIndex !== undefined && isUserCaption(pageIndex)) {
      loggedOnly.push(`precheck@${key}:user_caption`);
      continue;
    }
    addTarget(key, "pre", codes, `precheck@${key}`);
  }

  // 2. Critic issues: only when the score is below the threshold.
  let coverSwap: string | null = null;
  if (critique) {
    const repairs = critique.score < CRITIC_REPAIR_BELOW;
    for (const issue of critique.issues) {
      const at = `${issue.type}@${issue.pageIndex ?? "book"}`;
      if (!repairs) {
        loggedOnly.push(`${at}:score_ok`);
        continue;
      }
      if ((CAPTION_REPAIR_TYPES as readonly string[]).includes(issue.type)) {
        const pi = issue.pageIndex;
        const page = pi === null ? undefined : doc.pages[pi];
        const key = pi === null ? null : keys[pi];
        if (pi === null || !page || !key) {
          loggedOnly.push(`${at}:no_page`);
        } else if (page.caption?.source === "user") {
          loggedOnly.push(`${at}:user_caption`);
        } else if (!page.caption || !isCaptionable(page)) {
          loggedOnly.push(`${at}:no_caption`);
        } else {
          addTarget(key, "critic", [issue.type], at);
        }
        continue;
      }
      if (issue.type === "weak_cover") {
        if (opts.keepCoverOverride) loggedOnly.push(`${at}:cover_locked`);
        else if (coverSwap === null) {
          coverSwap = pickCoverSwap(opts.photos, doc.cover.photoId);
          if (coverSwap === null) loggedOnly.push(`${at}:no_candidate`);
        }
        continue;
      }
      loggedOnly.push(at);
    }
  }

  // 3. Group by batch, doc order inside a batch (headings first in their moment).
  const order = (key: string) => {
    const p = pageOfKey.get(key);
    if (p !== undefined) return p;
    // heading: just before the first page of its moment
    const m = momentIdOfKey(key);
    const first = keys.findIndex((k) => k !== null && momentIdOfKey(k) === m);
    return first >= 0 ? first - 0.5 : Number.MAX_SAFE_INTEGER;
  };
  const rewrite = new Map<number, RepairTarget[]>();
  const sorted = [...targets.entries()].sort((a, b) => a[1].batch - b[1].batch || order(a[0]) - order(b[0]));
  for (const [key, t] of sorted) {
    const parts = [
      ...(t.pre.length ? [`pre-check: ${t.pre.join(", ")}`] : []),
      ...(t.critic.length ? [`critic: ${t.critic.join(", ")}`] : []),
    ];
    const list = rewrite.get(t.batch) ?? [];
    list.push({ key, reason: parts.join("; ") });
    rewrite.set(t.batch, list);
  }
  return { rewrite, coverSwap, loggedOnly };
}

/** Total number of captions to rewrite. */
export function repairTargetCount(plan: Pick<RepairPlan, "rewrite">): number {
  let n = 0;
  for (const list of plan.rewrite.values()) n += list.length;
  return n;
}
