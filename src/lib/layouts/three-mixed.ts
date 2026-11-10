import type { Layout } from "@/lib/book/types";

/** One wide photo on top, two portrait photos below, caption at the bottom. */
export const threeMixed: Layout = {
  id: "three-mixed",
  name: "1 wide + 2 tall",
  role: "page",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 3,
  prefers: ["landscape", "portrait", "portrait"],
  slots: [
    { x: 5, y: 5, w: 90, h: 40 },
    { x: 5, y: 47, w: 44, h: 38 },
    { x: 51, y: 47, w: 44, h: 38 },
  ],
  caption: { x: 5, y: 88, w: 90, h: 7 },
};
