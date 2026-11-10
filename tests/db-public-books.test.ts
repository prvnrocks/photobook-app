import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

// In-memory fake of the admin client: books/photos tables with real filtering + column
// projection, get_published_book mirroring the SQL, and a recording storage signer.
const fake = vi.hoisted(() => {
  const state = {
    books: [] as Row[],
    photos: [] as Row[],
    selects: [] as { table: string; cols: string }[],
    rpcs: [] as { fn: string; args: Record<string, unknown> }[],
    signCalls: [] as { bucket: string; paths: string[]; ttl: number }[],
    queryCount: 0,
    user: null as { id: string } | null,
    now: Date.now(),
    clearResult: { data: true, error: null } as { data: unknown; error: { code?: string } | null },
  };

  function query(table: string, cols: string) {
    state.queryCount++;
    state.selects.push({ table, cols });
    const filters: ((r: Row) => boolean)[] = [];
    let single = false;
    const project = (r: Row) => {
      const out: Row = {};
      for (const c of cols.split(",").map((s) => s.trim())) out[c] = r[c] ?? null;
      return out;
    };
    const run = () => {
      const src = table === "books" ? state.books : state.photos;
      const rows = src.filter((r) => filters.every((f) => f(r))).map(project);
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    };
    const b = {
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
      not: (c: string, op: string, v: unknown) => {
        if (op !== "is" || v !== null) throw new Error("unsupported not()");
        filters.push((r) => r[c] !== null && r[c] !== undefined);
        return b;
      },
      maybeSingle: () => ((single = true), b),
      then: (res: (r: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  function getPublishedBook(slug: string) {
    const b = state.books.find((r) => r.slug === slug && r.published_doc != null && r.published_at != null);
    if (!b) return [];
    const exp = b.expires_at as string | null;
    const isExpired = !b.is_paid && exp !== null && Date.parse(exp) <= state.now;
    const hasPassword = b.password_hash != null;
    const doc = b.published_doc as { pages?: unknown[] };
    return [
      {
        id: b.id,
        slug: b.slug,
        title: b.title,
        caption_lang: b.caption_lang,
        is_paid: b.is_paid,
        page_count: Array.isArray(doc.pages) ? doc.pages.length : 0,
        published_rev: b.published_rev,
        published_at: b.published_at,
        expires_at: b.expires_at,
        is_expired: isExpired,
        has_password: hasPassword,
        doc: isExpired || hasPassword ? null : b.published_doc,
      },
    ];
  }

  const admin = {
    from: (table: string) => ({ select: (cols: string) => query(table, cols) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.queryCount++;
      state.rpcs.push({ fn, args });
      if (fn === "get_published_book") return { data: getPublishedBook(args.p_slug as string), error: null };
      if (fn === "clear_unlock_attempt") return state.clearResult;
      return { data: null, error: { code: "42883" } };
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[], ttl: number) => {
          state.signCalls.push({ bucket, paths, ttl });
          return { data: paths.map((p) => ({ path: p, signedUrl: `https://signed.test/${p}?t=1`, error: null })), error: null };
        },
      }),
    },
  };
  const server = {
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  };
  return { state, admin, server };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.server }));

const { getViewerBook, getOgData, isViewerOwner, clearUnlockAttempt, VIEWER_URL_TTL_SECONDS } = await import("@/lib/db/public-books");
const { APP_NAME } = await import("@/lib/brand");
const { hashPassword, passwordFingerprint } = await import("@/lib/publish/password");
const { signAccess, accessExpiry } = await import("@/lib/publish/access-cookie");

const SECRET = "test-secret-test-secret-test-secret-0123";
const OWNER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const OTHER_BOOK = "99999999-9999-4999-8999-999999999999";
const P1 = "33333333-3333-4333-8333-333333333331";
const P2 = "33333333-3333-4333-8333-333333333332";
const P_UNUSED = "33333333-3333-4333-8333-333333333333";
const P_PENDING = "33333333-3333-4333-8333-333333333334";
const P_FOREIGN = "44444444-4444-4444-8444-444444444444";
const SLUG = "our-trip-AbCdEfGhJk";

function publicDoc(photoIds: { cover: string | null; pages: string[] }) {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    cover: { layout: "cover", photoId: photoIds.cover, title: "Our Trip", subtitle: "" },
    chapters: [{ id: "c1", title: "Day one", dateLabel: "March 2025" }],
    pages: photoIds.pages.map((id, i) => ({
      id: `p${i}`,
      chapterId: "c1",
      layout: "full-page",
      slots: [{ photoId: id, crop: { x: 0.5, y: 0.5, zoom: 1 } }],
      caption: { text: "Sun and sand", font: "Playfair", align: "center" },
    })),
    style: { background: "#FAF7F2", font: "Playfair" },
  };
}

