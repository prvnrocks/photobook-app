// T10 N3: per-request memoised public reads for /b/[slug] — argument plumbing (cache() itself only
// memoises inside a React server render; here it calls through).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const getViewerBook = vi.fn(async (...args: unknown[]) => void args || ({ bookId: null, book: { state: "not_found" } }));
const getOgData = vi.fn(async (...args: unknown[]) => void args || ({ state: "not_found" }));
const getPublishedBookRow = vi.fn(async (...args: unknown[]) => void args || null);
vi.mock("@/lib/db/public-books", () => ({ getViewerBook, getOgData, getPublishedBookRow }));

const { getViewerBookCached, getOgDataCached, getPublishedBookRowCached } = await import("@/lib/viewer/cached-reads");

beforeEach(() => vi.clearAllMocks());

describe("cached public reads", () => {
  it("getViewerBookCached passes slug + access cookie through", async () => {
    await expect(getViewerBookCached("trip-abcdefghij", "tok")).resolves.toMatchObject({ bookId: null });
    expect(getViewerBook).toHaveBeenCalledWith("trip-abcdefghij", { accessCookie: "tok" });
    await getViewerBookCached("trip-abcdefghij", null);
    expect(getViewerBook).toHaveBeenLastCalledWith("trip-abcdefghij", { accessCookie: null });
  });

  it("getOgDataCached / getPublishedBookRowCached call the slug-only readers", async () => {
    await getOgDataCached("trip-abcdefghij");
    expect(getOgData).toHaveBeenCalledWith("trip-abcdefghij");
    await getPublishedBookRowCached("trip-abcdefghij");
    expect(getPublishedBookRow).toHaveBeenCalledWith("trip-abcdefghij");
  });
});
