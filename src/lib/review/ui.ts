// Pure helpers for the keep/drop review screen (M3). Safe on client and server: no imports
// from src/lib/ai or src/lib/db (those are server-only); values are mirrored here as strings.

/** Photo row as the review UI needs it (subset of db ReviewPhoto, never AI descriptions). */
export type ReviewTilePhoto = {
  id: string;
  status: string;
  dropReason: string | null;
  userOverride: boolean;
  dupGroup: number | null;
  width: number | null;
  height: number | null;
  thumbUrl: string | null;
};

export type ReviewTab = "kept" | "dropped";

/** Mirrors USER_DROP_REASON in src/lib/db/photos.ts. */
export const USER_REMOVED_REASON = "user_removed";

const REASON_LABELS: Record<string, string> = {
  screenshot: "Screenshot",
  blurry: "Blurry",
  duplicate: "Duplicate",
  document: "Document",
  poor_quality: "Poor quality",
  irrelevant: "Not relevant",
  [USER_REMOVED_REASON]: "Removed by you",
};

/** Chip text for a dropped photo. Unknown / missing reasons get a neutral label. */
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason || !Object.prototype.hasOwnProperty.call(REASON_LABELS, reason)) return "Not picked";
  return REASON_LABELS[reason];
}

export function isKept(p: Pick<ReviewTilePhoto, "status">): boolean {
  return p.status !== "dropped";
}

export function tabOf(p: Pick<ReviewTilePhoto, "status">): ReviewTab {
  return isKept(p) ? "kept" : "dropped";
}

export function countKept(photos: readonly Pick<ReviewTilePhoto, "status">[]): number {
  let n = 0;
  for (const p of photos) if (isKept(p)) n += 1;
  return n;
}

/**
 * Photos shown in a tab. `pinned` = ids the user toggled since opening this tab: they stay in
 * place (showing their new state) until the tab changes, so a tile never jumps away under a tap.
 */
export function visiblePhotos<T extends Pick<ReviewTilePhoto, "id" | "status">>(
  photos: readonly T[],
  tab: ReviewTab,
  pinned: ReadonlySet<string>,
): T[] {
  return photos.filter((p) => tabOf(p) === tab || pinned.has(p.id));
}

