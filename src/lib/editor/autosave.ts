// Autosave for the editor (M5 Task 8) — the pure part: a scheduler with injected timers and
// transport, so it is unit-testable in node without jsdom. `useAutosave`
// (src/components/editor) wires it to React, fetch and page lifecycle events.
//
// Contract with PUT /api/books/[id]/doc (D-036, T3):
//   200 { rev, savedAt } → ok (identical doc keeps rev)
//   409 conflict          → terminal, no retry ("Changed in another tab – Reload")
//   503 saving_unavailable→ terminal, autosave stops (migration 0900 missing: saving can't work)
//   503 unavailable       → retry (M12: Supabase timeout; the save is idempotent, T3) — the next
//                           try waits at least Retry-After (default 3 s) on top of the backoff
//   503 anything else     → terminal (unknown 503: don't hammer)
//   422 <code> / 400      → this doc is rejected: no retry, friendly message; the NEXT edit tries again
//   413 too_large         → same as 422 (code `too_large`): resending the same doc can't succeed
//   401                   → terminal (signed out)
//   403 / 404             → terminal (can't save this book)
//   429 / 5xx / network   → retry with backoff
// Rules: debounce DEBOUNCE_MS after the last change; ONE request in flight per book; changes made
// while a request is in flight are queued (only the latest doc is kept) and sent right after.
// Leaving the page (flush with keepalive) while a request is in flight and a newer doc is queued
// sends the newer doc at once as a keepalive "rescue" (see flush()).

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
  | {
      kind: "retry";
      reason: "network" | "server" | "rate";
      /** Server Retry-After in ms: the next try waits at least this long (M12). */
      minWaitMs?: number;
    };

export type RetryReason = Extract<SaveOutcome, { kind: "retry" }>["reason"];

export type AutosaveStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; savedAt: string | null }
  | { kind: "retrying"; attempt: number; reason?: RetryReason }
  | { kind: "invalid"; code: string }
  | { kind: "conflict" }
  | { kind: "unavailable" }
  | { kind: "signedOut" }
  | { kind: "failed" };

export type TerminalStatusKind = "conflict" | "unavailable" | "signedOut" | "failed";

export function isTerminal(s: AutosaveStatus): s is Extract<AutosaveStatus, { kind: TerminalStatusKind }> {
  return s.kind === "conflict" || s.kind === "unavailable" || s.kind === "signedOut" || s.kind === "failed";
}

/** Retry-After for a 503 "unavailable" save without a usable header (= the route's default). */
export const UNAVAILABLE_RETRY_AFTER_MS = 3000;
/** Never wait longer than this for a Retry-After, whatever the header says. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Retry-After header (delta seconds) → ms, or null when missing / unparsable. HTTP dates aren't used by our routes. */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  const raw = header?.trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(Number(raw) * 1000));
}

/**
 * Map an HTTP response (or a network error: status null) of the save route to an outcome.
 * `retryAfterMs` = the parsed Retry-After header (parseRetryAfterMs), if any.
 */
