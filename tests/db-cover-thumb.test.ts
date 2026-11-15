import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M21 T1: one signed cover thumb for the share preview — RLS (user) client only, one photos
// lookup + one createSignedUrl with COVER_THUMB_TTL_SECONDS; any problem → null, never a throw.

type Result = { data: unknown; error: { code?: string } | null };

const fake = vi.hoisted(() => {
  const state = {
    chains: [] as { table: string; calls: unknown[][] }[],
    results: [] as Result[],
    signCalls: [] as { bucket: string; path: string; ttl: number }[],
    signResult: null as null | { data: unknown; error: unknown },
    signThrows: false,
    adminUsed: false,
  };
  function builder(table: string) {
    const entry = { table, calls: [] as unknown[][] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "in", "select", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(state.results.shift() ?? { data: null, error: null }).then(resolve, reject);
    return b;
  }
  const client = {
    from: (table: string) => ({
      select: (cols: string) => {
        const b = builder(table);
        (b.select as (c: string) => unknown)(cols);
        return b;
      },
    }),
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => {
          state.signCalls.push({ bucket, path, ttl });
          if (state.signThrows) throw new Error("network");
          if (state.signResult) return state.signResult;
          return { data: { signedUrl: `https://signed/${path}` }, error: null };
        },
      }),
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    fake.state.adminUsed = true;
    throw new Error("admin client must not be used");
  },
}));

const { getCoverThumbUrl, coverPhotoIdOfDoc } = await import("@/lib/db/cover-thumb");
const { COVER_THUMB_TTL_SECONDS } = await import("@/lib/db/books");
const { PHOTOS_BUCKET } = await import("@/lib/db/photos");

const BOOK = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const docWith = (coverPhoto: string | null, pages: { slots: { photoId: string | null }[] }[] = []) => ({
  cover: { title: "x", photoId: coverPhoto },
  pages,
});

beforeEach(() => {
  fake.state.chains = [];
  fake.state.results = [];
  fake.state.signCalls = [];
  fake.state.signResult = null;
  fake.state.signThrows = false;
  fake.state.adminUsed = false;
});

describe("coverPhotoIdOfDoc", () => {
  it("cover photo first, else the first slot photo in page/slot order", () => {
    expect(coverPhotoIdOfDoc(docWith(P1, [{ slots: [{ photoId: P2 }] }]))).toBe(P1);
    expect(coverPhotoIdOfDoc(docWith(null, [{ slots: [{ photoId: null }] }, { slots: [{ photoId: null }, { photoId: P2 }] }]))).toBe(P2);
    expect(coverPhotoIdOfDoc(docWith(null, [{ slots: [] }]))).toBeNull();
  });

  it("malformed docs / non-uuid ids → null", () => {
    expect(coverPhotoIdOfDoc(null)).toBeNull();
    expect(coverPhotoIdOfDoc("doc")).toBeNull();
    expect(coverPhotoIdOfDoc({ cover: { photoId: "d0" }, pages: "x" })).toBeNull();
    expect(coverPhotoIdOfDoc({ pages: [null, { slots: [7, { photoId: 3 }] }] })).toBeNull();
  });
});

describe("getCoverThumbUrl", () => {
  it("signs the ready thumb of this book's cover photo with the user client and the cover TTL", async () => {
    fake.state.results.push({ data: { id: P1, book_id: BOOK, thumb_path: "u/b/p1_thumb.jpg" }, error: null });
    expect(await getCoverThumbUrl(BOOK, docWith(P1))).toBe("https://signed/u/b/p1_thumb.jpg");
    expect(fake.state.chains).toHaveLength(1);
    expect(fake.state.chains[0].table).toBe("photos");
    expect(fake.state.chains[0].calls).toContainEqual(["eq", "id", P1]);
    expect(fake.state.chains[0].calls).toContainEqual(["eq", "upload_state", "ready"]);
    expect(fake.state.signCalls).toEqual([{ bucket: PHOTOS_BUCKET, path: "u/b/p1_thumb.jpg", ttl: COVER_THUMB_TTL_SECONDS }]);
    expect(fake.state.adminUsed).toBe(false);
  });

  it("no photo in the doc / bad book id → null without any query", async () => {
    expect(await getCoverThumbUrl(BOOK, docWith(null))).toBeNull();
    expect(await getCoverThumbUrl("nope", docWith(P1))).toBeNull();
    expect(fake.state.chains).toHaveLength(0);
    expect(fake.state.signCalls).toHaveLength(0);
  });

  it("photo missing / not ready / another book's / no thumb → null, nothing signed", async () => {
    fake.state.results.push(
      { data: null, error: null },
      { data: { id: P1, book_id: OTHER, thumb_path: "x" }, error: null },
      { data: { id: P1, book_id: BOOK, thumb_path: null }, error: null },
      { data: null, error: { code: "PGRST000" } },
    );
    for (let i = 0; i < 4; i++) expect(await getCoverThumbUrl(BOOK, docWith(P1))).toBeNull();
    expect(fake.state.signCalls).toHaveLength(0);
  });

  it("signing error or throw → null", async () => {
    fake.state.results.push({ data: { id: P1, book_id: BOOK, thumb_path: "t" }, error: null });
    fake.state.signResult = { data: null, error: { message: "denied" } };
    expect(await getCoverThumbUrl(BOOK, docWith(P1))).toBeNull();

    fake.state.results.push({ data: { id: P1, book_id: BOOK, thumb_path: "t" }, error: null });
    fake.state.signResult = null;
    fake.state.signThrows = true;
    expect(await getCoverThumbUrl(BOOK, docWith(P1))).toBeNull();
  });
});
