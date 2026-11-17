// TEST-ONLY M29 cover styles (D-080) — NOT in the shipping catalogue. One `autoPick: false` cover
// per design (4 styles × 2 formats) that prefers "any" orientation, so it WOULD win
// bestCoverLayout / show up in the Storyteller catalogue if anything forgot the autoCoversFor
// filter. They stand in for the real M29 covers until the theme builders add them.
//
//   vi.mock("@/lib/layouts", async (orig) => (await import("./fixtures/test-m29-covers")).withTestCovers(await orig()));
//
// withTestCoversFirst puts them BEFORE every real layout (stricter: an autoPick:false cover first
// in catalogue order must still never be picked).

import type { BookFormat, DesignStyle, Layout } from "@/lib/book/types";

// Literal lists (no runtime import: this module is loaded inside a vi.mock factory of
// @/lib/layouts, and lib/book/schema imports @/lib/layouts). tests/layouts-covers.test.ts asserts
// they equal DESIGN_STYLES / BOOK_FORMATS.
export const TEST_STYLES = ["classic", "modern", "geometric", "scrapbook"] as const satisfies readonly DesignStyle[];
export const TEST_FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const satisfies readonly BookFormat[];

const short = (f: BookFormat) => (f === "A5_PORTRAIT" ? "p" : "l");

/** Id of the test cover for a design, e.g. "test-classic-p-cover-mock". */
export const testCoverId = (style: DesignStyle, format: BookFormat) => `test-${style}-${short(format)}-cover-mock`;

function testCover(style: DesignStyle, format: BookFormat): Layout {
  return {
    id: testCoverId(style, format),
    name: "Cover: test mock",
    role: "cover",
    style,
    format,
    photoCount: 1,
    prefers: ["any"],
    slots: [{ x: 0, y: 0, w: 100, h: 60 }],
    caption: { x: 10, y: 66, w: 80, h: 24 },
    texts: [
      { bind: "coverTitle", box: { x: 10, y: 66, w: 80, h: 14 }, align: "center", font: "title" },
      { bind: "coverSubtitle", box: { x: 10, y: 82, w: 80, h: 8 }, align: "center", font: "year" },
    ],
    autoPick: false,
  };
}

export const TEST_M29_COVERS: readonly Layout[] = TEST_STYLES.flatMap((s) => TEST_FORMATS.map((f) => testCover(s, f)));

type LayoutsModule = typeof import("@/lib/layouts");

function withCatalogue<M extends LayoutsModule>(real: M, all: readonly Layout[]): M {
  const byId = new Map(all.map((l) => [l.id, l]));
  return {
    ...real,
    LAYOUTS: all,
    LAYOUT_IDS: all.map((l) => l.id),
    getLayout: (id: string) => byId.get(id),
  };
}

/** vi.mock factory body: the real catalogue with TEST_M29_COVERS appended (the real M29 position). */
export function withTestCovers<M extends LayoutsModule>(real: M): M {
  return withCatalogue(real, [...real.LAYOUTS, ...TEST_M29_COVERS]);
}

/** vi.mock factory body: TEST_M29_COVERS before every real layout. */
export function withTestCoversFirst<M extends LayoutsModule>(real: M): M {
  return withCatalogue(real, [...TEST_M29_COVERS, ...real.LAYOUTS]);
}