function photo(id: string, bookId: string, extra: Row = {}): Row {
  return {
    id,
    book_id: bookId,
    user_id: OWNER,
    upload_state: "ready",
    web_path: `${OWNER}/${bookId}/${id}/web.jpg`,
    thumb_path: `${OWNER}/${bookId}/${id}/thumb.jpg`,
    original_path: `${OWNER}/${bookId}/${id}/original.jpg`,
    width: 4000,
    height: 3000,
    lat: 24.45,
    lng: 54.38,
    taken_at: "2025-03-01T10:00:00Z",
    place: "Abu Dhabi",
    camera: "iPhone",
    ai: { description: "secret" },
    ...extra,
  };
}

function book(extra: Row = {}): Row {
  return {
    id: BOOK,
    user_id: OWNER,
    slug: SLUG,
    title: "Our trip",
    caption_lang: "en",
    is_paid: false,
    published_at: "2026-11-01T00:00:00Z",
    expires_at: new Date(fake.state.now + 86400_000).toISOString(),
    published_rev: 3,
    published_doc: publicDoc({ cover: P1, pages: [P1, P2] }),
    password_hash: null,
    doc: { meta: { generator: "ai" } },
    ...extra,
  };
}

const FORBIDDEN_KEYS = [
  "user_id", "userId", "original_path", "web_path", "thumb_path", "lat", "lng", "taken_at",
  "ai", "meta", "place", "camera", "password_hash", "bookId", "id_book",
];

function deepKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) deepKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      deepKeys(x, out);
    }
  }
  return out;
}

function expectClean(dto: unknown) {
  const keys = deepKeys(dto);
  for (const k of FORBIDDEN_KEYS) expect(keys, `key ${k}`).not.toContain(k);
  // Signed URLs are the only values allowed to carry a storage path (Supabase embeds the object
  // path `{user}/{book}/{photo}-web.jpg` in them — known, flagged to the orchestrator); every URL
  // must point at a web copy. Outside URLs: no ids or paths at all.
  const urls: string[] = [];
  const json = JSON.stringify(dto, (k, v) => (k === "url" || k === "coverUrl") && typeof v === "string" ? (urls.push(v), "<url>") : v);
  for (const u of urls) expect(u).toMatch(/\/web\.jpg\?/);
  expect(json).not.toContain(OWNER);
  expect(json).not.toContain(BOOK);
  expect(json).not.toContain("original");
  expect(json).not.toContain("thumb");
}

let prevSecret: string | undefined;
let HASH = "";
beforeAll(async () => {
  prevSecret = process.env.BOOK_ACCESS_SECRET;
  process.env.BOOK_ACCESS_SECRET = SECRET;
  HASH = await hashPassword("open sesame");
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.BOOK_ACCESS_SECRET;
  else process.env.BOOK_ACCESS_SECRET = prevSecret;
});

beforeEach(() => {
  fake.state.now = Date.now();
  fake.state.books = [book()];
  fake.state.photos = [
    photo(P1, BOOK),
    photo(P2, BOOK),
    photo(P_UNUSED, BOOK),
    photo(P_PENDING, BOOK, { upload_state: "pending" }),
    photo(P_FOREIGN, OTHER_BOOK),
  ];
  fake.state.selects = [];
  fake.state.rpcs = [];
  fake.state.signCalls = [];
  fake.state.queryCount = 0;
  fake.state.user = null;
  fake.state.clearResult = { data: true, error: null };
});

const cookieFor = (hash: string, bookId = BOOK) =>
  signAccess({ bookId, fingerprint: passwordFingerprint(hash), exp: accessExpiry(fake.state.now) }) as string;

