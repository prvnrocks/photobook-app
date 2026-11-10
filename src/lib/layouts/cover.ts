import type { Layout } from "@/lib/book/types";

/** Cover: full-bleed photo on the top ~3/4, title + subtitle below. */
export const cover: Layout = {
  id: "cover",
  name: "Cover",
  role: "cover",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 0, y: 0, w: 100, h: 74 }],
  caption: { x: 8, y: 78, w: 84, h: 16 },
};
