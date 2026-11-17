// M29 T8 — print pipeline checks for the 22 user-chosen cover styles (M29_COVERS, autoPick:false).
// For every M29 cover: the print box (printSlotSizeMm: bleed box, or photoRectOf for framed /
// tilted slots), the print image plan (planPrintImages sizes the cover photo for that box at
// 300 dpi), the low-res warning (layoutSlotMm / isSlotLowRes), the print render model (bleed only
// on slots that bleed) and the real /print/[bookId] page (parseBookDoc → PrintDocument) with an
// M29 cover on sheet 0. Pre-M29 numbers are frozen elsewhere (m10c-print-plumbing, goldens).

import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  getExportForRender: vi.fn(),
  listPrintPhotoDims: vi.fn(),
  headers: new Map<string, string>(),
}));

class NotFoundSignal extends Error {}

vi.mock("@/lib/db/exports", () => ({ getExportForRender: h.getExportForRender }));
vi.mock("@/lib/db/print", () => ({ listPrintPhotoDims: h.listPrintPhotoDims }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => h.headers.get(k.toLowerCase()) ?? null }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  },
}));

import PrintPage from "@/app/print/[bookId]/page";
import { bleedRect, printSlotSizeMm, slotBleeds } from "@/lib/book/bleed";
import { serializeDoc } from "@/lib/book/doc-version";
import { pageMm } from "@/lib/book/format";
import { coverRenderModel } from "@/lib/book/render";
import { effectiveDpi, isSlotLowRes, layoutSlotMm, slotSizeMm } from "@/lib/book/resolution";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { photoRectOf } from "@/lib/book/slot-geometry";
import { layoutsFor } from "@/lib/book/spreads";
import type { BookDoc, Layout } from "@/lib/book/types";
import { M29_COVERS } from "@/lib/layouts";
import { neededPx, planPrintImages, PRINT_DPI, PRINT_MAX_LONG_EDGE } from "@/lib/pdf/image-plan";
import { printAssetUrl } from "@/lib/pdf/print-assets";
import { printPhotoIds, printRenderPhotos } from "@/lib/pdf/print-doc";
import { printTokenExpiry, signPrintToken } from "@/lib/pdf/print-token";

const SECRET = "m".repeat(40);
const BOOK = "1111aaaa-2222-4333-8444-5555ffff5555";
const EXPORT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COVER_PHOTO = pid(1);
const TITLE = "Summer by the sea";
const SUBTITLE = "Abu Dhabi 2026";

/** A minimal valid book of the cover's own format + style: the M29 cover + one filled page. */
function docWithCover(cover: Layout): BookDoc {
  const page = layoutsFor(cover.format, cover.style, "page").find((l) => l.photoCount >= 1)!;
  return {
    version: 2,
    format: cover.format,
    occasion: "travel",
    cover: { layout: cover.id, photoId: COVER_PHOTO, title: TITLE, subtitle: SUBTITLE },
    chapters: [],
    pages: [
      {
        id: "pg0",
        chapterId: null,
        layout: page.id,
        slots: Array.from({ length: page.slots.length }, (_, i) => ({ photoId: pid(10 + i), crop: { x: 0.5, y: 0.5, zoom: 1 } })),
        caption: null,
      },
    ],
    style: { background: { kind: "color", hex: "#F5EFE6" }, designStyle: cover.style, font: "Playfair" },
  };
}

const photoIdsOf = (d: BookDoc) => new Set([d.cover.photoId!, ...d.pages.flatMap((p) => p.slots.map((s) => s.photoId!))]);
const framed = (l: Layout) => !!l.slots[0].frame && l.slots[0].frame.kind !== "none";
/** Trim-size mm of the cover's visible photo rect (photoRectOf). */
const photoMm = (l: Layout) => {
  const r = photoRectOf(l, 0, l.format)!;
  const p = pageMm(l.format);
  return { w: (r.w / 100) * p.w, h: (r.h / 100) * p.h };
};

