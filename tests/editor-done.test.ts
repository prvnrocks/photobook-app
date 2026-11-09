import { describe, expect, it, vi } from "vitest";
import type { AutosaveStatus } from "@/lib/editor/autosave";
import {
  DONE_MESSAGES,
  doneStepAfterFinish,
  doneStepAfterSave,
  drainSaves,
  loginHref,
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
  ] as const)("%o → finish", (s) => {
    expect(doneStepAfterSave(s, BOOK)).toEqual({ kind: "finish" });
  });

  it.each([[{ kind: "pending" }], [{ kind: "saving" }], [{ kind: "retrying", attempt: 1 }]] as const)(
    "%o → stays with the unsaved message",
    (s) => {
      expect(doneStepAfterSave(s, BOOK)).toEqual({ kind: "error", message: DONE_MESSAGES.unsaved });
    },
  );

  it("signed out → login back to the editor", () => {
    expect(doneStepAfterSave({ kind: "signedOut" }, BOOK)).toEqual({
      kind: "navigate",
      to: `/login?next=${encodeURIComponent(`/books/${BOOK}/edit`)}`,
    });
    expect(loginHref(BOOK)).toBe(`/login?next=%2Fbooks%2F${BOOK}%2Fedit`);
  });

  it.each([[{ kind: "conflict" }], [{ kind: "unavailable" }], [{ kind: "failed" }], [{ kind: "readOnly" }]] as const)(
    "read-only %o → dashboard without finishing",
    (s) => {
      expect(doneStepAfterSave(s, BOOK)).toEqual({ kind: "navigate", to: "/dashboard" });
    },
  );
});

describe("doneStepAfterFinish", () => {
  it("ok → redirectTo", () => {
    expect(doneStepAfterFinish({ ok: true, redirectTo: "/dashboard" }, BOOK)).toEqual({ kind: "navigate", to: "/dashboard" });
    expect(doneStepAfterFinish({ ok: true, redirectTo: `/books/${BOOK}/publish` }, BOOK)).toEqual({
      kind: "navigate",
      to: `/books/${BOOK}/publish`,
    });
  });

  it("never follows off-origin redirects", () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil", ""]) {
      expect(doneStepAfterFinish({ ok: true, redirectTo: bad }, BOOK)).toEqual({ kind: "navigate", to: "/dashboard" });
    }
  });

  it("signed_out → login; not_found → dashboard", () => {
    expect(doneStepAfterFinish({ ok: false, error: "signed_out" }, BOOK)).toEqual({ kind: "navigate", to: loginHref(BOOK) });
    expect(doneStepAfterFinish({ ok: false, error: "not_found" }, BOOK)).toEqual({ kind: "navigate", to: "/dashboard" });
  });

  it("failed / threw → retry message", () => {
    expect(doneStepAfterFinish({ ok: false, error: "failed" }, BOOK)).toEqual({ kind: "error", message: DONE_MESSAGES.failed });
    expect(doneStepAfterFinish(null, BOOK)).toEqual({ kind: "error", message: DONE_MESSAGES.failed });
  });
});
