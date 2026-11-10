import { describe, expect, it } from "vitest";
import type { BookDoc } from "@/lib/book/types";
import {
  AutosaveScheduler,
  backoffMs,
  canUseKeepalive,
  classifySaveResponse,
  DEBOUNCE_MS,
  invalidSaveCopy,
  KEEPALIVE_MAX_BYTES,
  type AutosaveStatus,
  type SaveOutcome,
} from "@/lib/editor/autosave";

// ---- deterministic fake timers + controllable transport -----------------------------------------

class FakeTimers {
  now = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (h: unknown) => {
    this.tasks.delete(h as number);
  };
  get pending() {
    return this.tasks.size;
  }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.tasks) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
}

type Call = { doc: BookDoc; rev: number; keepalive: boolean; resolve: (o: SaveOutcome) => void };

function setup(baseRev = 1) {
  const timers = new FakeTimers();
  const calls: Call[] = [];
  const statuses: AutosaveStatus[] = [];
  const saved: number[] = [];
  const doc0 = mk("d0");
  const s = new AutosaveScheduler({
    baseRev,
    savedDoc: doc0,
    timers,
    send: (doc, rev, o) => new Promise<SaveOutcome>((resolve) => calls.push({ doc, rev, keepalive: o.keepalive, resolve })),
    onStatus: (st) => statuses.push(st),
    onSaved: (rev) => saved.push(rev),
  });
  return { s, timers, calls, statuses, saved, doc0 };
}

function mk(title: string): BookDoc {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: null, title, subtitle: "" },
    chapters: [],
    pages: [],
    style: { background: "#FFFFFF", font: "Playfair" },
  };
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

// ---- pure helpers -------------------------------------------------------------------------------

describe("classifySaveResponse", () => {
  it("maps the save route contract", () => {
    expect(classifySaveResponse(200, { rev: 4, savedAt: "t" })).toEqual({ kind: "ok", rev: 4, savedAt: "t" });
    expect(classifySaveResponse(200, { nope: 1 })).toEqual({ kind: "retry", reason: "server" });
    expect(classifySaveResponse(409, { error: "conflict" })).toEqual({ kind: "conflict" });
    expect(classifySaveResponse(503, {})).toEqual({ kind: "unavailable" });
    expect(classifySaveResponse(422, { error: "page_limit" })).toEqual({ kind: "invalid", code: "page_limit" });
    expect(classifySaveResponse(422, null)).toEqual({ kind: "invalid", code: "invalid_doc" });
    expect(classifySaveResponse(400, { error: "invalid_body" })).toEqual({ kind: "invalid", code: "invalid_body" });
    expect(classifySaveResponse(401, {})).toEqual({ kind: "signedOut" });
    expect(classifySaveResponse(404, {})).toEqual({ kind: "failed" });
    expect(classifySaveResponse(403, {})).toEqual({ kind: "failed" });
    // 413: resending the same doc can never succeed → rejected like a 422, not retried forever.
    expect(classifySaveResponse(413, { error: "too_large" })).toEqual({ kind: "invalid", code: "too_large" });
    expect(classifySaveResponse(413, null)).toEqual({ kind: "invalid", code: "too_large" });
    expect(classifySaveResponse(429, {})).toEqual({ kind: "retry", reason: "rate" });
    expect(classifySaveResponse(500, {})).toEqual({ kind: "retry", reason: "server" });
    expect(classifySaveResponse(null, null)).toEqual({ kind: "retry", reason: "network" });
  });

  it("backoff doubles from 2 s and caps at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(backoffMs(0)).toBe(2000);
  });

  it("keepalive only under 60 KB", () => {
    expect(canUseKeepalive(1000)).toBe(true);
    expect(canUseKeepalive(KEEPALIVE_MAX_BYTES)).toBe(false);
    expect(canUseKeepalive(0)).toBe(false);
  });

  it("has friendly copy for every 422 code", () => {
    for (const c of ["page_limit", "foreign_photo", "duplicate_photo", "invalid_font", "invalid_doc", "too_large", "x"]) {
      expect(invalidSaveCopy(c).length).toBeGreaterThan(10);
    }
    expect(invalidSaveCopy("too_large")).toBe("This album is too big to save — try removing a page.");
  });
});