describe("M29 covers: catalogue sanity for print", () => {
  it("22 covers, every one a single-photo cover of its own format + style", () => {
    expect(M29_COVERS).toHaveLength(22);
    for (const l of M29_COVERS) {
      expect(l.role, l.id).toBe("cover");
      expect(l.slots, l.id).toHaveLength(1);
      expect(l.autoPick, l.id).toBe(false);
    }
  });

  it("the sample doc for every cover is a valid book (layouts match the book's format + style)", () => {
    for (const l of M29_COVERS) {
      const d = docWithCover(l);
      expect(validateBookDoc(d, { photoIds: photoIdsOf(d), maxPages: 20 }), l.id).toEqual([]);
    }
  });
});

describe.each(M29_COVERS.map((l) => [l.id, l] as const))("print: %s", (_id, l) => {
  const slot = l.slots[0];
  const bleeds = slotBleeds(slot);

  it("print box: bleed box when the slot bleeds, else the framed / tilted photo rect at trim size", () => {
    expect(bleeds).toBe(!framed(l) && !slot.rotate);
    const box = printSlotSizeMm(l, 0, l.format)!;
    if (bleeds) {
      const b = bleedRect(slot, pageMm(l.format));
      expect(box).toEqual({ w: b.sheetMm.w, h: b.sheetMm.h });
      // Never smaller than the trim slot; grows by 3 mm per trim edge it touches.
      const trim = slotSizeMm(slot, l.format);
      const edges = Object.values(b.edges);
      expect(box.w + box.h).toBeCloseTo(trim.w + trim.h + 3 * edges.filter(Boolean).length, 6);
    } else {
      expect(box).toEqual(photoMm(l));
      const trim = slotSizeMm(slot, l.format);
      expect(box.w).toBeLessThan(trim.w); // the frame band is excluded
      expect(box.h).toBeLessThan(trim.h);
    }
    expect(printSlotSizeMm(l.id, 0, l.format)).toEqual(box);
  });

  it("image plan: the cover photo prints at ≥ 300 dpi on that box (zoom 1, DEFAULT_CROP), capped at 3000 px by default", () => {
    const d = docWithCover(l);
    const BIG = { id: COVER_PHOTO, width: 8000, height: 6000 };
    const box = printSlotSizeMm(l, 0, l.format)!;
    const uncapped = planPrintImages(d, [BIG], { maxLongEdge: 100_000 }).get(COVER_PHOTO)!;
    const n = neededPx(BIG.width, BIG.height, box.w, box.h, 1, PRINT_DPI);
    expect(uncapped).toEqual({ width: Math.round(n.w), height: Math.round(n.h) });
    expect(effectiveDpi(uncapped.width, uncapped.height, box.w, box.h)!).toBeGreaterThanOrEqual(PRINT_DPI - 0.5);
    const capped = planPrintImages(d, [BIG], {}).get(COVER_PHOTO)!;
    expect(Math.max(capped.width, capped.height)).toBeLessThanOrEqual(PRINT_MAX_LONG_EDGE);
    // Never upscaled: a small original stays at its own size.
    const small = planPrintImages(d, [{ id: COVER_PHOTO, width: 800, height: 600 }]).get(COVER_PHOTO)!;
    expect(small).toEqual({ width: 800, height: 600 });
    // Unknown size → max box (resize "inside").
    expect(planPrintImages(d, [{ id: COVER_PHOTO, width: null, height: null }]).get(COVER_PHOTO)).toEqual({
      width: PRINT_MAX_LONG_EDGE,
      height: PRINT_MAX_LONG_EDGE,
    });
  });

  it("low-res check measures the visible photo rect (framed → photoRectOf) and warns only below 150 dpi", () => {
    const mm = layoutSlotMm(l.id, 0, l.format)!;
    expect(mm).toEqual(framed(l) ? photoMm(l) : slotSizeMm(slot, l.format));
    expect(isSlotLowRes({ width: 6000, height: 4500 }, l.id, 0, 1, l.format)).toBe(false);
    expect(isSlotLowRes({ width: 300, height: 225 }, l.id, 0, 1, l.format)).toBe(true);
    expect(isSlotLowRes({ width: null, height: null }, l.id, 0, 1, l.format)).toBe(false);
    // Exactly at the 150 dpi line on the limiting axis → not low-res.
    const at150 = { width: Math.ceil((mm.w / 25.4) * 150), height: Math.ceil((mm.h / 25.4) * 150) };
    expect(isSlotLowRes(at150, l.id, 0, 1, l.format)).toBe(false);
  });

  it("print render model: photo on the print-asset origin; bleed-extended only when the slot bleeds", () => {
    const d = docWithCover(l);
    const photos = printRenderPhotos([{ id: COVER_PHOTO, width: 4000, height: 3000 }]);
    const view = coverRenderModel(d, photos, "en");
    const print = coverRenderModel(d, photos, "en", { bleed: true });
    expect(print.knownLayout).toBe(true);
    expect(print.slot!.photo!.url).toBe(printAssetUrl(COVER_PHOTO));
    if (bleeds) expect(print.slot!.rect).toEqual(bleedRect(slot, pageMm(l.format)).pct);
    else expect(print.slot).toEqual(view.slot);
    // Title / subtitle panels are the same in print (text never moves into the bleed).
    expect(print.panels).toEqual(view.panels);
    expect(print.panels?.map((p) => p.bind).sort()).toEqual(["coverSubtitle", "coverTitle"]);
  });

  it("print sheets: the cover sheet lists the cover photo", () => {
    const d = docWithCover(l);
    expect(printPhotoIds(d, ["cover"])).toEqual([COVER_PHOTO]);
  });
});

