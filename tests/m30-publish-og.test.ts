// M30 T14a — OG / WhatsApp preview for a published magazine / editorial book. The OG image
// (src/lib/viewer/og-image.tsx) does NOT draw the cover layout: it shows the first public photo
// (publicPhotoIds → the cover photo) cover-cropped with the snapshot title. So the M30 risk is the
// snapshot path: parsePublicDoc must accept the M30 cover ids, a chapter description and the accent
// colourway (both stored without `source`), else getOgData says "unavailable" and the preview
// silently falls back to the generic card. Same harness as tests/m29-publish-og.test.ts: the real
// /b/[slug]/og route + getOgData against a fake admin client holding an M30 snapshot.

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

const { M30_LAYOUTS } = await import("@/lib/layouts");
const { colourwaysFor } = await import("@/lib/design/colourways");
const { chaptersShowingDescription, layoutShowsDescription } = await import("@/lib/layouts/description");
const { layoutsFor } = await import("@/lib/book/spreads");
const { PublicBookDocV2Schema, publicDocToRenderDoc, toPublicDoc } = await import("@/lib/publish/public-doc");
const { hasUserDescriptions, isAiReplaceableDoc } = await import("@/lib/book/replaceable");
const { albumEditedByUser } = await import("@/lib/review/ui");
const { validateBookDoc } = await import("@/lib/book/schema");
const { setChapterDescription, EditOpError } = await import("@/lib/book/edit-ops");
const { getOgData } = await import("@/lib/db/public-books");
const { OG_CACHE_CONTROL } = await import("@/lib/viewer/og-image");

const SMOOTH_COVER = readFileSync(fileURLToPath(new URL("./fixtures/og-cover-smooth.jpg", import.meta.url)));

const M30_COVERS = M30_LAYOUTS.filter((l) => l.role === "cover");
const DESCRIPTION = "We left before sunrise and followed the old road into the hills.";

