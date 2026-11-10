// Fixture book for the dev-only /dev-viewer route (404 in production). No user data: synthetic
// SVG photos. 12 pages (default; `pages` 1..100 for end-card / filler checks) in 3 chapters with
// English and Arabic captions.

import type { RenderPhotos } from "@/lib/book/render";
import type { BookDoc, Chapter } from "@/lib/book/types";
import { LAYOUTS } from "@/lib/layouts";

const COLORS = ["#c2410c", "#0f766e", "#1d4ed8", "#a21caf", "#4d7c0f", "#b45309", "#be123c", "#334155"];

function svgPhoto(w: number, h: number, color: string, label: string): string {
  const s = Math.min(w, h);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="${color}"/>` +
    `<circle cx="${w * 0.7}" cy="${h * 0.3}" r="${s / 8}" fill="#fff" fill-opacity=".55"/>` +
    `<path d="M0 ${h}L${w * 0.35} ${h * 0.55}L${w * 0.6} ${h * 0.8}L${w * 0.8} ${h * 0.6}L${w} ${h}Z" fill="#000" fill-opacity=".25"/>` +
    `<text x="50%" y="${h * 0.9}" font-size="${s / 10}" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const CHAPTERS: Chapter[] = [
  { id: "ch-arrival", title: "Arrival", dateLabel: "12 Feb", place: null },
  { id: "ch-dinner", title: "عشاء العائلة", dateLabel: "12 Feb", place: null },
  { id: "ch-desert", title: "Desert morning", dateLabel: "13 Feb", place: null },
];

const CAPTIONS_EN = [
  "First light over the water, and nobody wanted to leave.",
  "The longest table, the loudest laughs, and everyone in one room.",
  "Sand in our shoes and smiles on every face.",
];
const CAPTION_AR = "أجمل ليلة بدأت بضحكة، وانتهت بذكرى لا تُنسى";

export const DEV_VIEWER_PAGE_COUNT = 12;

export function devViewerPhotos(): RenderPhotos {
  const out: Record<string, { url: string; width: number; height: number }> = {};
  for (let i = 0; i < DEV_PHOTO_COUNT; i++) {
    const [w, h] = i % 3 === 1 ? [1600, 1067] : i % 3 === 2 ? [1200, 1200] : [1200, 1600];
    out[`v${i}`] = { url: svgPhoto(w, h, COLORS[i % COLORS.length], `v${i}`), width: w, height: h };
  }
  return out;
}

const DEV_PHOTO_COUNT = 40;

/** Page count from a `?pages=` query value: 1..100, default DEV_VIEWER_PAGE_COUNT. */
export function devViewerPageCount(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : DEV_VIEWER_PAGE_COUNT;
}

/** Page background from a `?bg=RRGGBB` query value (no '#'), default white. */
export function devViewerBackground(raw: unknown): string {
  return typeof raw === "string" && /^[0-9A-Fa-f]{6}$/.test(raw) ? `#${raw.toUpperCase()}` : "#FFFFFF";
}

export function devViewerDoc(opts: { lang?: "en" | "ar"; pages?: number; background?: string } = {}): BookDoc {
  const pageLayouts = LAYOUTS.filter((l) => l.role === "page");
  const count = opts.pages ?? DEV_VIEWER_PAGE_COUNT;
  let n = 1;
  // Photo ids v1..v39 (v0 is the cover), recycled for long books.
  const nextPhoto = () => `v${((n++ - 1) % (DEV_PHOTO_COUNT - 1)) + 1}`;
  const pages = Array.from({ length: count }, (_, i) => {
    const l = pageLayouts[i % pageLayouts.length];
    const chapter = CHAPTERS[Math.min(Math.floor((i * CHAPTERS.length) / count), CHAPTERS.length - 1)];
    const arabic = opts.lang === "ar" ? i % 2 === 0 : i === 4 || i === 5;
    return {
      id: `vp${i}`,
      chapterId: chapter.id,
      layout: l.id,
      slots: l.slots.map(() => ({ photoId: nextPhoto(), crop: { x: 0.5, y: 0.5, zoom: 1 } })),
      caption: l.caption
        ? arabic
          ? { text: CAPTION_AR, font: "Cairo", align: "center" as const, source: "ai" as const }
          : { text: CAPTIONS_EN[i % CAPTIONS_EN.length], font: "Playfair", align: "center" as const, source: "ai" as const }
        : null,
    };
  });
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: {
      layout: "cover",
      photoId: "v0",
      title: opts.lang === "ar" ? "رحلتنا إلى أبوظبي" : "Our Abu Dhabi trip",
      subtitle: "Feb 2026",
    },
    chapters: CHAPTERS,
    pages,
    style: { background: { kind: "color", hex: opts.background ?? "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
  };
}
