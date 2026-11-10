import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OgData } from "@/lib/db/public-books";

vi.mock("server-only", () => ({}));

const getOgData = vi.hoisted(() => vi.fn<(slug: string) => Promise<OgData>>());
vi.mock("@/lib/db/public-books", () => ({ getOgData }));

const SUPABASE = "https://proj.supabase.co";
const SITE = "https://photobook.example.ae";
const SLUG = "eid-at-home-7KxP2mQr9Z";
const COVER_URL = `${SUPABASE}/storage/v1/object/sign/photos/u/b/web.jpg?token=t`;

function pngSize(buf: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(buf);
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(b.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// A web-copy-sized (1600×1067, ~350 KB) synthetic photo with texture + grain
// (tests/fixtures/make-og-cover.mjs) — photo content is the worst case for PNG output size.
const COVER = readFileSync(fileURLToPath(new URL("./fixtures/og-cover.jpg", import.meta.url)));
// Same scene without texture/grain — low-detail covers fit the full 1200×630 size.
const SMOOTH_COVER = readFileSync(fileURLToPath(new URL("./fixtures/og-cover-smooth.jpg", import.meta.url)));

const okData = (over: Partial<OgData> = {}): OgData => ({
  state: "ok",
  title: "Summer in Abu Dhabi",
  coverUrl: COVER_URL,
  isPaid: false,
  publishedRev: 3,
  hasPassword: false,
  captionLang: "en",
  ...over,
});

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", SITE);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(new Uint8Array(COVER), { headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetchMock);
  getOgData.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("buildBookMetadata", () => {
  it("ok: book title, absolute OG image with version, large card, noindex", async () => {
    const { buildBookMetadata } = await import("@/lib/viewer/metadata");
    const m = buildBookMetadata(SLUG, okData());
    expect(m.title).toEqual({ absolute: "Summer in Abu Dhabi" });
    expect(m.description).toBe("A photobook made with Photobook — tap to flip through");
    expect(String(m.metadataBase)).toBe(`${SITE}/`);
    expect(m.robots).toEqual({ index: false, follow: false });
    const og = m.openGraph as Record<string, unknown>;
    expect(og.type).toBe("website");
    expect(og.url).toBe(`${SITE}/b/${SLUG}`);
    expect(og.title).toBe("Summer in Abu Dhabi");
    const [img] = og.images as { url: string; width: number; height: number; alt: string }[];
    expect(img).toMatchObject({ url: `${SITE}/b/${SLUG}/og?v=3-0`, width: 1200, height: 630 });
    expect(new URL(img.url).origin).toBe(SITE);
    expect(img.alt).toContain("Summer in Abu Dhabi");
    const tw = m.twitter as Record<string, unknown>;
    expect(tw.card).toBe("summary_large_image");
    expect((tw.images as { url: string }[])[0].url).toBe(img.url);
  });

  it("locked (password): generic title, never the book title, version marks the password", async () => {
    const { buildBookMetadata } = await import("@/lib/viewer/metadata");
    // Even if a caller passed a title by mistake, locked must not leak it.
    const m = buildBookMetadata(SLUG, okData({ state: "locked", title: "Secret wedding", coverUrl: null, hasPassword: true }));
    expect(JSON.stringify(m)).not.toContain("Secret wedding");
    expect(m.title).toEqual({ absolute: "A private photobook" });
    const og = m.openGraph as { images: { url: string; alt: string }[]; title: string };
    expect(og.title).toBe("A private photobook");
    expect(og.images[0].url).toBe(`${SITE}/b/${SLUG}/og?v=3-1`);
    expect(og.images[0].alt).toBe("Photobook");
  });

  it("expired and not_found: generic titles, no book title", async () => {
    const { buildBookMetadata } = await import("@/lib/viewer/metadata");
    const exp = buildBookMetadata(SLUG, okData({ state: "expired", title: "Old trip", coverUrl: null }));
    expect(exp.title).toEqual({ absolute: "Photobook expired" });
    expect(JSON.stringify(exp)).not.toContain("Old trip");
    const nf = buildBookMetadata(SLUG, okData({ state: "not_found", title: null, coverUrl: null, publishedRev: null }));
    expect(nf.title).toEqual({ absolute: "Photobook not found" });
    expect((nf.openGraph as { images: { url: string }[] }).images[0].url).toBe(`${SITE}/b/${SLUG}/og?v=0-0`);
  });

  it("Arabic title passes through to og:title", async () => {
    const { buildBookMetadata } = await import("@/lib/viewer/metadata");
    const m = buildBookMetadata(SLUG, okData({ title: "عيد في البيت" }));
    expect((m.openGraph as { title: string }).title).toBe("عيد في البيت");
  });

  it("invalid slug is never echoed into URLs", async () => {
    const { buildBookMetadata } = await import("@/lib/viewer/metadata");
    const m = buildBookMetadata("../evil?x=<script>", okData({ state: "not_found", title: null }));
    expect(JSON.stringify(m)).not.toContain("evil");
    expect(m.robots).toEqual({ index: false, follow: false });
  });
});

describe("og title rules", () => {
  it("draws Latin titles, skips Arabic/emoji (no runtime font fetch), clips long ones", async () => {
    const { ogDrawableTitle } = await import("@/lib/viewer/og-image");
    expect(ogDrawableTitle("  Café  days ")).toBe("Café days");
    expect(ogDrawableTitle("عيد في البيت")).toBeNull();
    expect(ogDrawableTitle("Eid عيد")).toBeNull();
    expect(ogDrawableTitle("Beach 🏖️")).toBeNull();
    expect(ogDrawableTitle(null)).toBeNull();
    expect(Array.from(ogDrawableTitle("a".repeat(200)) ?? "").length).toBeLessThanOrEqual(61);
  });
});

describe("fetchCoverDataUrl", () => {
  it("rejects other origins without fetching", async () => {
    const { fetchCoverDataUrl } = await import("@/lib/viewer/og-image");
    expect(await fetchCoverDataUrl("https://evil.example/x.jpg")).toBeNull();
    expect(await fetchCoverDataUrl("not a url")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the size cap and the image sniff", async () => {
    const { fetchCoverDataUrl } = await import("@/lib/viewer/og-image");
    expect(await fetchCoverDataUrl(COVER_URL, { maxBytes: 1000 })).toBeNull();
    fetchMock.mockImplementationOnce(async () => new Response("<html>"));
    expect(await fetchCoverDataUrl(COVER_URL)).toBeNull();
    fetchMock.mockImplementationOnce(async () => new Response("x", { status: 403 }));
    expect(await fetchCoverDataUrl(COVER_URL)).toBeNull();
    expect(await fetchCoverDataUrl(COVER_URL)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("times out", async () => {
    const { fetchCoverDataUrl } = await import("@/lib/viewer/og-image");
    fetchMock.mockImplementationOnce(
      (_u, init) =>
        new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal?.reason))),
    );
    expect(await fetchCoverDataUrl(COVER_URL, { timeoutMs: 50 })).toBeNull();
  });
});

describe("GET /b/[slug]/og", () => {
  async function get(slug = SLUG) {
    const { GET } = await import("@/app/b/[slug]/og/route");
    const res = await GET(new Request(`${SITE}/b/${slug}/og`), { params: Promise.resolve({ slug }) });
    const body = new Uint8Array(await res.arrayBuffer());
    return { res, body };
  }

  it("ok (smooth cover): PNG 1200×630 under 600 KB with long cache", { timeout: 30_000 }, async () => {
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(SMOOTH_COVER)));
    getOgData.mockResolvedValue(okData());
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=86400, stale-while-revalidate=604800");
    expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
    expect(body.byteLength).toBeLessThan(600 * 1024);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(COVER_URL);
  });

  it("ok (textured photo): steps down in size, keeps 1.91:1 and stays under 600 KB", { timeout: 60_000 }, async () => {
    getOgData.mockResolvedValue(okData());
    const { res, body } = await get();
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
    const { width, height } = pngSize(body);
    expect([1200, 800, 600]).toContain(width);
    expect(width / height).toBeCloseTo(1200 / 630, 1);
    expect(body.byteLength).toBeLessThan(600 * 1024);
  });

  it("locked: generic card, no cover fetch, short cache", { timeout: 30_000 }, async () => {
    getOgData.mockResolvedValue(okData({ state: "locked", title: null, coverUrl: null, hasPassword: true }));
    const { res, body } = await get();
    expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Arabic title: renders photo + brand without throwing or fetching fonts", { timeout: 30_000 }, async () => {
    getOgData.mockResolvedValue(okData({ title: "عيد في البيت" }));
    const { res, body } = await get();
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
    expect(pngSize(body).width / pngSize(body).height).toBeCloseTo(1200 / 630, 1);
    // Only the cover was fetched — no Google Fonts request for Arabic glyphs.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cover fetch failure and DB errors fall back to the generic card", { timeout: 30_000 }, async () => {
    getOgData.mockResolvedValue(okData());
    fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
    const a = await get();
    expect(a.res.headers.get("cache-control")).toContain("s-maxage=300");
    expect(pngSize(a.body)).toEqual({ width: 1200, height: 630 });

    getOgData.mockRejectedValue(new Error("db down"));
    const b = await get();
    expect(b.res.status).toBe(200);
    expect(pngSize(b.body)).toEqual({ width: 1200, height: 630 });
  });

  it("invalid slug: generic card without DB lookup", { timeout: 30_000 }, async () => {
    const { res, body } = await get("NOT-valid");
    expect(res.status).toBe(200);
    expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
    expect(getOgData).not.toHaveBeenCalled();
  });
});
