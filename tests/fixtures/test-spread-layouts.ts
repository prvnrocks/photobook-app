// TEST-ONLY spread layouts (M10b A2) — NOT in the shipping catalogue. They exercise the spread
// storage model and repairSpreads until the real modern / landscape spreads land (A5). Tests add
// them to the catalogue with vi.mock("@/lib/layouts", withTestSpreads).
//
// Coordinates: x 0..200 across both pages (0..100 = left page), y 0..100.

import type { Layout } from "@/lib/book/types";

/** Full-bleed photo on the left page, two stacked landscapes + caption on the right page. */
export const TEST_SPREAD_A: Layout = {
  id: "test-spread-a",
  name: "Test spread: 1 + 2",
  role: "spread",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["portrait", "landscape", "landscape"],
  slots: [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 105, y: 5, w: 90, h: 39 },
    { x: 105, y: 46, w: 90, h: 39 },
  ],
  caption: { x: 105, y: 88, w: 90, h: 7 },
  twin: ["full-page", "two-horizontal"],
  texts: [{ bind: "chapterTitle", box: { x: 110, y: 90, w: 80, h: 6 }, align: "start", font: "chapter" }],
};

/**
 * 2×2 grid + caption on the left, two tall photos on the right. Its left twin (one-portrait)
 * holds only 1 photo → a split must pick a bigger single layout (four-grid).
 */
export const TEST_SPREAD_B: Layout = {
  id: "test-spread-b",
  name: "Test spread: 4 + 2",
  role: "spread",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 6,
  prefers: ["any", "any", "any", "any", "portrait", "portrait"],
  slots: [
    { x: 5, y: 5, w: 44, h: 39 },
    { x: 51, y: 5, w: 44, h: 39 },
    { x: 5, y: 46, w: 44, h: 39 },
    { x: 51, y: 46, w: 44, h: 39 },
    { x: 105, y: 8, w: 43, h: 72 },
    { x: 152, y: 8, w: 43, h: 72 },
  ],
  caption: { x: 5, y: 88, w: 90, h: 7 },
  twin: ["one-portrait", "two-vertical"],
};

/** 6 + 6 photos: no classic single page holds 6, so a split continues on extra pages. */
export const TEST_SPREAD_C: Layout = {
  id: "test-spread-c",
  name: "Test spread: 6 + 6",
  role: "spread",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 12,
  prefers: Array.from({ length: 12 }, () => "any" as const),
  slots: Array.from({ length: 12 }, (_, i) => ({
    x: (i < 6 ? 5 : 105) + (i % 2) * 46,
    y: 5 + Math.floor((i % 6) / 2) * 30,
    w: 44,
    h: 28,
  })),
  caption: null,
  twin: ["full-page", "full-page"],
};

/** A single-page layout of another style (usesV2Features: any non-classic layout is v2). */
export const TEST_MODERN_PAGE: Layout = {
  id: "test-modern-one",
  name: "Test modern: 1 photo",
  role: "page",
  style: "modern",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 0, y: 0, w: 100, h: 70 }],
  caption: { x: 8, y: 76, w: 84, h: 12 },
};

export const TEST_SPREADS: readonly Layout[] = [TEST_SPREAD_A, TEST_SPREAD_B, TEST_SPREAD_C, TEST_MODERN_PAGE];

/**
 * vi.mock factory body: the real @/lib/layouts module with TEST_SPREADS appended to the catalogue.
 * Usage: vi.mock("@/lib/layouts", async (orig) => withTestSpreads(await orig()));
 */
export function withTestSpreads<M extends typeof import("@/lib/layouts")>(real: M): M {
  const all: readonly Layout[] = [...real.LAYOUTS, ...TEST_SPREADS];
  const byId = new Map(all.map((l) => [l.id, l]));
  return {
    ...real,
    LAYOUTS: all,
    LAYOUT_IDS: all.map((l) => l.id),
    getLayout: (id: string) => byId.get(id),
    layoutsByRole: (role: Layout["role"]) => all.filter((l) => l.role === role),
  };
}