describe("getViewerBook", () => {
  it("returns the snapshot with signed web URLs, internal bookId split from the DTO", async () => {
    const r = await getViewerBook(SLUG);
    expect(r.bookId).toBe(BOOK);
    expect(r.book.state).toBe("ok");
    // Snapshot cover title (D-039), not the live books.title ("Our trip").
    expect(r.book.title).toBe("Our Trip");
    expect(r.book.pageCount).toBe(2);
    expect(r.book.publishedRev).toBe(3);
    expect(r.book.hasPassword).toBe(false);
    expect(r.book.doc?.pages).toHaveLength(2);
    expect(Object.keys(r.book.photos).sort()).toEqual([P1, P2]);
    expect(r.book.photos[P1]).toEqual({ url: `https://signed.test/${OWNER}/${BOOK}/${P1}/web.jpg?t=1`, width: 4000, height: 3000 });
    expect(fake.state.signCalls).toHaveLength(1);
    expect(fake.state.signCalls[0].ttl).toBe(VIEWER_URL_TTL_SECONDS);
    expect(VIEWER_URL_TTL_SECONDS).toBe(21600);
    expectClean(r.book);
  });

  it("never selects private photo/book columns", async () => {
    await getViewerBook(SLUG);
    fake.state.books = [book({ password_hash: HASH })];
    await getViewerBook(SLUG, { accessCookie: cookieFor(HASH) });
    const cols = fake.state.selects.map((s) => s.cols).join(",");
    for (const c of ["user_id", "original_path", "thumb_path", "lat", "lng", "taken_at", "ai", "camera", "meta", "place", "doc"]) {
      expect(cols.split(",").map((x) => x.trim()), c).not.toContain(c);
    }
  });

  it("invalid slug → not_found without any DB call", async () => {
    for (const s of ["", "x", "../etc", "Our-Trip-AbCdEfGhJk", "our-trip-AbCdEfGhJ0", "a".repeat(60)]) {
      const r = await getViewerBook(s);
      expect(r).toEqual({ bookId: null, book: expect.objectContaining({ state: "not_found", doc: null, photos: {} }) });
    }
    expect(fake.state.queryCount).toBe(0);
  });

  it("unknown or unpublished slug → not_found", async () => {
    expect((await getViewerBook("other-book-AbCdEfGhJk")).book.state).toBe("not_found");
    fake.state.books = [book({ published_doc: null })];
    expect((await getViewerBook(SLUG)).book.state).toBe("not_found");
  });

  it("expired free book → no doc, no photos, no title, no signing", async () => {
    fake.state.books = [book({ expires_at: new Date(fake.state.now - 1000).toISOString() })];
    const r = await getViewerBook(SLUG);
    expect(r.book).toMatchObject({ state: "expired", doc: null, photos: {}, title: null, pageCount: null });
    expect(r.bookId).toBe(BOOK);
    expect(fake.state.signCalls).toHaveLength(0);
    expectClean(r.book);
  });

  it("paid book past expires_at is still ok", async () => {
    fake.state.books = [book({ is_paid: true, expires_at: new Date(fake.state.now - 1000).toISOString() })];
    const r = await getViewerBook(SLUG);
    expect(r.book.state).toBe("ok");
    expect(r.book.expiresAt).toBeNull();
  });

  it("password book without cookie → locked, no doc query, no signing", async () => {
    fake.state.books = [book({ password_hash: HASH })];
    const r = await getViewerBook(SLUG);
    expect(r.book).toMatchObject({ state: "locked", doc: null, photos: {}, title: null, hasPassword: true });
    expect(fake.state.selects).toHaveLength(0);
    expect(fake.state.signCalls).toHaveLength(0);
    expectClean(r.book);
  });

  it("password book with a valid cookie → doc + photos", async () => {
    fake.state.books = [book({ password_hash: HASH })];
    const r = await getViewerBook(SLUG, { accessCookie: cookieFor(HASH), now: fake.state.now });
    expect(r.book.state).toBe("ok");
    expect(r.book.hasPassword).toBe(true);
    expect(r.book.doc?.pages).toHaveLength(2);
    expect(Object.keys(r.book.photos).sort()).toEqual([P1, P2]);
    expectClean(r.book);
  });

  it("tampered cookie → locked", async () => {
    fake.state.books = [book({ password_hash: HASH })];
    const good = cookieFor(HASH);
    const [v, payload, mac] = good.split(".");
    const flipped = mac[0] === "A" ? `B${mac.slice(1)}` : `A${mac.slice(1)}`;
    for (const bad of [`${v}.${payload}.${flipped}`, `${good}x`, "garbage", cookieFor(HASH, OTHER_BOOK)]) {
      const r = await getViewerBook(SLUG, { accessCookie: bad });
      expect(r.book.state).toBe("locked");
      expect(r.book.doc).toBeNull();
    }
    expect(fake.state.signCalls).toHaveLength(0);
  });

  it("password change → old cookie locked", async () => {
    const oldCookie = cookieFor(HASH);
    const newHash = await hashPassword("open sesame");
    fake.state.books = [book({ password_hash: newHash })];
    expect((await getViewerBook(SLUG, { accessCookie: oldCookie })).book.state).toBe("locked");
    expect((await getViewerBook(SLUG, { accessCookie: cookieFor(newHash) })).book.state).toBe("ok");
  });

  it("expired password book with a valid cookie → expired", async () => {
    fake.state.books = [book({ password_hash: HASH, expires_at: new Date(fake.state.now - 1).toISOString() })];
    const r = await getViewerBook(SLUG, { accessCookie: cookieFor(HASH) });
    expect(r.book.state).toBe("expired");
    expect(r.book.doc).toBeNull();
  });

  it("signs only snapshot photos of this book that are ready, in ONE call", async () => {
    fake.state.books = [book({ published_doc: publicDoc({ cover: P_FOREIGN, pages: [P1, P_FOREIGN, P_PENDING, P2, P1] }) })];
    const r = await getViewerBook(SLUG);
    expect(r.book.state).toBe("ok");
    expect(Object.keys(r.book.photos).sort()).toEqual([P1, P2]);
    expect(fake.state.signCalls).toHaveLength(1);
    const paths = fake.state.signCalls[0].paths;
    expect(paths.sort()).toEqual([`${OWNER}/${BOOK}/${P1}/web.jpg`, `${OWNER}/${BOOK}/${P2}/web.jpg`]);
    expect(paths.join()).not.toContain(OTHER_BOOK);
    expect(paths.join()).not.toContain(P_UNUSED);
  });

  it("snapshot that fails the strict schema → unavailable, nothing signed", async () => {
    const doc = publicDoc({ cover: P1, pages: [P1] }) as Row;
    doc.meta = { generator: "ai" };
    fake.state.books = [book({ published_doc: doc })];
    const r = await getViewerBook(SLUG);
    expect(r.book).toMatchObject({ state: "unavailable", doc: null, photos: {} });
    expect(fake.state.signCalls).toHaveLength(0);
  });

  it("captionLang is normalised (old snapshot without captionLang → live column)", async () => {
    fake.state.books = [book({ caption_lang: "ar" })];
    expect((await getViewerBook(SLUG)).book.captionLang).toBe("ar");
    fake.state.books = [book({ caption_lang: "xx" })];
    expect((await getViewerBook(SLUG)).book.captionLang).toBe("en");
  });

  it("title comes from the snapshot even when the live books.title differs (D-039)", async () => {
    fake.state.books = [book({ title: "Unpublished new title" })];
    const r = await getViewerBook(SLUG);
    expect(r.book.title).toBe("Our Trip");
    expect(JSON.stringify(r.book)).not.toContain("Unpublished new title");
  });

  it("empty / blank snapshot cover title → APP_NAME (never the live books.title)", async () => {
    const doc = publicDoc({ cover: P1, pages: [P1] });
    doc.cover.title = "   ";
    fake.state.books = [book({ title: "Live title", published_doc: doc })];
    const r = await getViewerBook(SLUG);
    expect(r.book.title).toBe(APP_NAME);
    const og = await getOgData(SLUG);
    expect(og.title).toBeNull();
    expect(JSON.stringify([r.book, og])).not.toContain("Live title");
  });

  it("snapshot captionLang wins over the live caption_lang (D-039)", async () => {
    fake.state.books = [book({ caption_lang: "en", published_doc: { ...publicDoc({ cover: P1, pages: [P1] }), captionLang: "ar" } })];
    expect((await getViewerBook(SLUG)).book.captionLang).toBe("ar");
    expect((await getOgData(SLUG)).captionLang).toBe("ar");
    fake.state.books = [book({ caption_lang: "ar", published_doc: { ...publicDoc({ cover: P1, pages: [P1] }), captionLang: "en" } })];
    expect((await getViewerBook(SLUG)).book.captionLang).toBe("en");
    expect((await getOgData(SLUG)).captionLang).toBe("en");
  });

  it("old snapshot without captionLang still parses and renders", async () => {
    const doc = publicDoc({ cover: P1, pages: [P1, P2] });
    expect(doc).not.toHaveProperty("captionLang");
    fake.state.books = [book({ caption_lang: "ar", published_doc: doc })];
    const r = await getViewerBook(SLUG);
    expect(r.book.state).toBe("ok");
    expect(r.book.doc).not.toHaveProperty("captionLang");
    expect(r.book.captionLang).toBe("ar");
  });

  it("snapshot with an invalid captionLang → unavailable (strict schema)", async () => {
    fake.state.books = [book({ published_doc: { ...publicDoc({ cover: P1, pages: [P1] }), captionLang: "fr" } })];
    expect((await getViewerBook(SLUG)).book.state).toBe("unavailable");
  });
});

