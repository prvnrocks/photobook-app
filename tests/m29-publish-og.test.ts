// M29 T8 — OG / WhatsApp preview for a book published with an M29 cover style. The OG image
// (src/lib/viewer/og-image.tsx) does NOT draw the cover layout: it shows the first public photo
// (publicPhotoIds → the cover photo) cover-cropped with the snapshot title. So the only M29 risk is
// the snapshot path: parsePublicDoc must accept the M29 cover id, else getOgData says
// "unavailable" and the preview silently falls back to the generic card. This runs the real
// /b/[slug]/og route + getOgData against a fake admin client holding an M29 snapshot.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDoc, Layout } from "@/lib/book/types";

vi.mock("server-only", () => ({}));

const SUPABASE = "https://proj.supabase.co";
const SITE = "https://photobook.example.ae";
const OWNER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333331";
const P2 = "33333333-3333-4333-8333-333333333332";
const SLUG = "eid-at-home-7KxP2mQr9Z";

const fake = vi.hoisted(() => ({ snapshot: null as unknown, signed: [] as string[] }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: { p_slug?: string }) => {
      if (fn !== "get_published_book" || args.p_slug !== SLUG) return { data: [], error: null };
      return {
        data: [
          {
            id: BOOK,
            slug: SLUG,
            title: "Live title",
            caption_lang: "en",
            is_paid: false,
            page_count: 1,
            published_rev: 2,
            published_at: "2026-11-01T00:00:00Z",
            expires_at: "2099-01-01T00:00:00Z",
            is_expired: false,
            has_password: false,
            doc: fake.snapshot,
          },
        ],
        error: null,
      };
    },
    from: () => {
      let ids: string[] = [];
      const b = {
        select: () => b,
        eq: () => b,
        in: (_c: string, v: string[]) => ((ids = v), b),
        then: (res: (r: unknown) => unknown) =>
          Promise.resolve({
            data: ids.map((id) => ({ id, web_path: `${OWNER}/${BOOK}/${id}/web.jpg`, width: 1600, height: 1067 })),
            error: null,
          }).then(res),
      };
      return b;
    },
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => {
          fake.signed.push(...paths);
          return {
            data: paths.map((p) => ({ path: p, signedUrl: `${SUPABASE}/storage/v1/object/sign/photos/${p}?token=t`, error: null })),
            error: null,
          };
        },
      }),
    },
  }),
}));

const { M29_COVERS } = await import("@/lib/layouts");
const { layoutsFor } = await import("@/lib/book/spreads");
const { toPublicDoc } = await import("@/lib/publish/public-doc");
const { getOgData } = await import("@/lib/db/public-books");
const { OG_CACHE_CONTROL } = await import("@/lib/viewer/og-image");

const SMOOTH_COVER = readFileSync(fileURLToPath(new URL("./fixtures/og-cover-smooth.jpg", import.meta.url)));

function docWithCover(l: Layout, title: string): BookDoc {
  const page = layoutsFor(l.format, l.style, "page").find((p) => p.photoCount === 1)!;
  return {
    version: 2,
    format: l.format,
    occasion: "family",
    cover: { layout: l.id, photoId: P1, title, subtitle: "2026" },
    chapters: [],
    pages: [{ id: "pg0", chapterId: null, layout: page.id, slots: [{ photoId: P2, crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption: null }],
    style: { background: { kind: "color", hex: "#F5EFE6" }, designStyle: l.style, font: "Playfair" },
  };
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", SITE);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(new Uint8Array(SMOOTH_COVER), { headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetchMock);
  fake.signed = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getOgData with an M29 cover snapshot", () => {
  it.each(M29_COVERS.map((l) => [l.id, l] as const))("%s: ok, snapshot title, signed cover photo", async (_id, l) => {
    fake.snapshot = JSON.parse(JSON.stringify(toPublicDoc(docWithCover(l, "Eid at home"), { captionLang: "en" })));
    const og = await getOgData(SLUG);
    expect(og.state).toBe("ok");
    expect(og.title).toBe("Eid at home");
    expect(og.coverUrl).toBe(`${SUPABASE}/storage/v1/object/sign/photos/${OWNER}/${BOOK}/${P1}/web.jpg?token=t`);
    expect(fake.signed).toEqual([`${OWNER}/${BOOK}/${P1}/web.jpg`]);
  });
});

describe("GET /b/[slug]/og with an M29 cover", () => {
  const cases = [
    ["c-p-cover-window", "Eid at home"],
    ["g-l-cover-arch", "Desert weekend"],
    ["s-p-cover-tag", "عيد سعيد في البيت"],
  ] as const;
  it.each(cases)("%s: real PNG preview of the cover photo (not the generic card)", { timeout: 60_000 }, async (id, title) => {
    const l = M29_COVERS.find((c) => c.id === id)!;
    fake.snapshot = JSON.parse(JSON.stringify(toPublicDoc(docWithCover(l, title))));
    const { GET } = await import("@/app/b/[slug]/og/route");
    const res = await GET(new Request(`${SITE}/b/${SLUG}/og`), { params: Promise.resolve({ slug: SLUG }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(OG_CACHE_CONTROL); // generic card has a short cache
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16) / png.readUInt32BE(20)).toBeCloseTo(1200 / 630, 1);
    // The only network fetch is the signed cover photo (no runtime font fetch, even for Arabic).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`${P1}/web.jpg`);
  });
});