/** The user's choice applied to one photo (what setUserOverride writes). */
export function applyUserChoice<T extends ReviewTilePhoto>(p: T, keep: boolean): T {
  return {
    ...p,
    status: keep ? "kept" : "dropped",
    dropReason: keep ? null : USER_REMOVED_REASON,
    userOverride: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Header + banners

/** books.ai_status values (server-only column, read on the server and passed down). */
export type BookAiStatusValue =
  | "idle"
  | "analyzing"
  | "planning"
  | "captioning"
  | "done"
  | "partial"
  | "failed";

/** Did the AI pick (some of) these photos? done / partial → yes; idle / failed → rules only. */
export function aiPicked(aiStatus: string | null | undefined): boolean {
  return aiStatus === "done" || aiStatus === "partial";
}

export function headerCopy(input: { aiUsed: boolean; kept: number; total: number }): string {
  const { aiUsed, kept, total } = input;
  return aiUsed ? `AI kept ${kept} of ${total}` : `Kept ${kept} of ${total}`;
}

export type ReviewBanner = "building" | "ai_off" | "partial" | "failed" | null;

/**
 * Which banner to show. An active run wins; then AI unavailable (only if the AI never picked
 * these); then a partial / failed AI result.
 */
export function reviewBanner(input: {
  activeRun: boolean;
  aiAvailable: boolean;
  aiStatus: string | null | undefined;
}): ReviewBanner {
  if (input.activeRun) return "building";
  const s = input.aiStatus;
  if (!input.aiAvailable && !aiPicked(s)) return "ai_off";
  if (s === "partial") return "partial";
  if (s === "failed") return "failed";
  return null;
}

export const BANNER_COPY: Record<Exclude<ReviewBanner, null>, string> = {
  building: "Your album is still being built…",
  ai_off: "AI isn't switched on yet — we picked these with simple rules.",
  partial: "Some of this was done with simple rules. Try AI again?",
  failed: "AI couldn't finish this time — we picked these with simple rules. Try AI again?",
};

// ---------------------------------------------------------------------------------------------
// Rebuild

/** Rebuilds left for the book (never negative). */
export function rebuildsLeft(maxRebuilds: number, used: number): number {
  const left = Math.floor(maxRebuilds) - Math.floor(used);
  return Number.isFinite(left) && left > 0 ? left : 0;
}

export function rebuildsLeftLabel(n: number): string {
  if (n <= 0) return "No rebuilds left";
  return n === 1 ? "1 rebuild left" : `${n} rebuilds left`;
}

/**
 * What the rebuild button does:
 * - 'rebuild'  → AI picked these (done): "Rebuild album" (trigger rebuild, counts toward the limit)
 * - 'retry_ai' → AI partial/failed: "Try AI again" (trigger rebuild)
 * - 'first_ai' → AI available but never used on this book: "Build with AI" (trigger build)
 * - 'ai_off'   → AI unavailable: "Rebuild album" re-runs the simple rules; "Try AI again" disabled
 */
export type RebuildVariant = "rebuild" | "retry_ai" | "first_ai" | "ai_off";

export function rebuildVariant(input: { aiAvailable: boolean; aiStatus: string | null | undefined }): RebuildVariant {
  if (!input.aiAvailable) return "ai_off";
  if (input.aiStatus === "done") return "rebuild";
  if (input.aiStatus === "partial" || input.aiStatus === "failed") return "retry_ai";
  return "first_ai";
}

export const REBUILD_LABELS: Record<RebuildVariant, string> = {
  rebuild: "Rebuild album",
  retry_ai: "Try AI again",
  first_ai: "Build with AI",
  ai_off: "Rebuild album",
};

export function rebuildTrigger(variant: RebuildVariant): "build" | "rebuild" {
  return variant === "first_ai" ? "build" : "rebuild";
}

/** Outcome of POST /api/ai/runs as the review screen handles it. */
export type RebuildOutcome =
  | { kind: "go_build"; runId: string | null }
  | { kind: "refreshed" }
  | { kind: "error"; message: string };

export const REBUILD_MESSAGES = {
  ruleFailed: "We couldn't rebuild the album. Please try again.",
  userEdited: "You've edited this album, so we won't rebuild it over your changes.",
  limitRebuilds: "You've used all the rebuilds for this book.",
  limitDaily: "You've reached today's AI limit. Please try again tomorrow.",
  limitPhotos: "This book has more photos than AI can check on this plan.",
  signedOut: "Please sign in again.",
  notFound: "That book wasn't found.",
  generic: "Something went wrong. Please try again.",
  offline: "You seem to be offline. Check your connection and try again.",
} as const;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Maps a POST /api/ai/runs response (T11 shapes) to what the UI does next. */
export function rebuildOutcome(status: number, body: unknown): RebuildOutcome {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (status === 201) {
    if (b.mode === "rule") {
      return b.state === "failed" ? { kind: "error", message: REBUILD_MESSAGES.ruleFailed } : { kind: "refreshed" };
    }
    return { kind: "go_build", runId: str(b.runId) };
  }
  if (status === 409) {
    if (b.error === "already_running") return { kind: "go_build", runId: str(b.runId) };
    if (b.error === "user_edited") return { kind: "error", message: REBUILD_MESSAGES.userEdited };
    return { kind: "error", message: REBUILD_MESSAGES.generic };
  }
  if (status === 429) {
    if (b.limit === "rebuilds") return { kind: "error", message: REBUILD_MESSAGES.limitRebuilds };
    if (b.limit === "analysed_photos") return { kind: "error", message: REBUILD_MESSAGES.limitPhotos };
    return { kind: "error", message: REBUILD_MESSAGES.limitDaily };
  }
  if (status === 401) return { kind: "error", message: REBUILD_MESSAGES.signedOut };
  if (status === 404) return { kind: "error", message: REBUILD_MESSAGES.notFound };
  return { kind: "error", message: REBUILD_MESSAGES.generic };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** POST /api/ai/runs and map the answer. Never throws. */
export async function requestRebuild(
  bookId: string,
  trigger: "build" | "rebuild",
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
): Promise<RebuildOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/ai/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookId, trigger }),
      cache: "no-store",
    });
  } catch {
    return { kind: "error", message: REBUILD_MESSAGES.offline };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return rebuildOutcome(res.status, body);
}

/** Thumb box size for <img width/height> (thumbs are ≤512 px on the long side). */
export function thumbSize(p: Pick<ReviewTilePhoto, "width" | "height">): { width: number; height: number } {
  const w = p.width && p.width > 0 ? p.width : 512;
  const h = p.height && p.height > 0 ? p.height : 512;
  const scale = 512 / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