describe("clearUnlockAttempt", () => {
  it("calls clear_unlock_attempt with the pair; true → cleared, false → none", async () => {
    expect(await clearUnlockAttempt(BOOK, "iphash")).toBe("cleared");
    expect(fake.state.rpcs).toEqual([{ fn: "clear_unlock_attempt", args: { p_book: BOOK, p_ip_hash: "iphash" } }]);
    fake.state.clearResult = { data: false, error: null };
    expect(await clearUnlockAttempt(BOOK, "iphash")).toBe("none");
  });

  it.each(["PGRST202", "42883"])("missing function (%s, migration 1100 not applied) → 'missing', no throw", async (code) => {
    fake.state.clearResult = { data: null, error: { code } };
    expect(await clearUnlockAttempt(BOOK, "iphash")).toBe("missing");
  });

  it("other errors throw a code-only PublicBooksQueryError", async () => {
    fake.state.clearResult = { data: null, error: { code: "57014" } };
    await expect(clearUnlockAttempt(BOOK, "iphash")).rejects.toThrow("Failed to clear unlock attempt (57014)");
  });
});

describe("getOgData", () => {
  it("ok → title + signed cover", async () => {
    const og = await getOgData(SLUG);
    expect(og).toMatchObject({ state: "ok", title: "Our Trip", isPaid: false, hasPassword: false, publishedRev: 3 });
    expect(og.coverUrl).toBe(`https://signed.test/${OWNER}/${BOOK}/${P1}/web.jpg?t=1`);
    expect(fake.state.signCalls).toHaveLength(1);
    expectClean(og);
  });

  it("title is the snapshot cover title even when the live books.title differs (D-039)", async () => {
    fake.state.books = [book({ title: "Unpublished new title" })];
    const og = await getOgData(SLUG);
    expect(og.title).toBe("Our Trip");
  });

  it("password / expired → no title, no cover, no signing", async () => {
    fake.state.books = [book({ password_hash: HASH })];
    expect(await getOgData(SLUG)).toMatchObject({ state: "locked", title: null, coverUrl: null, hasPassword: true });
    fake.state.books = [book({ expires_at: new Date(fake.state.now - 1).toISOString() })];
    expect(await getOgData(SLUG)).toMatchObject({ state: "expired", title: null, coverUrl: null });
    expect(fake.state.signCalls).toHaveLength(0);
  });

  it("invalid slug → not_found without DB calls", async () => {
    expect((await getOgData("nope")).state).toBe("not_found");
    expect(fake.state.queryCount).toBe(0);
  });
});

describe("isViewerOwner", () => {
  it("true only for the signed-in owner", async () => {
    expect(await isViewerOwner(BOOK)).toBe(false);
    fake.state.user = { id: "55555555-5555-4555-8555-555555555555" };
    expect(await isViewerOwner(BOOK)).toBe(false);
    fake.state.user = { id: OWNER };
    expect(await isViewerOwner(BOOK)).toBe(true);
    expect(await isViewerOwner("not-a-uuid")).toBe(false);
  });
});
