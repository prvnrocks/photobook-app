// Shared, pure types + helpers for the Storyteller step (agent, plan-to-doc, replay synth).
// No SDK, no server-only: safe to import from tests and pure modules.

import { parseTime } from "@/lib/autolayout";
import type { CaptionLang, Occasion, Tone } from "@/lib/book/options";
import { limitsFor } from "./limits";
import type { MOODS, SCENES } from "./schemas";

export type StoryOrientation = "portrait" | "landscape" | "square";

/** What the Curator (or code fallback) said about a photo. Text is user data — never log it. */
export interface StoryAnalysis {
  description: string;
  scene: (typeof SCENES)[number];
  mood: (typeof MOODS)[number];
  quality: number;
  coverWorthy: boolean;
}

/**
 * One photo of the book as the Storyteller step sees it. The orchestrator builds it from the
 * photos row + photos.ai (+ user overrides). `keep` is the FINAL decision (user override wins).
 */
export interface StoryPhoto {
  /** Real photo id (uuid). Never sent to the model — aliases are (D-023). */
  id: string;
  width: number;
  height: number;
  /** ISO timestamp; strings without a zone are Asia/Dubai wall-clock time (as in autolayout). */
  takenAt: string | null;
  /** Reverse-geocoded place, usually null (D-020). */
  place: string | null;
  keep: boolean;
  /** null when the photo was not analysed (e.g. a failed Curator batch). */
  analysis: StoryAnalysis | null;
}

export interface StoryBook {
  occasion: Occasion;
  tone: Tone;
  captionLang: CaptionLang;
  /** books.title — the user's title wins over the AI title. null/blank = none. */
  title: string | null;
  isPaid: boolean;
  /** books.max_pages (server-set). */
  maxPages: number;
}

const LANDSCAPE_RATIO = 1.1;
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Same thresholds as autolayout: w/h ≥ 1.1 landscape, ≤ 1/1.1 portrait, else square. */
export function orientationOf(width: number, height: number): StoryOrientation {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  const r = w > 0 && h > 0 ? w / h : 1;
  return r >= LANDSCAPE_RATIO ? "landscape" : r <= 1 / LANDSCAPE_RATIO ? "portrait" : "square";
}

/** Page cap for this book: the plan limit and books.max_pages, whichever is smaller (≥ 1). */
export function effectiveMaxPages(book: Pick<StoryBook, "isPaid" | "maxPages">): number {
  const plan = limitsFor(book.isPaid).maxPages;
  const own = Number.isInteger(book.maxPages) && book.maxPages > 0 ? book.maxPages : plan;
  return Math.max(1, Math.min(plan, own));
}

export function photoMs(p: Pick<StoryPhoto, "takenAt">): number | null {
  return parseTime(p.takenAt);
}

/** Asia/Dubai calendar day index (days since epoch), as autolayout. */
export function dubaiDay(ms: number): number {
  return Math.floor((ms + DUBAI_OFFSET_MS) / DAY_MS);
}

/** "2026-10-12 18:22" in Asia/Dubai, or "undated". */
export function formatLocal(ms: number | null): string {
  if (ms === null) return "undated";
  const d = new Date(ms + DUBAI_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Chronological, undated last, ties by id — the order photos are shown to the model. */
export function byStoryTime<T extends Pick<StoryPhoto, "takenAt" | "id">>(a: T, b: T): number {
  const ma = photoMs(a);
  const mb = photoMs(b);
  if (ma !== null && mb !== null && ma !== mb) return ma - mb;
  if (ma === null && mb !== null) return 1;
  if (ma !== null && mb === null) return -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Normalise a place for comparison (trim, collapse spaces, case-insensitive). */
export function placeKey(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return t ? t : null;
}
