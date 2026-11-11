import { describe, expect, it, vi } from "vitest";
import {
  callFinalize,
  colorsBody,
  FOLLOW_UP_GAP_MS,
  finalizeWithPlaces,
  parseRetryAfter,
  type FinalizeResult,
} from "@/lib/upload/finalize-client";
import { plural, skippedLines } from "@/lib/upload/summary-text";

const BOOK = "11111111-1111-4111-8111-111111111111";

function result(over: Partial<FinalizeResult> = {}): FinalizeResult {
  return {
    photos: 10,
    withDate: 8,
    withGps: 6,
    withPlace: 6,
    placesPending: 0,
    dupGroups: 1,
    dupPhotos: 2,
    pages: 5,
    wroteDoc: true,
    docStale: false,
    ...over,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const limited = (retryAfter?: string) =>
  json({ error: "rate_limited" }, 429, retryAfter === undefined ? {} : { "retry-after": retryAfter });

/** Fake clock: sleep advances `t` instantly; fetch records the time of each call. */
function fakeClock() {
  const c = { t: 0, sleeps: [] as number[], callTimes: [] as number[] };
  const sleep = vi.fn(async (ms: number) => {
    c.sleeps.push(ms);
    c.t += ms;
  });
  const track = (responses: Response[]) =>
    vi.fn(async () => {
      c.callTimes.push(c.t);
      const r = responses.shift();
      if (!r) throw new Error("unexpected call");
      return r;
    });
  return { c, sleep, track };
}

describe("callFinalize", () => {
  it("POSTs to the same-origin finalize route and returns counts", async () => {
    const f = vi.fn(async () => json(result()));
    const out = await callFinalize(BOOK, f);
    expect(out).toEqual({ ok: true, result: result() });
    expect(f).toHaveBeenCalledWith(`/api/books/${BOOK}/finalize`, expect.objectContaining({ method: "POST" }));
  });

  it.each([
    [401, "signed_out"],
    [404, "not_found"],
    [403, "failed"],
    [500, "failed"],
  ] as const)("maps %i to %s", async (status, error) => {
    const out = await callFinalize(BOOK, async () => json({ error: "x" }, status));
    expect(out).toEqual({ ok: false, error });
  });

  it("network errors and malformed bodies → failed", async () => {
    expect(await callFinalize(BOOK, async () => Promise.reject(new TypeError("offline")))).toEqual({
      ok: false,
      error: "failed",
    });
    expect(await callFinalize(BOOK, async () => json({ photos: "10" }))).toEqual({ ok: false, error: "failed" });
    expect(await callFinalize(BOOK, async () => new Response("<html>", { status: 200 }))).toEqual({
      ok: false,
      error: "failed",
    });
  });

  it("maps 429 to rate_limited with the Retry-After wait", async () => {
    expect(await callFinalize(BOOK, async () => limited("7"))).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfterMs: 7000,
    });
    expect(await callFinalize(BOOK, async () => limited())).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfterMs: 10_000,
    });
  });

  it("rejects a non-uuid book id without fetching", async () => {
    const f = vi.fn();
    expect(await callFinalize("../x", f)).toEqual({ ok: false, error: "not_found" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("parseRetryAfter", () => {
  it.each([
    ["5", 5000],
    ["1", 1000],
    ["0", 1000],
    ["60", 60_000],
    ["3600", 60_000],
    ["2.5", 2500],
    [" 4 ", 4000],
    ["", 10_000],
    ["soon", 10_000],
    ["-3", 10_000],
  ] as const)("%j → %i ms", (header, ms) => {
    expect(parseRetryAfter(header)).toBe(ms);
  });

  it("missing header → 10 s; HTTP date → delta, clamped", () => {
    expect(parseRetryAfter(null)).toBe(10_000);
    const now = Date.parse("2026-11-08T10:00:00Z");
    expect(parseRetryAfter("Sun, 08 Nov 2026 10:00:20 GMT", now)).toBe(20_000);
    expect(parseRetryAfter("Sun, 08 Nov 2026 09:00:00 GMT", now)).toBe(1000);
    expect(parseRetryAfter("Sun, 08 Nov 2026 11:00:00 GMT", now)).toBe(60_000);
  });
});

describe("finalizeWithPlaces", () => {
  it("calls once when no places are pending", async () => {
    const { sleep } = fakeClock();
    const f = vi.fn(async () => json(result()));
    await finalizeWithPlaces(BOOK, f, { sleep });
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("429 then 200: waits Retry-After (+ jitter) and succeeds", async () => {
    const { c, sleep, track } = fakeClock();
    const f = track([limited("3"), json(result())]);
    const out = await finalizeWithPlaces(BOOK, f, { sleep, random: () => 0.5 });
    expect(out).toEqual({ ok: true, result: result() });
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.sleeps).toEqual([3150]);
  });

  it("429 three times: gives up after 2 waits with rate_limited", async () => {
    const { c, sleep, track } = fakeClock();
    const f = track([limited("2"), limited("2"), limited("4")]);
    const out = await finalizeWithPlaces(BOOK, f, { sleep, random: () => 0 });
    expect(out).toEqual({ ok: false, error: "rate_limited", retryAfterMs: 4000 });
    expect(f).toHaveBeenCalledTimes(3);
    expect(c.sleeps).toEqual([2000, 2000]);
  });

  it("429 then a real error → that error", async () => {
    const { sleep, track } = fakeClock();
    const f = track([limited("1"), json({}, 500)]);
    expect(await finalizeWithPlaces(BOOK, f, { sleep })).toEqual({ ok: false, error: "failed" });
  });

  it("spaces follow-up calls at least 10 s apart", async () => {
    const { c, sleep, track } = fakeClock();
    const f = track([
      json(result({ placesPending: 4 })),
      json(result({ placesPending: 2, wroteDoc: false })),
      json(result({ placesPending: 1, wroteDoc: false })),
    ]);
    await finalizeWithPlaces(BOOK, f, { sleep });
    expect(c.callTimes).toHaveLength(3);
    for (let i = 1; i < c.callTimes.length; i++) {
      expect(c.callTimes[i] - c.callTimes[i - 1]).toBeGreaterThanOrEqual(10_000);
    }
    expect(c.sleeps).toEqual([FOLLOW_UP_GAP_MS, FOLLOW_UP_GAP_MS]);
  });

  it("a follow-up hit by 429 waits and retries, keeping wroteDoc", async () => {
    const { sleep, track } = fakeClock();
    const f = track([
      json(result({ placesPending: 2, wroteDoc: true })),
      limited("2"),
      json(result({ placesPending: 0, withPlace: 6, wroteDoc: false })),
    ]);
    const out = await finalizeWithPlaces(BOOK, f, { sleep, random: () => 0 });
    expect(out).toEqual({ ok: true, result: result({ placesPending: 0, withPlace: 6, wroteDoc: true }) });
  });

  it("a follow-up still rate limited after 2 waits keeps the last good result", async () => {
    const { sleep, track } = fakeClock();
    const f = track([json(result({ placesPending: 2 })), limited("1"), limited("1"), limited("1")]);
    const out = await finalizeWithPlaces(BOOK, f, { sleep, extraRuns: 1 });
    expect(out).toEqual({ ok: true, result: result({ placesPending: 2 }) });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("stops issuing calls once aborted", async () => {
    const ctrl = new AbortController();
    const sleep = vi.fn(async () => {
      ctrl.abort();
    });
    const f = vi.fn().mockResolvedValueOnce(json(result({ placesPending: 3 })));
    const out = await finalizeWithPlaces(BOOK, f, { sleep, signal: ctrl.signal });
    expect(f).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ok: true, result: result({ placesPending: 3 }) });
  });

  it("re-runs at most 2 more times while places are pending, keeping wroteDoc", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(result({ placesPending: 4, withPlace: 2 })))
      .mockResolvedValueOnce(json(result({ placesPending: 2, withPlace: 4, wroteDoc: false })))
      .mockResolvedValueOnce(json(result({ placesPending: 1, withPlace: 5, wroteDoc: false })));
    const out = await finalizeWithPlaces(BOOK, f, { sleep: async () => {} });
    expect(f).toHaveBeenCalledTimes(3);
    expect(out).toEqual({ ok: true, result: result({ placesPending: 1, withPlace: 5, wroteDoc: true }) });
  });

  it("keeps the last good result when a follow-up fails", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(result({ placesPending: 3 })))
      .mockResolvedValueOnce(json({ error: "server_error" }, 500));
    const out = await finalizeWithPlaces(BOOK, f, { sleep: async () => {} });
    expect(f).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ ok: true, result: result({ placesPending: 3 }) });
  });

  it("returns the first error", async () => {
    expect(await finalizeWithPlaces(BOOK, async () => json({}, 401))).toEqual({ ok: false, error: "signed_out" });
  });
});

