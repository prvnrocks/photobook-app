// Fixture doc + placeholder photos for the dev-only /dev-book-page preview. No user data.

import { CLASSIC_PORTRAIT_LAYOUTS as LAYOUTS } from "@/lib/layouts";
import type { RenderPhotos } from "./render";
import type { BookDoc, BookFormat } from "./types";

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

/**
 * Book format from a dev route's `?format=` query value: "landscape" → A5_LANDSCAPE, anything else
 * → A5_PORTRAIT. Until M10b brings landscape layouts, landscape fixtures reuse the portrait
 * layouts (stretched slots) — fine for format plumbing checks.
 */
export function parseDevFormat(raw: unknown): BookFormat {
  return raw === "landscape" ? "A5_LANDSCAPE" : "A5_PORTRAIT";
}

export function devPreviewDoc(format: BookFormat = "A5_PORTRAIT"): BookDoc {
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
    version: 2,
    format,
    occasion: "wedding",
    cover: { layout: "cover", photoId: "d0", title: "Sara & Omar", subtitle: "Abu Dhabi · 2026" },
    chapters: [],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
  };
}

/** `?bg=` of the dev print/page routes (M10a A6): background fixtures; anything else → none. */
export type DevBackgrounds = "tile" | "wash" | "photo" | "mix";

export function parseDevBackgrounds(raw: unknown): DevBackgrounds | null {
  return raw === "tile" || raw === "wash" || raw === "photo" || raw === "mix" ? raw : null;
}

/**
 * The fixture doc with backgrounds: `tile` / `wash` / `photo` set the book default (cover + every
 * page); `mix` sets a cream-paper book default and per-page overrides cycling through linen,
 * blush wash, photo + white veil, photo + navy veil (light ink), tinted kraft and navy colour.
 * Background photos are uuid aliases of d15 / d1 (see devPreviewPhotosWithBackgrounds).
 */
export function withDevBackgrounds(doc: BookDoc, kind: DevBackgrounds): BookDoc {
  const tile = { kind: "texture", textureId: "paper-cream" } as const;
  const wash = { kind: "texture", textureId: "watercolour-blush" } as const;
  const photo = { kind: "photo", photoId: DEV_BG_PHOTO_UUID, veil: 0.75, veilColor: "#FFFFFF" } as const;
  if (kind !== "mix") {
    const bg = kind === "tile" ? tile : kind === "wash" ? wash : photo;
    return { ...doc, style: { ...doc.style, background: bg } };
  }
  const cycle = [
    { kind: "texture", textureId: "linen", source: "user" },
    { kind: "texture", textureId: "watercolour-blush", source: "user" },
    { kind: "photo", photoId: DEV_BG_PHOTO_UUID, veil: 0.75, veilColor: "#FFFFFF", source: "user" },
    { kind: "photo", photoId: DEV_SLOT_PHOTO_UUID, veil: 0.6, veilColor: "#1E2A47", source: "user" },
    { kind: "texture", textureId: "kraft", tint: "#CFE1F0", source: "user" },
    { kind: "color", hex: "#1E2A47", source: "user" },
  ] as const;
  return {
    ...doc,
    style: { ...doc.style, background: tile },
    pages: doc.pages.map((p, i) => ({ ...p, background: { ...cycle[i % cycle.length] } })),
  };
}

// Photo backgrounds need uuid photo ids (schema); the dev photo map aliases them to d15 / d1.
export const DEV_BG_PHOTO_UUID = "00000000-0000-4000-8000-0000000000f5";
export const DEV_SLOT_PHOTO_UUID = "00000000-0000-4000-8000-000000000001";

/** devPreviewPhotos() plus the uuid aliases used by withDevBackgrounds. */
export function devPreviewPhotosWithBackgrounds(): RenderPhotos {
  const p = devPreviewPhotos();
  return { ...p, [DEV_BG_PHOTO_UUID]: p.d15, [DEV_SLOT_PHOTO_UUID]: p.d1 };
}
