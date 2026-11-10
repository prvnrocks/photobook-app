import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M6 T4b: owner publish actions (D-039 / D-040) over src/lib/db/publish.ts with a fake admin
// client (records every chain), so the real query shapes are asserted too.

type Result = { data: unknown; error: { code?: string; message?: string } | null };
type Chain = { table: string; op: string; payload?: unknown; calls: unknown[][] };

const fake = vi.hoisted(() => {
  const state = {
    chains: [] as Chain[],
    results: [] as Result[],
    user: null as { id: string } | null,
    mine: null as { id: string } | null,
    photos: [] as { id: string; status: string }[],
    learn: (async () => "updated") as (...a: unknown[]) => Promise<string>,
  };
  function builder(table: string, op: string, payload?: unknown) {
    const entry: Chain = { table, op, payload, calls: [] };
    state.chains.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "is", "filter", "select", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(state.results.shift() ?? { data: [], error: null }).then(resolve, reject);
    return b;
  }
  const admin = {
    from: (table: string) => ({
      select: (cols: string) => {
        const b = builder(table, "select");
        (b.select as (c: string) => unknown)(cols);
        return b;
      },
      update: (payload: unknown) => builder(table, "update", payload),
    }),
  };
  return { state, admin, revalidatePath: vi.fn(), learnFromBook: vi.fn() };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.admin }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => fake.state.user }));
vi.mock("@/lib/db/books", () => ({ getMyBook: async () => fake.state.mine }));
vi.mock("@/lib/db/photos", () => ({ listPlaceablePhotos: async () => fake.state.photos }));
vi.mock("@/lib/ai/learn-from-book", () => ({ learnFromBook: fake.learnFromBook }));
vi.mock("next/cache", () => ({ revalidatePath: fake.revalidatePath }));

const { publishBookAction, unpublishBookAction, setBookPasswordAction, getPublishState } = await import(
  "@/app/books/[id]/publish/actions"
);
const { verifyPassword } = await import("@/lib/publish/password");
const { isValidSlug } = await import("@/lib/publish/slug");
const { devPreviewDoc } = await import("@/lib/book/dev-preview");
const { addPage } = await import("@/lib/book/edit-ops");

const USER = "33333333-3333-4333-8333-333333333333";
const BOOK = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const SECRET = "SECRET_Private_Villa_Caption";
const PW = "SecretPw#9183";

function doc(pages?: number) {
  let d = devPreviewDoc();
  d = { ...d, cover: { ...d.cover, title: `Summer ${SECRET}` } };
  d = { ...d, pages: d.pages.map((p) => (p.caption ? { ...p, caption: { ...p.caption, text: SECRET } } : p)) };
  if (pages !== undefined) {
    while (d.pages.length > pages) d = { ...d, pages: d.pages.slice(0, -1) };
    while (d.pages.length < pages) d = addPage(d, d.pages.length - 1, "one-portrait", 100);
  }
  return d;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: BOOK,
    title: "Summer in Abu Dhabi",
    doc: doc(),
    doc_rev: 7,
    max_pages: 20,
    is_paid: false,
    slug: null,
    published_at: null,
    expires_at: null,
    published_rev: null,
    last_published_at: null,
    live_version: null,
    password_hash: null,
    ...over,
  };
}

const updates = () => fake.state.chains.filter((c) => c.op === "update");
let logs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://photobook.ae");
  fake.state.chains = [];
  fake.state.results = [];
  fake.state.user = { id: USER };
  fake.state.mine = { id: BOOK };
  fake.state.photos = Array.from({ length: 16 }, (_, i) => ({ id: `d${i}`, status: "kept" }));
  fake.learnFromBook.mockReset().mockResolvedValue("updated");
  fake.revalidatePath.mockReset();
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // no password, caption or title text ever reaches the logs
  for (const l of logs) {
    expect(l).not.toContain(SECRET);
    expect(l).not.toContain(PW);
    expect(l).not.toContain(BOOK);
  }
});