/** A published-shape M30 book: `l` on the cover, a one-photo DESCRIPTION page, an AI description, a user colourway. */
function docWithCover(l: Layout, title: string): BookDoc {
  const page = layoutsFor(l.format, l.style, "page").find((p) => p.photoCount === 1 && layoutShowsDescription(p))!;
  return {
    version: 2,
    format: l.format,
    occasion: "travel",
    cover: { layout: l.id, photoId: P1, title, subtitle: "2026" },
    chapters: [{ id: "c1", title: "Into the hills", dateLabel: "3 Nov 2026", place: null, description: { text: DESCRIPTION, source: "ai" } }],
    pages: [{ id: "pg0", chapterId: "c1", layout: page.id, slots: [{ photoId: P2, crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption: null }],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: l.style, font: "Poppins", colourway: { id: colourwaysFor(l.style)[2].id, source: "user" } },
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

describe("getOgData with an M30 cover snapshot", () => {
  it("the catalogue has 16 M30 covers (2 styles × 2 shapes × auto + 3)", () => {
    expect(M30_COVERS).toHaveLength(16);
  });

  it.each(M30_COVERS.map((l) => [l.id, l] as const))("%s: ok, snapshot title, signed cover photo", async (_id, l) => {
    const pub = toPublicDoc(docWithCover(l, "Eid at home"), { captionLang: "en" });
    // The snapshot keeps the description text and the colourway id, never who chose them.
    const json = JSON.stringify(pub);
    expect(json).toContain(DESCRIPTION);
    expect(json).toContain(`"colourway":{"id":"${colourwaysFor(l.style)[2].id}"}`);
    expect(json).not.toContain('"source"');
    fake.snapshot = JSON.parse(json);
    const og = await getOgData(SLUG);
    expect(og.state).toBe("ok");
    expect(og.title).toBe("Eid at home");
    expect(og.coverUrl).toBe(`${SUPABASE}/storage/v1/object/sign/photos/${OWNER}/${BOOK}/${P1}/web.jpg?token=t`);
    expect(fake.signed).toEqual([`${OWNER}/${BOOK}/${P1}/web.jpg`]);
  });
});

// M30 review: a description no page shows (its page was moved to another layout, or deleted) is
// invisible to the owner — it must not be published and must not count as a user edit.
describe("a chapter description is published / counts as a user edit only when a page shows it", () => {
  const cover = M30_COVERS.find((l) => l.id === "mg-p-cover")!;
  const shownDoc = docWithCover(cover, "Eid at home");
  const plainId = layoutsFor(cover.format, cover.style, "page").find((p) => p.photoCount === 1 && !layoutShowsDescription(p))!.id;
  const spread = layoutsFor(cover.format, cover.style, "spread").find((l) => layoutShowsDescription(l))!;
  const crop = { x: 0.5, y: 0.5, zoom: 1 };
  const withPages = (pages: BookDoc["pages"], d: BookDoc = shownDoc): BookDoc => ({ ...d, pages });
  const swapped = withPages([{ ...shownDoc.pages[0], layout: plainId }]);
  const deleted = withPages([]);
  const otherChapter: BookDoc = {
    ...shownDoc,
    chapters: [...shownDoc.chapters, { id: "c2", title: "Home", dateLabel: "4 Nov 2026", place: null }],
    pages: [{ ...shownDoc.pages[0], chapterId: "c2" }],
  };
  const asUser = (d: BookDoc): BookDoc => ({ ...d, chapters: d.chapters.map((c) => (c.description ? { ...c, description: { ...c.description, source: "user" as const } } : c)) });
  const v2 = (d: BookDoc) => PublicBookDocV2Schema.parse(JSON.parse(JSON.stringify(toPublicDoc(d, { captionLang: "en" }))));

  it("shown: the text is published (no source) and the snapshot passes its strict schema", () => {
    const pub = v2(shownDoc);
    expect(pub.chapters[0].description).toEqual({ text: DESCRIPTION });
    expect(publicDocToRenderDoc(pub).chapters[0].description?.text).toBe(DESCRIPTION);
  });

  it.each([
    ["page moved to a layout without a description panel", swapped],
    ["description page deleted", deleted],
    ["only a page of ANOTHER chapter has a description layout", otherChapter],
    ["only an orphaned right half names the chapter", withPages([{ id: "pg0", chapterId: "c1", layout: spread.id, slots: [], caption: null, side: "right" }])],
  ] as const)("not shown (%s): no description key, text absent, strict schema still passes", (_name, d) => {
    for (const doc of [d, asUser(d)]) {
      const raw = toPublicDoc(doc, { captionLang: "en" });
      expect(JSON.stringify(raw)).not.toContain(DESCRIPTION);
      const pub = PublicBookDocV2Schema.parse(JSON.parse(JSON.stringify(raw)));
      for (const c of pub.chapters) expect("description" in c).toBe(false);
      expect(publicDocToRenderDoc(pub).chapters.every((c) => c.description === undefined)).toBe(true);
    }
  });

  it("a spread shows the description of its LEFT half's chapter", () => {
    const slots = Array.from({ length: spread.photoCount }, (_, i) => ({ photoId: i === 0 ? P2 : `${P2.slice(0, -2)}${String(10 + i)}`, crop }));
    const pages: BookDoc["pages"] = [
      { id: "pg0", chapterId: "c1", layout: spread.id, slots, caption: null, side: "left" },
      { id: "pg1", chapterId: "c1", layout: spread.id, slots: [], caption: null, side: "right" },
    ];
    expect([...chaptersShowingDescription(pages)]).toEqual(["c1"]);
    expect(v2(withPages(pages)).chapters[0].description).toEqual({ text: DESCRIPTION });
  });

  it("chaptersShowingDescription ignores unknown layouts, pages without a chapter and junk", () => {
    expect([...chaptersShowingDescription([{ chapterId: "c1", layout: "nope" }, { chapterId: null, layout: shownDoc.pages[0].layout }, { chapterId: 3, layout: 4 }, {}])]).toEqual([]);
  });

  it("every layout whose block depends on the description also has the description panel", () => {
    for (const l of M30_LAYOUTS) if (l.blocks?.some((b) => b.when === "chapterDescription")) expect(layoutShowsDescription(l), l.id).toBe(true);
  });

  it("replaceable: a user description blocks an AI rebuild only while a page shows it", () => {
    expect(hasUserDescriptions(shownDoc)).toBe(false); // the AI's
    expect(hasUserDescriptions(asUser(shownDoc))).toBe(true);
    expect(isAiReplaceableDoc(asUser(shownDoc))).toBe(false);
    expect(albumEditedByUser(asUser(shownDoc))).toBe(true);
    for (const d of [swapped, deleted, otherChapter]) {
      expect(hasUserDescriptions(asUser(d))).toBe(false);
      expect(isAiReplaceableDoc(asUser(d))).toBe(true);
      expect(albumEditedByUser(asUser(d))).toBe(false);
    }
    expect(hasUserDescriptions({ chapters: asUser(shownDoc).chapters })).toBe(false); // no pages → nothing shown
    expect(hasUserDescriptions({ chapters: asUser(shownDoc).chapters, pages: [null, 1, "x"] })).toBe(false);
  });
});

// M30 review: like the colourway, a description belongs to a style with description layouts.
describe("validateBookDoc: chapter descriptions only on magazine / editorial", () => {
  const photoIds = new Set([P1, P2]);
  const classic: BookDoc = {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: P1, title: "T", subtitle: "" },
    chapters: [{ id: "c1", title: "One", dateLabel: "2026", place: null }],
    pages: [{ id: "pg0", chapterId: "c1", layout: "full-page", slots: [{ photoId: P2, crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption: null }],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
  };
  const issues = (d: BookDoc) => validateBookDoc(d, { photoIds, maxPages: 20 });

  it("magazine / editorial: a description is valid, shown or not", () => {
    for (const id of ["mg-p-cover", "ed-l-cover-frame"]) {
      const d = docWithCover(M30_COVERS.find((l) => l.id === id)!, "T");
      expect(issues(d)).toEqual([]);
      expect(issues({ ...d, pages: [] })).toEqual([]);
    }
  });

  it("an older style: valid without, one issue per described chapter (index + style only, no user text)", () => {
    expect(issues(classic)).toEqual([]);
    const bad: BookDoc = { ...classic, chapters: [{ ...classic.chapters[0], description: { text: DESCRIPTION, source: "user" } }] };
    expect(issues(bad)).toEqual(["chapters[0].description: classic books have no chapter descriptions"]);
  });

  it("setChapterDescription refuses on an older style (so the editor can't build such a doc); clearing still works", () => {
    let code: unknown = null;
    try {
      setChapterDescription(classic, "c1", "Mine.");
    } catch (e) {
      code = e instanceof EditOpError ? e.code : e;
    }
    expect(code).toBe("no_description_area");
    expect(setChapterDescription(classic, "c1", " ")).toBe(classic);
  });
});

describe("GET /b/[slug]/og with an M30 cover", () => {
  const cases = [
    ["mg-p-cover", "Ten days across the Hajar peaks"],
    ["ed-l-cover-frame", "Desert weekend"],
    ["mg-l-cover-panel", "عشرة أيام بين قمم جبال الحجر"],
  ] as const;
  it.each(cases)("%s: real PNG preview of the cover photo (not the generic card)", { timeout: 60_000 }, async (id, title) => {
    const l = M30_COVERS.find((c) => c.id === id)!;
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
