// Autosave for the editor (M5 Task 8) — the pure part: a scheduler with injected timers and
// transport, so it is unit-testable in node without jsdom. `useAutosave`
// (src/components/editor) wires it to React, fetch and page lifecycle events.
//
// Contract with PUT /api/books/[id]/doc (D-036, T3):
//   200 { rev, savedAt } → ok (identical doc keeps rev)
//   409 conflict          → terminal, no retry ("Changed in another tab – Reload")
//   503 saving_unavailable→ terminal, autosave stops
//   422 <code> / 400      → this doc is rejected: no retry, friendly message; the NEXT edit tries again
//   401                   → terminal (signed out)
//   403 / 404             → terminal (can't save this book)
//   413 / 429 / 5xx / network → retry with backoff
// Rules: debounce DEBOUNCE_MS after the last change; ONE request in flight per book; changes made
// while a request is in flight are queued (only the latest doc is kept) and sent right after.

import type { BookDoc } from "@/lib/book/types";

export const DEBOUNCE_MS = 2000;
/** fetch keepalive bodies are capped at 64 KB per page by browsers — stay under it. */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 30_000;

export type SaveOutcome =
  | { kind: "ok"; rev: number; savedAt: string | null }
  | { kind: "conflict" }
  | { kind: "unavailable" }
  | { kind: "invalid"; code: string }
  | { kind: "signedOut" }
  | { kind: "failed" }
  | { kind: "retry"; reason: "network" | "server" | "too_large" | "rate" };

export type AutosaveStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; savedAt: string | null }
  | { kind: "retrying"; attempt: number }
  | { kind: "invalid"; code: string }
  | { kind: "conflict" }
  | { kind: "unavailable" }
  | { kind: "signedOut" }
  | { kind: "failed" };

export type TerminalStatusKind = "conflict" | "unavailable" | "signedOut" | "failed";

export function isTerminal(s: AutosaveStatus): s is Extract<AutosaveStatus, { kind: TerminalStatusKind }> {
  return s.kind === "conflict" || s.kind === "unavailable" || s.kind === "signedOut" || s.kind === "failed";
}

/** Map an HTTP response (or a network error: status null) of the save route to an outcome. */
export function classifySaveResponse(status: number | null, body: unknown): SaveOutcome {
  if (status === null) return { kind: "retry", reason: "network" };
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status >= 200 && status < 300) {
    const rev = b.rev;
    if (typeof rev === "number" && Number.isSafeInteger(rev) && rev >= 0) {
      return { kind: "ok", rev, savedAt: typeof b.savedAt === "string" ? b.savedAt : null };
    }
    return { kind: "retry", reason: "server" };
  }
  if (status === 409) return { kind: "conflict" };
  if (status === 503) return { kind: "unavailable" };
  if (status === 422 || status === 400) {
    return { kind: "invalid", code: typeof b.error === "string" ? b.error : "invalid_doc" };
  }
  if (status === 401) return { kind: "signedOut" };
  if (status === 403 || status === 404) return { kind: "failed" };
  if (status === 413) return { kind: "retry", reason: "too_large" };
  if (status === 429) return { kind: "retry", reason: "rate" };
  return { kind: "retry", reason: "server" };
}

/** Exponential backoff: 2 s, 4 s, 8 s, 16 s, then 30 s (attempt starts at 1). */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

/** Use fetch keepalive (survives page unload) only for bodies under the browser cap. */
export function canUseKeepalive(bodyBytes: number): boolean {
  return bodyBytes > 0 && bodyBytes < KEEPALIVE_MAX_BYTES;
}

/** Friendly copy for 422/400 codes of the save route. */
export function invalidSaveCopy(code: string): string {
  switch (code) {
    case "page_limit":
      return "This book has more pages than its limit, so it can't be saved. Remove a page to keep saving.";
    case "foreign_photo":
      return "A photo in this book is no longer available. Replace it to keep saving.";
    case "duplicate_photo":
      return "The same photo is used twice. Change one of them to keep saving.";
    case "invalid_font":
      return "A caption font isn't supported. Pick another font to keep saving.";
    default:
      return "This change couldn't be saved. Undo it or try another edit.";
  }
}

export interface AutosaveTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AutosaveOptions {
  /** books.doc_rev at load. */
  baseRev: number;
  /** The doc as loaded (= saved at baseRev); changing back to it saves nothing. */
  savedDoc: BookDoc;
  send(doc: BookDoc, baseRev: number, opts: { keepalive: boolean }): Promise<SaveOutcome>;
  onStatus?(status: AutosaveStatus): void;
  /** Called after a successful save with the new rev. */
  onSaved?(rev: number, doc: BookDoc): void;
  timers?: AutosaveTimers;
  debounceMs?: number;
  backoff?(attempt: number): number;
}

