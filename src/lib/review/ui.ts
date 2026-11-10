// Pure helpers for the keep/drop review screen (M3). Safe on client and server: no imports
// from src/lib/ai or src/lib/db (those are server-only); values are mirrored here as strings.

import { docOrigin, hasUserCaptions } from "@/lib/book/replaceable";
import { AI_BREAK_COPY } from "@/lib/runs/stage-copy";

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

export type ReviewBanner = "building" | "ai_off" | "partial" | "captions_missing" | "failed" | null;

/**
 * Which banner to show. An active run wins; then AI unavailable (only if the AI never picked
 * these); then a partial / failed AI result.
 *
 * A partial run is told apart by what the album actually is (`generator` = docOrigin(doc).generator):
 * - the AI album was used ('ai') and some captionable pages are empty → "captions_missing"
 *   (no "simple rules" claim — the album is the AI's);
 * - the AI album was used and every captionable page has a caption (e.g. only the final check
 *   failed) → no banner;
 * - otherwise (rule fallback, or unknown) → "partial" ("Some of this was done with simple rules").
 * Both optional inputs default to the pre-M4 behaviour ("partial").
 */
export function reviewBanner(input: {
  activeRun: boolean;
  aiAvailable: boolean;
  aiStatus: string | null | undefined;
  /** docOrigin(books.doc).generator: 'ai' | 'rule' | 'none'. */
  generator?: string | null;
  /** Captionable pages without a caption (captionsPreviewModel(...).missing). */
  missingCaptions?: number;
}): ReviewBanner {
  if (input.activeRun) return "building";
  const s = input.aiStatus;
  if (!input.aiAvailable && !aiPicked(s)) return "ai_off";
  if (s === "partial") {
    if (input.generator !== "ai") return "partial";
    return (input.missingCaptions ?? 0) > 0 ? "captions_missing" : null;
  }
  if (s === "failed") return "failed";
  return null;
}