describe("publishBookAction", () => {
  it("first publish of a free book: one guarded admin UPDATE, expires_at = now + 30 d, new slug", async () => {
    fake.state.results.push({ data: row(), error: null }, { data: [{ id: BOOK }], error: null });
    const r = await publishBookAction(BOOK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expiry = new Date(NOW.getTime() + 30 * DAY).toISOString();
    expect(r.expiresAt).toBe(expiry);
    expect(isValidSlug(r.slug)).toBe(true);
    expect(r.slug.startsWith("summer-in-abu-dhabi-")).toBe(true);
    expect(r.url).toBe(`https://photobook.ae/b/${r.slug}`);

    const [read, upd] = fake.state.chains;
    expect(read).toMatchObject({ table: "books", op: "select" });
    expect(read.calls).toContainEqual(["eq", "user_id", USER]);
    expect(upd.payload).toMatchObject({
      published_rev: 7,
      last_published_at: NOW.toISOString(),
      published_at: NOW.toISOString(),
      expires_at: expiry,
      slug: r.slug,
    });
    // snapshot = public doc: no meta, no caption source
    const pub = (upd.payload as { published_doc: Record<string, unknown> }).published_doc;
    expect(pub).not.toHaveProperty("meta");
    expect(JSON.stringify(pub)).not.toContain('"source"');
    expect(upd.payload).not.toHaveProperty("doc");
    expect(upd.payload).not.toHaveProperty("doc_rev");
    expect(upd.calls).toEqual([
      ["eq", "id", BOOK],
      ["eq", "user_id", USER],
      ["eq", "doc_rev", 7],
      ["eq", "is_paid", false],
      ["is", "slug", null],
      ["is", "published_at", null],
      ["is", "expires_at", null],
      ["select", "id"],
    ]);
    expect(fake.learnFromBook).toHaveBeenCalledWith(USER, BOOK, "publish");
    expect(fake.revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(fake.revalidatePath).toHaveBeenCalledWith(`/b/${r.slug}`);
  });

  it("republish keeps slug, published_at and expires_at verbatim (never extended)", async () => {
    const slug = "summer-in-abu-dhabi-AbCdEfGh12";
    const first = "2026-11-01T09:00:00.123456+00:00";
    const exp = "2026-12-01T09:00:00.123456+00:00";
    fake.state.results.push(
      { data: row({ slug, published_at: first, expires_at: exp, published_rev: 3, live_version: 1, doc_rev: 9 }), error: null },
      { data: [{ id: BOOK }], error: null },
    );
    const r = await publishBookAction(BOOK);
    expect(r).toEqual({ ok: true, slug, url: `https://photobook.ae/b/${slug}`, expiresAt: exp });
    const upd = updates()[0];
    expect(upd.payload).toMatchObject({ slug, published_at: first, expires_at: exp, published_rev: 9 });
    expect(upd.calls).toContainEqual(["eq", "slug", slug]);
    expect(upd.calls).toContainEqual(["eq", "published_at", first]);
    expect(upd.calls).toContainEqual(["eq", "expires_at", exp]);
  });

  it("paid book → expires_at null (even if it had a free expiry before payment)", async () => {
    fake.state.results.push(
      { data: row({ is_paid: true, max_pages: 100, expires_at: "2026-12-01T00:00:00+00:00" }), error: null },
      { data: [{ id: BOOK }], error: null },
    );
    const r = await publishBookAction(BOOK);
    expect(r.ok && r.expiresAt).toBeNull();
    expect(updates()[0].payload).toMatchObject({ expires_at: null });
    expect(updates()[0].calls).toContainEqual(["eq", "is_paid", true]);
  });

  it("expired free book → expired, no write", async () => {
    fake.state.results.push({
      data: row({ slug: "x-AbCdEfGh12", published_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-31T00:00:00Z" }),
      error: null,
    });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "expired" });
    expect(updates()).toHaveLength(0);
    expect(fake.learnFromBook).not.toHaveBeenCalled();
  });

  it("foreign / missing book → not_found without touching the admin client", async () => {
    fake.state.mine = null;
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "not_found" });
    expect(fake.state.chains).toHaveLength(0);
    expect(await publishBookAction("not-a-uuid")).toEqual({ ok: false, error: "not_found" });
  });

  it("admin read finds no row for this owner → not_found", async () => {
    fake.state.results.push({ data: null, error: null });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "not_found" });
  });

  it("signed out → signed_out", async () => {
    fake.state.user = null;
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "signed_out" });
  });

  it("21-page free doc → page_limit; 0 pages → empty; broken doc → invalid_doc", async () => {
    fake.state.results.push({ data: row({ doc: doc(21) }), error: null });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "page_limit" });
    fake.state.results.push({ data: row({ doc: doc(0) }), error: null });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "empty" });
    fake.state.results.push({ data: row({ doc: {} }), error: null });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "invalid_doc" });
    expect(updates()).toHaveLength(0);
  });

  it("21-page paid doc (max_pages 100) publishes", async () => {
    fake.state.results.push({ data: row({ doc: doc(21), is_paid: true, max_pages: 100 }), error: null }, { data: [{ id: BOOK }], error: null });
    expect((await publishBookAction(BOOK)).ok).toBe(true);
  });

  it("a photo that isn't one of this book's ready photos → invalid_doc", async () => {
    fake.state.photos = fake.state.photos.filter((p) => p.id !== "d0"); // cover photo
    fake.state.results.push({ data: row(), error: null });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "invalid_doc" });
    expect(updates()).toHaveLength(0);
  });

  it("doc_rev changed mid-publish (0 rows) → conflict, no learning", async () => {
    fake.state.results.push({ data: row(), error: null }, { data: [], error: null });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "conflict" });
    expect(updates()).toHaveLength(1);
    expect(fake.learnFromBook).not.toHaveBeenCalled();
  });

  it("slug collision (23505) retries with a fresh slug, up to 5 attempts", async () => {
    fake.state.results.push(
      { data: row(), error: null },
      { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"books_slug_key\"" } },
      { data: null, error: { code: "23505" } },
      { data: [{ id: BOOK }], error: null },
    );
    const r = await publishBookAction(BOOK);
    expect(r.ok).toBe(true);
    const slugs = updates().map((u) => (u.payload as { slug: string }).slug);
    expect(slugs).toHaveLength(3);
    expect(new Set(slugs).size).toBe(3);
    expect(r.ok && r.slug).toBe(slugs[2]);
  });

  it("5 collisions in a row → failed", async () => {
    fake.state.results.push({ data: row(), error: null });
    for (let i = 0; i < 5; i++) fake.state.results.push({ data: null, error: { code: "23505" } });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "failed" });
    expect(updates()).toHaveLength(5);
  });

  it("23505 with an existing slug is not retried", async () => {
    fake.state.results.push(
      { data: row({ slug: "a-AbCdEfGh12", published_at: "2026-11-01T00:00:00Z", expires_at: "2026-12-01T00:00:00Z" }), error: null },
      { data: null, error: { code: "23505" } },
    );
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "failed" });
    expect(updates()).toHaveLength(1);
  });

  it("Arabic title → random-only slug", async () => {
    fake.state.results.push({ data: row({ title: "صيف أبوظبي" }), error: null }, { data: [{ id: BOOK }], error: null });
    const r = await publishBookAction(BOOK);
    expect(r.ok && r.slug).toMatch(/^[1-9A-HJ-NP-Za-km-z]{10}$/);
  });

  it("learnFromBook throwing or failing still returns ok", async () => {
    fake.learnFromBook.mockRejectedValueOnce(Object.assign(new Error(SECRET), { code: "boom" }));
    fake.state.results.push({ data: row(), error: null }, { data: [{ id: BOOK }], error: null });
    expect((await publishBookAction(BOOK)).ok).toBe(true);
    fake.learnFromBook.mockResolvedValueOnce("failed");
    fake.state.results.push({ data: row(), error: null }, { data: [{ id: BOOK }], error: null });
    expect((await publishBookAction(BOOK)).ok).toBe(true);
  });

  it("db error → failed with a code-only log", async () => {
    fake.state.results.push({ data: null, error: { code: "08006", message: SECRET } });
    expect(await publishBookAction(BOOK)).toEqual({ ok: false, error: "failed" });
    expect(logs.some((l) => l.includes("08006"))).toBe(true);
  });
});

