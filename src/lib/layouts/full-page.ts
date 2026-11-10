import type { Layout } from "@/lib/book/types";

/** One photo bleeding to all edges, no caption. */
export const fullPage: Layout = {
  id: "full-page",
  name: "Full page photo",
  role: "page",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: null,
};
