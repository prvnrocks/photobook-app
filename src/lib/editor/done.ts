// Editor "Done" (M5 Task 12). Pure + tested in node: wait for pending saves, then decide what the
// Done button does. The UI (EditorShell) calls finishEditingAction (T13) only when the latest edit
// is saved (or nothing was pending), so the Memory Keeper learns from what the user sees.

import { isTerminal, type AutosaveStatus } from "./autosave";

/** What drainSaves needs from AutosaveScheduler. */
export interface DrainableSaves {
  flush(): Promise<void> | null;
  hasUnsaved(): boolean;
  getStatus(): AutosaveStatus;
}

/** Upper bound on save rounds (a change made while a save is in flight needs a second one). */
export const MAX_DRAIN_ROUNDS = 4;

/**
 * Sends anything pending now (skipping the debounce and any retry backoff) and waits until nothing
 * is unsaved, a terminal state is reached, or one retry round failed again (offline). Returns the
 * final status. Never throws.
 */
export async function drainSaves(saves: DrainableSaves, maxRounds = MAX_DRAIN_ROUNDS): Promise<AutosaveStatus> {
  for (let i = 0; i < maxRounds; i++) {
    const before = saves.getStatus();
    if (isTerminal(before) || !saves.hasUnsaved()) return before;
    const inflight = saves.flush();
    if (!inflight) return saves.getStatus();
    try {
      await inflight;
    } catch {
      // the scheduler maps errors to statuses; just read the status below
    }
    if (saves.getStatus().kind === "retrying") return saves.getStatus();
  }
  return saves.getStatus();
}

/** Save state as the editor sees it ("readOnly" = saving was never available). */
export type DoneSaveState = AutosaveStatus | { kind: "readOnly" };

export type DoneStep =
  | { kind: "finish" }
  | { kind: "navigate"; to: string }
  | { kind: "error"; message: string };

export const DONE_MESSAGES = {
  unsaved: "We couldn't save your latest changes. Check your connection and tap Done again.",
  failed: "Something went wrong. Please tap Done again.",
} as const;

export function loginHref(bookId: string): string {
  return `/login?next=${encodeURIComponent(`/books/${bookId}/edit`)}`;
}

/**
 * After drainSaves: what Done does next.
 * - saved / nothing pending / last edit rejected as invalid (it can never be saved; the banner
 *   already says so) → finish (Memory Keeper + redirect);
 * - still unsaved (offline / retrying / pending) → stay, show an error;
 * - signed out → login, back to the editor;
 * - read-only (conflict / saving unavailable / failed / never available) → straight to the
 *   dashboard: nothing more can be saved, and the saved book may not be what's on screen.
 */
export function doneStepAfterSave(s: DoneSaveState, bookId: string): DoneStep {
  switch (s.kind) {
    case "idle":
    case "saved":
    case "invalid":
      return { kind: "finish" };
    case "pending":
    case "saving":
    case "retrying":
      return { kind: "error", message: DONE_MESSAGES.unsaved };
    case "signedOut":
      return { kind: "navigate", to: loginHref(bookId) };
    case "conflict":
    case "unavailable":
    case "failed":
    case "readOnly":
      return { kind: "navigate", to: "/dashboard" };
  }
}

/** Mirrors FinishEditingResult (src/app/books/[id]/edit/actions.ts) without importing server code. */
export type FinishResult =
  | { ok: true; redirectTo: string }
  | { ok: false; error: "signed_out" | "not_found" | "failed" };

/** Only same-origin app paths are followed (never `//host` or a URL). */
function safePath(p: unknown): string {
  return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\") ? p : "/dashboard";
}

/** After finishEditingAction (null = the call threw / network error). */
export function doneStepAfterFinish(r: FinishResult | null | undefined, bookId: string): Exclude<DoneStep, { kind: "finish" }> {
  if (!r) return { kind: "error", message: DONE_MESSAGES.failed };
  if (r.ok) return { kind: "navigate", to: safePath(r.redirectTo) };
  switch (r.error) {
    case "signed_out":
      return { kind: "navigate", to: loginHref(bookId) };
    case "not_found":
      return { kind: "navigate", to: "/dashboard" };
    default:
      return { kind: "error", message: DONE_MESSAGES.failed };
  }
}