describe("unpublishBookAction", () => {
  it("only clears published_doc (slug / published_at / expires_at stay)", async () => {
    fake.state.results.push({ data: [{ slug: "a-AbCdEfGh12" }], error: null });
    expect(await unpublishBookAction(BOOK)).toEqual({ ok: true });
    const [u] = updates();
    expect(u.payload).toEqual({ published_doc: null });
    expect(u.calls).toEqual([
      ["eq", "id", BOOK],
      ["eq", "user_id", USER],
      ["select", "slug"],
    ]);
    expect(fake.revalidatePath).toHaveBeenCalledWith("/b/a-AbCdEfGh12");
  });

  it("not the owner's → not_found", async () => {
    fake.state.mine = null;
    expect(await unpublishBookAction(BOOK)).toEqual({ ok: false, error: "not_found" });
    expect(updates()).toHaveLength(0);
  });
});

describe("setBookPasswordAction", () => {
  it("sets an scrypt hash (never the plaintext) and revalidates the viewer", async () => {
    fake.state.results.push({ data: [{ slug: "a-AbCdEfGh12" }], error: null });
    expect(await setBookPasswordAction(BOOK, PW)).toEqual({ ok: true, hasPassword: true });
    const hash = (updates()[0].payload as { password_hash: string }).password_hash;
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain(PW);
    expect(await verifyPassword(PW, hash)).toBe(true);
    expect(updates()[0].calls).toContainEqual(["eq", "user_id", USER]);
    expect(fake.revalidatePath).toHaveBeenCalledWith("/b/a-AbCdEfGh12");
  });

  it("null clears the password", async () => {
    fake.state.results.push({ data: [{ slug: null }], error: null });
    expect(await setBookPasswordAction(BOOK, null)).toEqual({ ok: true, hasPassword: false });
    expect(updates()[0].payload).toEqual({ password_hash: null });
  });

  it.each([
    ["abc", "too_short"],
    ["x".repeat(65), "too_long"],
    ["ab\ncd", "invalid_chars"],
    [42, "invalid_password"],
  ])("%j → %s, no write", async (pw, code) => {
    expect(await setBookPasswordAction(BOOK, pw as string)).toEqual({ ok: false, error: code });
    expect(updates()).toHaveLength(0);
  });

  it("foreign book → not_found before hashing", async () => {
    fake.state.mine = null;
    expect(await setBookPasswordAction(BOOK, PW)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("getPublishState", () => {
  it("never published", async () => {
    fake.state.results.push({ data: row(), error: null });
    const r = await getPublishState(BOOK);
    expect(r).toEqual({
      ok: true,
      state: expect.objectContaining({
        published: false,
        slug: null,
        url: null,
        hasChanges: false,
        expired: false,
        isPaid: false,
        hasPassword: false,
        publishedAt: null,
        canPublishReason: null,
        maxPages: 20,
      }),
    });
    // the read never selects the snapshot itself, only a JSON path
    expect(String(fake.state.chains[0].calls[0][1])).toContain("published_doc->version");
  });

  it("live + doc_rev bumped → hasChanges; password → hasPassword (hash not returned)", async () => {
    fake.state.results.push({
      data: row({
        slug: "a-AbCdEfGh12",
        published_at: "2026-11-01T00:00:00Z",
        expires_at: "2026-12-01T00:00:00Z",
        published_rev: 7,
        doc_rev: 8,
        live_version: 1,
        password_hash: "scrypt$32768$8$1$x$y",
      }),
      error: null,
    });
    const r = await getPublishState(BOOK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toMatchObject({ published: true, hasChanges: true, hasPassword: true, url: "https://photobook.ae/b/a-AbCdEfGh12" });
    expect(JSON.stringify(r)).not.toContain("scrypt");
  });

  it("same rev → no changes; expired free → expired + canPublishReason expired", async () => {
    fake.state.results.push({
      data: row({ slug: "a-AbCdEfGh12", published_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-31T00:00:00Z", published_rev: 7, live_version: 1 }),
      error: null,
    });
    const r = await getPublishState(BOOK);
    expect(r.ok && r.state).toMatchObject({ hasChanges: false, expired: true, canPublishReason: "expired" });
  });

  it("paid → never expired; 21 pages free → page_limit", async () => {
    fake.state.results.push({ data: row({ is_paid: true, expires_at: "2020-01-01T00:00:00Z" }), error: null });
    const paid = await getPublishState(BOOK);
    expect(paid.ok && paid.state).toMatchObject({ expired: false, isPaid: true, canPublishReason: null });
    fake.state.results.push({ data: row({ doc: doc(21) }), error: null });
    const r = await getPublishState(BOOK);
    expect(r.ok && r.state.canPublishReason).toBe("page_limit");
  });

  it("not_found / signed_out", async () => {
    fake.state.mine = null;
    expect(await getPublishState(BOOK)).toEqual({ ok: false, error: "not_found" });
    fake.state.user = null;
    expect(await getPublishState(BOOK)).toEqual({ ok: false, error: "signed_out" });
  });
});
