// Photos-first hand-off (M13 T5, D-070): the files picked on /books/start (or the dashboard's
// "New book") wait here, in memory, while startBookAction creates the draft and the app navigates
// client-side to /books/<id>/upload. The Uploader takes them on mount and starts uploading, so the
// user never sees a second picker. A full reload clears this module → the normal picker shows.
//
// Browser only: the module state must never exist on the server (it would be shared across
// requests), so every call is a no-op without `window`. Only File objects and a shape hint are
// kept — nothing is logged or sent anywhere.

import type { BookFormat } from "@/lib/book/types";

export type PendingFiles = {
  files: File[];
  /** Page shape suggested from the picked files at start (shown as a hint on the setup card). */
  suggestedFormat?: BookFormat;
};

/** Older hand-offs are dropped (the user went elsewhere and came back much later). */
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

type Entry = PendingFiles & { at: number };

const store = new Map<string, Entry>();

const inBrowser = () => typeof window !== "undefined";

/** Keeps `files` for the upload screen of `bookId` (replaces an earlier hand-off for it). */
export function stashPendingFiles(bookId: string, pending: PendingFiles, now: number = Date.now()): void {
  if (!inBrowser() || pending.files.length === 0) return;
  // One hand-off at a time: a stale one for another book would only hold memory.
  store.clear();
  store.set(bookId, { ...pending, files: [...pending.files], at: now });
}

/** Returns and forgets the files waiting for `bookId`; null when there are none (or too old). */
export function takePendingFiles(bookId: string, now: number = Date.now()): PendingFiles | null {
  if (!inBrowser()) return null;
  const entry = store.get(bookId);
  store.delete(bookId);
  if (!entry || now - entry.at > PENDING_MAX_AGE_MS || entry.files.length === 0) return null;
  return entry.suggestedFormat ? { files: entry.files, suggestedFormat: entry.suggestedFormat } : { files: entry.files };
}

/** True while files wait for `bookId` (without taking them). */
export function hasPendingFiles(bookId: string, now: number = Date.now()): boolean {
  if (!inBrowser()) return false;
  const entry = store.get(bookId);
  return entry !== undefined && now - entry.at <= PENDING_MAX_AGE_MS && entry.files.length > 0;
}
