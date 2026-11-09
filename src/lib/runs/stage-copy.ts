// Plain-words copy + progress percent for the build screen. Pure — safe in client components.
// Percent bands: queued 2 · curating 5–75 (by photos) · storytelling 82 · final check 92 · done 100.
import type { RunProgress, RunState } from "./client";

export type StageCopy = {
  /** Main line, e.g. "Looking at your photos… 12 / 40". */
  text: string;
  /** Optional second line (capped photos). */
  detail: string | null;
  /** 0..100 for the progress bar. */
  percent: number;
};

const CURATE_FROM = 5;
const CURATE_TO = 75;

export function stageCopy(state: RunState, progress: RunProgress | null): StageCopy {
  const phase = state;
  switch (phase) {
    case "queued":
      return { text: "Getting ready…", detail: null, percent: 2 };
    case "curating": {
      const total = progress?.photosTotal ?? 0;
      const done = Math.min(progress?.photosDone ?? 0, total);
      const capped = progress?.photosCapped ?? 0;
      const ratio = total > 0 ? done / total : 0;
      return {
        text: total > 0 ? `Looking at your photos… ${done} / ${total}` : "Looking at your photos…",
        detail: capped > 0 ? `…${capped} more checked quickly` : null,
        percent: Math.round(CURATE_FROM + (CURATE_TO - CURATE_FROM) * ratio),
      };
    }
    case "storytelling":
      return { text: "Finding your moments…", detail: null, percent: 82 };
    case "captioning":
    case "critiquing":
    case "repairing":
    case "validating":
      return { text: "Final check…", detail: null, percent: 92 };
    case "done":
      return { text: "Your album is ready", detail: null, percent: 100 };
    case "failed":
      return { text: "We couldn't finish the AI album", detail: null, percent: 100 };
  }
}

export type LimitKind = "daily_builds" | "rebuilds" | "analysed_photos" | "rate";

/** Copy for a 429 from POST /api/ai/runs. The rule album still exists in every case. */
export function limitCopy(limit: LimitKind, isPaid: boolean, dailyCap: number): string {
  switch (limit) {
    case "daily_builds":
      return isPaid
        ? `You've used today's ${dailyCap} AI builds — try again tomorrow.`
        : `You've used today's ${dailyCap} free AI builds — try again tomorrow.`;
    case "rebuilds":
      return "No AI rebuilds left for this book.";
    case "analysed_photos":
      return "This book has more photos than AI can look at on your plan.";
    case "rate":
      return "Your album was just built. Please wait a few seconds and try again.";
  }
}

const STAGE_RANK: Record<RunState, number> = {
  queued: 0,
  curating: 1,
  storytelling: 2,
  captioning: 3,
  critiquing: 4,
  repairing: 5,
  validating: 6,
  done: 7,
  failed: 7,
};

export type ProgressSnapshot = { state: RunState; progress: RunProgress | null };

/**
 * The newer of two snapshots (the advance response and a parallel GET poll can arrive out of
 * order). Later stage wins; within curating, more photos done wins; ties keep `current`.
 */
export function newerSnapshot(current: ProgressSnapshot, next: ProgressSnapshot): ProgressSnapshot {
  const a = STAGE_RANK[current.state];
  const b = STAGE_RANK[next.state];
  if (b !== a) return b > a ? next : current;
  const da = current.progress?.photosDone ?? 0;
  const db = next.progress?.photosDone ?? 0;
  if (db !== da) return db > da ? next : current;
  // Same stage + count: prefer the one that has totals filled in.
  if ((next.progress?.photosTotal ?? 0) > (current.progress?.photosTotal ?? 0)) return next;
  return current;
}