// ---- /print/[bookId] with an M29 cover ----------------------------------------------------------

const NOW = () => Math.floor(Date.now() / 1000);
function token(to: number): string {
  const t = signPrintToken(
    { exportId: EXPORT, bookId: BOOK, docRev: 3, from: 0, to, exp: printTokenExpiry(NOW()) },
    Buffer.from(SECRET),
  );
  if (!t) throw new Error("no token");
  return t;
}

async function renderPrint(doc: unknown, to = 1): Promise<string> {
  h.getExportForRender.mockResolvedValue({
    id: EXPORT,
    bookId: BOOK,
    userId: pid(999),
    docRev: 3,
    doc,
    captionLang: "en",
    status: "rendering",
  });
  h.headers.clear();
  h.headers.set("x-print-token", token(to));
  const el = await PrintPage({ params: Promise.resolve({ bookId: BOOK }), searchParams: Promise.resolve({}) });
  expect(isValidElement(el)).toBe(true);
  return renderToStaticMarkup(el as ReactElement);
}

let oldSecret: string | undefined;
beforeAll(() => {
  oldSecret = process.env.BOOK_ACCESS_SECRET;
  process.env.BOOK_ACCESS_SECRET = SECRET;
});
afterAll(() => {
  if (oldSecret === undefined) delete process.env.BOOK_ACCESS_SECRET;
  else process.env.BOOK_ACCESS_SECRET = oldSecret;
});
beforeEach(() => {
  h.getExportForRender.mockReset();
  h.listPrintPhotoDims.mockReset().mockImplementation(async (_book: string, ids: string[]) =>
    ids.map((id) => ({ id, width: 4000, height: 3000 })),
  );
});

describe("/print/[bookId] accepts a book whose cover is an M29 layout", () => {
  it.each(M29_COVERS.map((l) => [l.id, l] as const))("%s: stored doc (as saved) renders cover + page sheets", async (_id, l) => {
    // The export snapshot is the stored JSON (serializeDoc), exactly what the job reads.
    const stored = JSON.parse(JSON.stringify(serializeDoc(docWithCover(l))));
    expect(parseBookDoc(stored).ok).toBe(true);
    const html = await renderPrint(stored);
    expect((html.match(/data-print-sheet="true"/g) ?? []).length).toBe(2);
    expect(html).toContain(printAssetUrl(COVER_PHOTO).replace(/&/g, "&amp;"));
    expect(html).toContain(TITLE);
    expect(html).toContain(SUBTITLE);
    // The photo ids the route asks dims for include the cover photo.
    expect(h.listPrintPhotoDims.mock.calls[0][1]).toContain(COVER_PHOTO);
  });

  it("Arabic 120-code-point title on an M29 cover still renders (dir=auto)", async () => {
    const l = M29_COVERS.find((c) => c.id === "c-p-cover-split")!;
    const ar = "رحلة العائلة إلى أبوظبي ".repeat(6).slice(0, 120);
    const d = { ...docWithCover(l), cover: { ...docWithCover(l).cover, title: ar } };
    const html = await renderPrint(JSON.parse(JSON.stringify(serializeDoc(d))));
    expect(html).toContain(ar);
    expect(html).toMatch(/dir="auto"/);
  });
});
