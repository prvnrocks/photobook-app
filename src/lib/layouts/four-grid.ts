import type { Layout } from "@/lib/book/types";

/** 2×2 grid, caption at the bottom. */
export const fourGrid: Layout = {
  id: "four-grid",
  name: "4 photo grid",
  role: "page",
  photoCount: 4,
  prefers: ["any", "any", "any", "any"],
  slots: [
    { x: 5, y: 5, w: 44, h: 39 },
    { x: 51, y: 5, w: 44, h: 39 },
    { x: 5, y: 46, w: 44, h: 39 },
    { x: 51, y: 46, w: 44, h: 39 },
  ],
  caption: { x: 5, y: 88, w: 90, h: 7 },
};