const defaultTimers: AutosaveTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class AutosaveScheduler {
  private baseRev: number;
  private savedDoc: BookDoc;
  /** Newest doc not yet saved (null = nothing to save). */
  private latest: BookDoc | null = null;
  private inflight: Promise<void> | null = null;
  private timer: unknown = null;
  private timerKind: "debounce" | "retry" | null = null;
  private attempt = 0;
  private status: AutosaveStatus = { kind: "idle" };
  private disposed = false;
  private readonly opts: AutosaveOptions;
  private readonly timers: AutosaveTimers;

  constructor(opts: AutosaveOptions) {
    this.opts = opts;
    this.baseRev = opts.baseRev;
    this.savedDoc = opts.savedDoc;
    this.timers = opts.timers ?? defaultTimers;
  }

  getStatus(): AutosaveStatus {
    return this.status;
  }

  getRev(): number {
    return this.baseRev;
  }

  /** Something is unsaved (queued, waiting, in flight or retrying). */
  hasUnsaved(): boolean {
    return this.latest !== null || this.inflight !== null;
  }

  isInFlight(): boolean {
    return this.inflight !== null;
  }

  /** The editor's doc changed. */
  change(doc: BookDoc): void {
    if (this.disposed || isTerminal(this.status)) return;
    if (doc === this.latest) return;
    if (doc === this.savedDoc && !this.inflight) {
      // Back to the saved doc (e.g. undo to the start): nothing to send.
      this.latest = null;
      this.clearTimer();
      this.attempt = 0;
      if (this.status.kind !== "idle" && this.status.kind !== "saved") this.setStatus({ kind: "saved", savedAt: null });
      return;
    }
    this.latest = doc;
    if (this.timerKind === "retry") return; // keep the backoff; the retry sends the newest doc
    this.clearTimer();
    this.timer = this.timers.set(() => this.fire(false), this.opts.debounceMs ?? DEBOUNCE_MS);
    this.timerKind = "debounce";
    if (!this.inflight) this.setStatus({ kind: "pending" });
  }

  /** Send now (pagehide / tab hidden / unmount / back online). Returns the in-flight save, if any. */
  flush(opts: { keepalive?: boolean } = {}): Promise<void> | null {
    if (this.disposed || isTerminal(this.status)) return this.inflight;
    if (this.latest === null || this.inflight) return this.inflight;
    this.clearTimer();
    this.fire(opts.keepalive === true);
    return this.inflight;
  }

  /** Stop timers; an in-flight request still completes but changes nothing afterwards. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.timerKind = null;
  }

  private setStatus(s: AutosaveStatus) {
    if (s.kind === this.status.kind && JSON.stringify(s) === JSON.stringify(this.status)) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private fire(keepalive: boolean) {
    this.timer = null;
    this.timerKind = null;
    if (this.disposed && !keepalive) return;
    if (this.inflight || this.latest === null || isTerminal(this.status)) return;
    const doc = this.latest;
    const rev = this.baseRev;
    this.setStatus({ kind: "saving" });
    let outcome: Promise<SaveOutcome>;
    try {
      outcome = this.opts.send(doc, rev, { keepalive });
    } catch {
      outcome = Promise.resolve({ kind: "retry", reason: "network" });
    }
    this.inflight = outcome
      .catch((): SaveOutcome => ({ kind: "retry", reason: "network" }))
      .then((o) => {
        this.inflight = null;
        this.handle(doc, o);
      });
  }

  private handle(sent: BookDoc, o: SaveOutcome) {
    if (o.kind === "ok") {
      this.baseRev = o.rev;
      this.savedDoc = sent;
      this.attempt = 0;
      this.opts.onSaved?.(o.rev, sent);
      if (this.disposed) return;
      if (this.latest === sent) {
        this.latest = null;
        this.setStatus({ kind: "saved", savedAt: o.savedAt });
      } else if (this.latest !== null && this.timer === null) {
        // Changed while in flight and the debounce already ran out: send the newest doc now.
        this.fire(false);
      } else {
        this.setStatus({ kind: "pending" });
      }
      return;
    }
    if (this.disposed) return;
    if (o.kind === "retry") {
      this.attempt += 1;
      this.clearTimer();
      this.timer = this.timers.set(() => this.fire(false), (this.opts.backoff ?? backoffMs)(this.attempt));
      this.timerKind = "retry";
      this.setStatus({ kind: "retrying", attempt: this.attempt });
      return;
    }
    if (o.kind === "invalid") {
      // This doc is rejected; don't retry it. A newer change (already queued, or the next one)
      // gets its own attempt.
      this.attempt = 0;
      if (this.latest === sent) this.latest = null;
      if (this.latest !== null) {
        if (this.timer === null) this.fire(false);
        return;
      }
      this.setStatus({ kind: "invalid", code: o.code });
      return;
    }
    // Terminal: conflict / unavailable / signedOut / failed. Stop everything.
    this.clearTimer();
    this.setStatus({ kind: o.kind });
  }
}
