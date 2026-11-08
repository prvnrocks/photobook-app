import { describe, expect, it, vi } from "vitest";
import { callFinalize, finalizeWithPlaces, type FinalizeResult } from "@/lib/upload/finalize-client";
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

  it("rejects a non-uuid book id without fetching", async () => {
    const f = vi.fn();
    expect(await callFinalize("../x", f)).toEqual({ ok: false, error: "not_found" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("finalizeWithPlaces", () => {
  it("calls once when no places are pending", async () => {
    const f = vi.fn(async () => json(result()));
    await finalizeWithPlaces(BOOK, f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("re-runs at most 2 more times while places are pending, keeping wroteDoc", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(result({ placesPending: 4, withPlace: 2 })))
      .mockResolvedValueOnce(json(result({ placesPending: 2, withPlace: 4, wroteDoc: false })))
      .mockResolvedValueOnce(json(result({ placesPending: 1, withPlace: 5, wroteDoc: false })));
    const out = await finalizeWithPlaces(BOOK, f);
    expect(f).toHaveBeenCalledTimes(3);
    expect(out).toEqual({ ok: true, result: result({ placesPending: 1, withPlace: 5, wroteDoc: true }) });
  });

  it("keeps the last good result when a follow-up fails", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(result({ placesPending: 3 })))
      .mockResolvedValueOnce(json({ error: "server_error" }, 500));
    const out = await finalizeWithPlaces(BOOK, f);
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
