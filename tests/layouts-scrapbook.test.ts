// M10c T6a/T6b — scrapbook layouts, A5 portrait + landscape (src/lib/layouts/scrapbook): catalogue
// shape, full layoutIssues validation against the real sticker catalogue, photo aspect vs prefers
// (frame inset included), readable text (caption areas clear of photos and stickers, plates only on
// chapterTitle / dateLabel), decoration budget, small overlaps, spread twins + D-064 repair, and
// validateBookDoc over a doc using every layout.

import { describe, expect, it } from "vitest";
import { pageMm } from "@/lib/book/format";
import { layoutIssues, LayoutSchema, validateBookDoc } from "@/lib/book/schema";
import { photoRectOf, rotatedBoundsPct, type BoundsPct } from "@/lib/book/slot-geometry";
import { layoutsFor, rectHalf, repairSpreads } from "@/lib/book/spreads";
import type { BookDoc, BookFormat, BookPage, Caption, Layout, Rect } from "@/lib/book/types";
import { DECORATION_STICKER_IDS, OCCASION_ACCENT, STICKERS } from "@/lib/design/stickers";
import { getLayout, LAYOUTS, SAFE_MM } from "@/lib/layouts";
import { SCRAPBOOK_LANDSCAPE_LAYOUTS } from "@/lib/layouts/scrapbook/landscape";
import { SCRAPBOOK_PORTRAIT_LAYOUTS } from "@/lib/layouts/scrapbook/portrait";

const MM_EPS = 0.01;
const FOLD_MIN_MM = 8;
const MAX_DECORATIONS_PER_PAGE = 6;
const MAX_SHADOWS_PER_PAGE = 2;
/** A photo may be covered by a print on top of it by at most this share of its area. */
const MAX_COVERED = 0.2;

const stickerIds = new Set(DECORATION_STICKER_IDS);
const stickerKinds = new Map(Object.values(STICKERS).map((s) => [s.id, s.kind] as const));

const SETS = [
  { format: "A5_PORTRAIT" as BookFormat, prefix: "s-p-", layouts: SCRAPBOOK_PORTRAIT_LAYOUTS },
  { format: "A5_LANDSCAPE" as BookFormat, prefix: "s-l-", layouts: SCRAPBOOK_LANDSCAPE_LAYOUTS },
];
const ALL = SETS.flatMap((s) => s.layouts);

const boundsOf = (r: Rect, rotate: number | undefined, format: BookFormat): BoundsPct => rotatedBoundsPct(r, rotate ?? 0, pageMm(format));
const overlaps = (a: BoundsPct, b: BoundsPct) => a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6;
const area = (b: BoundsPct) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a: BoundsPct, b: BoundsPct): BoundsPct => ({
  x0: Math.max(a.x0, b.x0),
  y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
});
const sameRect = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6;
const plain = (r: Rect): BoundsPct => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
/** Which page of a spread a bounds lies on (layout validation already forbids crossing the fold). */
const halfOf = (l: Layout, b: BoundsPct) => (l.role === "spread" && b.x0 >= 100 - 1e-6 ? "right" : "left");

