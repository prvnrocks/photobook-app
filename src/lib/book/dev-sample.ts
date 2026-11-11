// Modern sample books (M10b A9) for the dev-only render checks (/dev-book-page?sample=…,
// /dev-print?sample=…) and the m10b goldens: every modern layout of a format once, spreads on even
// indices (left halves), English + Arabic captions and chapter titles, one right half with its own
// background. Placeholder photos from devPreviewPhotos(). No user data.

import { getLayout } from "@/lib/layouts";
import { devPreviewPhotos } from "./dev-preview";
import type { RenderPhotos } from "./render";
import type { BookDoc, BookFormat, BookPage, Caption } from "./types";

export type DevSample = "modern-portrait" | "modern-landscape";

export function parseDevSample(raw: unknown): DevSample | null {
  return raw === "modern-portrait" || raw === "modern-landscape" ? raw : null;
}

const EN = "The longest table, the loudest laughs, and everyone we love in one room.";
const AR = "أجمل ليلة بدأت بضحكة، وانتهت بذكرى لا تُنسى";

const CHAPTERS = [
  { id: "c1", title: "The mehndi night", dateLabel: "12 Oct 2026", place: "Abu Dhabi" },
  { id: "c2", title: "ليلة العمر", dateLabel: "١٣ أكتوبر ٢٠٢٦", place: null },
  { id: "c3", title: "A day by the sea", dateLabel: "14 Oct 2026", place: "Saadiyat" },
];

/** [layout id, chapter, caption language] per stored page; a spread id appears ONCE (left half). */
const ORDER: Record<DevSample, Array<[string, string, "en" | "ar" | null]>> = {
  "modern-portrait": [
    ["m-p-one-band", "c1", "ar"],
    ["m-p-two-panel", "c1", "en"],
    ["m-p-spread-mosaic", "c2", "ar"],
    ["m-p-spread-panorama", "c3", null],
    ["m-p-spread-grid", "c3", null],
    ["m-p-three-panel", "c3", "en"],
    ["m-p-four-grid", "c3", "ar"],
    ["m-p-five-mosaic", "c3", null],
    ["m-p-six-grid", "c3", "en"],
    ["m-p-full", "c3", null],
    ["m-p-two-stack", "c3", null],
    ["m-p-three-mosaic", "c3", null],
  ],
  "modern-landscape": [
    ["m-l-one-text", "c1", "en"],
    ["m-l-two", "c1", "ar"],
    ["m-l-spread-mosaic", "c2", "ar"],
    ["m-l-spread-panorama", "c3", null],
    ["m-l-spread-grid", "c3", null],
    ["m-l-one", "c3", "en"],
    ["m-l-three", "c3", "ar"],
    ["m-l-three-b", "c3", "en"],
    ["m-l-three-row", "c3", null],
    ["m-l-four", "c3", "en"],
    ["m-l-five", "c3", null],
    ["m-l-six", "c3", "ar"],
    ["m-l-full-bleed", "c3", null],
  ],
};

const caption = (lang: "en" | "ar"): Caption =>
  lang === "ar"
    ? { text: AR, font: "Amiri", align: "center", source: "ai" }
    : { text: EN, font: "Cormorant", align: "center", source: "ai" };

/** Photos used by any sample: cover d0, pages sp0…sp{SAMPLE_PHOTO_COUNT-1} (aliases of d1…d15). */
export const SAMPLE_PHOTO_COUNT = 64;

export function devSamplePhotos(): RenderPhotos {
  const base = devPreviewPhotos();
  const out: Record<string, RenderPhotos[string]> = { d0: base.d0 };
  for (let i = 0; i < SAMPLE_PHOTO_COUNT; i++) out[`sp${i}`] = base[`d${(i % 15) + 1}`];
  return out;
}

/** A valid modern book of `sample` (passes validateBookDoc with the devSamplePhotos() ids). */
export function devSampleDoc(sample: DevSample): BookDoc {
  const format: BookFormat = sample === "modern-landscape" ? "A5_LANDSCAPE" : "A5_PORTRAIT";
  let n = 0;
  const nextPhoto = () => `sp${n++}`;
  const pages: BookPage[] = [];
  for (const [id, chapterId, lang] of ORDER[sample]) {
    const l = getLayout(id);
    if (!l) throw new Error(`dev sample: unknown layout ${id}`);
    const left: BookPage = {
      id: `s${pages.length}`,
      chapterId,
      layout: id,
      slots: l.slots.map(() => ({ photoId: nextPhoto(), crop: { x: 0.5, y: 0.5, zoom: 1 } })),
      caption: l.caption && lang ? caption(lang) : null,
    };
    if (l.role !== "spread") {
      pages.push(left);
      continue;
    }
    pages.push({ ...left, side: "left" });
    pages.push({
      id: `s${pages.length}`,
      chapterId,
      layout: id,
      side: "right",
      slots: [],
      caption: null,
      // The mosaic's right half shows its own background (each half keeps its page background).
      ...(id.endsWith("spread-mosaic") ? { background: { kind: "texture", textureId: "paper-cream", source: "user" } as const } : {}),
    });
  }
  return {
    version: 2,
    format,
    occasion: "wedding",
    cover: {
      layout: format === "A5_LANDSCAPE" ? "m-l-cover-strip" : "m-p-cover-strips",
      photoId: "d0",
      title: "Sara & Omar",
      subtitle: "Abu Dhabi · 2026",
    },
    chapters: CHAPTERS.map((c) => ({ ...c })),
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "modern", font: "Cormorant" },
  };
}
