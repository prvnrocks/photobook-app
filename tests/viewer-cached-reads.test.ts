// T10 N3: per-request memoised public reads for /b/[slug] — argument plumbing (cache() itself only
// memoises inside a React server render; here it calls through).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// vi.hoisted: the vi.mock factory below is hoisted above plain const declarations.
const { getViewerBook, getOgData } = vi.hoisted(() => ({
  getViewerBook: vi
    .fn<(slug: string, opts: { accessCookie?: string | null }) => Promise<unknown>>()
    .mockResolvedValue({ bookId: null, book: { state: "not_found" } }),
  getOgData: vi.fn<(slug: string) => Promise<unknown>>().mockResolvedValue({ state: "not_found" }),
}));
vi.mock("@/lib/db/public-books", () => ({ getViewerBook, getOgData }));

const { getViewerBookCached, getOgDataCached } = await import("@/lib/viewer/cached-reads");

beforeEach(() => {
  getViewerBook.mockClear();
  getOgData.mockClear();
});

describe("cached public reads", () => {
  it("getViewerBookCached passes slug + access cookie through", async () => {
    await expect(getViewerBookCached("trip-abcdefghij", "tok")).resolves.toMatchObject({ bookId: null });
    expect(getViewerBook).toHaveBeenCalledWith("trip-abcdefghij", { accessCookie: "tok" });
    await getViewerBookCached("trip-abcdefghij", null);
    expect(getViewerBook).toHaveBeenLastCalledWith("trip-abcdefghij", { accessCookie: null });
  });

  it("getOgDataCached calls the slug-only reader", async () => {
    await getOgDataCached("trip-abcdefghij");
    expect(getOgData).toHaveBeenCalledWith("trip-abcdefghij");
  });
});
