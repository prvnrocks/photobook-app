// Fixture doc + placeholder photos for the dev-only /dev-book-page preview. No user data.

import { LAYOUTS } from "@/lib/layouts";
import type { RenderPhotos } from "./render";
import type { BookDoc } from "./types";

const COLORS = ["#c2410c", "#0f766e", "#1d4ed8", "#a21caf", "#4d7c0f", "#b45309", "#be123c", "#334155"];

/** SVG data URL with a grid + centre mark, so crop offsets are visible. */
function placeholder(w: number, h: number, color: string, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="${color}"/>` +
    `<path d="M0 0L${w} ${h}M${w} 0L0 ${h}" stroke="#fff" stroke-opacity=".4" stroke-width="${w / 100}"/>` +
    `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 10}" fill="#fff" fill-opacity=".7"/>` +
    `<text x="50%" y="${h / 2 + Math.min(w, h) / 4}" font-size="${Math.min(w, h) / 8}" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function devPreviewPhotos(): RenderPhotos {
  const out: Record<string, { url: string; width: number; height: number }> = {};
  for (let i = 0; i < 16; i++) {
    const landscape = i % 3 === 1;
    const [w, h] = landscape ? [1600, 1067] : i % 3 === 2 ? [1200, 1200] : [1200, 1600];
    out[`d${i}`] = { url: placeholder(w, h, COLORS[i % COLORS.length], `d${i} ${w}×${h}`), width: w, height: h };
  }
  return out;
}

export function devPreviewDoc(): BookDoc {
  let n = 1;
  const pages = LAYOUTS.filter((l) => l.role === "page").map((l, i) => ({
    id: `pg${i}`,
    chapterId: null,
    layout: l.id,
    slots: l.slots.map((_, j) => ({
      photoId: i === 2 && j === 1 ? null : `d${n++}`,
      crop: j === 0 ? { x: 0.3, y: 0.5, zoom: 1.4 } : { x: 0.5, y: 0.5, zoom: 1 },
    })),
    caption: l.caption
      ? i % 2 === 0
        ? { text: "أجمل ليلة بدأت بضحكة، وانتهت بذكرى لا تُنسى", font: "Cairo", align: "center" as const, source: "ai" as const }
        : { text: "The longest table, the loudest laughs, and everyone we love in one room.", font: "Playfair", align: "left" as const, source: "ai" as const }
      : null,
  }));
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "wedding",
    cover: { layout: "cover", photoId: "d0", title: "Sara & Omar", subtitle: "Abu Dhabi · 2026" },
    chapters: [],
    pages,
    style: { background: "#FFFFFF", font: "Playfair" },
  };
}