export function classifySaveResponse(status: number | null, body: unknown, retryAfterMs: number | null = null): SaveOutcome {
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
  if (status === 503) {
    // M12: a Supabase timeout is temporary and the save is safe to replay → retry after Retry-After.
    if (b.error === "unavailable") {
      return { kind: "retry", reason: "server", minWaitMs: retryAfterMs ?? UNAVAILABLE_RETRY_AFTER_MS };
    }
    return { kind: "unavailable" }; // saving_unavailable (migration missing) or an unknown 503
  }
  if (status === 413) return { kind: "invalid", code: "too_large" };
  if (status === 422 || status === 400) {
    return { kind: "invalid", code: typeof b.error === "string" ? b.error : "invalid_doc" };
  }
  if (status === 401) return { kind: "signedOut" };
  if (status === 403 || status === 404) return { kind: "failed" };
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
    case "unsupported_design":
      return "This book's design style isn't available yet, so it can't be saved.";
    case "too_large":
      return "This album is too big to save — try removing a page.";
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
  /** The doc of the request in flight. */
  private inflightDoc: BookDoc | null = null;
  /** A keepalive "rescue" of a newer doc sent while `inflight` was still pending (see flush). */
  private rescue: { doc: BookDoc; outcome: Promise<SaveOutcome> } | null = null;
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

  /**
   * Send now (pagehide / tab hidden / unmount / back online / Done). Returns the in-flight save,
   * if any.
   *
   * While a request is in flight, a newer queued doc can't simply wait for it if the page is
   * going away: so
   * - the debounce is cancelled, so the newer doc goes out the moment the in-flight request
   *   settles (covers "tab hidden, page stays alive");
   * - with `keepalive` (the page may be unloading) the newer doc is ALSO sent at once as a
   *   keepalive "rescue" against the same baseRev, so it survives an unload that kills the
   *   chain. The server's rev check keeps this safe: of the two requests at most one wins; the
   *   other gets 409, and the outcomes are reconciled together (an own-race 409 is never shown
   *   as "changed in another tab").
   * Residual risk (accepted): if the in-flight request lands first and the page is gone before
   * the chained resend, the rescue's 409 means the newest edits (those of the last ~2 s) are lost.
   * The book stays consistent — it holds the older doc. Two keepalive bodies may also exceed the
   * browser's shared 64 KB keepalive quota; that send then fails like a network error.
   */
  flush(opts: { keepalive?: boolean } = {}): Promise<void> | null {
    if (this.disposed || isTerminal(this.status) || this.latest === null) return this.inflight;
    if (this.inflight) {
      if (this.timerKind === "debounce") this.clearTimer();
      if (opts.keepalive && !this.rescue && this.latest !== this.inflightDoc) this.sendRescue(this.latest);
      return this.inflight;
    }
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
    const outcome = this.safeSend(doc, rev, keepalive);
    this.inflightDoc = doc;
    this.inflight = outcome.then(async (o) => {
      // A rescue sent during this request: wait for it too, then settle both together.
      const rescue = this.rescue;
      const r = rescue ? await rescue.outcome : null;
      this.rescue = null;
      this.inflight = null;
      this.inflightDoc = null;
      if (rescue && r) {
        const settled = reconcileRescue(doc, o, rescue.doc, r);
        this.handle(settled.doc, settled.outcome);
      } else {
        this.handle(doc, o);
      }
    });
  }

  private safeSend(doc: BookDoc, rev: number, keepalive: boolean): Promise<SaveOutcome> {
    let outcome: Promise<SaveOutcome>;
    try {
      outcome = this.opts.send(doc, rev, { keepalive });
    } catch {
      outcome = Promise.resolve({ kind: "retry", reason: "network" });
    }
    return outcome.catch((): SaveOutcome => ({ kind: "retry", reason: "network" }));
  }

  private sendRescue(doc: BookDoc) {
    this.rescue = { doc, outcome: this.safeSend(doc, this.baseRev, true) };
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
      const wait = Math.max((this.opts.backoff ?? backoffMs)(this.attempt), o.minWaitMs ?? 0);
      this.timer = this.timers.set(() => this.fire(false), wait);
      this.timerKind = "retry";
      this.setStatus({ kind: "retrying", attempt: this.attempt, reason: o.reason });
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

/**
 * Settle an in-flight save (`first`) together with the keepalive rescue of a newer doc sent
 * against the same baseRev (see AutosaveScheduler.flush). Both carried the same baseRev, so
 * normally at most one changed the book:
 * - rescue ok → the newer doc is saved (if both were ok, one of them was a no-op re-save; the
 *   higher rev is the book's current one);
 * - otherwise → the in-flight result as usual (a rescue 409 just means the in-flight request
 *   won the race; its ok-handler then sends the still-queued newer doc).
 */
export function reconcileRescue(
  firstDoc: BookDoc,
  first: SaveOutcome,
  rescueDoc: BookDoc,
  rescue: SaveOutcome,
): { doc: BookDoc; outcome: SaveOutcome } {
  if (rescue.kind === "ok") {
    if (first.kind === "ok" && first.rev > rescue.rev) return { doc: firstDoc, outcome: first };
    return { doc: rescueDoc, outcome: rescue };
  }
  return { doc: firstDoc, outcome: first };
}