describe("summary text", () => {
  it("pluralises", () => {
    expect(plural(1, "photo")).toBe("1 photo");
    expect(plural(3, "photo")).toBe("3 photos");
  });

  it("groups skip reasons in plain words, fixed order, non-zero only", () => {
    expect(
      skippedLines({
        limit: 2,
        duplicate_in_selection: 1,
        already_uploaded: 3,
        unsupported_type: 1,
        decode_failed: 0,
        too_small: 1,
      }),
    ).toEqual([
      { key: "already", text: "4 already added" },
      { key: "not_photo", text: "1 not a photo" },
      { key: "too_small", text: "1 too small" },
      { key: "limit", text: "2 over the photo limit" },
    ]);
    expect(skippedLines({})).toEqual([]);
  });
});

describe("finalize colours (M10c)", () => {
  const P1 = "00000000-0000-4000-8000-000000000001";
  const P2 = "00000000-0000-4000-8000-000000000002";

  it("colorsBody keeps valid entries only, caps at 500, null when empty", () => {
    expect(colorsBody(undefined)).toBeNull();
    expect(colorsBody({})).toBeNull();
    expect(colorsBody({ [P1]: "#8a7f72", [P2]: "#ABCDEF", "x": "#123456" })).toEqual({ [P1]: "#8a7f72" });
    const many = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "#123456"]),
    );
    expect(Object.keys(colorsBody(many)!)).toHaveLength(500);
  });

  it("first call (and its 429 retry) carries the JSON body; follow-ups and colour-less calls send none", async () => {
    const { sleep } = fakeClock();
    const inits: (RequestInit | undefined)[] = [];
    const responses = [limited("1"), json(result({ placesPending: 2 })), json(result({ placesPending: 0 }))];
    const f = vi.fn(async (_i: string, init?: RequestInit) => {
      inits.push(init);
      return responses.shift()!;
    });
    const out = await finalizeWithPlaces(BOOK, f, { sleep, random: () => 0, colors: { [P1]: "#8a7f72" } });
    expect(out.ok).toBe(true);
    expect(inits).toHaveLength(3);
    for (const init of inits.slice(0, 2)) {
      expect(JSON.parse(String(init?.body))).toEqual({ colors: { [P1]: "#8a7f72" } });
      expect(init?.headers).toEqual({ "content-type": "application/json" });
    }
    expect(inits[2]?.body).toBeUndefined();

    const g = vi.fn(async (_i: string, init?: RequestInit) => {
      inits.push(init);
      return json(result());
    });
    await callFinalize(BOOK, g, {});
    expect(inits.at(-1)?.body).toBeUndefined();
  });
});

