// TEST-ONLY M10c layouts (T8a/T8b) — NOT in the shipping catalogue. They exercise every new render
// feature (shapes, tilt, frames, shadows, z, decorations incl. the occasion accent and photo
// corners, label plates, rotated text, spread halves, cover) until the real geometric / scrapbook
// layouts land. Tests add them with vi.mock("@/lib/layouts", async (orig) => withTestM10c(await orig())).
//
// Portrait A5 = 148 × 210 mm: the 4 mm safe zone is x ≥ 2.703 %, y ≥ 1.905 %.

import type { BookDoc, Layout } from "@/lib/book/types";

/** Page: polaroid (tilted, lifted, z 2), framed rounded (soft, z 1), circle, bleed hexagon, diamond, bleed polygon. */
export const TEST_M10C_PAGE: Layout = {
  id: "test-m10c-page",
  name: "Test M10c page",
  role: "page",
  style: "scrapbook",
  format: "A5_PORTRAIT",
  photoCount: 6,
  prefers: ["any", "any", "any", "any", "any", "any"],
  slots: [
    { x: 8, y: 6, w: 50, h: 36, frame: { kind: "polaroid", side: 3, bottom: 10 }, rotate: -4, shadow: "lifted", z: 2 },
    { x: 55, y: 12, w: 38, h: 26, shape: { kind: "rounded", r: 4 }, frame: { kind: "border", mm: 1.5, hex: "#FFFFFF" }, shadow: "soft", z: 1 },
    { x: 10, y: 54, w: 30, h: 21.1429, shape: { kind: "circle" } },
    { x: 0, y: 78, w: 45, h: 22, shape: { kind: "hexagon" } },
    { x: 55, y: 52, w: 35, h: 24.6667, shape: { kind: "diamond" }, shadow: "soft" },
    { x: 50, y: 80, w: 50, h: 20, shape: { kind: "polygon", points: [[10, 0], [100, 0], [100, 100], [0, 100]] } },
  ],
  caption: { x: 50, y: 44, w: 45, h: 5 },
  texts: [
    { bind: "dateLabel", box: { x: 60, y: 3, w: 30, h: 6 }, align: "center", font: "year", plate: { id: "plate-label" }, rotate: -3 },
    { bind: "chapterTitle", box: { x: 10, y: 46, w: 35, h: 6 }, align: "start", font: "chapter", rotate: 2 },
  ],
  decorations: [
    { kind: "sticker", id: "occasion-accent", box: { x: 80, y: 42, w: 12, h: 8 }, layer: "under" },
    { kind: "tape", id: "tape-washi", box: { x: 25, y: 4, w: 20, h: 4 }, rotate: -8, layer: "over" },
    { kind: "sticker", id: "photo-corner", box: { x: 54, y: 11, w: 5, h: 3.5238 }, layer: "over" },
    { kind: "sticker", id: "photo-corner", box: { x: 89, y: 35.5, w: 5, h: 3.5238 }, rotate: 180, layer: "over" },
  ],
};

/** Spread: plain full-bleed left page, tilted polaroid + plated chapter title on the right. */
export const TEST_M10C_SPREAD: Layout = {
  id: "test-m10c-spread",
  name: "Test M10c spread",
  role: "spread",
  style: "scrapbook",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["any", "any"],
  slots: [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 110, y: 10, w: 80, h: 50, frame: { kind: "polaroid", side: 3, bottom: 9 }, rotate: 3, shadow: "soft" },
  ],
  caption: { x: 110, y: 86, w: 80, h: 6 },
  twin: ["full-page", "two-horizontal"],
  texts: [{ bind: "chapterTitle", box: { x: 115, y: 70, w: 60, h: 10 }, align: "center", font: "chapter", plate: { id: "plate-tag", tint: "#B65A4E" } }],
  decorations: [
    { kind: "sticker", id: "star", box: { x: 80, y: 85, w: 12, h: 8 }, layer: "over", tint: "#D9A84E" },
    { kind: "tape", id: "tape-kraft", box: { x: 140, y: 7, w: 20, h: 4 }, rotate: 5, layer: "over" },
  ],
};

/** Cover: tilted polaroid, plated title, rotated subtitle, tape + occasion accent. */
export const TEST_M10C_COVER: Layout = {
  id: "test-m10c-cover",
  name: "Test M10c cover",
  role: "cover",
  style: "scrapbook",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [{ x: 12, y: 8, w: 76, h: 60, frame: { kind: "polaroid", side: 3, bottom: 12 }, rotate: -3, shadow: "lifted" }],
  caption: { x: 10, y: 74, w: 80, h: 20 },
  texts: [
    { bind: "coverTitle", box: { x: 10, y: 74, w: 80, h: 12 }, align: "center", font: "title", plate: { id: "plate-label" } },
    { bind: "coverSubtitle", box: { x: 10, y: 88, w: 80, h: 6 }, align: "center", font: "subtitle", rotate: -2 },
  ],
  decorations: [
    { kind: "sticker", id: "occasion-accent", box: { x: 76, y: 64, w: 14, h: 10 }, layer: "under" },
    { kind: "tape", id: "tape-striped", box: { x: 40, y: 5, w: 20, h: 4 }, layer: "over" },
  ],
};

export const TEST_M10C_LAYOUTS: readonly Layout[] = [TEST_M10C_PAGE, TEST_M10C_SPREAD, TEST_M10C_COVER];

export function withTestM10c<M extends typeof import("@/lib/layouts")>(real: M): M {
  const all: readonly Layout[] = [...real.LAYOUTS, ...TEST_M10C_LAYOUTS];
  const byId = new Map(all.map((l) => [l.id, l]));
  return {
    ...real,
    LAYOUTS: all,
    LAYOUT_IDS: all.map((l) => l.id),
    getLayout: (id: string) => byId.get(id),
    layoutsByRole: (role: Layout["role"]) => all.filter((l) => l.role === role),
  };
}

const slot = (n: number) => ({ photoId: `p${n}`, crop: { x: 0.5, y: 0.5, zoom: 1 } });

/** A scrapbook book using the three test layouts (pages: 0 = page, 1/2 = spread halves). */
export function testM10cDoc(occasion: BookDoc["occasion"] = "travel", chapterTitle = "Old Town Walk"): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion,
    cover: { layout: TEST_M10C_COVER.id, photoId: "p0", title: "Summer in Lisbon", subtitle: "July 2026" },
    chapters: [{ id: "ch1", title: chapterTitle, dateLabel: "12 July", place: null }],
    pages: [
      {
        id: "pg0",
        chapterId: "ch1",
        layout: TEST_M10C_PAGE.id,
        slots: [1, 2, 3, 4, 5, 6].map(slot),
        caption: { text: "Tiles everywhere we looked.", font: "Cormorant", align: "center", source: "ai" },
      },
      {
        id: "pg1",
        chapterId: "ch1",
        layout: TEST_M10C_SPREAD.id,
        side: "left",
        slots: [7, 8].map(slot),
        caption: { text: "The tram up the hill.", font: "Cormorant", align: "center", source: "ai" },
      },
      { id: "pg2", chapterId: "ch1", layout: TEST_M10C_SPREAD.id, side: "right", slots: [], caption: null },
    ],
    style: { background: { kind: "color", hex: "#F6F0E4" }, designStyle: "scrapbook", font: "Cormorant" },
  };
}