export const BANNER_COPY: Record<Exclude<ReviewBanner, null>, string> = {
  building: "Your album is still being built…",
  ai_off: "AI isn't switched on yet — we picked these with simple rules.",
  partial: "Some of this was done with simple rules. Try AI again?",
  captions_missing: "Your album is ready. Some pages don't have captions yet — you can add them later.",
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
 * - 'rebuild'  → AI picked these (done): "Rebuild with AI" (trigger rebuild, counts toward the limit)
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
  rebuild: "Rebuild with AI",
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
  limitRate: "Your album was just rebuilt. Please wait a few seconds and try again.",
  /** D-059: global daily AI budget used up (same copy as the build screen). */
  aiBreak: AI_BREAK_COPY,
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
    if (b.limit === "rate") return { kind: "error", message: REBUILD_MESSAGES.limitRate };
    if (b.limit === "budget_exhausted") return { kind: "error", message: REBUILD_MESSAGES.aiBreak };
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

// ---------------------------------------------------------------------------------------------
// Album sync (D-028): keep / drop choices reach the album through "Update album".

/**
 * Photo ids the album uses (page slots + cover). Loose read of the raw books.doc jsonb: anything
 * that isn't the expected shape is skipped, so `{}` / garbage → empty set. Never throws.
 */
export function docPhotoIds(doc: unknown): string[] {
  const ids = new Set<string>();
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [];
  const d = doc as { pages?: unknown; cover?: unknown };
  if (Array.isArray(d.pages)) {
    for (const page of d.pages) {
      const slots = typeof page === "object" && page !== null ? (page as { slots?: unknown }).slots : null;
      if (!Array.isArray(slots)) continue;
      for (const s of slots) {
        const id = typeof s === "object" && s !== null ? (s as { photoId?: unknown }).photoId : null;
        if (typeof id === "string" && id.length > 0) ids.add(id);
      }
    }
  }
  const coverId =
    typeof d.cover === "object" && d.cover !== null ? (d.cover as { photoId?: unknown }).photoId : null;
  if (typeof coverId === "string" && coverId.length > 0) ids.add(coverId);
  return [...ids];
}

/**
 * Photos whose keep / drop choice isn't in the album yet:
 * - a dropped photo the album still shows (page or cover), or
 * - a photo the user chose to keep (user_override) that the album doesn't use.
 * AI-kept photos the album leaves out are fine (the AI / page cap picks a subset), so they never
 * count. Nothing is out of sync when there is no album yet (`{}`), when the album was edited by
 * the user (D-028: Update album never runs on it), or while a build is running.
 */
export function unsyncedPhotoIds(
  photos: readonly Pick<ReviewTilePhoto, "id" | "status" | "userOverride">[],
  albumIds: ReadonlySet<string>,
  opts: { hasAlbum: boolean; userEdited: boolean; building: boolean },
): string[] {
  if (!opts.hasAlbum || opts.userEdited || opts.building) return [];
  const out: string[] = [];
  for (const p of photos) {
    const inAlbum = albumIds.has(p.id);
    if (isKept(p) ? p.userOverride && !inAlbum : inAlbum) out.push(p.id);
  }
  return out;
}

/** Server-side flag for the review page: is any choice not in the album yet? */
export function docOutOfSync(
  doc: unknown,
  photos: readonly Pick<ReviewTilePhoto, "id" | "status" | "userOverride">[],
  opts: { userEdited: boolean; building: boolean },
): boolean {
  const ids = docPhotoIds(doc);
  return unsyncedPhotoIds(photos, new Set(ids), { hasAlbum: ids.length > 0, ...opts }).length > 0;
}

export function changedPhotosCopy(n: number): string {
  return n === 1 ? "You changed 1 photo." : `You changed ${n} photos.`;
}

/** Result of updateAlbumAction (src/app/books/[id]/review/actions.ts). */
export type UpdateAlbumResult =
  | { ok: true; changed: boolean; pages: number }
  | { ok: false; error: "signed_out" | "not_found" | "user_edited" | "busy" | "failed" };

export type UpdateAlbumOutcome =
  | { kind: "updated"; toast: string }
  | { kind: "error"; error: string; message: string; link: { href: string; label: string } | null };

export const UPDATE_ALBUM_MESSAGES = {
  updated: "Album updated",
  upToDate: "Already up to date",
  userEdited: "You've edited this album, so we won't change it.",
  busy: "Your album is still being built — try again in a moment.",
  signedOut: "Please sign in again.",
  notFound: "That book wasn't found.",
  generic: "We couldn't update your album. Please try again.",
} as const;

/** Maps an updateAlbumAction result (or a thrown call → null) to what the review screen shows. */
export function updateAlbumOutcome(bookId: string, result: UpdateAlbumResult | null | undefined): UpdateAlbumOutcome {
  if (result && result.ok === true) {
    return { kind: "updated", toast: result.changed ? UPDATE_ALBUM_MESSAGES.updated : UPDATE_ALBUM_MESSAGES.upToDate };
  }
  const error = result && result.ok === false ? result.error : "failed";
  switch (error) {
    case "user_edited":
      return { kind: "error", error, message: UPDATE_ALBUM_MESSAGES.userEdited, link: null };
    case "busy":
      return {
        kind: "error",
        error,
        message: UPDATE_ALBUM_MESSAGES.busy,
        link: { href: `/books/${bookId}/build`, label: "See progress" },
      };
    case "signed_out":
      return {
        kind: "error",
        error,
        message: UPDATE_ALBUM_MESSAGES.signedOut,
        link: { href: `/login?next=${encodeURIComponent(`/books/${bookId}/review`)}`, label: "Sign in" },
      };
    case "not_found":
      return { kind: "error", error, message: UPDATE_ALBUM_MESSAGES.notFound, link: null };
    default:
      return { kind: "error", error: "failed", message: UPDATE_ALBUM_MESSAGES.generic, link: null };
  }
}

export const CONTINUE_UNSYNCED_NOTE = "Your changes aren't in the album yet — tap Update album.";

/**
 * The album has user edits (editor save → meta.userEdited, or any caption with source "user").
 * Then the review screen offers only "Continue in the editor" — no Update album, no Rebuild
 * with AI (D-037 #2). Unparsable docs count as edited (docOrigin's safe side).
 */
export function albumEditedByUser(doc: unknown): boolean {
  return docOrigin(doc).userEdited || hasUserCaptions(doc);
}

export const EDITED_ALBUM_COPY = {
  title: "You've edited this album — continue in the editor",
  body: "Photo choices here no longer change the album. Add or swap photos in the editor.",
  button: "Continue in the editor",
} as const;

/** The editor route for a book (review Continue and the edited-album button). */
export function editorHref(bookId: string): string {
  return `/books/${bookId}/edit`;
}

/** Hint under the secondary "Rebuild with AI" button. */
export function rebuildHint(left: number | null): string {
  return left === null ? "Re-plans the whole story with AI." : `Re-plans the whole story with AI (${left} left)`;
}

// ---------------------------------------------------------------------------------------------
// Captions preview (M4 T12): read-only list of the album's captions on the review screen.

export type PreviewCaptionSource = "ai" | "user" | "auto";

/**
 * Minimal projection of books.doc for the captions preview — no photo ids, URLs or crop data.
 * `chapter` is the index into `chapters` (null = page without a chapter);
 * `captionable` = the page's layout has a caption area.
 */
export type CaptionsPreviewDoc = {
  chapters: { title: string; dateLabel: string }[];
  pages: { chapter: number | null; caption: { text: string; source: PreviewCaptionSource } | null; captionable: boolean }[];
};

const PREVIEW_SOURCES: readonly PreviewCaptionSource[] = ["ai", "user", "auto"];

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function plainText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Loose read of the raw books.doc jsonb into the preview projection. Never throws; malformed
 * pages / chapters are skipped or treated as "no caption". `hasCaptionArea(layoutId)` decides
 * whether a page could carry a caption (pass the layout catalogue lookup).
 */
export function captionsPreviewOf(
  doc: unknown,
  hasCaptionArea: (layoutId: string) => boolean,
): CaptionsPreviewDoc {
  const d = rec(doc);
  const chapters: CaptionsPreviewDoc["chapters"] = [];
  const chapterIndex = new Map<string, number>();
  if (d && Array.isArray(d.chapters)) {
    for (const raw of d.chapters) {
      const c = rec(raw);
      if (!c || typeof c.id !== "string" || chapterIndex.has(c.id)) continue;
      chapterIndex.set(c.id, chapters.length);
      chapters.push({ title: plainText(c.title), dateLabel: plainText(c.dateLabel) });
    }
  }
  const pages: CaptionsPreviewDoc["pages"] = [];
  if (d && Array.isArray(d.pages)) {
    for (const raw of d.pages) {
      const p = rec(raw);
      if (!p) continue;
      const chapter = typeof p.chapterId === "string" ? (chapterIndex.get(p.chapterId) ?? null) : null;
      const cap = rec(p.caption);
      const text = plainText(cap?.text);
      const source = PREVIEW_SOURCES.find((s) => s === cap?.source) ?? "ai";
      const captionable = typeof p.layout === "string" && hasCaptionArea(p.layout);
      pages.push({ chapter, caption: cap && text ? { text, source } : null, captionable });
    }
  }
  return { chapters, pages };
}

export type CaptionsPreviewGroup = {
  /** Chapter heading (AI-written) — null for pages without a chapter. */
  title: string | null;
  dateLabel: string | null;
  items: { text: string; source: PreviewCaptionSource }[];
};

export type CaptionsPreviewModel = {
  count: number;
  /** Pages whose layout has a caption area but no caption yet. */
  missing: number;
  groups: CaptionsPreviewGroup[];
};

/**
 * Groups captions by consecutive chapter, in page order. Returns null when there is nothing to
 * show (no captions and no captionable pages).
 */
export function captionsPreviewModel(preview: CaptionsPreviewDoc | null | undefined): CaptionsPreviewModel | null {
  if (!preview) return null;
  let count = 0;
  let missing = 0;
  let captionable = 0;
  const groups: CaptionsPreviewGroup[] = [];
  let current: { chapter: number | null; group: CaptionsPreviewGroup } | null = null;
  for (const page of preview.pages) {
    if (page.captionable) captionable += 1;
    if (!page.caption) {
      if (page.captionable) missing += 1;
      continue;
    }
    count += 1;
    if (!current || current.chapter !== page.chapter) {
      const ch = page.chapter !== null ? preview.chapters[page.chapter] : undefined;
      current = {
        chapter: page.chapter,
        group: { title: ch?.title || null, dateLabel: ch?.dateLabel || null, items: [] },
      };
      groups.push(current.group);
    }
    current.group.items.push(page.caption);
  }
  if (count === 0 && captionable === 0) return null;
  return { count, missing, groups };
}

export function captionSourceLabel(source: PreviewCaptionSource): string {
  if (source === "user") return "Your caption";
  if (source === "auto") return "Added automatically";
  return "Written by AI";
}

export function missingCaptionsCopy(n: number): string {
  return n === 1 ? "1 page has no caption yet" : `${n} pages have no caption yet`;
}

export const PARTIAL_CAPTIONS_NOTE = "Some pages may not have captions yet.";

/**
 * True when the text is mainly Arabic script: more Arabic-script letters than Latin letters
 * (digits, punctuation, emoji and spaces don't count). Used for lang="ar" per caption; dir="auto"
 * is always set regardless.
 */
export function isMainlyArabic(text: string): boolean {
  let arabic = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x0600 && c <= 0x06ff) ||
      (c >= 0x0750 && c <= 0x077f) ||
      (c >= 0x08a0 && c <= 0x08ff) ||
      (c >= 0xfb50 && c <= 0xfdff) ||
      (c >= 0xfe70 && c <= 0xfeff)
    ) {
      // Skip Arabic-Indic digits and Arabic punctuation (comma, semicolon, question mark).
      if ((c >= 0x0660 && c <= 0x0669) || (c >= 0x06f0 && c <= 0x06f9) || c === 0x060c || c === 0x061b || c === 0x061f) continue;
      arabic += 1;
    } else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7)) {
      latin += 1;
    }
  }
  return arabic > 0 && arabic > latin;
}

/** lang / font for one caption: lang="ar" only for Arabic-script text; Cairo for ar books or Arabic text. */
export function captionTextAttrs(text: string, captionLang: string): { lang: "ar" | undefined; arabicFont: boolean } {
  const ar = isMainlyArabic(text);
  return { lang: ar ? "ar" : undefined, arabicFont: ar || captionLang === "ar" };
}

/** Extra line under the partial banner when captionable pages are still empty. */
export function partialCaptionsNote(banner: ReviewBanner, missing: number): string | null {
  return banner === "partial" && missing > 0 ? PARTIAL_CAPTIONS_NOTE : null;
}
