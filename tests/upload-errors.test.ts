import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/ai/limits";
import { mapUploadDbError } from "@/lib/upload/errors";

describe("mapUploadDbError", () => {
  it("maps the photo cap trigger with its hint as the limit", () => {
    expect(mapUploadDbError({ code: "P0001", message: "photo_limit_reached", hint: "150" })).toEqual({
      kind: "photo_limit_reached",
      limit: 150,
    });
    expect(mapUploadDbError({ code: "P0001", message: "photo_limit_reached", hint: "500" })).toEqual({
      kind: "photo_limit_reached",
      limit: 500,
    });
  });

  it("falls back to the free limit when the hint is missing or garbled", () => {
    for (const hint of [undefined, "", "abc", "0", "-3"]) {
      expect(mapUploadDbError({ code: "P0001", message: "photo_limit_reached", hint })).toEqual({
        kind: "photo_limit_reached",
        limit: LIMITS.free.maxUploadPhotos,
      });
    }
  });

  it("treats other P0001 raises as unknown", () => {
    expect(mapUploadDbError({ code: "P0001", message: "something_else", hint: "150" })).toEqual({
      kind: "unknown",
    });
  });

  it("maps 23505 on photos_book_fingerprint_key to duplicate (message or details)", () => {
    expect(
      mapUploadDbError({
        code: "23505",
        message: 'duplicate key value violates unique constraint "photos_book_fingerprint_key"',
      }),
    ).toEqual({ kind: "duplicate" });
    expect(
      mapUploadDbError({ code: "23505", message: "dup", details: "photos_book_fingerprint_key" }),
    ).toEqual({ kind: "duplicate" });
  });

  it("maps other unique violations to unknown", () => {
    expect(
      mapUploadDbError({
        code: "23505",
        message: 'duplicate key value violates unique constraint "photos_pkey"',
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("maps 42501 to not_allowed", () => {
    expect(
      mapUploadDbError({ code: "42501", message: 'new row violates row-level security policy for table "photos"' }),
    ).toEqual({ kind: "not_allowed" });
  });

  it("maps anything else (and nullish) to unknown", () => {
    expect(mapUploadDbError({ code: "23514", message: "check" })).toEqual({ kind: "unknown" });
    expect(mapUploadDbError({})).toEqual({ kind: "unknown" });
    expect(mapUploadDbError(null)).toEqual({ kind: "unknown" });
    expect(mapUploadDbError(undefined)).toEqual({ kind: "unknown" });
  });

  it("never copies error text into the result", () => {
    const r = mapUploadDbError({ code: "XX000", message: "secret user text", details: "more" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