describe.each(SETS)("scrapbook $format catalogue", ({ format, prefix, layouts }) => {
  const byRole = (role: Layout["role"]) => layouts.filter((l) => l.role === role);

  it("has 1 cover, 6 single pages and 2 spreads — all scrapbook, this format, ids " + prefix + "*", () => {
    expect(byRole("cover")).toHaveLength(1);
    expect(byRole("page")).toHaveLength(6);
    expect(byRole("spread")).toHaveLength(2);
    for (const l of layouts) {
      expect(l.id.startsWith(prefix)).toBe(true);
      expect(l.style).toBe("scrapbook");
      expect(l.format).toBe(format);
    }
    expect(new Set(layouts.map((l) => l.id)).size).toBe(layouts.length);
  });

  it("is wired into the catalogue: getLayout + layoutsFor(format, scrapbook, role)", () => {
    for (const l of layouts) expect(getLayout(l.id)).toBe(l);
    expect(LAYOUTS.filter((l) => l.style === "scrapbook" && l.format === format)).toEqual([...layouts]);
    for (const role of ["page", "spread", "cover"] as const) expect(layoutsFor(format, "scrapbook", role)).toEqual(byRole(role));
  });

  it("single pages cover photo counts 1–5 and both orientations for 1–2 photos", () => {
    const pages = byRole("page");
    for (let n = 1; n <= 5; n++) expect(pages.some((l) => l.photoCount === n), `count ${n}`).toBe(true);
    const twos = pages.filter((l) => l.photoCount === 2);
    expect(twos.some((l) => l.prefers.every((p) => p === "portrait"))).toBe(true);
    expect(twos.some((l) => l.prefers.every((p) => p === "landscape"))).toBe(true);
  });

  it("uses the occasion accent on the cover and on at least one page", () => {
    const usesAccent = (l: Layout) => (l.decorations ?? []).some((d) => d.id === OCCASION_ACCENT);
    expect(usesAccent(byRole("cover")[0])).toBe(true);
    expect(byRole("page").filter(usesAccent).length).toBeGreaterThanOrEqual(1);
  });

  it("uses photo-corner sets on 2–3 layouts", () => {
    const n = layouts.filter((l) => (l.decorations ?? []).some((d) => d.id === "photo-corner")).length;
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("has label plates (chapter title / date) on several pages and overlapping photos with z", () => {
    expect(layouts.filter((l) => (l.texts ?? []).some((t) => t.plate)).length).toBeGreaterThanOrEqual(3);
    expect(layouts.filter((l) => l.slots.some((s) => (s.z ?? 0) > 0)).length).toBeGreaterThanOrEqual(3);
  });
});

describe.each(ALL.map((l) => [l.id, l] as const))("%s", (_id, l) => {
  const page = pageMm(l.format);
  const areaW = l.role === "spread" ? 200 : 100;
  const texts = l.texts ?? [];
  const decos = l.decorations ?? [];

  it("passes LayoutSchema and layoutIssues with the real sticker ids + kinds", () => {
    expect(LayoutSchema.safeParse(l).success).toBe(true);
    expect(layoutIssues(l, { stickerIds, stickerKinds })).toEqual([]);
  });

  it("photoCount = slots = prefers (1–12); every photo is a framed and/or tilted print inside the page", () => {
    expect(l.slots).toHaveLength(l.photoCount);
    expect(l.prefers).toHaveLength(l.photoCount);
    for (const s of l.slots) {
      expect((s.frame?.kind ?? "none") !== "none" || (s.rotate ?? 0) !== 0).toBe(true);
      expect(Math.abs(s.rotate ?? 0)).toBeLessThanOrEqual(8);
    }
  });

  it("photo area (slot minus frame) suits its preference", () => {
    l.slots.forEach((_, i) => {
      const r = photoRectOf(l, i)!;
      const ratio = (r.w * page.w) / (r.h * page.h);
      const p = l.prefers[i];
      const [min, max] = p === "portrait" ? [0.5, 0.999] : p === "landscape" ? [1.001, 2] : [0.75, 1.35];
      expect(ratio, `slot ${i} (${p})`).toBeGreaterThanOrEqual(min);
      expect(ratio, `slot ${i} (${p})`).toBeLessThanOrEqual(max);
    });
  });

  it(`a print on top covers at most ${MAX_COVERED * 100} % of a photo below it`, () => {
    l.slots.forEach((_, i) => {
      const photo = plain(photoRectOf(l, i)!);
      l.slots.forEach((top, j) => {
        if (i === j) return;
        const above = (top.z ?? 0) > (l.slots[i].z ?? 0) || ((top.z ?? 0) === (l.slots[i].z ?? 0) && j > i);
        if (!above) return;
        const covered = area(inter(photo, boundsOf(top, top.rotate, l.format))) / area(photo);
        expect(covered, `slot ${j} over slot ${i}`).toBeLessThanOrEqual(MAX_COVERED);
      });
    });
  });

  it("plates sit only on chapterTitle / dateLabel; the caption box has its pageCaption panel", () => {
    for (const t of texts) if (t.plate) expect(["chapterTitle", "dateLabel"]).toContain(t.bind);
    for (const t of texts) if (t.bind === "pageCaption") expect(l.caption && sameRect(t.box, l.caption)).toBe(true);
    if (l.caption && l.role !== "cover") expect(texts.some((t) => t.bind === "pageCaption")).toBe(true);
    if (l.role === "spread" && l.caption) expect(rectHalf(l.caption)).toBe("left");
  });

  it("bindings fit the role (cover: title + year whose union is the caption box)", () => {
    const binds = texts.map((t) => t.bind);
    if (l.role === "cover") {
      expect(texts.find((t) => t.bind === "coverTitle")?.font).toBe("title");
      expect(texts.find((t) => t.bind === "coverSubtitle")?.font).toBe("year");
      expect(binds.every((b) => b === "coverTitle" || b === "coverSubtitle")).toBe(true);
      const bs = texts.map((t) => plain(t.box));
      const u = { x: Math.min(...bs.map((b) => b.x0)), y: Math.min(...bs.map((b) => b.y0)) };
      const union = { ...u, w: Math.max(...bs.map((b) => b.x1)) - u.x, h: Math.max(...bs.map((b) => b.y1)) - u.y };
      expect(l.caption && sameRect(l.caption, union)).toBe(true);
    } else {
      expect(binds.some((b) => b === "coverTitle" || b === "coverSubtitle")).toBe(false);
      for (const t of texts) {
        if (t.bind === "chapterTitle") expect(t.font).toBe("chapter");
        if (t.bind === "pageCaption") expect(t.font).toBe("caption");
      }
    }
  });

  it("readable text: unplated text + caption clear of photos and stickers; texts never overlap each other", () => {
    const slotB = l.slots.map((s) => boundsOf(s, s.rotate, l.format));
    const decoB = decos.map((d) => boundsOf(d.box, d.rotate, l.format));
    const textB = texts.map((t) => boundsOf(t.box, t.rotate, l.format));
    const clear = [...texts.filter((t) => !t.plate).map((t) => boundsOf(t.box, t.rotate, l.format)), ...(l.caption ? [plain(l.caption)] : [])];
    for (const b of clear) {
      slotB.forEach((s, i) => expect(overlaps(b, s), `text vs slot ${i}`).toBe(false));
      decoB.forEach((d, i) => expect(overlaps(b, d), `text vs decoration ${i}`).toBe(false));
    }
    // Plates may be stuck over a photo edge, but stickers never sit on a label.
    for (const b of texts.filter((t) => t.plate).map((t) => boundsOf(t.box, t.rotate, l.format))) {
      decoB.forEach((d, i) => expect(overlaps(b, d), `plate vs decoration ${i}`).toBe(false));
    }
    for (let i = 0; i < textB.length; i++)
      for (let j = i + 1; j < textB.length; j++) {
        if (l.role === "cover") continue; // cover title + year are separate boxes inside the caption
        expect(overlaps(textB[i], textB[j]), `texts ${i}/${j}`).toBe(false);
      }
  });

  it(`text ≥ ${SAFE_MM} mm inside the trim, ≥ ${FOLD_MIN_MM} mm from either side of a single page / from the fold`, () => {
    for (const t of texts) {
      const b = boundsOf(t.box, t.rotate, l.format);
      const x0 = (b.x0 / 100) * page.w;
      const x1 = (b.x1 / 100) * page.w;
      const fullW = (areaW / 100) * page.w;
      expect((b.y0 / 100) * page.h).toBeGreaterThanOrEqual(SAFE_MM - MM_EPS);
      expect(page.h - (b.y1 / 100) * page.h).toBeGreaterThanOrEqual(SAFE_MM - MM_EPS);
      expect(x0).toBeGreaterThanOrEqual(SAFE_MM - MM_EPS);
      expect(fullW - x1).toBeGreaterThanOrEqual(SAFE_MM - MM_EPS);
      if (l.role === "page") {
        expect(x0).toBeGreaterThanOrEqual(FOLD_MIN_MM - MM_EPS);
        expect(page.w - x1).toBeGreaterThanOrEqual(FOLD_MIN_MM - MM_EPS);
      }
      if (l.role === "spread") {
        const ok = x1 <= page.w - FOLD_MIN_MM + MM_EPS || x0 >= page.w + FOLD_MIN_MM - MM_EPS;
        expect(ok, `text ${t.bind} vs fold`).toBe(true);
      }
    }
  });

  it(`≤ ${MAX_DECORATIONS_PER_PAGE} decorations (a photo-corner set = 1) and ≤ ${MAX_SHADOWS_PER_PAGE} soft shadows per page`, () => {
    // A photo-corner set (4 "photo-corner" stickers on one print) counts as ONE decoration.
    const per = { left: 0, right: 0 };
    const corners = { left: 0, right: 0 };
    for (const d of decos) {
      const h = halfOf(l, boundsOf(d.box, d.rotate, l.format));
      if (d.id === "photo-corner") corners[h]++;
      else per[h]++;
    }
    for (const h of ["left", "right"] as const) {
      expect(corners[h] % 4, `${h}: corners come in sets of 4`).toBe(0);
      per[h] += corners[h] / 4;
    }
    expect(per.left).toBeLessThanOrEqual(MAX_DECORATIONS_PER_PAGE);
    expect(per.right).toBeLessThanOrEqual(MAX_DECORATIONS_PER_PAGE);
    const shadows = { left: 0, right: 0 };
    for (const s of l.slots) {
      if (!s.shadow || s.shadow === "none") continue;
      expect(s.shadow).toBe("soft");
      shadows[rectHalf(s)]++;
    }
    expect(shadows.left).toBeLessThanOrEqual(MAX_SHADOWS_PER_PAGE);
    expect(shadows.right).toBeLessThanOrEqual(MAX_SHADOWS_PER_PAGE);
  });

  it("photo-corner sets: each set holds the 4 corners of one print, turned 0/90/180/−90° + its tilt", () => {
    const set = decos.filter((d) => d.id === "photo-corner");
    for (let k = 0; k < set.length; k += 4) {
      const four = set.slice(k, k + 4);
      const centres = four.map((d) => ({ x: d.box.x + d.box.w / 2, y: d.box.y + d.box.h / 2 }));
      // The print whose box contains all four corner centres.
      const owner = l.slots.find((s) => centres.every((c) => c.x > s.x - 1 && c.x < s.x + s.w + 1 && c.y > s.y - 1 && c.y < s.y + s.h + 1));
      expect(owner, "corner set sits on a print").toBeDefined();
      const tilt = owner!.rotate ?? 0;
      four.forEach((d, i) => {
        const want = [0, 90, 180, -90][i] + tilt;
        const diff = ((((d.rotate ?? 0) - want) % 360) + 540) % 360 - 180;
        expect(Math.abs(diff), `corner ${i}`).toBeLessThan(1e-3);
        expect(d.layer).toBe("over");
      });
    }
  });

  it("stickers keep their natural aspect (tape/stickers; the accent box is square)", () => {
    for (const d of decos) {
      const ratio = (d.box.w * page.w) / (d.box.h * page.h);
      const want = d.id === OCCASION_ACCENT ? 1 : (() => {
        const [, , w, h] = STICKERS[d.id as keyof typeof STICKERS].viewBox;
        return w / h;
      })();
      expect(Math.abs(ratio - want) / want, d.id).toBeLessThan(0.01);
    }
    for (const t of texts.filter((x) => x.plate)) {
      const [, , w, h] = STICKERS[t.plate!.id as keyof typeof STICKERS].viewBox;
      expect(Math.abs((t.box.w * page.w) / (t.box.h * page.h) - w / h) / (w / h)).toBeLessThan(0.01);
    }
  });

  it("a caption column (caption taller than 30 % of the page) also carries the chapter title and date (G1: never bare when the caption is empty)", () => {
    if (!l.caption || l.role === "cover" || l.caption.h < 30) return;
    const half = halfOf(l, plain(l.caption));
    const binds = texts.filter((t) => halfOf(l, plain(t.box)) === half).map((t) => t.bind);
    expect(binds).toContain("chapterTitle");
    expect(binds).toContain("dateLabel");
  });

  it("small stickers (not tape) sit ≥ 1.5 mm inside the 4 mm safe line (tilt included)", () => {
    for (const d of decos.filter((x) => x.kind === "sticker")) {
      const b = boundsOf(d.box, d.rotate, l.format);
      const gaps = [b.x0 * page.w, b.y0 * page.h, (areaW - b.x1) * page.w, (100 - b.y1) * page.h].map((v) => v / 100);
      for (const gap of gaps) expect(gap, `${d.id} ${JSON.stringify(d.box)}`).toBeGreaterThanOrEqual(SAFE_MM + 1.5 - MM_EPS);
    }
  });
});

// --- Spreads: twins + repair ---------------------------------------------------------------------

const caption = (text: string): Caption => ({ text, font: "Cormorant", align: "left", source: "user" });

function pageOf(l: Layout, id: string, start: number): BookPage {
  return {
    id,
    chapterId: "m1",
    layout: l.id,
    slots: l.slots.map((_, i) => ({ photoId: `ph${start + i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
    caption: l.caption ? caption(`cap ${id}`) : null,
  };
}
function spreadOf(l: Layout, id: string, start: number): [BookPage, BookPage] {
  return [
    { ...pageOf(l, id, start), side: "left" },
    { id: `${id}r`, chapterId: "m1", layout: l.id, side: "right", slots: [], caption: null },
  ];
}
function docOf(format: BookFormat, pages: BookPage[], coverLayout: string): BookDoc {
  return {
    version: 2,
    format,
    occasion: "family",
    cover: { layout: coverLayout, photoId: "ph0", title: "Summer", subtitle: "2026" },
    chapters: [{ id: "m1", title: "Moment", dateLabel: "12 Feb", place: null }],
    pages,
    style: { background: { kind: "color", hex: "#F6F0E4" }, designStyle: "scrapbook", font: "Cormorant" },
  };
}
const photoIdsOf = (pages: BookPage[]) => pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => x !== null));

describe.each(ALL.filter((l) => l.role === "spread").map((l) => [l.id, l] as const))("spread %s", (_id, l) => {
  it("twin = two scrapbook single pages of the same format holding each half's photos; caption twin on the left", () => {
    const halves = { left: 0, right: 0 };
    for (const s of l.slots) halves[rectHalf(s)]++;
    l.twin!.forEach((id, h) => {
      const t = getLayout(id)!;
      expect(t.role).toBe("page");
      expect(t.style).toBe("scrapbook");
      expect(t.format).toBe(l.format);
      expect(t.photoCount).toBeGreaterThanOrEqual(h === 0 ? halves.left : halves.right);
    });
    if (l.caption) expect(getLayout(l.twin![0])!.caption).not.toBeNull();
  });

  it("slots are ordered left page first", () => {
    const sides = l.slots.map((s) => rectHalf(s));
    const firstRight = sides.indexOf("right");
    expect(firstRight).toBeGreaterThan(0);
    expect(sides.slice(firstRight).every((s) => s === "right")).toBe(true);
  });

  it("a misaligned spread splits into exactly its twins, keeping every photo and the caption", () => {
    const single = ALL.find((x) => x.role === "page" && x.format === l.format && x.photoCount === 1)!;
    const cover = ALL.find((x) => x.role === "cover" && x.format === l.format)!;
    const [left, right] = spreadOf(l, "sp1", 1);
    const doc = docOf(l.format, [pageOf(single, "f1", 100), left, right], cover.id);
    const r = repairSpreads(doc);
    expect(r.splitCount).toBe(1);
    expect(r.doc.pages.map((p) => p.layout)).toEqual([single.id, ...l.twin!]);
    expect(photoIdsOf(r.doc.pages).sort()).toEqual(photoIdsOf(doc.pages).sort());
    expect(r.doc.pages.filter((p) => p.caption).length).toBe(doc.pages.filter((p) => p.caption).length);
  });
});

describe.each(SETS)("validateBookDoc over every scrapbook $format layout", ({ format, layouts }) => {
  it("an aligned doc using the cover, each single page and each spread has no issues", () => {
    let n = 1;
    const pages: BookPage[] = [];
    for (const l of layouts.filter((x) => x.role === "page")) {
      pages.push(pageOf(l, `pg${pages.length}`, n));
      n += l.photoCount;
    }
    expect(pages.length % 2).toBe(0);
    for (const l of layouts.filter((x) => x.role === "spread")) {
      pages.push(...spreadOf(l, `sp${pages.length}`, n));
      n += l.photoCount;
    }
    const photoIds = new Set(["ph0", ...photoIdsOf(pages)]);
    const cover = layouts.find((x) => x.role === "cover")!;
    expect(validateBookDoc(docOf(format, pages, cover.id), { photoIds, maxPages: 100 })).toEqual([]);
  });
});
