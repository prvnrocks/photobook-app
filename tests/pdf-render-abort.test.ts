import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, HTTPRequest } from "puppeteer-core";

vi.mock("server-only", () => ({}));

// M8 review S2 + N6: renderBook / renderChunk with a fake puppeteer browser — the deadline signal
// really stops the render (tab + browser closed, no further chunks), and the print token travels
// only in the x-print-token header of same-origin navigations (never in the URL).

import { PRINT_TOKEN_HEADER, renderBook, renderChunk, routePrintRequest } from "@/lib/pdf/render-pdf";
import { verifyPrintToken } from "@/lib/pdf/print-token";
import type { PrintImageLoader } from "@/lib/pdf/images";

const APP = "https://app.example.ae";
const BOOK = "1111aaaa-2222-4333-8444-5555ffff5555";
const EXPORT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const loader: PrintImageLoader = { get: async () => Buffer.from([0xff, 0xd8]) };

interface FakePage {
  gotoUrls: string[];
  closed: boolean;
  /** Request handler registered by renderChunk. */
  handler?: (req: HTTPRequest) => void;
}

/**
 * Fake browser: each page's goto() resolves after `gotoMs` (or hangs with `hang`), then reports
 * ready; page.pdf returns bytes. A closed page rejects pending calls like puppeteer does.
 */
function fakeBrowser(opts: { gotoMs?: number; hang?: boolean } = {}) {
  const pages: FakePage[] = [];
  const browser = {
    closed: false,
    newPage: vi.fn(async () => {
      const state: FakePage = { gotoUrls: [], closed: false };
      pages.push(state);
      const rejecters: ((e: Error) => void)[] = [];
      const guard = <T>(p: Promise<T>) =>
        new Promise<T>((resolve, reject) => {
          if (state.closed) return reject(new Error("Target closed"));
          rejecters.push(reject);
          p.then(resolve, reject);
        });
      return {
        setRequestInterception: async () => undefined,
        on: (_ev: string, h: (req: HTTPRequest) => void) => {
          state.handler = h;
        },
        emulateMediaType: async () => undefined,
        goto: (url: string) => {
          state.gotoUrls.push(url);
          return guard(
            new Promise((resolve) => {
              if (!opts.hang) setTimeout(() => resolve({ ok: () => true, url: () => url }), opts.gotoMs ?? 0);
            }),
          );
        },
        waitForFunction: () => guard(Promise.resolve(true)),
        evaluate: () => guard(Promise.resolve({ ready: true, error: false, timeout: false })),
        pdf: () => guard(Promise.resolve(new Uint8Array([37, 80, 68, 70]))),
        close: async () => {
          state.closed = true;
          for (const r of rejecters) r(new Error("Target closed"));
        },
      };
    }),
  };
  return { browser: browser as unknown as Browser & { closed: boolean }, pages, raw: browser };
}

const savedSecret = process.env.BOOK_ACCESS_SECRET;
beforeEach(() => {
  process.env.BOOK_ACCESS_SECRET = "s".repeat(40);
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.BOOK_ACCESS_SECRET;
  else process.env.BOOK_ACCESS_SECRET = savedSecret;
});

const base = { origin: APP, bookId: BOOK, exportId: EXPORT, docRev: 3, loader, chunkSheets: 2 };

