import type { Layout } from "@/lib/book/types";

/** One photo bleeding to all edges, no caption. */
export const fullPage: Layout = {
  id: "full-page",
  name: "Full page photo",
  role: "page",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: null,
};
