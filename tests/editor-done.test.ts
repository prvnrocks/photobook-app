import { describe, expect, it, vi } from "vitest";
import type { AutosaveStatus } from "@/lib/editor/autosave";
import {
  DONE_MESSAGES,
  doneStepAfterSave,
  doneStepAfterShare,
  drainSaves,
  loginHref,
  shareSubtitle,
  type DrainableSaves,
} from "@/lib/editor/done";

const BOOK = "11111111-1111-4111-8111-111111111111";

/** Fake scheduler: each flush resolves into the next scripted (status, unsaved) step. */
function fakeSaves(initial: AutosaveStatus, unsaved: boolean, script: { status: AutosaveStatus; unsaved: boolean }[]) {
  let status = initial;
  let pending = unsaved;
  const flush = vi.fn(() => {
    const next = script.shift();
    if (!next) return null;
    return Promise.resolve().then(() => {
      status = next.status;
      pending = next.unsaved;
    });
  });
  const saves: DrainableSaves = { flush, hasUnsaved: () => pending, getStatus: () => status };
  return { saves, flush };
}

describe("drainSaves", () => {
  it("nothing unsaved → no flush, returns status", async () => {
    const { saves, flush } = fakeSaves({ kind: "saved", savedAt: null }, false, []);
    expect(await drainSaves(saves)).toEqual({ kind: "saved", savedAt: null });
    expect(flush).not.toHaveBeenCalled();
  });

  it("pending → flushes and waits until saved", async () => {
    const { saves, flush } = fakeSaves({ kind: "pending" }, true, [{ status: { kind: "saved", savedAt: "t" }, unsaved: false }]);
    expect((await drainSaves(saves)).kind).toBe("saved");
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("a change landed during the save → second round", async () => {
    const { saves, flush } = fakeSaves({ kind: "saving" }, true, [
      { status: { kind: "pending" }, unsaved: true },
      { status: { kind: "saved", savedAt: null }, unsaved: false },
    ]);
    expect((await drainSaves(saves)).kind).toBe("saved");
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("offline: one retry round, then gives up with retrying", async () => {
    const { saves, flush } = fakeSaves({ kind: "retrying", attempt: 2 }, true, [
      { status: { kind: "retrying", attempt: 3 }, unsaved: true },
      { status: { kind: "saved", savedAt: null }, unsaved: false },
    ]);
    expect((await drainSaves(saves)).kind).toBe("retrying");
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("terminal state → no flush", async () => {
    const { saves, flush } = fakeSaves({ kind: "conflict" }, true, []);
    expect((await drainSaves(saves)).kind).toBe("conflict");
    expect(flush).not.toHaveBeenCalled();
  });

  it("bounded rounds", async () => {
    const script = Array.from({ length: 10 }, () => ({ status: { kind: "pending" } as AutosaveStatus, unsaved: true }));
    const { saves, flush } = fakeSaves({ kind: "pending" }, true, script);
    expect((await drainSaves(saves, 3)).kind).toBe("pending");
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it("a rejected flush promise doesn't throw", async () => {
    let unsaved = true;
    const saves: DrainableSaves = {
      flush: () => {
        unsaved = false;
        return Promise.reject(new Error("x"));
      },
      hasUnsaved: () => unsaved,
      getStatus: () => ({ kind: "idle" }),
    };
    expect((await drainSaves(saves)).kind).toBe("idle");
  });
});

describe("doneStepAfterSave", () => {
  it.each([
    [{ kind: "idle" }],
    [{ kind: "saved", savedAt: null }],
    [{ kind: "invalid", code: "too_many_pages" }],
  ] as const)("%o → share", (s) => {
    expect(doneStepAfterSave(s, BOOK)).toEqual({ kind: "share" });
  });

  it.each([[{ kind: "pending" }], [{ kind: "saving" }], [{ kind: "retrying", attempt: 1 }]] as const)(
    "%o → stays with the unsaved message",
    (s) => {
      expect(doneStepAfterSave(s, BOOK)).toEqual({ kind: "error", message: DONE_MESSAGES.unsaved });
    },
  );

  it("M12: retrying because the server is busy → stays with the 'delayed' message (not read-only)", () => {
    for (const reason of ["server", "rate"] as const) {
      expect(doneStepAfterSave({ kind: "retrying", attempt: 1, reason }, BOOK)).toEqual({ kind: "error", message: DONE_MESSAGES.delayed });
    }
    expect(doneStepAfterSave({ kind: "retrying", attempt: 1, reason: "network" }, BOOK)).toEqual({ kind: "error", message: DONE_MESSAGES.unsaved });
  });

  it("signed out → login back to the editor", () => {
    expect(doneStepAfterSave({ kind: "signedOut" }, BOOK)).toEqual({
      kind: "navigate",
      to: `/login?next=${encodeURIComponent(`/books/${BOOK}/edit`)}`,
    });
    expect(loginHref(BOOK)).toBe(`/login?next=%2Fbooks%2F${BOOK}%2Fedit`);
  });

  it.each([[{ kind: "conflict" }], [{ kind: "unavailable" }], [{ kind: "failed" }], [{ kind: "readOnly" }]] as const)(
    "read-only %o → share screen without publishing",
    (s) => {
      expect(doneStepAfterSave(s, BOOK)).toEqual({ kind: "navigate", to: `/books/${BOOK}/publish` });
    },
  );
});

describe("doneStepAfterShare (M13 T9)", () => {
  const SCREEN = `/books/${BOOK}/publish`;
  it("ok → redirectTo (share screen, with or without ?shared=)", () => {
    expect(doneStepAfterShare({ ok: true, redirectTo: `${SCREEN}?shared=live`, published: null }, BOOK)).toEqual({
      kind: "navigate",
      to: `${SCREEN}?shared=live`,
    });
    expect(doneStepAfterShare({ ok: true, redirectTo: SCREEN, published: null }, BOOK)).toEqual({ kind: "navigate", to: SCREEN });
  });

  it("never follows off-origin redirects (falls back to the share screen)", () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil", ""]) {
      expect(doneStepAfterShare({ ok: true, redirectTo: bad, published: null }, BOOK)).toEqual({ kind: "navigate", to: SCREEN });
    }
  });

  it("signed_out → login; not_found → dashboard", () => {
    expect(doneStepAfterShare({ ok: false, error: "signed_out" }, BOOK)).toEqual({ kind: "navigate", to: loginHref(BOOK) });
    expect(doneStepAfterShare({ ok: false, error: "not_found" }, BOOK)).toEqual({ kind: "navigate", to: "/dashboard" });
  });

  it("failed / threw → retry message, stays in the editor", () => {
    expect(doneStepAfterShare({ ok: false, error: "failed" }, BOOK)).toEqual({ kind: "error", message: DONE_MESSAGES.failed });
    expect(doneStepAfterShare(null, BOOK)).toEqual({ kind: "error", message: DONE_MESSAGES.failed });
  });

  it("blocked publishes stay in the editor with the publish copy; expired / page_limit link to the share screen", () => {
    expect(doneStepAfterShare({ ok: false, error: "empty" }, BOOK)).toEqual({ kind: "error", message: expect.stringContaining("no pages") });
    expect(doneStepAfterShare({ ok: false, error: "invalid_doc" }, BOOK)).toMatchObject({ kind: "error" });
    expect(doneStepAfterShare({ ok: false, error: "conflict" }, BOOK)).toEqual({ kind: "error", message: "Something changed — try again" });
    const limit = doneStepAfterShare({ ok: false, error: "page_limit" }, BOOK, 20);
    expect(limit).toEqual({ kind: "error", message: expect.stringContaining("more than 20 pages"), link: { href: SCREEN, label: "See options" } });
    const expired = doneStepAfterShare({ ok: false, error: "expired" }, BOOK);
    expect(expired).toMatchObject({ kind: "error", message: expect.stringContaining("expired"), link: { href: SCREEN } });
  });
});

describe("shareSubtitle", () => {
  it("free → 30-day notice; paid → permanent; unpublished edits → Publish changes", () => {
    expect(shareSubtitle({ isPaid: false, hasChanges: false })).toBe("Free · 30 days");
    expect(shareSubtitle({ isPaid: true, hasChanges: false })).toBe("Permanent link");
    expect(shareSubtitle({ isPaid: false, hasChanges: true })).toBe("Publish changes");
    expect(shareSubtitle({ isPaid: true, hasChanges: true })).toBe("Publish changes");
  });
});
