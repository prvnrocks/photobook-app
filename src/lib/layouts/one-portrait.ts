import type { Layout } from "@/lib/book/types";

/** One framed portrait photo with a caption underneath. */
export const onePortrait: Layout = {
  id: "one-portrait",
  name: "1 photo with caption",
  role: "page",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 10, y: 7, w: 80, h: 72 }],
  caption: { x: 10, y: 83, w: 80, h: 10 },
};