// ---- scheduler ----------------------------------------------------------------------------------

describe("AutosaveScheduler", () => {
  it("debounces: one save 2 s after the last change, with the latest doc", async () => {
    const { s, timers, calls, statuses } = setup();
    const a = mk("a");
    const b = mk("b");
    s.change(a);
    timers.advance(1500);
    s.change(b);
    timers.advance(1500);
    expect(calls).toHaveLength(0);
    expect(s.getStatus().kind).toBe("pending");
    timers.advance(DEBOUNCE_MS - 1500);
    expect(calls).toHaveLength(1);
    expect(calls[0].doc).toBe(b);
    expect(calls[0].rev).toBe(1);
    expect(calls[0].keepalive).toBe(false);
    expect(s.getStatus().kind).toBe("saving");
    calls[0].resolve({ kind: "ok", rev: 2, savedAt: "now" });
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "saved", savedAt: "now" });
    expect(s.getRev()).toBe(2);
    expect(s.hasUnsaved()).toBe(false);
    expect(statuses.map((x) => x.kind)).toEqual(["pending", "saving", "saved"]);
  });

  it("does nothing for the loaded doc", () => {
    const { s, timers, calls, doc0 } = setup();
    s.change(doc0);
    timers.advance(10_000);
    expect(calls).toHaveLength(0);
    expect(s.getStatus().kind).toBe("idle");
  });

  it("changing back to the saved doc cancels the pending save", () => {
    const { s, timers, calls, doc0 } = setup();
    s.change(mk("a"));
    s.change(doc0);
    timers.advance(10_000);
    expect(calls).toHaveLength(0);
    expect(s.hasUnsaved()).toBe(false);
  });

  it("keeps ONE request in flight and queues only the latest doc", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    const c = mk("c");
    s.change(mk("b"));
    s.change(c);
    timers.advance(DEBOUNCE_MS * 3);
    expect(calls).toHaveLength(1); // still in flight
    expect(s.getStatus().kind).toBe("saving");
    calls[0].resolve({ kind: "ok", rev: 2, savedAt: null });
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(calls[1].doc).toBe(c);
    expect(calls[1].rev).toBe(2); // uses the rev returned by the first save
    calls[1].resolve({ kind: "ok", rev: 3, savedAt: null });
    await flushMicrotasks();
    expect(s.getRev()).toBe(3);
    expect(s.getStatus().kind).toBe("saved");
  });

  it("a change during flight whose debounce hasn't run out waits for it", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.change(mk("b"));
    calls[0].resolve({ kind: "ok", rev: 2, savedAt: null });
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(s.getStatus().kind).toBe("pending");
    timers.advance(DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
  });

  it("409 conflict is terminal: no retry, later changes ignored", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    calls[0].resolve({ kind: "conflict" });
    await flushMicrotasks();
    expect(s.getStatus().kind).toBe("conflict");
    s.change(mk("b"));
    timers.advance(60_000);
    expect(s.flush()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(timers.pending).toBe(0);
  });

  it("503 stops autosave", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    calls[0].resolve({ kind: "unavailable" });
    await flushMicrotasks();
    expect(s.getStatus().kind).toBe("unavailable");
    s.change(mk("b"));
    timers.advance(60_000);
    expect(calls).toHaveLength(1);
  });

  it("401 and 404 are terminal too", async () => {
    for (const kind of ["signedOut", "failed"] as const) {
      const { s, timers, calls } = setup();
      s.change(mk("a"));
      timers.advance(DEBOUNCE_MS);
      calls[0].resolve({ kind });
      await flushMicrotasks();
      expect(s.getStatus().kind).toBe(kind);
      s.change(mk("b"));
      timers.advance(60_000);
      expect(calls).toHaveLength(1);
    }
  });

  it("422 does not retry the same doc, but the next edit is saved", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    calls[0].resolve({ kind: "invalid", code: "page_limit" });
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "invalid", code: "page_limit" });
    timers.advance(60_000);
    expect(calls).toHaveLength(1);
    expect(s.hasUnsaved()).toBe(false);
    const b = mk("b");
    s.change(b);
    timers.advance(DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1].doc).toBe(b);
    expect(calls[1].rev).toBe(1);
  });

  it("422 with a newer doc queued sends the newer doc right away", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    const b = mk("b");
    s.change(b);
    timers.advance(DEBOUNCE_MS); // debounce ran out during flight
    calls[0].resolve({ kind: "invalid", code: "duplicate_photo" });
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(calls[1].doc).toBe(b);
  });

  it("network / 5xx / 429 retry with exponential backoff and send the newest doc", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    calls[0].resolve({ kind: "retry", reason: "network" });
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "retrying", attempt: 1 });
    timers.advance(1999);
    expect(calls).toHaveLength(1);
    timers.advance(1);
    expect(calls).toHaveLength(2);
    calls[1].resolve({ kind: "retry", reason: "server" });
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "retrying", attempt: 2 });
    // A change while waiting keeps the backoff (no 2 s debounce reset) and is what gets sent.
    const b = mk("b");
    s.change(b);
    expect(s.getStatus().kind).toBe("retrying");
    timers.advance(3999);
    expect(calls).toHaveLength(2);
    timers.advance(1);
    expect(calls).toHaveLength(3);
    expect(calls[2].doc).toBe(b);
    calls[2].resolve({ kind: "retry", reason: "rate" });
    await flushMicrotasks();
    timers.advance(8000);
    expect(calls).toHaveLength(4);
    calls[3].resolve({ kind: "ok", rev: 5, savedAt: null });
    await flushMicrotasks();
    expect(s.getStatus().kind).toBe("saved");
    // Backoff resets after success.
    s.change(mk("c"));
    timers.advance(DEBOUNCE_MS);
    calls[4].resolve({ kind: "retry", reason: "network" });
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "retrying", attempt: 1 });
  });

  it("a send that throws/rejects counts as a network error", async () => {
    const timers = new FakeTimers();
    let n = 0;
    const s = new AutosaveScheduler({
      baseRev: 0,
      savedDoc: mk("x"),
      timers,
      send: () => {
        n++;
        if (n === 1) throw new Error("sync");
        return Promise.reject(new Error("async"));
      },
    });
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "retrying", attempt: 1 });
    timers.advance(2000);
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "retrying", attempt: 2 });
  });

  it("flush sends immediately (keepalive) and skips the debounce", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    const p = s.flush({ keepalive: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].keepalive).toBe(true);
    timers.advance(DEBOUNCE_MS);
    expect(calls).toHaveLength(1); // the debounce timer was cleared
    expect(s.flush({ keepalive: true })).toBe(p); // in flight: no second request
    calls[0].resolve({ kind: "ok", rev: 2, savedAt: null });
    await p;
    expect(s.getStatus().kind).toBe("saved");
  });

  it("flush with nothing pending is a no-op", () => {
    const { s, calls } = setup();
    expect(s.flush()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("flush during a retry wait sends now", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    calls[0].resolve({ kind: "retry", reason: "network" });
    await flushMicrotasks();
    s.flush();
    expect(calls).toHaveLength(2);
  });

  it("413 too_large is not retried: invalid state; a smaller next edit saves", async () => {
    const { s, timers, calls } = setup();
    s.change(mk("huge"));
    timers.advance(DEBOUNCE_MS);
    calls[0].resolve(classifySaveResponse(413, { error: "too_large" }));
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "invalid", code: "too_large" });
    timers.advance(120_000);
    expect(calls).toHaveLength(1);
    const smaller = mk("smaller");
    s.change(smaller);
    timers.advance(DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1].doc).toBe(smaller);
  });

  // ---- S4: leaving the page while a save is in flight --------------------------------------------

  it("keepalive flush during an in-flight save sends the newer doc at once (rescue, same baseRev)", async () => {
    const { s, timers, calls } = setup(1);
    const a = mk("a");
    const b = mk("b");
    s.change(a);
    timers.advance(DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    s.change(b); // queued behind the in-flight save
    const p = s.flush({ keepalive: true });
    expect(p).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ doc: b, rev: 1, keepalive: true });
    // A second hidden/pagehide event doesn't send a third copy.
    s.flush({ keepalive: true });
    expect(calls).toHaveLength(2);
  });

  it("rescue wins the race (in-flight gets 409): newer doc saved, no false conflict", async () => {
    const { s, timers, calls, saved } = setup(1);
    const b = mk("b");
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.change(b);
    const p = s.flush({ keepalive: true });
    calls[1].resolve({ kind: "ok", rev: 2, savedAt: "t" });
    calls[0].resolve({ kind: "conflict" });
    await p;
    expect(s.getStatus()).toEqual({ kind: "saved", savedAt: "t" });
    expect(s.getRev()).toBe(2);
    expect(saved).toEqual([2]);
    expect(s.hasUnsaved()).toBe(false);
    timers.advance(DEBOUNCE_MS * 5);
    expect(calls).toHaveLength(2);
  });

  it("in-flight wins the race (rescue gets 409), page stays alive: newer doc is chained right after", async () => {
    const { s, timers, calls } = setup(1);
    const b = mk("b");
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.change(b);
    const p = s.flush({ keepalive: true });
    calls[0].resolve({ kind: "ok", rev: 2, savedAt: null });
    calls[1].resolve({ kind: "conflict" });
    await p;
    // Sent at once (no new debounce), against the rev the in-flight save produced.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ doc: b, rev: 2 });
    expect(s.getStatus().kind).toBe("saving");
    calls[2].resolve({ kind: "ok", rev: 3, savedAt: "t3" });
    await flushMicrotasks();
    expect(s.getStatus()).toEqual({ kind: "saved", savedAt: "t3" });
  });

  it("both requests 409 → a real conflict (another tab)", async () => {
    const { s, timers, calls } = setup(1);
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.change(mk("b"));
    const p = s.flush({ keepalive: true });
    calls[0].resolve({ kind: "conflict" });
    calls[1].resolve({ kind: "conflict" });
    await p;
    expect(s.getStatus()).toEqual({ kind: "conflict" });
  });

  it("in-flight aborted by the unload (network) but rescue landed → saved", async () => {
    const { s, timers, calls } = setup(1);
    const b = mk("b");
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.change(b);
    const p = s.flush({ keepalive: true });
    calls[0].resolve({ kind: "retry", reason: "network" });
    calls[1].resolve({ kind: "ok", rev: 2, savedAt: null });
    await p;
    expect(s.getStatus().kind).toBe("saved");
    expect(s.getRev()).toBe(2);
  });

  it("both ok (one was a no-op re-save): keeps the higher rev and resends the newest doc if needed", async () => {
    const { s, timers, calls } = setup(1);
    const b = mk("b");
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.change(b);
    const p = s.flush({ keepalive: true });
    calls[1].resolve({ kind: "ok", rev: 1, savedAt: null }); // rescue doc equalled the stored one
    calls[0].resolve({ kind: "ok", rev: 2, savedAt: null });
    await p;
    expect(s.getRev()).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ doc: b, rev: 2 });
  });

  it("non-keepalive flush during flight (Done / back online) cancels the debounce and chains", async () => {
    const { s, timers, calls } = setup(1);
    const b = mk("b");
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.change(b);
    const p = s.flush();
    expect(calls).toHaveLength(1); // no rescue without keepalive
    calls[0].resolve({ kind: "ok", rev: 2, savedAt: null });
    await p;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ doc: b, rev: 2, keepalive: false });
  });

  it("keepalive flush with nothing newer than the in-flight doc sends nothing extra", () => {
    const { s, timers, calls } = setup(1);
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.flush({ keepalive: true });
    expect(calls).toHaveLength(1);
  });

  it("dispose stops timers; an in-flight save still records the rev", async () => {
    const { s, timers, calls, saved } = setup();
    s.change(mk("a"));
    timers.advance(DEBOUNCE_MS);
    s.change(mk("b"));
    s.dispose();
    timers.advance(60_000);
    calls[0].resolve({ kind: "ok", rev: 2, savedAt: null });
    await flushMicrotasks();
    expect(saved).toEqual([2]);
    expect(calls).toHaveLength(1);
  });
});