describe("renderBook abort (S2)", () => {
  it("renders every chunk without a signal (baseline)", async () => {
    const f = fakeBrowser();
    const close = vi.fn(async () => undefined);
    const chunks = await renderBook({ ...base, sheetCount: 5, launch: async () => f.browser, close });
    expect(chunks).toHaveLength(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("abort mid-chunk → closes the tab and the owned browser, render_timeout, no further chunk", async () => {
    const f = fakeBrowser({ hang: true });
    const close = vi.fn(async () => undefined);
    const ac = new AbortController();
    const p = renderBook({ ...base, sheetCount: 5, launch: async () => f.browser, close, signal: ac.signal });
    await vi.waitFor(() => expect(f.pages).toHaveLength(1));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "render_timeout" });
    expect(f.pages[0].closed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1); // once, even though both abort and finally close
    expect(f.raw.newPage).toHaveBeenCalledTimes(1);
  });

  it("abort between chunks → the next chunk never opens", async () => {
    const f = fakeBrowser();
    const ac = new AbortController();
    const close = vi.fn(async () => undefined);
    const p = renderBook({
      ...base,
      sheetCount: 5,
      launch: async () => f.browser,
      close,
      signal: ac.signal,
      onChunkDone: (k) => {
        if (k === 0) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ code: "render_timeout" });
    expect(f.raw.newPage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("already aborted → never launches", async () => {
    const launch = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(renderBook({ ...base, sheetCount: 3, launch, signal: ac.signal })).rejects.toMatchObject({ code: "render_timeout" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("abort during launch → browser closed right after it starts", async () => {
    const f = fakeBrowser();
    const ac = new AbortController();
    const close = vi.fn(async () => undefined);
    const p = renderBook({
      ...base,
      sheetCount: 3,
      launch: async () => {
        ac.abort();
        return f.browser;
      },
      close,
      signal: ac.signal,
    });
    await expect(p).rejects.toMatchObject({ code: "render_timeout" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.raw.newPage).not.toHaveBeenCalled();
  });

  it("a caller's browser is not closed on abort — only its tab", async () => {
    const f = fakeBrowser({ hang: true });
    const close = vi.fn(async () => undefined);
    const ac = new AbortController();
    const p = renderBook({ ...base, sheetCount: 3, browser: f.browser, close, signal: ac.signal });
    await vi.waitFor(() => expect(f.pages).toHaveLength(1));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "render_timeout" });
    expect(f.pages[0].closed).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it("renderChunk: an already-aborted signal opens no tab", async () => {
    const f = fakeBrowser();
    const ac = new AbortController();
    ac.abort();
    await expect(
      renderChunk(f.browser, { url: `${APP}/print/${BOOK}`, origin: APP, loader, timeoutMs: 5_000, signal: ac.signal }),
    ).rejects.toMatchObject({ code: "render_timeout" });
    expect(f.raw.newPage).not.toHaveBeenCalled();
  });
});

describe("print token in a header (N6)", () => {
  it("the print URL carries no token; each chunk's handler adds a valid token for its range to navigations", async () => {
    const f = fakeBrowser();
    await renderBook({ ...base, sheetCount: 3, launch: async () => f.browser, close: async () => undefined });
    expect(f.pages).toHaveLength(2);
    for (const [k, page] of f.pages.entries()) {
      expect(page.gotoUrls).toEqual([`${APP}/print/${BOOK}`]);
      const calls: unknown[] = [];
      const nav = {
        url: () => `${APP}/print/${BOOK}`,
        method: () => "GET",
        headers: () => ({ accept: "text/html" }),
        isNavigationRequest: () => true,
        isInterceptResolutionHandled: () => false,
        continue: async (arg?: unknown) => void calls.push(arg),
      } as unknown as HTTPRequest;
      page.handler!(nav);
      const headers = (calls[0] as { headers: Record<string, string> }).headers;
      const grant = verifyPrintToken(headers[PRINT_TOKEN_HEADER], { bookId: BOOK, nowSec: Math.floor(Date.now() / 1000) });
      expect(grant).toMatchObject({ exportId: EXPORT, docRev: 3, from: k * 2, to: Math.min(k * 2 + 1, 2) });
    }
  });

  it("only same-origin navigations get the header — never sub-resources or other origins", () => {
    const run = (url: string, navigation: boolean) => {
      const calls: { kind: string; arg?: unknown }[] = [];
      const req = {
        url: () => url,
        method: () => "GET",
        headers: () => ({ accept: "*/*" }),
        isNavigationRequest: () => navigation,
        isInterceptResolutionHandled: () => false,
        continue: async (arg?: unknown) => void calls.push({ kind: "continue", arg }),
        abort: async (arg?: unknown) => void calls.push({ kind: "abort", arg }),
        respond: async (arg?: unknown) => void calls.push({ kind: "respond", arg }),
      } as unknown as HTTPRequest;
      routePrintRequest(req, { origin: APP, loader, bypassSecret: null, printToken: "tok" });
      return calls;
    };
    expect(run(`${APP}/print/${BOOK}`, true)).toEqual([
      { kind: "continue", arg: { headers: { accept: "*/*", [PRINT_TOKEN_HEADER]: "tok" } } },
    ]);
    expect(run(`${APP}/_next/static/chunk.js`, false)).toEqual([{ kind: "continue", arg: undefined }]);
    expect(JSON.stringify(run("https://evil.example/print", true))).not.toContain("tok");
  });
});
