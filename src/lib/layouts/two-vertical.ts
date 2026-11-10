import type { Layout } from "@/lib/book/types";

/** Two tall photos side by side, caption below. */
export const twoVertical: Layout = {
  id: "two-vertical",
  name: "2 photos side by side",
  role: "page",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["portrait", "portrait"],
  slots: [
    { x: 5, y: 8, w: 43, h: 72 },
    { x: 52, y: 8, w: 43, h: 72 },
  ],
  caption: { x: 5, y: 84, w: 90, h: 10 },
};
