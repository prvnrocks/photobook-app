import { describe, expect, it, vi } from "vitest";
import { PRINT_READY_TIMEOUT_MS, publishPrintReady, waitForPrintReady, type PrintReadyGlobals } from "@/lib/pdf/print-ready";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTimer() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      (h as { cleared: boolean }).cleared = true;
    },
    fire: () => timers.forEach((t) => !t.cleared && t.fn()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("waitForPrintReady", () => {
  it("waits for every image AND fonts, then resolves without error", async () => {
    const a = deferred();
    const b = deferred();
    const fonts = deferred();
    const t = fakeTimer();
    let result: unknown = null;
    void waitForPrintReady({
      images: [{ decode: () => a.promise }, { decode: () => b.promise }],
      fontsReady: fonts.promise,
      ...t,
    }).then((r) => (result = r));
    a.resolve();
    await flush();
    expect(result).toBeNull();
    fonts.resolve();
    await flush();
    expect(result).toBeNull();
    b.resolve();
    await flush();
    expect(result).toEqual({ error: null, timeout: false });
    expect(t.timers[0].ms).toBe(PRINT_READY_TIMEOUT_MS);
    expect(t.timers[0].cleared).toBe(true);
  });

  it("an image that fails (reject or throw) → error 'image' but still ready", async () => {
    const t = fakeTimer();
    const r = await waitForPrintReady({
      images: [
        { decode: () => Promise.reject(new Error("broken")) },
        {
          decode: () => {
            throw new Error("sync");
          },
        },
        { decode: () => Promise.resolve() },
      ],
      fontsReady: Promise.resolve(),
      ...t,
    });
    expect(r).toEqual({ error: "image", timeout: false });
  });

  it("no images: fonts alone decide", async () => {
    expect(await waitForPrintReady({ images: [], fontsReady: Promise.resolve(), ...fakeTimer() })).toEqual({
      error: null,
      timeout: false,
    });
  });

  it("rejected fonts.ready does not block", async () => {
    expect(await waitForPrintReady({ images: [], fontsReady: Promise.reject(new Error("x")), ...fakeTimer() })).toEqual({
      error: null,
      timeout: false,
    });
  });

  it("hard cap: a hanging image → timeout, reported once", async () => {
    const t = fakeTimer();
    const hang = deferred();
    const done = vi.fn();
    void waitForPrintReady({
      images: [{ decode: () => Promise.reject(new Error("x")) }, { decode: () => hang.promise }],
      fontsReady: Promise.resolve(),
      ...t,
    }).then(done);
    await flush();
    expect(done).not.toHaveBeenCalled();
    t.fire();
    await flush();
    expect(done).toHaveBeenCalledWith({ error: "image", timeout: true });
    hang.resolve();
    await flush();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("uses real timers by default", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForPrintReady({ images: [{ decode: () => new Promise<void>(() => {}) }], fontsReady: Promise.resolve() });
      await vi.advanceTimersByTimeAsync(PRINT_READY_TIMEOUT_MS);
      expect(await p).toEqual({ error: null, timeout: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("publishPrintReady", () => {
  it("sets only __PRINT_READY__ on success", () => {
    const w: PrintReadyGlobals = {};
    publishPrintReady(w, { error: null, timeout: false });
    expect(w).toEqual({ __PRINT_READY__: true });
  });
  it("sets error + timeout flags too", () => {
    const w: PrintReadyGlobals = {};
    publishPrintReady(w, { error: "image", timeout: true });
    expect(w).toEqual({ __PRINT_ERROR__: "image", __PRINT_TIMEOUT__: true, __PRINT_READY__: true });
  });
});
