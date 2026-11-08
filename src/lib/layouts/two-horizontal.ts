import type { Layout } from "@/lib/book/types";

/** Two landscape photos stacked, caption below. */
export const twoHorizontal: Layout = {
  id: "two-horizontal",
  name: "2 photos stacked",
  role: "page",
  photoCount: 2,
  prefers: ["landscape", "landscape"],
  slots: [
    { x: 5, y: 5, w: 90, h: 39 },
    { x: 5, y: 46, w: 90, h: 39 },
  ],
  caption: { x: 5, y: 88, w: 90, h: 7 },
};
